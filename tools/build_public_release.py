"""Create Windows installer, portable ZIP and a bounded public source snapshot.

Usage: python tools/build_public_release.py --release dist/StructBoardTauri --output dist/public
No upload, deployment, user data, credentials, logs or Git history are included.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

SRC = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(SRC / 'tools'))
import build_desktop
import resource_contract as resources


def get(url, path):
    request = urllib.request.Request(url, headers={'User-Agent': 'StructBoard-release-builder'})
    with urllib.request.urlopen(request, timeout=120) as response, path.open('wb') as output:
        shutil.copyfileobj(response, output)


def public_source(destination):
    provenance = resources.capture_source(SRC)
    from check_public_source import audit, load_inventory
    issues = audit(SRC)
    if issues:
        raise RuntimeError('Public source audit failed: ' + '; '.join(issues))
    names = set(load_inventory(SRC)['files']) | {'public-source.json'}
    # Only explicitly named dependencies are publishable. Internal handovers,
    # user pipelines, troubleshooting scripts and .git history never enter.
    for name in sorted(names):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SRC / name, target)
    files = {name: resources.file_hash(destination / name) for name in sorted(names)}
    tracked = sorted(name for name in names if name in provenance['tracked_files'])
    approved = sorted(names - set(tracked))
    data = {**provenance, 'files': files, 'tracked_files': tracked,
            'approved_untracked_files': approved,
            'changed_tracked_files': sorted(set(provenance['changed_tracked_files']) & names),
            'candidate_digest': resources.canonical_digest(files)}
    data['committed_clean'] = not data['approved_untracked_files'] and not data['changed_tracked_files']
    resources.validate_provenance(data)
    (destination / resources.CANDIDATE_RECORD).write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    resources.capture_source(destination)
    return data


def archive(directory, output):
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
        for path in sorted(directory.rglob('*')):
            if path.is_file():
                zipped.write(path, str(Path(directory.name) / path.relative_to(directory)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--skip-installer', action='store_true')
    args = parser.parse_args()
    release, output = args.release.resolve(), args.output.resolve()
    resources.validate_frontend_build(SRC)
    build_desktop.validate_release(release)
    if output.exists():
        raise SystemExit('Choose a new output directory to preserve earlier releases.')
    output.mkdir(parents=True)
    source = output / 'StructBoard-source'
    provenance = public_source(source)
    archive(source, output / 'StructBoard-0.3.0-source.zip')
    portable = output / 'StructBoard'
    shutil.copytree(release, portable)
    for name in ('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'):
        shutil.copy2(SRC / name, portable / name)
    shutil.copytree(SRC / 'licenses', portable / 'licenses')
    archive(portable, output / 'StructBoard-0.3.0-windows-x64.zip')
    if not args.skip_installer:
        dependencies = output / 'build-dependencies'
        dependencies.mkdir()
        nsis_zip = dependencies / 'nsis.zip'
        get('https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip', nsis_zip)
        digest = hashlib.sha256(nsis_zip.read_bytes()).hexdigest()
        if digest != 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1':
            raise RuntimeError('NSIS download checksum mismatch')
        with zipfile.ZipFile(nsis_zip) as zipped:
            for item in zipped.infolist():
                if Path(item.filename).is_absolute() or '..' in Path(item.filename).parts:
                    raise RuntimeError('Unsafe NSIS archive member')
            zipped.extractall(dependencies / 'nsis')
        compiler = next((dependencies / 'nsis').rglob('makensis.exe'))
        webview = dependencies / 'MicrosoftEdgeWebview2Setup.exe'
        get('https://go.microsoft.com/fwlink/p/?LinkId=2124703', webview)
        env = dict(os.environ, STRUCTBOARD_SIGNATURE_TARGET=str(webview))
        verification_shell = shutil.which('pwsh') or shutil.which('pwsh.exe') or 'powershell.exe'
        # Certificate-chain/revocation lookups may briefly fail on first use.
        # Retry verification; never run an unverified bootstrapper.
        for attempt in range(3):
            signature = subprocess.run([verification_shell, '-NoProfile', '-NonInteractive', '-Command',
                "$s=Get-AuthenticodeSignature -LiteralPath $env:STRUCTBOARD_SIGNATURE_TARGET; "
                "if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){exit 1}"],
                env=env, capture_output=True)
            if signature.returncode == 0:
                break
            if attempt == 2:
                raise RuntimeError('Microsoft WebView2 signature could not be verified; installer not built')
            time.sleep(2)
        installer = output / 'StructBoard-0.3.0-windows-x64-setup.exe'
        subprocess.run([str(compiler), '/V2', '/INPUTCHARSET', 'UTF8',
            '/DRELEASE_DIR=' + str(portable), '/DSOURCE_DIR=' + str(SRC),
            '/DWEBVIEW_BOOTSTRAPPER=' + str(webview), '/DINSTALLER_OUTPUT=' + str(installer),
            str(SRC / 'tools/public_installer.nsi')], check=True)
    checksums = {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                 for file in output.iterdir() if file.suffix in ('.zip', '.exe')}
    (output / 'SHA256SUMS.txt').write_text(''.join(digest + '  ' + name + '\n' for name, digest in checksums.items()), encoding='ascii')
    print('Public release artifacts:', output)
    print('Source snapshot:', provenance['candidate_digest'])


if __name__ == '__main__':
    main()
