#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""StructBoard 设计管线后端：按「管线定义」扫描真实目录，补上事实数据。

设计取舍
--------
磁盘上的物理目录不等于筛选流程的一步，目录名也不一定包含轮次，
流程语义（生成 → MPNN → 折叠 → 选父本 → 重设计 → 最终）只散落在各个 .py 里。
所以把两件事拆开：

  定义（pipelines/<id>.json）  流程语义：步骤顺序、标题、筛选条件、命令、路径 glob
  扫描（本模块）              事实数据：每个步骤下真实有哪些文件、多少行、什么列

定义是人写的、机器不猜；扫描是机器做的、人不写。换项目时复制改一份 JSON 即可，
不用改代码。

只读原则
--------
本模块只读取用户指定根目录下的文件（统计行数/列名），不修改任何原始数据。
唯一写入的是便签文件 <root>/.pipeline_notes.json —— 那是用户自己写的备注，
写在自己的目录里，与原始数据隔离。
"""
import csv
import errno
import json
import math
import os
import re
import stat as stat_module
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from itertools import chain

if os.name == 'nt':
    import msvcrt
else:
    import fcntl

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

# 桌面后端用 STRUCTBOARD_PIPE_DIR 重定向；不设时用源码 pipelines/ 目录。
PIPE_DIR = os.environ.get('STRUCTBOARD_PIPE_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pipelines')
NOTES_NAME = '.pipeline_notes.json'
MAX_CSV_ROWS = 200000      # 超过这个行数就不数了，避免大文件拖慢响应
MAX_CSV_BYTES = 64 * 1024 * 1024
MAX_FILE_ITEMS = 60        # 每个步骤最多列多少个文件明细（真实数量另计）
MAX_CSV_FACTS = 8          # 每个步骤最多统计几个 CSV 的行数/列名

STRUCTURE_RE = re.compile(r'\.(pdb|ent|cif|mmcif|mcif|bcif)(\.gz)?$', re.I)
MODEL_RE = re.compile(r'(.*)_model_(\d+)((?:\.(?:pdb|ent|cif|mmcif|mcif|bcif))(?:\.gz)?)$', re.I)
MAX_STRUCTURE_BYTES = 128 * 1024 * 1024
MAX_STEP_BYTES = 2 * 1024 * 1024 * 1024

LINEAGE_STRING_FIELDS = (
    'parentId', 'parentName', 'candidateId', 'candidateName',
    'runId', 'referencePath', 'referenceStepId', 'assessmentSource',
)
LINEAGE_ENUM_VALUES = {
    'parentRole': frozenset(('main', 'extra_control')),
    'role': frozenset(('candidate', 'variant', 'parent', 'parent_control', 'reference')),
    'artifactKind': frozenset(('design', 'mpnn_backbone', 'prediction', 'aligned', 'reference', 'preview')),
}
ARTIFACT_KINDS = LINEAGE_ENUM_VALUES['artifactKind']
LINEAGE_INT_FIELDS = frozenset(('modelIndex', 'variantIndex'))
LINEAGE_NUMBER_FIELDS = frozenset(('temperature', 'poseRmsd'))
LINEAGE_BOOL_FIELDS = frozenset(('posePass', 'geometryPass'))
LINEAGE_FIELDS = (frozenset(LINEAGE_STRING_FIELDS) | frozenset(LINEAGE_ENUM_VALUES) |
                  LINEAGE_INT_FIELDS | LINEAGE_NUMBER_FIELDS | LINEAGE_BOOL_FIELDS)


# ---------------------------------------------------------------- 工具函数

def list_pipelines():
    """列出所有可用管线定义（只读 pipelines/ 目录）。"""
    out = []
    if not os.path.isdir(PIPE_DIR):
        return out
    for name in sorted(os.listdir(PIPE_DIR)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(PIPE_DIR, name)
        try:
            with open(path, encoding='utf-8') as fh:
                defn = json.load(fh)
        except Exception as exc:
            out.append({'id': name[:-5], 'name': name[:-5], 'error': str(exc)})
            continue
        out.append({
            'id': defn.get('id', name[:-5]),
            'name': defn.get('name', name[:-5]),
            'target': defn.get('target', ''),
            'root': defn.get('root', ''),
            'rootExists': os.path.isdir(defn.get('root', '')),
            'steps': len(defn.get('steps', [])),
        })
    return out


def load_definition(pid):
    """按 id 读取管线定义。id 允许省略 .json 后缀。"""
    if not pid:
        raise ValueError('缺少管线 id')
    if not re.fullmatch(r'[A-Za-z0-9_\-]{1,64}', pid):
        raise ValueError('管线 id 非法: %r' % pid)
    path = os.path.join(PIPE_DIR, pid + '.json')
    if not os.path.isfile(path):
        raise FileNotFoundError('没有这条管线定义: %s' % pid)
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


# ---------------------------------------------------------------- 定义校验

ID_RE = re.compile(r'[A-Za-z0-9_\-]{1,64}')


def _is_nonnegative_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_nonnegative_finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return False
    return math.isfinite(number) and number >= 0


def _is_plain_scalar(value):
    if value is None or isinstance(value, (str, bool, int)):
        return True
    return isinstance(value, float) and math.isfinite(value)


def _valid_reference_path(value, root):
    """referencePath 必须是 root 内的相对路径；safe_join 之前先拒绝绝对写法。"""
    if not isinstance(value, str):
        return False
    norm = value.strip().replace('\\', '/')
    if not norm or norm.startswith('/') or re.match(r'^[A-Za-z]:', norm):
        return False
    if '..' in norm.split('/'):
        return False
    return safe_join(root, norm) is not None if root else True


def _normalize_lineage(raw, root=None, label='lineage'):
    """清洗 lineage，返回 (clean, errors)。

    已知字段按白名单校验；未知字段只接受简单标量，不递归透传对象/数组。
    """
    if raw is None:
        return {}, []
    if not isinstance(raw, dict):
        return {}, ['%s 必须是对象' % label]
    clean, errors = {}, []
    for key, value in raw.items():
        if not isinstance(key, str):
            errors.append('%s 的字段名必须是字符串' % label)
            continue
        if key in LINEAGE_STRING_FIELDS:
            if not isinstance(value, str):
                errors.append('%s.%s 必须是字符串' % (label, key))
                continue
            text = value.strip()
            if key == 'referencePath' and not _valid_reference_path(text, root):
                errors.append('%s.%s 必须是 root 内的相对路径' % (label, key))
                continue
            clean[key] = text
        elif key in LINEAGE_ENUM_VALUES:
            allowed = LINEAGE_ENUM_VALUES[key]
            if not isinstance(value, str) or value not in allowed:
                errors.append('%s.%s 必须是 %s 之一' % (label, key, '/'.join(sorted(allowed))))
                continue
            clean[key] = value
        elif key in LINEAGE_INT_FIELDS:
            if not _is_nonnegative_int(value):
                errors.append('%s.%s 必须是非负整数' % (label, key))
                continue
            clean[key] = value
        elif key in LINEAGE_NUMBER_FIELDS:
            if not _is_nonnegative_finite(value):
                errors.append('%s.%s 必须是非负有限数' % (label, key))
                continue
            clean[key] = value
        elif key in LINEAGE_BOOL_FIELDS:
            if not isinstance(value, bool):
                errors.append('%s.%s 必须是布尔值' % (label, key))
                continue
            clean[key] = value
        elif not _is_plain_scalar(value):
            errors.append('%s.%s 只允许简单标量，不能是嵌套对象' % (label, key))
        else:
            clean[key] = value
    return clean, errors


def _lineage_errors(value, root, label):
    if value is None:
        return ['%s 必须是对象' % label]
    return _normalize_lineage(value, root, label)[1]


def _merge_lineage(step_lineage, file_lineage):
    """步骤 lineage 是默认值，文件 lineage 覆盖同名字段。"""
    merged = dict(step_lineage or {})
    merged.update(file_lineage or {})
    return merged


def summarize_structures(items):
    """纯内存汇总完整结构集合；不读盘、不修改 items。"""
    items = list(items or [])
    candidate_ids, parent_ids = set(), set()
    variant_ids, control_ids = set(), set()
    counts = {
        'files': len(items), 'candidates': 0, 'parents': 0,
        'variants': 0, 'controls': 0, 'models': 0,
        'backbones': 0, 'previews': 0, 'references': 0,
        'designs': 0, 'known': True, 'identifiedFiles': 0,
    }
    identified = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        lineage, lineage_errors = _normalize_lineage(item.get('lineage'), None)
        artifact = lineage.get('artifactKind')
        role = lineage.get('role')
        candidate_id = lineage.get('candidateId')
        parent_id = lineage.get('parentId')
        candidate_id = candidate_id.strip() if isinstance(candidate_id, str) else ''
        parent_id = parent_id.strip() if isinstance(parent_id, str) else ''

        if candidate_id:
            candidate_ids.add(candidate_id)
        if parent_id:
            parent_ids.add(parent_id)
        if role == 'variant' and candidate_id:
            variant_ids.add(candidate_id)
        if role == 'parent_control' and candidate_id:
            control_ids.add(candidate_id)

        if artifact == 'prediction':
            counts['models'] += 1
        elif artifact == 'mpnn_backbone':
            counts['backbones'] += 1
        elif artifact == 'preview':
            counts['previews'] += 1
        elif artifact == 'reference':
            counts['references'] += 1
        elif artifact == 'design':
            counts['designs'] += 1

        sufficient = artifact in ARTIFACT_KINDS and (artifact == 'reference' or bool(candidate_id))
        if lineage_errors:
            sufficient = False
        if item.get('groupingWarning'):
            sufficient = False
        if role in ('candidate', 'variant', 'parent_control') and not candidate_id:
            sufficient = False
        if role == 'parent' and not parent_id:
            sufficient = False
        if sufficient:
            identified += 1

    counts['candidates'] = len(candidate_ids)
    counts['parents'] = len(parent_ids)
    counts['variants'] = len(variant_ids)
    counts['controls'] = len(control_ids)
    counts['identifiedFiles'] = identified
    counts['known'] = identified == len(items)
    return counts


def _parse_group_by(value):
    """返回 (mode, depth)。mode: default/none/parent/candidate/dir。"""
    if value is None:
        return 'default', None
    if not isinstance(value, str):
        return 'default', None
    text = value.strip()
    if not text:
        return 'default', None
    if text == 'none':
        return 'none', None
    if text in ('parent', 'candidate'):
        return text, None
    if text.startswith('dir:'):
        try:
            depth = max(1, int(text.split(':', 1)[1].strip()))
        except (TypeError, ValueError):
            depth = None
        return 'dir', depth
    return 'default', None


def _structure_metadata(rel, pipeline_id, sid, group_mode, group_depth, step_lineage, file_lineage):
    """生成结构文件的来源/分组元数据；显示名与隔离 key 分离。"""
    lineage = _merge_lineage(step_lineage, file_lineage)
    base = rel.rsplit('/', 1)[-1]
    dir_prefix = rel.rsplit('/', 1)[0] if '/' in rel else ''
    segments = dir_prefix.split('/') if dir_prefix else []

    explicit_model = lineage.get('modelIndex')
    model_index = explicit_model if _is_nonnegative_int(explicit_model) else None
    artifact = lineage.get('artifactKind')
    group = group_kind = group_key = warning = None

    # 旧 _model_N 推断只用于未指定 groupBy 或 dir:N 的预测/无语义旧文件；
    # parent/candidate/none 以及明确的非预测骨架都不从文件名猜分组。
    allow_inference = group_mode not in ('none', 'parent', 'candidate')
    if allow_inference and artifact in (None, '', 'prediction'):
        match = MODEL_RE.fullmatch(base)
        if match:
            sequence_label = match.group(1)
            if model_index is None:
                model_index = int(match.group(2))
            group = sequence_label
            group_kind = 'directory'
            group_key = '%s|%s|model|%s|%s' % (pipeline_id, sid, dir_prefix, sequence_label)

    if group_mode == 'parent':
        parent_id = lineage.get('parentId')
        if isinstance(parent_id, str) and parent_id.strip():
            group = lineage.get('parentName') or parent_id
            group_kind = 'parent'
            group_key = '%s|%s|parent|%s' % (pipeline_id, sid, parent_id)
        else:
            group = group_kind = group_key = None
            warning = 'groupBy=parent 缺少 parentId，未分组'
    elif group_mode == 'candidate':
        candidate_id = lineage.get('candidateId')
        if isinstance(candidate_id, str) and candidate_id.strip():
            group = lineage.get('candidateName') or candidate_id
            group_kind = 'candidate'
            group_key = '%s|%s|candidate|%s' % (pipeline_id, sid, candidate_id)
        else:
            group = group_kind = group_key = None
            warning = 'groupBy=candidate 缺少 candidateId，未分组'
    elif group_mode == 'dir' and group_depth and group is None:
        if len(segments) >= group_depth:
            display = segments[-group_depth]
            group = display
            group_kind = 'directory'
            ancestor = '/'.join(segments[:len(segments) - group_depth + 1])
            group_key = '%s|%s|dir:%d|%s' % (pipeline_id, sid, group_depth, ancestor)
    elif group_mode == 'none':
        group = group_kind = group_key = None

    return {
        'lineage': lineage,
        'group': group,
        'groupKind': group_kind,
        'groupKey': group_key,
        'groupingWarning': warning or '',
        'modelIndex': model_index,
    }


def _explicit_files(step):
    """返回显式文件的有序路径与 path->定义 映射。"""
    order, mapping = [], {}
    for f in step.get('files') or []:
        if not isinstance(f, dict):
            continue
        raw = f.get('path') or f.get('name') or ''
        rel = str(raw).replace('\\', '/')
        if not rel:
            continue
        if rel not in mapping:
            order.append(rel)
        mapping[rel] = f
    return order, mapping


def _explicit_lineages(mapping, root):
    out = {}
    for rel, f in mapping.items():
        if 'lineage' in f:
            out[rel] = _normalize_lineage(f['lineage'], root)[0]
    return out


def _organization_errors(data, step_index):
    """工作台收纳只影响显示，不改变 files / lineage。"""
    label = '第 %d 步 organization' % (step_index + 1)
    if not isinstance(data, dict):
        return ['%s 必须是对象' % label]
    errors = []
    folders = data.get('folders')
    folder_ids = set()
    if 'folders' in data and not isinstance(folders, list):
        errors.append('%s.folders 必须是数组' % label)
        folders = []
    for index, folder in enumerate(folders or []):
        if (not isinstance(folder, dict) or not isinstance(folder.get('id'), str) or
                not isinstance(folder.get('name'), str)):
            errors.append('%s.folders[%d] 必须含 id/name 字符串' % (label, index))
            continue
        folder_id = folder['id']
        if not folder_id:
            errors.append('%s.folders[%d].id 不能为空' % (label, index))
        elif folder_id in folder_ids:
            errors.append('%s.folders[%d].id 重复: %r' % (label, index, folder_id))
        else:
            folder_ids.add(folder_id)
    parent_by_id = {}
    for index, folder in enumerate(folders or []):
        if not isinstance(folder, dict) or not isinstance(folder.get('id'), str) or not folder.get('id'):
            continue
        parent = folder.get('parentId')
        if parent is None or parent == '' or parent == 'root':
            parent = None
        elif not isinstance(parent, str):
            errors.append('%s.folders[%d].parentId 必须是字符串或 null' % (label, index))
            continue
        elif parent.startswith('lineage:'):
            parent_by_id[folder['id']] = None
            continue
        elif parent not in folder_ids:
            errors.append('%s.folders[%d].parentId 引用不存在的文件夹: %r' % (label, index, parent))
            continue
        parent_by_id[folder['id']] = parent
    for folder_id in folder_ids:
        seen = set()
        current = folder_id
        while current in parent_by_id and parent_by_id[current] is not None:
            if current in seen:
                errors.append('%s.folders 存在循环父级引用: %r' % (label, folder_id))
                break
            seen.add(current)
            current = parent_by_id[current]
    if 'dissolved' in data and not isinstance(data.get('dissolved'), list):
        errors.append('%s.dissolved 必须是数组' % label)
    if 'placements' in data and not isinstance(data.get('placements'), (list, dict)):
        errors.append('%s.placements 必须是数组或对象' % label)
    if 'removed' in data and not isinstance(data.get('removed'), list):
        errors.append('%s.removed 必须是数组' % label)
    if 'notes' in data and data.get('notes') is not None and not isinstance(data.get('notes'), dict):
        errors.append('%s.notes 必须是对象' % label)
    if 'layout' in data and data.get('layout') is not None:
        layout = data.get('layout')
        if not isinstance(layout, dict) or not isinstance(layout.get('parents', {}), dict):
            errors.append('%s.layout 必须是对象（parents 为对象）' % label)
        else:
            for parent_key, rec in layout.get('parents', {}).items():
                if not isinstance(parent_key, str) or not parent_key or not isinstance(rec, dict) or not isinstance(rec.get('slots'), list):
                    errors.append('%s.layout.parents 键必须是非空字符串且含 slots 数组' % label)
                    continue
                seen_refs, seen_slots = set(), set()
                broken = False
                for row in rec['slots']:
                    if broken:
                        break
                    if not isinstance(row, dict) or not isinstance(row.get('ref'), str) or not row['ref']:
                        errors.append('%s.layout.parents[%r].slots 项必须含 ref 字符串' % (label, parent_key))
                        continue
                    slot = row.get('slot')
                    if not isinstance(slot, int) or isinstance(slot, bool) or slot < 0 or slot > 100000:
                        errors.append('%s.layout.parents[%r].slots.slot 必须是 0..100000 的整数' % (label, parent_key))
                        continue
                    if row['ref'] in seen_refs or slot in seen_slots:
                        errors.append('%s.layout.parents[%r] 存在重复 ref 或 slot' % (label, parent_key))
                        broken = True
                        continue
                    seen_refs.add(row['ref'])
                    seen_slots.add(slot)
    return errors


def _is_unsafe_rel(rel):
    return (os.path.isabs(rel) or bool(re.match(r'^[A-Za-z]:', rel)) or
            '..' in rel.split('/'))


def _iter_structure_rels(explicit_paths, structure_rels, root):
    """合并显式文件与一次扫描得到的结构路径；只产出 root 内结构文件。"""
    structure_set = set(structure_rels)
    seen = set()
    for raw in chain(explicit_paths, structure_rels):
        rel = str(raw or '').replace('\\', '/')
        if not rel or rel in seen:
            continue
        seen.add(rel)
        if not STRUCTURE_RE.search(rel) or _is_unsafe_rel(rel):
            continue
        if rel in structure_set:
            yield rel
            continue
        full = safe_join(root, rel)
        if full and os.path.isfile(full):
            yield rel


def _source_keys(pipeline_id, sid, real_root, rel, file_stat=None):
    if file_stat is None:
        file_key = '%s|%s' % (real_root, rel)
    else:
        file_key = '%s|%s|%d|%d' % (real_root, rel, file_stat.st_size, file_stat.st_mtime_ns)
    return file_key, '%s|%s|%s' % (pipeline_id, sid, file_key)


def _operation_text(step):
    value = step.get('operation', '')
    return value if isinstance(value, str) else ('' if value is None else str(value))


def _tool_text(step):
    value = step.get('tool', '')
    text = value if isinstance(value, str) else ('' if value is None else str(value))
    return text[:18]


def _compile_glob(pattern):
    rx = re.escape(pattern.replace('\\', '/')).replace(r'\*\*', '\x00').replace(r'\*', '[^/]*')
    return re.compile(rx.replace('\x00', '.*'))


def validate_definition(defn, filename=None, cancel=None):
    """校验一份管线定义。返回 (ok, errors, warnings)。

    errors 会阻止导入；warnings 只是提醒（比如 root 目录不存在）。
    """
    errors = []
    warnings = []
    if not isinstance(defn, dict):
        return False, ['定义必须是 JSON 对象'], warnings

    for key in ('id', 'name', 'root'):
        if not isinstance(defn.get(key, ''), str):
            errors.append('%s 必须是字符串' % key)
    if errors:
        return False, errors, warnings
    pid = defn.get('id', '')
    if not pid:
        errors.append('缺少 id')
    elif not ID_RE.fullmatch(str(pid)):
        errors.append('id 非法（只允许字母数字 _ -，最长 64）: %r' % pid)
    elif filename and str(pid) != filename:
        errors.append('id 与文件名不一致: id=%r file=%r' % (pid, filename))

    if not (defn.get('name') or '').strip():
        errors.append('缺少 name')

    root = (defn.get('root') or '').strip()
    if not root:
        errors.append('缺少 root')
    else:
        norm = root.replace('\\', '/')
        if not (re.match(r'^[A-Za-z]:/', norm) or norm.startswith('/')):
            errors.append('root 必须是绝对路径: %r' % root)
        elif not os.path.isdir(root):
            warnings.append('root 目录当前不存在: %s' % root)

    steps = defn.get('steps')
    if not isinstance(steps, list) or not steps:
        errors.append('steps 必须是非空数组')
        return False, errors, warnings

    seen = set()
    for i, st in enumerate(steps):
        _check_cancel(cancel)
        if not isinstance(st, dict):
            errors.append('第 %d 步不是对象' % (i + 1))
            continue
        if any(not isinstance(st.get(k, ''), str) for k in ('id', 'title', 'dir')):
            errors.append('第 %d 步的 id/title/dir 必须是字符串' % (i + 1))
            continue
        if any(k in st and not isinstance(st[k], list) for k in ('files', 'globs', 'starGlobs')):
            errors.append('第 %d 步的 files/globs/starGlobs 必须是数组' % (i + 1))
            continue
        if 'star' in st and not isinstance(st['star'], bool):
            errors.append('第 %d 步的 star 必须是 true 或 false' % (i + 1))
        if 'groupBy' in st and st['groupBy'] is not None and not isinstance(st['groupBy'], str):
            errors.append('第 %d 步的 groupBy 必须是字符串' % (i + 1))
        if 'organization' in st and st['organization'] is not None:
            errors.extend(_organization_errors(st['organization'], i))
        if 'lineage' in st:
            errors.extend(_lineage_errors(st['lineage'], root, '第 %d 步 lineage' % (i + 1)))
        sid = str(st.get('id', '')).strip()
        if not sid:
            errors.append('第 %d 步缺少 id' % (i + 1))
        elif not ID_RE.fullmatch(sid):
            errors.append('第 %d 步 id 非法: %r' % (i + 1, sid))
        elif sid in seen:
            errors.append('步骤 id 重复: %r' % sid)
        else:
            seen.add(sid)
        if not (st.get('title') or '').strip():
            errors.append('第 %d 步缺少 title' % (i + 1))
        state = st.get('state', 'done')
        if state not in ('done', 'now', 'wait'):
            errors.append('第 %d 步 state 只能是 done/now/wait: %r' % (i + 1, state))
        for j, f in enumerate(st.get('files', []) or []):
            if j % 1024 == 0:
                _check_cancel(cancel)
            if not isinstance(f, dict):
                errors.append('第 %d 步 files[%d] 不是对象' % (i + 1, j))
                continue
            if any(not isinstance(f.get(k, ''), str) for k in ('name', 'path')):
                errors.append('第 %d 步 files[%d] 的 name/path 必须是字符串' % (i + 1, j))
                continue
            if 'star' in f and not isinstance(f['star'], bool):
                errors.append('第 %d 步 files[%d] 的 star 必须是 true 或 false' % (i + 1, j))
                continue
            if 'lineage' in f:
                errors.extend(_lineage_errors(
                    f['lineage'], root, '第 %d 步 files[%d].lineage' % (i + 1, j)))
            name = (f.get('name') or '').strip()
            path = (f.get('path') or name).strip()
            if not name and not path:
                errors.append('第 %d 步 files[%d] 缺少 name/path' % (i + 1, j))
                continue
            if root and path:
                if safe_join(root, path) is None:
                    errors.append('第 %d 步的文件路径越出 root: %r' % (i + 1, path))
        for field in ('globs', 'starGlobs'):
            for g in st.get(field, []) or []:
                if not isinstance(g, str) or not g.strip():
                    errors.append('第 %d 步的 %s 非法' % (i + 1, field))
                    continue
                if root and safe_join(root, g.split('*')[0] or g) is None:
                    errors.append('第 %d 步的 %s 越出 root: %r' % (i + 1, field, g))

    return (not errors), errors, warnings


def import_definition(defn, overwrite=False):
    """校验并保存一份管线定义。返回 (ok, message, pid)。"""
    pid_value = defn.get('id', '') if isinstance(defn, dict) else ''
    pid = pid_value.strip() if isinstance(pid_value, str) else ''
    if pid and not ID_RE.fullmatch(pid):
        return False, 'id 非法: %r' % pid, None
    ok, errors, warnings = validate_definition(defn, filename=pid or None)
    if not ok:
        return False, '; '.join(errors), pid

    os.makedirs(PIPE_DIR, exist_ok=True)
    path = os.path.join(PIPE_DIR, pid + '.json')
    if os.path.exists(path) and not overwrite:
        return False, '已存在同名管线 %s（要覆盖请勾选 overwrite）' % pid, pid

    import tempfile
    descriptor, tmp = tempfile.mkstemp(prefix=pid + '-', suffix='.tmp', dir=PIPE_DIR)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as fh:
            json.dump(defn, fh, ensure_ascii=False, indent=2)
        if overwrite:
            os.replace(tmp, path)
        else:
            # 原子创建且不覆盖，避免并发导入越过同名保护。
            os.link(tmp, path)
            os.unlink(tmp)
    except FileExistsError:
        if os.path.exists(tmp):
            os.unlink(tmp)
        return False, '已存在同名管线 %s（要覆盖请勾选 overwrite）' % pid, pid
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    msg = '已保存 %s' % path
    if warnings:
        msg += '（提醒：%s）' % '；'.join(warnings)
    return True, msg, pid


def archive_definition(pid):
    """停用一条管线定义：重命名为 <id>.json.bak（可恢复，不真删）。

    不用 os.remove 的原因：真删除在本机会被安全删除守卫按"本轮批量操作"拦下，
    而服务端没法弹确认框。归档是可恢复的等效操作，且只动 pipelines/ 下的一个文件。
    """
    if not pid or not ID_RE.fullmatch(pid):
        raise ValueError('管线 id 非法: %r' % pid)
    path = os.path.join(PIPE_DIR, pid + '.json')
    if not os.path.isfile(path):
        raise FileNotFoundError('没有这条管线定义: %s' % pid)
    bak = path + '.bak'
    # 已存在的 .bak 用带时间戳的新名覆盖，避免真删除触发安全守卫
    if os.path.exists(bak):
        bak = path + '.%s.bak' % datetime.now().strftime('%Y%m%d%H%M%S')
    os.replace(path, bak)
    return bak


def safe_join(root, rel):
    """把定义里的相对路径拼到 root 下，并确保不越出 root。"""
    if not rel:
        return None
    rel = rel.replace('\\', '/').lstrip('/')
    target = os.path.normpath(os.path.join(root, rel))
    root_n = os.path.normpath(root)
    if not (target == root_n or target.startswith(root_n + os.sep)):
        return None
    return target


def _match(rel_path, pattern):
    """按 glob 匹配相对路径。** 跨目录，* 不跨目录。"""
    return _compile_glob(pattern).fullmatch(rel_path) is not None


def _check_cancel(cancel):
    if cancel is not None and cancel.is_set():
        raise InterruptedError('导入已取消')


def collect_files(root, globs, progress=None, cancel=None):
    """只遍历 glob 固定前缀覆盖的目录；空规则不扫描。"""
    if not globs or not os.path.isdir(root):
        return []
    patterns = [_compile_glob(g) for g in globs]
    starts = {}
    for g in globs:
        normalized = g.replace('\\', '/')
        prefix = normalized.split('*')[0]
        base = prefix.rsplit('/', 1)[0] if '/' in prefix else ''
        start = safe_join(root, base) if base else os.path.normpath(root)
        tail = normalized[len(base) + 1:] if base else normalized
        depth = None if '**' in tail else tail.count('/')
        if start and os.path.isdir(start):
            old = starts.get(start, -1)
            starts[start] = None if old is None or depth is None else max(old, depth)
    roots = []
    for start, depth in sorted(starts.items(), key=lambda item: len(item[0])):
        covered = False
        for parent, parent_depth in roots:
            if start == parent or start.startswith(parent + os.sep):
                distance = len(os.path.relpath(start, parent).split(os.sep)) if start != parent else 0
                if parent_depth is None or (depth is not None and parent_depth >= distance + depth):
                    covered = True
                    break
        if not covered:
            roots.append((start, depth))
    hits, scanned = set(), 0
    for start, max_depth in roots:
        for dirpath, dirnames, filenames in os.walk(start):
            _check_cancel(cancel)
            depth = 0 if dirpath == start else len(os.path.relpath(dirpath, start).split(os.sep))
            dirnames[:] = ([] if max_depth is not None and depth >= max_depth else
                           [d for d in dirnames if not d.startswith('.')])
            for fn in filenames:
                scanned += 1
                if scanned % 512 == 0:
                    _check_cancel(cancel)
                    if progress:
                        progress(scanned)
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace('\\', '/')
                if any(rx.fullmatch(rel) for rx in patterns):
                    hits.add(rel)
    _check_cancel(cancel)
    return sorted(hits)


def csv_facts(path, cancel=None):
    """流式统计 CSV，不把整份文件读入内存。"""
    info = {'rows': None, 'cols': [], 'size': None, 'rowsTruncated': False}
    try:
        info['size'] = os.path.getsize(path)
        if info['size'] > MAX_CSV_BYTES:
            return info
        for enc in ('utf-8-sig', 'latin-1'):
            try:
                with open(path, encoding=enc, newline='') as fh:
                    reader = csv.reader(fh)
                    header = next(reader, None)
                    if header is None:
                        return info
                    info['cols'] = [c.strip() for c in header]
                    n = 0
                    for _ in reader:
                        n += 1
                        if n % 1024 == 0:
                            _check_cancel(cancel)
                        if n > MAX_CSV_ROWS:
                            info['rowsTruncated'] = True
                            n = MAX_CSV_ROWS
                            break
                    info['rows'] = n
                    return info
            except UnicodeDecodeError:
                continue
    except InterruptedError:
        raise
    except (OSError, csv.Error):
        pass
    return info


def human_size(n):
    if n is None:
        return '—'
    if n < 1024:
        return '%d B' % n
    if n < 1024 * 1024:
        return '%.1f KB' % (n / 1024)
    if n < 1024 ** 3:
        return '%.1f MB' % (n / 1024 ** 2)
    return '%.1f GB' % (n / 1024 ** 3)


# ---------------------------------------------------------------- 步骤结构读取（仅允许定义关联的文件）

def _structure_step(pid, sid):
    defn = load_definition(pid)
    root = defn.get('root', '')
    if not os.path.isdir(root):
        raise FileNotFoundError('根目录不存在: %s' % root)
    for i, step in enumerate(defn.get('steps', [])):
        if step.get('id', 's%d' % i) == sid:
            return defn, root, step
    raise FileNotFoundError('没有这个管线步骤: %s' % sid)


def _step_patterns(step):
    raw_globs = step.get('globs') or []
    patterns = [g.replace('\\', '/') for g in raw_globs if isinstance(g, str) and g.strip()]
    # 有明确 glob 时以它为准；只有 dir 的节点才读取该目录下的结构。
    if not patterns and step.get('dir'):
        directory = str(step['dir']).replace('\\', '/').rstrip('/')
        if directory:
            patterns = [directory + '/*', directory + '/**/*']
    return patterns


def resolve_structure(pid, sid, rel):
    """逐次验证归属与真实路径，拒绝遍历、符号链接越界和非结构文件。"""
    _, root, step = _structure_step(pid, sid)
    rel = rel.replace('\\', '/')
    if not STRUCTURE_RE.search(rel) or _is_unsafe_rel(rel):
        raise ValueError('结构文件路径不合法')
    explicit, _ = _explicit_files(step)
    if rel not in explicit and not any(_match(rel, g) for g in _step_patterns(step)):
        raise ValueError('文件不属于这个管线步骤')
    full = safe_join(root, rel)
    real_root = os.path.normcase(os.path.realpath(root))
    real_file = os.path.normcase(os.path.realpath(full)) if full else ''
    if not real_file or os.path.commonpath([real_root, real_file]) != real_root:
        raise ValueError('结构文件越出管线根目录')
    if not os.path.isfile(full):
        raise FileNotFoundError('结构文件不存在: %s' % rel)
    if os.path.getsize(full) > MAX_STRUCTURE_BYTES:
        raise ValueError('单个结构超过 128 MB: %s' % rel)
    return full


def step_structures(pid, sid):
    """完整结构清单，不受画布明细 60 条 / 抽屉 8 条的限制。"""
    defn, root, step = _structure_step(pid, sid)
    pipeline_id = defn.get('id', pid) or pid
    explicit_order, explicit_map = _explicit_files(step)
    step_lineage, _ = _normalize_lineage(step.get('lineage'), root)
    explicit_lineages = _explicit_lineages(explicit_map, root)
    patterns = _step_patterns(step)
    structure_rels = collect_files(root, patterns) if patterns else []
    star_globs = [g for g in (step.get('starGlobs') or []) if isinstance(g, str)]
    star_matchers = [_compile_glob(g) for g in star_globs]
    group_mode, group_depth = _parse_group_by(step.get('groupBy'))
    real_root = os.path.normcase(os.path.realpath(root))

    files, items, warnings = [], [], []
    total = 0
    for rel in _iter_structure_rels(explicit_order, structure_rels, root):
        full = safe_join(root, rel)
        if not full:
            continue
        try:
            file_stat = os.stat(full)
        except OSError:
            continue
        if not stat_module.S_ISREG(file_stat.st_mode):
            continue
        if file_stat.st_size > MAX_STRUCTURE_BYTES:
            continue
        total += file_stat.st_size

        explicit = explicit_map.get(rel)
        explicit_star = explicit is not None and 'star' in explicit
        star = bool(explicit.get('star')) if explicit_star else bool((explicit or {}).get('star', step.get('star', False)))
        if not explicit_star and star_matchers and any(rx.fullmatch(rel) for rx in star_matchers):
            star = True

        meta = _structure_metadata(rel, pipeline_id, sid, group_mode, group_depth,
                                   step_lineage, explicit_lineages.get(rel))
        file_key, source_key = _source_keys(pipeline_id, sid, real_root, rel, file_stat)
        name = str(explicit.get('name') or '') if explicit is not None else ''
        item = {
            'name': name or os.path.basename(rel),
            'path': rel,
            'fullPath': full.replace('\\', '/'),
            'size': file_stat.st_size,
            'star': star,
            'fileKey': file_key,
            'sourceKey': source_key,
        }
        item.update(meta)
        files.append(item)
        items.append(item)
        if meta['groupingWarning'] and meta['groupingWarning'] not in warnings:
            warnings.append(meta['groupingWarning'])

    counts = summarize_structures(items)
    warning = ''
    if total > MAX_STEP_BYTES:
        warning = '这一步超过 2 GB，结构按需读取，不会一次全部载入'
    return {
        'id': pipeline_id,
        'stepId': sid,
        'name': defn.get('name', pid),
        'title': step.get('title', sid),
        'operation': _operation_text(step),
        'tool': _tool_text(step),
        'state': step.get('state', 'done'),
        'desc': step.get('desc', ''),
        'files': files,
        'totalBytes': total,
        'warning': warning,
        'groupingWarning': '；'.join(warnings),
        'counts': counts,
    }


# ---------------------------------------------------------------- 便签落盘

_NOTES_LOCKS = {}
_NOTES_LOCKS_GUARD = threading.Lock()


def notes_path(root):
    return os.path.join(root, NOTES_NAME)


@contextmanager
def _notes_lock(root):
    """同一真实 root 的线程/进程共用锁；sidecar 不删除，以免替换锁文件造成分叉。"""
    if not os.path.isdir(root):
        raise FileNotFoundError('根目录不存在: %s' % root)
    real_root = os.path.normcase(os.path.realpath(root))
    with _NOTES_LOCKS_GUARD:
        lock = _NOTES_LOCKS.setdefault(real_root, threading.Lock())
    with lock:
        # 锁独立于被 os.replace 的 JSON 文件；Windows 允许锁住空文件的第一个字节。
        with open(notes_path(real_root) + '.lock', 'a+b') as fh:
            if os.name == 'nt':
                deadline = time.monotonic() + 30
                while True:
                    try:
                        fh.seek(0)
                        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as exc:
                        if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                            raise
                        if time.monotonic() >= deadline:
                            raise TimeoutError('等待便签文件锁超时: %s' % root) from exc
                        time.sleep(.01)
            else:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == 'nt':
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _read_notes_unlocked(root):
    try:
        with open(notes_path(root), encoding='utf-8') as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError('磁盘便签数据必须是对象')
    return data


def read_notes(root):
    """缺少文件时返回 {}；JSON 损坏、非对象或读取失败必须向调用方报错。"""
    if not os.path.isdir(root):
        return {}
    # 读取也参与锁，避免 Windows 上打开的读句柄阻止另一个进程 os.replace。
    with _notes_lock(root):
        return _read_notes_unlocked(root)


def _write_notes_unlocked(root, data):
    requested_path = notes_path(root)
    # The lock already uses the canonical root. Use the same path for replace:
    # aliases containing '..' should not reach Windows' atomic rename operation.
    canonical_root = os.path.realpath(root)
    path = notes_path(canonical_root)
    descriptor, tmp = tempfile.mkstemp(prefix=NOTES_NAME + '-', suffix='.tmp', dir=canonical_root)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2, allow_nan=False)
            fh.flush()
            os.fsync(fh.fileno())
        for attempt in range(6):
            try:
                os.replace(tmp, path)
                break
            except OSError as error:
                # A non-cooperating reader may briefly retain a Windows handle.
                # Keep the same flushed temporary file and the per-root lock;
                # never remove the original to make the replacement succeed.
                if os.name != 'nt' or getattr(error, 'winerror', None) not in (5, 32, 33) or attempt == 5:
                    raise
                time.sleep(.02 * (2 ** attempt))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return requested_path


def write_notes(root, data):
    """全量替换并返回便签路径；与 patch 共用锁，拒绝覆盖损坏的原文件。"""
    if not isinstance(data, dict):
        raise ValueError('便签数据必须是对象')
    with _notes_lock(root):
        _read_notes_unlocked(root)
        return _write_notes_unlocked(root, data)


def patch_notes(root, patch):
    """按顶层键合并，空字符串保留；返回 (path, merged_notes)。"""
    if not isinstance(patch, dict):
        raise ValueError('patch 必须是对象')
    for key, value in patch.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError('patch 的键必须是非空字符串')
        if key == '__structboard_marks__':
            if not isinstance(value, dict):
                raise ValueError('patch.__structboard_marks__ 必须是对象')
        elif not isinstance(value, str):
            raise ValueError('patch[%r] 必须是字符串' % key)
    with _notes_lock(root):
        notes = _read_notes_unlocked(root)
        notes.update(patch)
        return _write_notes_unlocked(root, notes), notes


# ---------------------------------------------------------------- 组装管线

def build_pipeline(pid, definition=None, progress=None, cancel=None):
    """扫描规则限定目录；列表只统计前 60 条明细，完整数量照实返回。"""
    _check_cancel(cancel)
    defn = definition if definition is not None else load_definition(pid)
    root = defn.get('root', '') or ''
    root = root if isinstance(root, str) else str(root)
    root_exists = bool(root) and os.path.isdir(root)
    notes = read_notes(root) if root_exists else {}
    definitions = defn.get('steps', [])
    if not isinstance(definitions, list):
        definitions = []
    pipeline_id = defn.get('id', pid) or pid
    real_root = os.path.normcase(os.path.realpath(root)) if root else ''

    scans = {}
    all_patterns = []
    for st in definitions:
        if isinstance(st, dict):
            all_patterns.extend(_step_patterns(st))
    all_globs = tuple(dict.fromkeys(g for g in all_patterns if isinstance(g, str) and g.strip()))

    def report_discovery(scanned):
        if progress:
            progress(0, len(definitions), '匹配文件清单', scanned)

    # 多步骤的规则合并后只遍历一次磁盘，随后在内存中分组。
    all_rels = collect_files(root, all_globs, report_discovery, cancel) if root_exists and all_globs else []

    def pattern_hits(patterns):
        patterns = tuple(g.replace('\\', '/') for g in patterns if isinstance(g, str) and g.strip())
        if patterns not in scans:
            if patterns == all_globs:
                scans[patterns] = all_rels
            else:
                matchers = [_compile_glob(g) for g in patterns]
                hits = []
                for number, rel in enumerate(all_rels):
                    if number % 512 == 0:
                        _check_cancel(cancel)
                    if any(rx.fullmatch(rel) for rx in matchers):
                        hits.append(rel)
                scans[patterns] = hits
        return scans[patterns]

    steps = []
    for idx, st in enumerate(definitions):
        _check_cancel(cancel)
        if not isinstance(st, dict):
            continue
        title = st.get('title', st.get('id', ''))

        def report(scanned=None):
            if progress:
                progress(idx, len(definitions), title, scanned)
        report()

        step_id = st.get('id', 's%d' % idx)
        globs = tuple(g.replace('\\', '/') for g in (st.get('globs') or [])
                      if isinstance(g, str) and g.strip())
        structure_globs = tuple(_step_patterns(st))
        star_globs = [g for g in (st.get('starGlobs') or []) if isinstance(g, str)]
        star_matchers = [_compile_glob(g) for g in star_globs]
        rels = pattern_hits(globs)
        structure_rels = pattern_hits(structure_globs)

        explicit_order, explicit_map = _explicit_files(st)
        step_lineage, _ = _normalize_lineage(st.get('lineage'), root)
        explicit_lineages = _explicit_lineages(explicit_map, root)
        group_mode, group_depth = _parse_group_by(st.get('groupBy'))

        # 完整结构集合在内存里汇总 metadata；明细仍受 MAX_FILE_ITEMS 限制。
        structure_meta = {}
        grouping_warnings = []
        for rel in _iter_structure_rels(explicit_order, structure_rels, root):
            meta = _structure_metadata(rel, pipeline_id, step_id, group_mode, group_depth,
                                       step_lineage, explicit_lineages.get(rel))
            structure_meta[rel] = meta
            if meta['groupingWarning'] and meta['groupingWarning'] not in grouping_warnings:
                grouping_warnings.append(meta['groupingWarning'])
        counts = summarize_structures(structure_meta.values())
        grouping_warning = '；'.join(grouping_warnings)

        entries = []
        for rel in explicit_order:
            f = explicit_map[rel]
            entries.append((str(f.get('name') or ''), rel,
                            bool(f.get('star', st.get('star', False))), 'star' in f))
        for rel in rels:
            entries.append(('', rel, bool(st.get('star', False)), False))

        files, seen = [], set()
        for name, rel, entry_star, explicit_star in entries:
            if len(seen) % 1024 == 0:
                _check_cancel(cancel)
            normalized = str(rel).replace('\\', '/')
            if normalized in seen:
                continue
            seen.add(normalized)
            if len(files) >= MAX_FILE_ITEMS:
                continue
            full = safe_join(root, normalized)
            try:
                file_stat = os.stat(full) if full else None
                exists = file_stat is not None and stat_module.S_ISREG(file_stat.st_mode)
                size = file_stat.st_size if exists else None
            except OSError:
                file_stat, exists, size = None, False, None
            star = entry_star
            if not explicit_star and star_matchers and any(rx.fullmatch(normalized) for rx in star_matchers):
                star = True

            meta = structure_meta.get(normalized)
            if meta is None:
                lineage = _merge_lineage(step_lineage, explicit_lineages.get(normalized))
                explicit_model = lineage.get('modelIndex')
                group = group_kind = group_key = None
                file_grouping_warning = ''
                model_index = explicit_model if _is_nonnegative_int(explicit_model) else None
            else:
                lineage = meta['lineage']
                group = meta['group']
                group_kind = meta['groupKind']
                group_key = meta['groupKey']
                file_grouping_warning = meta['groupingWarning']
                model_index = meta['modelIndex']
            file_key, source_key = _source_keys(pipeline_id, step_id, real_root, normalized,
                                                file_stat if exists else None)
            files.append({
                'name': name or os.path.basename(normalized),
                'path': normalized,
                'fullPath': full.replace('\\', '/') if full else '',
                'size': size,
                'star': star,
                'sizeText': human_size(size),
                'exists': exists,
                'lineage': lineage,
                'group': group,
                'groupKind': group_kind,
                'groupKey': group_key,
                'groupingWarning': file_grouping_warning,
                'modelIndex': model_index,
                'fileKey': file_key,
                'sourceKey': source_key,
            })

        matched_total = len(rels)
        file_count = len(seen)
        files_truncated = file_count > MAX_FILE_ITEMS

        # CSV 事实：行数 + 列名（只统计少量，避免大 CSV 拖慢）
        facts = {}
        facts_scanned = 0
        for f in files:
            if not f['path'].lower().endswith('.csv') or not f['exists']:
                continue
            if facts_scanned >= MAX_CSV_FACTS:
                break
            full = safe_join(root, f['path'])
            if not full:
                continue
            cf = csv_facts(full, cancel=cancel)
            facts_scanned += 1
            if cf['rows'] is not None:
                facts[f['path']] = {'rows': cf['rows'], 'cols': cf['cols'][:24],
                                    'rowsTruncated': cf['rowsTruncated']}

        # 目录是否存在（定义里可以写 dir 字段做存在性检查）
        dir_info = None
        if st.get('dir'):
            d = safe_join(root, str(st['dir']))
            if d and os.path.isdir(d):
                dir_info = {'path': st['dir'], 'exists': True,
                            'entries': len([x for x in os.listdir(d)
                                            if not x.startswith('.')])}
            else:
                dir_info = {'path': st['dir'], 'exists': False, 'entries': 0}

        steps.append({
            'id': step_id,
            'tag': st.get('tag', ''),
            'tool': _tool_text(st),
            'operation': _operation_text(st),
            'title': st.get('title', step_id),
            'round': st.get('round', ''),
            'desc': st.get('desc', ''),
            'cmd': st.get('cmd', ''),
            'note': notes.get(step_id, st.get('note', '')),
            'files': files,
            'fileCount': file_count,
            'matchedTotal': matched_total,
            'truncated': files_truncated,
            'counts': counts,
            'groupingWarning': grouping_warning,
            'facts': facts,
            'dir': dir_info,
            'state': st.get('state', 'done'),
        })

    _check_cancel(cancel)
    if progress:
        progress(len(definitions), len(definitions), '扫描完成', None)
    return {
        'id': defn.get('id', pid),
        'name': defn.get('name', pid),
        'target': defn.get('target', ''),
        'root': root,
        'rootExists': bool(root) and os.path.isdir(root),
        'notesFile': notes_path(root) if root else None,
        'notes': notes,
        'generatedAt': datetime.now().isoformat(timespec='seconds'),
        'steps': steps,
        'totalFiles': sum(s['fileCount'] for s in steps),
    }
