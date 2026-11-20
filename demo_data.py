"""Small, deterministic, entirely synthetic demonstration; no research inputs."""
import csv
import io
import json
import math
from pathlib import Path

DEMO_ID = 'aurora-demo'
DEMO_NAME = 'Aurora · 人工合成演示'
NOTICE = '演示数据：结构、序列和分数均由程序人工生成，仅用于学习操作，不代表实验或预测结果。'


def pdb(candidate=0, model=0):
    lines = ['HEADER    SYNTHETIC STRUCTBOARD DEMONSTRATION',
             'REMARK 900 ARTIFICIAL COORDINATES AND SCORES; NOT RESEARCH DATA.']
    serial = 0
    for chain, count, shift in [('A', 42, 0), ('B', 24, 9 + candidate * .55 + model * .2)]:
        for residue in range(1, count + 1):
            for atom, radius, phase, dz in [('N', 1.98, -.42, -.72), ('CA', 2.3, 0, 0),
                    ('C', 2.58, .46, .70), ('O', 2.99, .58, 1.28), ('CB', 3.08, -.18, .15)]:
                theta = residue * math.radians(100) + phase
                x = radius * math.cos(theta) + shift
                y = radius * math.sin(theta) + (model * .22 if chain == 'B' else 0)
                z = residue * 1.5 + dz + (8 if chain == 'B' else 0)
                tilt = math.radians(65)
                x, z = x * math.cos(tilt) + z * math.sin(tilt), -x * math.sin(tilt) + z * math.cos(tilt)
                b = 92 - candidate * 6 - model * 2
                serial += 1
                lines.append(f'ATOM  {serial:5d} {atom:^4s} ALA {chain}{residue:4d}    '
                             f'{x:8.3f}{y:8.3f}{z:8.3f}{1:6.2f}{b:6.2f}          {atom[0]:>2s}')
        lines.append('TER')
    return '\n'.join(lines + ['END', ''])


def score_rows():
    return [{'design': f'Aurora_{candidate:03d}_model_{model}',
             'demo_score': round(.95 - candidate * .065 - model * .012, 3),
             'demo_deviation': round(.4 + candidate * .42 + model * .18, 2)}
            for candidate in range(1, 7) for model in range(3)]


def scores_csv():
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=['design', 'demo_score', 'demo_deviation'])
    writer.writeheader()
    writer.writerows(score_rows())
    return stream.getvalue()


def definition(root):
    def item(candidate, model, directory, kind='prediction'):
        return {'name': f'Aurora_{candidate:03d}_model_{model}.pdb',
                'path': f'{directory}/Aurora_{candidate:03d}_model_{model}.pdb',
                'lineage': {'candidateId': f'Aurora_{candidate:03d}', 'candidateName': f'Aurora_{candidate:03d}',
                            'modelIndex': model, 'artifactKind': kind, 'role': 'candidate',
                            'assessmentSource': 'synthetic-demo'}}
    return {'id': DEMO_ID, 'name': DEMO_NAME, 'target': NOTICE, 'root': str(Path(root).resolve()),
        'demo': True, 'steps': [
            {'id': 'template', 'title': '合成双链模板', 'tool': '演示', 'desc': NOTICE,
             'note': 'A 链 42 个丙氨酸，B 链 24 个丙氨酸。坐标由螺旋公式生成，无真实靶点。',
             'files': [{'name': 'synthetic_template.pdb', 'path': 'template/synthetic_template.pdb',
                        'lineage': {'role': 'reference', 'artifactKind': 'reference'}}]},
            {'id': 'design', 'title': '6 个示意候选', 'tool': '演示', 'desc': '平移合成 B 链，演示不同候选的结构差异。',
             'note': '这些候选不来自任何真实生成模型；可练习旋转、叠加、文件夹和便签。',
             'files': [item(c, 0, 'design', 'design') for c in range(1, 7)]},
            {'id': 'review', 'title': '6 个候选 × 3 个示意模型', 'tool': '演示',
             'desc': '18 个模型；demo_score 和 demo_deviation 是人为设定的教学数值。',
             'note': '教学筛选条件：demo_score ≥ 0.78，且同一候选至少 2/3 个模型达标。'
                     '\n按这个规则，Aurora_001、Aurora_002 入选。数值没有科研意义。',
             'starGlobs': ['review/Aurora_001_model_*.pdb', 'review/Aurora_002_model_*.pdb'],
             'files': [item(c, m, 'review') for c in range(1, 7) for m in range(3)]},
            {'id': 'shortlist', 'title': '2 个演示入选候选', 'tool': '演示',
             'desc': '2 个候选，保留全部 6 个模型，便于练习检阅。',
             'note': NOTICE + '\n可以在这里练习星标、并排检阅和修改便签。',
             'starGlobs': ['shortlist/*.pdb'],
             'files': [item(c, m, 'shortlist') for c in (1, 2) for m in range(3)]},
        ]}


def ensure_demo(data_dir, pipeline_dir):
    """Seed once in user-writable AppData. Existing demo edits are preserved."""
    root = Path(data_dir) / 'demonstrations' / 'aurora-v1'
    pipeline = Path(pipeline_dir) / (DEMO_ID + '.json')
    root.mkdir(parents=True, exist_ok=True)
    files = {'README.txt': NOTICE + '\n', 'demo-scores.csv': scores_csv(),
             'template/synthetic_template.pdb': pdb()}
    for c in range(1, 7):
        files[f'design/Aurora_{c:03d}_model_0.pdb'] = pdb(c)
        for m in range(3):
            text = pdb(c, m)
            files[f'review/Aurora_{c:03d}_model_{m}.pdb'] = text
            if c in (1, 2):
                files[f'shortlist/Aurora_{c:03d}_model_{m}.pdb'] = text
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(content, encoding='utf-8')
    pipeline.parent.mkdir(parents=True, exist_ok=True)
    if not pipeline.exists():
        pipeline.write_text(json.dumps(definition(root), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return root
