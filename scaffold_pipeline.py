#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从数据目录生成管线定义草稿（脚手架）。

定位
----
用户常常只有一堆数据和脚本，还没有写下"这一步叫什么、阈值多少、跑什么命令"。
本模块扫描目录，按**文件名关键词**做启发式分组，产出一份可编辑的 JSON 草稿。

三条硬规矩
----------
1. **草稿是推测，不是事实。** 分组只靠文件名关键词，猜不准就是猜不准。
   所以草稿里每一步的 desc 都会写明"自动分组，待人工确认"，
   cmd 一律填 "TODO: 补这一步实际运行的命令"，**绝不替用户编阈值**。
2. **不读文件内容。** 只看文件名和大小，不解析脚本里的阈值 —— 避免把
   读到的数字当成筛选条件写进定义。
3. **只读。** 不写任何原始数据，只产出内存里的草稿；由调用方决定是否落盘。

真要准确的阈值和顺序，还是得照着脚本手写 defn —— 那是人写的部分。
"""
import json
import os
import re

try:
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

MAX_ENTRIES = 4000          # 目录里条目太多就只看前面这些
MAX_STEPS = 24              # 草稿最多几个步骤
MAX_FILES_PER_STEP = 12     # 每步最多列多少文件

# 分组关键词 → (步骤标题, 轮次标签, 排序权重)
# 顺序即推测的流程顺序；权重小的在前。
KEYWORDS = [
    ('target',   '靶点与口袋准备',   'R0', 10),
    ('template', '靶点与口袋准备',   'R0', 11),
    ('hotspot',  '热点定义',         'R0', 12),
    ('filter',   '筛选脚本',         'R1', 20),
    ('rfd',      'RFD3 骨架生成',    'R1', 21),
    ('design',   '骨架生成',         'R1', 22),
    ('mpnn',     'MPNN 序列设计',    'R1', 30),
    ('seq',      '序列设计',         'R1', 31),
    ('relax',    '结构松弛',         'R1', 32),
    ('rosetta',  '结构松弛',         'R1', 33),
    ('fold',     '折叠检验',         'R1', 40),
    ('refold',   '折叠检验',         'R1', 41),
    ('check',    '检验',             'R1', 42),
    ('select',   '候选选择',         'R2', 50),
    ('round',    '轮次处理',         'R2', 51),
    ('merge',    '候选合并',         'R2', 52),
    ('combine',  '候选合并',         'R2', 53),
    ('rank',     '排序',             'R2', 54),
    ('final',    '最终入选',         'Final', 60),
    ('top',      '最终入选',         'Final', 61),
    ('export',   '结果导出',         'Export', 70),
    ('download', '结果导出',         'Export', 71),
    ('package',  '结果打包',         'Export', 72),
]

STRUCT_EXT = {'.pdb', '.cif', '.cif.gz', '.bcif', '.ent'}
SCRIPT_EXT = {'.py', '.sh', '.bat', '.ps1', '.yaml', '.yml'}
TABLE_EXT = {'.csv', '.tsv', '.xlsx', '.json', '.fasta', '.fa', '.txt'}

# 目录名里出现这些词，说明它是"生成出来的结构堆"而不是"筛选步骤"。
# 必须在通用关键词之前判断，否则 self_select（字面像"选择"）会被误归成候选选择，
# 而它其实是 RFD3 的输出目录。
OUTPUT_DIR_WORDS = ('out', 'output', 'full_chain', 'chain', 'center', 'spot',
                     'model', 'cif', 'struct', 'design')

# 输入类文件：.pdb（非 cif.gz）、链定义 yaml —— 归到 R0 靶点准备
INPUT_EXT = {'.pdb', '.ent'}
CHAIN_YAML_WORDS = ('chain', 'no445', 'yaml')


def _kind(name):
    low = name.lower()
    for ext in ('.cif.gz', '.tar.gz', '.tgz'):
        if low.endswith(ext):
            return 'struct'
    ext = os.path.splitext(low)[1]
    if ext in STRUCT_EXT:
        return 'struct'
    if ext in SCRIPT_EXT:
        return 'script'
    if ext in TABLE_EXT:
        return 'table'
    return 'other'


def _match_keyword(name, is_dir=False):
    """按文件名/目录名猜它属于哪一步。返回 (标题, 轮次, 权重)，猜不出返回 None。

    is_dir=True 时优先识别"结构输出目录"，避免字面关键词误导。
    """
    low = name.lower()

    if is_dir:
        # 目录：先判断是不是结构输出堆
        if any(w in low for w in OUTPUT_DIR_WORDS):
            return ('RFD3 骨架输出', 'R1', 25)
        # 明确是筛选产物目录
        if 'final' in low or 'top' in low:
            return ('最终入选', 'Final', 60)
        if 'export' in low or 'package' in low:
            return ('结果导出', 'Export', 70)

    best = None
    for kw, title, rnd, weight in KEYWORDS:
        if kw in low:
            # 关键词越靠前、权重越小，越优先
            if best is None or weight < best[2]:
                best = (title, rnd, weight)
    return best


def _match_input_file(name):
    """判断一个松散文件是不是"输入/靶点准备"类。返回 True 表示归 R0。"""
    low = name.lower()
    ext = os.path.splitext(low)[1]
    if ext in INPUT_EXT:
        return True
    if ext in ('.yaml', '.yml'):
        return any(w in low for w in CHAIN_YAML_WORDS)
    return False


def _human(n):
    if n is None:
        return '—'
    if n < 1024:
        return '%d B' % n
    if n < 1024 ** 2:
        return '%.1f KB' % (n / 1024)
    if n < 1024 ** 3:
        return '%.1f MB' % (n / 1024 ** 2)
    return '%.1f GB' % (n / 1024 ** 3)


def _listdir(path, limit=MAX_ENTRIES):
    try:
        names = sorted(os.listdir(path))
    except Exception:
        return []
    out = []
    for nm in names:
        if nm.startswith('.'):
            continue
        out.append(nm)
        if len(out) >= limit:
            break
    return out


def scaffold_from_dir(root, name=None, pid=None):
    """扫描目录，产出一份管线定义草稿（纯内存，不落盘）。

    返回 dict: {definition, warnings, stats}
    """
    root = (root or '').strip()
    warnings = []
    stats = {'entries': 0, 'dirs': 0, 'files': 0, 'skipped': 0}

    if not root:
        raise ValueError('请先给出数据目录')
    if not os.path.isdir(root):
        raise FileNotFoundError('目录不存在: %s' % root)

    # 1) 目录清单
    dirs, loose = [], []
    for nm in _listdir(root):
        full = os.path.join(root, nm)
        try:
            isdir = os.path.isdir(full)
        except Exception:
            continue
        stats['entries'] += 1
        if isdir:
            dirs.append(nm)
            stats['dirs'] += 1
        else:
            loose.append(nm)
            stats['files'] += 1

    # 2) 松散文件按关键词归堆
    buckets = {}   # (title, round) -> {'files': [], 'weight': w}
    unmatched = []
    input_files = []
    for nm in loose:
        if _match_input_file(nm):
            input_files.append(nm)
            continue
        hit = _match_keyword(nm)
        if hit is None:
            unmatched.append(nm)
            continue
        title, rnd, weight = hit
        key = (title, rnd)
        b = buckets.setdefault(key, {'files': [], 'weight': weight})
        b['files'].append(nm)

    # 输入/靶点准备单独成组，放最前
    if input_files:
        buckets[('靶点与口袋准备', 'R0')] = {
            'files': input_files, 'weight': 10,
        }

    # 3) 子目录各成一步（除非名字命中了已有关键词，就并进去）
    dir_steps = []
    for nm in dirs:
        hit = _match_keyword(nm, is_dir=True)
        n_inside = len(_listdir(os.path.join(root, nm), 200))
        dir_steps.append((nm, hit, n_inside))

    steps = []
    seq = 0

    # 先放按关键词分组的松散文件
    for (title, rnd), b in sorted(buckets.items(), key=lambda kv: kv[1]['weight']):
        seq += 1
        steps.append({
            'id': 's%d' % seq,
            'tag': rnd,
            'round': rnd,
            'title': title,
            'desc': '【自动分组，待人工确认】\n按文件名关键词归类，非事实判定。\n请对照脚本补齐筛选条件与命令。',
            'cmd': 'TODO: 补这一步实际运行的命令',
            'files': [{'name': f, 'path': f} for f in sorted(b['files'])[:MAX_FILES_PER_STEP]],
            'globs': [],
            'state': 'wait',
        })

    # 再放子目录：命中已有分组的并入那一步（同名不再裂成两步），
    # 完全没命中的各自成一步
    step_index = {(s['title'], s['round']): s for s in steps}
    for nm, hit, n_inside in dir_steps:
        if len(steps) >= MAX_STEPS:
            stats['skipped'] += 1
            continue
        if hit:
            title, rnd, _w = hit
            key = (title, rnd)
            target = step_index.get(key)
            if target is not None:
                # 并入已有步骤：加 glob，不改它的 title
                target['globs'] = list(target.get('globs', [])) + ['%s/*' % nm]
                target['desc'] = target['desc'].replace(
                    '请对照脚本补齐筛选条件与命令。',
                    '请对照脚本补齐筛选条件与命令。\n含目录：%s' % nm)
                continue
        # 没命中：各自成一步
        seq += 1
        rnd = hit[1] if hit else ''
        title = hit[0] if hit else nm
        desc = '【自动分组，待人工确认】\n目录 %s\n共 %d 项。\n分组依据是目录名，不是流程语义。' % (nm, n_inside)
        if not hit:
            desc += '\n这个目录名没命中任何关键词，无法判断它属于哪一步。'
        st = {
            'id': 's%d' % seq,
            'tag': rnd or '?',
            'round': rnd,
            'title': title if hit else nm,
            'desc': desc,
            'cmd': 'TODO: 补这一步实际运行的命令',
            'files': [],
            'globs': ['%s/*' % nm],
            'dir': nm,
            'state': 'wait',
        }
        steps.append(st)
        if hit:
            step_index[(title, rnd)] = st

    if not steps:
        warnings.append('这个目录里没找到可分组的文件或子目录')

    if unmatched:
        warnings.append('%d 个文件没能按关键词归类，已跳过：%s' %
                        (len(unmatched), '、'.join(unmatched[:6]) +
                         ('…' if len(unmatched) > 6 else '')))

    warnings.append('草稿里的分组、顺序都是按文件名猜的；cmd 与阈值必须你自己对照脚本补齐')

    # 4) 落一个 id
    if not pid:
        base = os.path.basename(root.replace('\\', '/').rstrip('/')) or 'pipeline'
        base = re.sub(r'[^A-Za-z0-9_\-]', '_', base)[:40] or 'pipeline'
        pid = base
    if not re.fullmatch(r'[A-Za-z0-9_\-]{1,64}', pid):
        pid = 'imported'
    if not name:
        name = '自动生成 · %s' % (os.path.basename(root.replace('\\', '/').rstrip('/')) or root)

    definition = {
        'id': pid,
        'name': name,
        'target': '（待补：这是什么靶点/体系）',
        'root': root,
        'steps': steps,
    }
    return {'definition': definition, 'warnings': warnings, 'stats': stats}


def scaffold_to_json(root, name=None, pid=None, indent=2):
    """返回草稿的 JSON 文本（便于前端预览/下载）。"""
    res = scaffold_from_dir(root, name=name, pid=pid)
    return json.dumps(res['definition'], ensure_ascii=False, indent=indent), res


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print('用法: python scaffold_pipeline.py <目录> [id] [名称]')
        sys.exit(1)
    _root = sys.argv[1]
    _pid = sys.argv[2] if len(sys.argv) > 2 else None
    _name = sys.argv[3] if len(sys.argv) > 3 else None
    _txt, _res = scaffold_to_json(_root, name=_name, pid=_pid)
    print(_txt)
    print('\n--- 提醒 ---', file=sys.stderr)
    for _w in _res['warnings']:
        print(' ·', _w, file=sys.stderr)
