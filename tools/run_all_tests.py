"""Run every StructBoard regression in one command: python tools/run_all_tests.py"""
import subprocess
import sys
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='replace')

SRC = Path(__file__).resolve().parent.parent

JS_SUITES = [
    'test_ui_architecture.js',
    'test_workspace_org.js',
    'test_workspace_org_identity.js',
    'test_overview_queue.js',
    'test_overview_lifecycle.js',
    'test_overview_demand.js',
    'test_pane_runtime.js',
    'test_pane_controls.js',
    'test_workspace_save.js',
    'test_session_store.js',
    'test_folder_notes.js',
    'test_toolbar_geometry.js',
    'test_parsed_retention.js',
    'test_pipeline_merge.js',
    'test_actions.js',
    'test_pipeline_assist.js',
    'test_ai_chat.js',
    'test_ai_chat_engine.js',
    'test_ai_chat_ui.js',
    'test_app_operations.js',
    'test_canvas_document.js',
    'test_canvas_bridge.js',
    'test_search_filter.js',
    'test_notes_sync.js',
    'test_step_note_edit.js',
    'test_session_badge.js',
    'test_harness_ui.js',
    'test_pipeline_tabs.js',
    'test_blank_tabs.js',
    'test_external_drop.js',
    'test_startup.js',
]
PY_SUITES = [
    'test_public_source.py',
    'test_client_setup.py', 'test_demo_data.py',
    'test_pipeline_notes.py', 'test_ai_proxy.py', 'test_ai_proxy_stream.py',
    'test_harness_broker.py', 'test_mcp_server.py', 'test_desktop_release.py',
]


def run(label, argv):
    print('--- %s' % label, flush=True)
    result = subprocess.run(argv, cwd=str(SRC), capture_output=True, text=True, encoding='utf-8', errors='replace')
    output = (result.stdout or '') + (result.stderr or '')
    if result.returncode != 0:
        print(output.strip()[-4000:], flush=True)
        print('FAILED: %s' % label, flush=True)
        return False
    last = [line for line in output.strip().splitlines() if line.strip()]
    print((last[-1] if last else 'ok'), flush=True)
    return True


def main():
    failures = []
    for name in JS_SUITES:
        path = SRC / 'tools' / name
        if not path.is_file():
            failures.append(name + ' (missing)')
            continue
        if not run(name, ['node', str(path)]):
            failures.append(name)
    for name in PY_SUITES:
        path = SRC / 'tools' / name
        if not path.is_file():
            failures.append(name + ' (missing)')
            continue
        if not run(name, [sys.executable, '-X', 'utf8', '-I', '-B', str(path)]):
            failures.append(name)
    print()
    if failures:
        print('%d suite(s) failed: %s' % (len(failures), ', '.join(failures)))
        return 1
    print('all %d suites passed' % (len(JS_SUITES) + len(PY_SUITES)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
