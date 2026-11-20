"""Validate the explicit public source inventory without printing sensitive values."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

MANIFEST = 'public-source.json'
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
    'provider-token': re.compile(r'\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b'),
    'personal-home-path': re.compile(r'(?i)(?:[A-Z]:[/\\]+Users[/\\]+(?!Public\b)[^/\\\s"<>]+|/home/[a-z0-9_-]+/|/Users/[a-z0-9_-]+/)'),
    'literal-credential': re.compile(r'''(?i)(?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']([^\s"']{14,})["']'''),
    'long-sequence': re.compile(r'\b[ACDEFGHIKLMNPQRSTVWY]{55,}\b'),
}
# Only these exact inert literals have been reviewed; never exclude a whole test file.
FIXTURES = {
    ('tools/test_ai_chat_engine.js', 'fake-secret-for-test'),
    ('frontend/tests/workspace.spec.mjs', 'synthetic-not-a-secret'),
}

def load_inventory(root):
    data = json.loads((root / MANIFEST).read_text(encoding='utf-8'))
    names = data['files']
    if data.get('version') != 1 or names != sorted(set(names)):
        raise ValueError('Invalid public inventory')
    for name in names:
        p = PurePosixPath(name)
        if not name or p.is_absolute() or '..' in p.parts or ':' in name or '\\' in name or '.git' in p.parts:
            raise ValueError('Unsafe public inventory name')
    if len({n.casefold() for n in names}) != len(names):
        raise ValueError('Case-colliding public names')
    return data

def audit(root, all_files=False):
    root = Path(root).resolve()
    data = load_inventory(root)
    expected = set(data['files']) | {MANIFEST}
    issues = []
    if (root / '.git').exists() and not all_files:
        listed = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode('utf-8')
        actual = set(filter(None, listed.split('\0')))
    else:
        actual = {p.relative_to(root).as_posix() for p in root.rglob('*')
                  if '.git' not in p.relative_to(root).parts and (p.is_file() or p.is_symlink())}
        # A source ZIP may contain its generated, separately validated provenance record.
        if 'candidate-provenance.json' in actual:
            actual.remove('candidate-provenance.json')
            record = json.loads((root / 'candidate-provenance.json').read_text(encoding='utf-8'))
            if set(record.get('files', {})) != expected:
                issues.append('candidate-provenance.json: unexpected inventory')
            for name, digest in record.get('files', {}).items():
                if name not in expected or not (root/name).is_file() or hashlib.sha256((root/name).read_bytes()).hexdigest() != digest:
                    issues.append('candidate-provenance.json: content mismatch')
    issues += [n + ': unexpected public file' for n in sorted(actual - expected)]
    issues += [n + ': missing public file' for n in sorted(expected - actual)]
    for name in sorted(expected):
        path = root / name
        if not path.is_file():
            continue
        if any(p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction())
               for p in [path, *list(path.parents)[:len(PurePosixPath(name).parts)-1]]):
            issues.append(name + ': links are not publishable')
            continue
        raw = path.read_bytes()
        if name in data.get('reviewedAssets', {}):
            asset_bytes = raw.replace(b'\r\n', b'\n') if path.suffix.lower() == '.svg' else raw
            if hashlib.sha256(asset_bytes).hexdigest() != data['reviewedAssets'][name]:
                issues.append(name + ': changed image needs privacy review')
        elif path.suffix.lower() in {'.png', '.ico', '.svg', '.jpg', '.webp'}:
            issues.append(name + ': image has not been reviewed')
        if b'\0' in raw[:8192]:
            if name not in data.get('reviewedAssets', {}):
                issues.append(name + ': unreviewed binary')
            continue
        text = raw.decode('utf-8', errors='replace')
        text = re.sub(r'data:[^;\s]+;base64,[A-Za-z0-9+/=]+', 'data:REVIEWED-IMAGE', text)
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                if label == 'literal-credential' and (name, match.group(1)) in FIXTURES:
                    continue
                issues.append(f'{name}:{text.count(chr(10), 0, match.start())+1}: {label}')
    return issues

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--all-files', action='store_true', help='Check a clean delivery directory including untracked files')
    args = parser.parse_args()
    issues = audit(args.root, args.all_files)
    if issues:
        print('\n'.join(issues))
        raise SystemExit(1)
    print('Public source inventory, image hashes and content checks passed.')

if __name__ == '__main__':
    main()
