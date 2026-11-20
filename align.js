/* StructBoard · align.js
 * CA 原子刚体叠加（Horn 四元数法），纯 JS，不依赖 Mol* 内部 API。
 * 只改「用于显示的坐标」，不写回用户原文件。
 */
(function (global) {
  'use strict';

  function caAtoms(parsed) {
    if (!parsed || !parsed.atoms) return [];
    return parsed.atoms.filter(function (a) {
      return a.name.toUpperCase() === 'CA' && (!a.altLoc || a.altLoc === 'A' || a.altLoc === '.');
    });
  }

  function key(a) { return a.chain + '|' + a.resSeq + '|' + (a.iCode || ''); }

  // 优先按 链+残基号 配对；配对太少时退回按 CA 出现顺序配对
  function pairCa(refCa, movCa) {
    const map = new Map();
    for (const a of refCa) { if (!map.has(key(a))) map.set(key(a), a); }
    const P = [], Q = [];
    for (const b of movCa) {
      const a = map.get(key(b));
      if (a) { P.push([a.x, a.y, a.z]); Q.push([b.x, b.y, b.z]); }
    }
    if (P.length >= 4) return { P, Q, mode: 'residue-id' };
    const n = Math.min(refCa.length, movCa.length);
    const P2 = [], Q2 = [];
    for (let i = 0; i < n; i++) {
      P2.push([refCa[i].x, refCa[i].y, refCa[i].z]);
      Q2.push([movCa[i].x, movCa[i].y, movCa[i].z]);
    }
    return { P: P2, Q: Q2, mode: P2.length >= 4 ? 'sequential' : 'none' };
  }

  function centroid(pts) {
    const c = [0, 0, 0];
    for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    const n = pts.length || 1;
    return [c[0] / n, c[1] / n, c[2] / n];
  }

  function matVec(N, v) {
    const r = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r[i] += N[i][j] * v[j];
    return r;
  }

  // 幂迭代求对称 4x4 矩阵的主特征向量
  function principalEigen(N) {
    let v = [1, 0.13, -0.07, 0.21];
    for (let k = 0; k < 200; k++) {
      const w = matVec(N, v);
      const len = Math.hypot(w[0], w[1], w[2], w[3]);
      if (!Number.isFinite(len) || len < 1e-12) return null;
      const nv = [w[0] / len, w[1] / len, w[2] / len, w[3] / len];
      let d = 0;
      for (let i = 0; i < 4; i++) d += Math.abs(nv[i] - v[i]);
      v = nv;
      if (d < 1e-12) break;
    }
    const len = Math.hypot(v[0], v[1], v[2], v[3]) || 1;
    return v.map(function (x) { return x / len; });
  }

  function quatToMatrix(q) {
    const [q0, q1, q2, q3] = q;
    return [
      [q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3, 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)],
      [2 * (q1 * q2 + q0 * q3), q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, 2 * (q2 * q3 - q0 * q1)],
      [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3],
    ];
  }

  function transpose(R) {
    return [
      [R[0][0], R[1][0], R[2][0]],
      [R[0][1], R[1][1], R[2][1]],
      [R[0][2], R[1][2], R[2][2]],
    ];
  }

  function rotate(R, v) {
    return [
      R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
      R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
      R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
    ];
  }

  function rmsdWith(R, cp, cq, P, Q) {
    let s = 0;
    for (let i = 0; i < P.length; i++) {
      const q = [Q[i][0] - cq[0], Q[i][1] - cq[1], Q[i][2] - cq[2]];
      const p = rotate(R, q);
      const dx = p[0] + cp[0] - P[i][0];
      const dy = p[1] + cp[1] - P[i][1];
      const dz = p[2] + cp[2] - P[i][2];
      s += dx * dx + dy * dy + dz * dz;
    }
    return Math.sqrt(s / (P.length || 1));
  }

  /**
   * 计算把 mov 叠到 ref 上的刚体变换。
   * 返回 { R, cp, cq, rmsd, n, mode }，失败返回 null。
   */
  function compute(refParsed, movParsed) {
    const paired = pairCa(caAtoms(refParsed), caAtoms(movParsed));
    if (paired.mode === 'none') return null;
    const P = paired.P, Q = paired.Q;
    const cp = centroid(P), cq = centroid(Q);

    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < P.length; i++) {
      const p = [P[i][0] - cp[0], P[i][1] - cp[1], P[i][2] - cp[2]];
      const q = [Q[i][0] - cq[0], Q[i][1] - cq[1], Q[i][2] - cq[2]];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a][b] += q[a] * p[b];
    }
    const Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2];
    const Syx = S[1][0], Syy = S[1][1], Syz = S[1][2];
    const Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];

    const N = [
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
    ];
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const plain = rmsdWith(I, cp, cq, P, Q);
    // 两个结构坐标本来就一致：直接返回恒等变换，避免退化矩阵求出伪旋转
    if (plain < 1e-4) {
      return { R: I, cp: cp, cq: cq, rmsd: plain, before: plain, n: P.length, mode: paired.mode };
    }

    const q = principalEigen(N);
    if (!q) return null;

    // 四元数约定可能与 Horn 原式差一个共轭：两种方向都算 RMSD，取更优的
    const R1 = quatToMatrix(q);
    const R2 = transpose(R1);
    const r1 = rmsdWith(R1, cp, cq, P, Q);
    const r2 = rmsdWith(R2, cp, cq, P, Q);
    const best = (r1 <= r2) ? { R: R1, rmsd: r1 } : { R: R2, rmsd: r2 };
    if (best.rmsd > plain + 1e-4) return null;  // 没变好就不动，避免把结构转坏

    return {
      R: best.R, cp: cp, cq: cq,
      rmsd: best.rmsd, before: plain,
      n: P.length, mode: paired.mode,
    };
  }

  function transformPoint(t, p) {
    const q = [p[0] - t.cq[0], p[1] - t.cq[1], p[2] - t.cq[2]];
    const r = rotate(t.R, q);
    return [r[0] + t.cp[0], r[1] + t.cp[1], r[2] + t.cp[2]];
  }

  function chainIdMap(chains) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const map = {};
    chains.forEach(function (c, i) { map[c] = alphabet[i % alphabet.length]; });
    return map;
  }

  /** 返回对齐后的 PDB 文本（视图专用），失败返回 null */
  function toAlignedPdb(parsed, transform) {
    if (!parsed || !transform || !parsed.atoms || !parsed.atoms.length) return null;
    const map = chainIdMap(parsed.chains);
    const atoms = parsed.atoms.map(function (a) {
      const p = transformPoint(transform, [a.x, a.y, a.z]);
      return Object.assign({}, a, { x: p[0], y: p[1], z: p[2] });
    });
    return global.SB_IO.toPdb(atoms, map);
  }

  global.SB_ALIGN = { caAtoms, compute, toAlignedPdb, transformPoint, chainIdMap };
})(window);
