/* StructBoard · zip.js
 * 零依赖 ZIP 阅读器：只读中央目录，按需解压单个条目。
 * 浏览器原生 DecompressionStream('deflate-raw')，不引入 JSZip、不联网。
 * 目的：AF3 批量包里 full_data_*.json 有几百 MB，全解压会爆内存，
 *       这里只取 *_model_N.cif 和 *_summary_confidences_N.json。
 * 支持标准 ZIP（method 0 存储 / 8 deflate），不支持 ZIP64、加密、分卷。
 */
(function (global) {
  'use strict';

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const UTF8 = new TextDecoder('utf-8');

  /** 解析中央目录，返回 { buf, dv, u8, entries }。entries: {name, method, csize, usize, localOff} */
  async function open(file) {
    const buf = await file.arrayBuffer();
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const len = buf.byteLength;
    if (len < 22) throw new Error('文件太小，不是有效的 ZIP');

    // EOCD 可能在末尾 64KB 内（含注释），从后往前找
    let eocd = -1;
    const min = Math.max(0, len - 65557);
    for (let i = len - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP（找不到结束记录，文件可能没下载完）');

    const count = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      throw new Error('暂不支持 ZIP64 格式');
    }

    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > len || dv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('ZIP 中央目录损坏（位置 ' + p + '）');
      }
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      if (flags & 0x1) throw new Error('ZIP 条目被加密，无法读取');
      let name = UTF8.decode(u8.subarray(p + 46, p + 46 + nameLen));
      if (!(flags & 0x800)) name = name.replace(/\\/g, '/');
      entries.push({ name: name, method: method, csize: csize, usize: usize, localOff: localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { buf: buf, dv: dv, u8: u8, entries: entries, name: file.name };
  }

  /** 解压单个条目，返回 string 或 Uint8Array */
  async function extract(zip, entry, asText) {
    const dv = zip.dv;
    const p = entry.localOff;
    if (p + 30 > dv.byteLength || dv.getUint32(p, true) !== SIG_LOCAL) {
      throw new Error('ZIP 条目损坏：' + entry.name);
    }
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start = p + 30 + nameLen + extraLen;
    if (start + entry.csize > zip.u8.length) {
      throw new Error('ZIP 条目数据被截断：' + entry.name);
    }
    const raw = zip.u8.subarray(start, start + entry.csize);

    let out;
    if (entry.method === 0) {
      out = raw.slice();
    } else if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('此浏览器不支持 deflate-raw 解压，请用新版 Chrome / Edge');
      }
      let ds;
      try { ds = new DecompressionStream('deflate-raw'); }
      catch (e) { throw new Error('浏览器不支持 deflate-raw 解压'); }
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      let ab;
      try { ab = await new Response(stream).arrayBuffer(); }
      catch (e) { throw new Error('解压失败：' + entry.name + '（' + (e && e.message ? e.message : e) + '）'); }
      out = new Uint8Array(ab);
    } else {
      throw new Error('不支持的 ZIP 压缩方式 ' + entry.method + '：' + entry.name);
    }
    return asText ? UTF8.decode(out) : out;
  }

  function byName(zip, name) {
    return zip.entries.find(function (e) { return e.name === name; }) || null;
  }

  global.SB_ZIP = { open: open, extract: extract, byName: byName };
})(window);
