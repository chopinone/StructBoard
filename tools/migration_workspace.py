"""Isolated migration preview, checks and build. Never installs or touches real profiles."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

SRC = Path(__file__).resolve().parents[1]
BASE = SRC / '_migration'


def environment(area):
    base = (BASE / area).resolve()
    if BASE.resolve() not in base.parents:
        raise ValueError('Profile must be inside this worktree')
    profile = base / 'profile'
    # WebView2 131 still fails to open LevelDB with deeply nested Windows paths.
    # Keep the explicit data override short; APPDATA/USERPROFILE remain isolated.
    data = base / 'data'
    for path in (data, base / 'temp', profile / 'AppData/Local', profile / 'AppData/Roaming'):
        path.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, USERPROFILE=str(profile), APPDATA=str(profile / 'AppData/Roaming'),
               LOCALAPPDATA=str(profile / 'AppData/Local'), STRUCTBOARD_DATA_DIR=str(data),
               STRUCTBOARD_PIPE_DIR=str(data / 'pipelines'), STRUCTBOARD_HARNESS_DISCOVERY=str(data / 'harness.json'),
               TEMP=str(base / 'temp'), TMP=str(base / 'temp'), PYTHONDONTWRITEBYTECODE='1',
               STRUCTBOARD_SKIP_DEPLOY='1', STRUCTBOARD_WORK_DIR=str(BASE / 'build'),
               STRUCTBOARD_OUTPUT_DIR=str(BASE / 'release'), STRUCTBOARD_CARGO_TARGET_DIR=str(BASE / 'cargo-target'),
               STRUCTBOARD_BUILD_PYTHON=sys.executable)
    env['TAURI_CONFIG'] = json.dumps({'identifier': 'com.structboard.migration', 'productName': 'StructBoard Migration'})
    env.pop('STRUCTBOARD_DEPLOY_TARGETS', None)
    return base, data, env


def preview(args):
    base, data, env = environment(args.profile)
    token = secrets.token_urlsafe(40)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    with http.server.ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Quiet, directory=str(SRC))) as server:
        url = 'http://127.0.0.1:' + str(server.server_address[1])
        env.update(STRUCTBOARD_API_TOKEN=token, STRUCTBOARD_DESKTOP_ORIGIN=url)
        with (base / 'backend.log').open('ab') as log:
            process = subprocess.Popen([sys.executable, '-B', str(SRC / 'desktop_backend.py')], cwd=SRC,
                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log,
                creationflags=0x08000000 if os.name == 'nt' else 0)
            try:
                ready = json.loads(process.stdout.readline())
                access = {'url': url, 'backend': 'http://127.0.0.1:' + str(ready['port']), 'token': token}
                (base / 'access.json').write_text(json.dumps(access), encoding='utf-8')
                print('UI_PREVIEW_READY ' + str(base / 'access.json'), flush=True)
                server.serve_forever()
            finally:
                process.terminate()
                process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preview', 'test', 'build'])
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--profile', default='browser', help='Isolated preview profile below _migration')
    args = parser.parse_args()
    if args.action == 'preview':
        preview(args)
    else:
        _, _, env = environment(args.action)
        target = 'tools/run_all_tests.py' if args.action == 'test' else 'build_desktop.py'
        if args.action == 'build':
            subprocess.run(['node', 'tools/check_frontend_build.mjs'], cwd=SRC, check=True)
        raise SystemExit(subprocess.call([sys.executable, '-X', 'utf8', '-I', '-B', str(SRC / target)], cwd=SRC, env=env))


if __name__ == '__main__':
    main()
