"""Private local API process and paired MCP connector owned by StructBoard."""
import json
import os
from pathlib import Path
import re
import secrets
import sys
import threading
from urllib.parse import parse_qs, urlsplit

if getattr(sys, "frozen", False):
    sys.path.insert(0, sys._MEIPASS)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--mcp":
        import mcp_server
        return mcp_server.main(argv[1:])
    if argv:
        raise RuntimeError("Unknown desktop backend arguments")

    import pipeline_api
    import serve
    from harness_broker import HarnessBroker

    token = os.environ.get("STRUCTBOARD_API_TOKEN", "")
    pipeline_dir = os.environ.get("STRUCTBOARD_PIPE_DIR", "")
    if len(token) < 32 or not pipeline_dir:
        raise RuntimeError("Desktop API must be launched by StructBoard")
    pipeline_api.PIPE_DIR = pipeline_dir
    data = Path(os.environ.get("STRUCTBOARD_DATA_DIR") or Path(pipeline_dir).parent)
    from demo_data import ensure_demo
    ensure_demo(data, pipeline_dir)
    desktop_origin = os.environ.get("STRUCTBOARD_DESKTOP_ORIGIN", "http://tauri.localhost")
    discovery = Path(os.environ.get("STRUCTBOARD_HARNESS_DISCOVERY") or data / "harness.json")
    broker = None

    class DesktopHandler(serve.Handler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin", "")
            if origin == desktop_origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-StructBoard-Token")
            super(serve.Handler, self).end_headers()

        def do_OPTIONS(self):
            if broker and broker.handle_external(self):
                return
            origin = self.headers.get("Origin", "")
            if origin and origin != desktop_origin:
                return self._send_json({"ok": False, "error": "Origin not allowed"}, 403)
            self.send_response(204)
            self.end_headers()

        def authorized(self):
            values = self.headers.get_all("X-StructBoard-Token", [])
            origin = self.headers.get("Origin", "")
            if origin and origin != desktop_origin:
                self._send_json({"ok": False, "error": "Origin not allowed"}, 403)
                return False
            if len(values) == 1 and secrets.compare_digest(values[0], token):
                return True
            self._send_json({"ok": False, "error": "Unauthorized"}, 401)
            return False

        def do_GET(self):
            if broker and broker.handle_external(self):
                return
            if not self.authorized():
                return
            if broker and broker.handle_renderer(self):
                return
            if not self.path.startswith("/api/"):
                return self._send_json({"ok": False, "error": "API only"}, 404)
            parsed = urlsplit(self.path)
            if parsed.path == '/api/demo/scores':
                from demo_data import score_rows
                return self._send_json({'ok': True, 'rows': score_rows()})
            if parsed.path == "/api/pipeline/window-bootstrap":
                query = parse_qs(parsed.query, keep_blank_values=True)
                keys = query.get("key", [])
                if set(query) != {"key"} or len(keys) != 1 or not re.fullmatch(r"w_[A-Za-z0-9_-]{6,94}", keys[0]):
                    return self._send_json({"ok": False, "error": "Invalid detached window key"}, 400)
                bootstrap = data / "pipeline-window-bootstrap" / (keys[0] + ".json")
                try:
                    if bootstrap.stat().st_size > 32 * 1024 * 1024:
                        return self._send_json({"ok": False, "error": "Detached workspace snapshot exceeds the transfer limit"}, 413)
                    value = json.loads(bootstrap.read_text(encoding="utf-8"))
                    if not isinstance(value, dict) or not isinstance(value.get("snapshot"), dict) or not isinstance(value.get("tabs"), list):
                        raise ValueError("Invalid detached workspace snapshot")
                except (OSError, ValueError):
                    return self._send_json({"ok": False, "error": "Detached workspace snapshot is unavailable"}, 404)
                try: bootstrap.unlink()
                except OSError: pass
                return self._send_json({"ok": True, "snapshot": value["snapshot"], "tabs": value["tabs"]})
            super().do_GET()

        def do_POST(self):
            if broker and broker.handle_external(self):
                return
            if not self.authorized():
                return
            if broker and broker.handle_renderer(self):
                return
            super().do_POST()

    with serve.Server(("127.0.0.1", 0), DesktopHandler) as server:
        endpoint = "http://127.0.0.1:%d" % server.server_address[1]
        connector = None
        if getattr(sys, "frozen", False) and os.name == "nt":
            # The packaged backend doubles as the MCP connector; advertise its own
            # exe plus the default credential path so the panel can copy a ready
            # client config. Source/dev runs keep this disabled.
            exe = Path(sys.executable)
            if exe.name.lower() == "structboardbackend.exe":
                default_credential = Path(os.environ.get("LOCALAPPDATA") or "") / "StructBoardMCP" / "connector.json"
                if str(default_credential.parent):
                    connector = {"exe": str(exe), "credential": str(default_credential)}
        broker = HarnessBroker(endpoint=endpoint, desktop_origin=desktop_origin,
                               discovery_path=discovery, grants_path=data / "harness-grants.json",
                               connector=connector)
        broker.initialize()
        if connector:
            from client_setup import ClientSetup
            broker.client_setup = ClientSetup(broker, Path.home(),
                Path(connector['credential']).parent, Path(connector['exe']))
        if os.name == "nt":
            # A process handle becomes signaled if the native parent exits, even after a crash.
            import ctypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.restype = ctypes.c_void_p
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            parent = kernel.OpenProcess(0x00100000, False, os.getppid())
            if parent:
                def watch_parent():
                    kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
                    kernel.CloseHandle(parent)
                    server.shutdown()
                threading.Thread(target=watch_parent, daemon=True).start()
        print(json.dumps({"port": server.server_address[1], "harness": broker.metadata()}), flush=True)
        try:
            server.serve_forever()
        finally:
            broker.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
