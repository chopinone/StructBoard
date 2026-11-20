"""Private desktop harness broker (stdlib only; never handles a desktop API token).

Attach to an already bound loopback HTTP server with HarnessBroker(endpoint=...,
desktop_origin=..., discovery_path=..., grants_path=...). initialize() publishes
public discovery metadata; close() stops jobs and removes that instance's file.
handle_external(handler) goes BEFORE the desktop token check for /harness/*;
handle_renderer(handler) goes AFTER it for /api/harness/*. Both return a boolean
indicating that they handled the route. The embedding server must not expose this
module from plain serve mode without its explicit test flag and renderer auth.

Renderer routes: GET contract/status, POST pairing/poll/result/approve/rename/revoke/stop.
External routes: POST pair/heartbeat/call/revoke, GET status. External auth is
Authorization: Bearer <independent paired grant>, never X-StructBoard-Token.
Only hashes of grant tokens are retained, and only remembered grants reach disk.
"""
from __future__ import annotations

import copy
import csv
import ctypes
import hashlib
import json
import math
import ntpath
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile
import threading
import time
import unicodedata
from collections import deque
from urllib.parse import urlsplit

CONTRACT_PATH = Path(__file__).with_name("harness_contract.json")
TERMINAL = frozenset(("completed", "failed", "cancelled", "expired"))
DURABILITIES = ("view", "queued", "local", "pipeline", "preview", "error")
DISPLAY_NAME = {"type": "string", "minLength": 1, "maxLength": 80}


def display_name(value):
    if not isinstance(value, str):
        return ""
    clean = "".join(c for c in value if unicodedata.category(c) not in ("Cc", "Cf", "Cs"))
    return " ".join(clean.split())[:80]


def client_display_name(value):
    name = display_name(value)
    key = name.casefold().replace("_", "-")
    if key in ("", "mcp", "mcp connector", "mcp-connector", "mcp client", "mcp-client", "client", "unknown"):
        return ""
    return {"codex": "Codex", "codex-cli": "Codex", "codex-app": "Codex", "codex-desktop": "Codex",
            "codex-mcp-client": "Codex", "openai-codex": "Codex", "zcode": "ZCode", "claude-code": "Claude Code",
            "cursor": "Cursor", "workbuddy": "WorkBuddy", "workbuddy-ai": "WorkBuddy"}.get(key, name)


class HarnessError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status

    def public(self):
        return {"code": self.code, "message": self.message}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON property")
        result[key] = value
    return result


def strict_json(data):
    def bad_constant(_value):
        raise ValueError("Non-finite JSON number")
    return json.loads(data, object_pairs_hook=_no_duplicates, parse_constant=bad_constant)


def load_contract(path=CONTRACT_PATH):
    return strict_json(Path(path).read_text(encoding="utf-8"))


def expand_schema(schema, contract):
    """Resolve this contract's local, acyclic references for standalone SDK schemas."""
    if isinstance(schema, list):
        return [expand_schema(item, contract) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/$defs/"):
            raise ValueError("Only contract-local references are allowed")
        resolved = expand_schema(contract["$defs"][ref.split("/")[-1]], contract)
        resolved.update({k: expand_schema(v, contract) for k, v in schema.items() if k != "$ref"})
        return resolved
    return {key: expand_schema(value, contract) for key, value in schema.items()}


def validate_schema(value, schema, contract=None, path="args", depth=0):
    """Validate the bounded JSON Schema subset used in the shared contract.

    The broker deliberately has no SDK/jsonschema runtime dependency. The SDK
    additionally validates the advertised schemas; this validator is independent
    of any client and enforces every keyword used by harness_contract.json.
    """
    if depth > 32:
        raise HarnessError("schema_error", "JSON nesting exceeds the limit")
    if "$ref" in schema:
        if contract is None or not schema["$ref"].startswith("#/$defs/"):
            raise HarnessError("schema_error", "Invalid schema reference")
        validate_schema(value, contract["$defs"][schema["$ref"].split("/")[-1]], contract, path, depth + 1)
    for keyword in ("oneOf", "anyOf", "allOf"):
        if keyword in schema:
            matches = 0
            for option in schema[keyword]:
                try:
                    validate_schema(value, option, contract, path, depth + 1)
                    matches += 1
                except HarnessError:
                    pass
            if ((keyword == "oneOf" and matches != 1) or
                    (keyword == "anyOf" and not matches) or
                    (keyword == "allOf" and matches != len(schema[keyword]))):
                raise HarnessError("schema_error", "%s does not match %s" % (path, keyword))
    if "not" in schema:
        try:
            validate_schema(value, schema["not"], contract, path, depth + 1)
        except HarnessError:
            pass
        else:
            raise HarnessError("schema_error", "%s contains incompatible fields" % path)
    kinds = schema.get("type")
    if kinds:
        kinds = kinds if isinstance(kinds, list) else [kinds]
        checks = {"object": isinstance(value, dict), "array": isinstance(value, list),
                  "string": isinstance(value, str), "boolean": isinstance(value, bool),
                  "integer": type(value) is int,
                  "number": type(value) in (int, float) and math.isfinite(value), "null": value is None}
        if not any(checks.get(kind, False) for kind in kinds):
            raise HarnessError("schema_error", "%s has an invalid type" % path)
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        raise HarnessError("schema_error", "%s has an invalid value" % path)
    if "enum" in schema and not any(value == x and type(value) is type(x) for x in schema["enum"]):
        raise HarnessError("schema_error", "%s has an invalid value" % path)
    if isinstance(value, dict):
        required = schema.get("required", [])
        if any(key not in value for key in required):
            raise HarnessError("schema_error", "%s is missing a required property" % path)
        props = schema.get("properties", {})
        patterns = schema.get("patternProperties", {})
        if schema.get("additionalProperties") is False and any(
                key not in props and not any(re.search(pattern, key) for pattern in patterns) for key in value):
            raise HarnessError("schema_error", "%s contains an unknown property" % path)
        if len(value) < schema.get("minProperties", 0) or len(value) > schema.get("maxProperties", 256):
            raise HarnessError("schema_error", "%s has too many or too few properties" % path)
        for key, item in value.items():
            if key in props:
                validate_schema(item, props[key], contract, "%s.%s" % (path, key), depth + 1)
            for pattern, item_schema in patterns.items():
                if re.search(pattern, key):
                    validate_schema(item, item_schema, contract, "%s.%s" % (path, key), depth + 1)
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", 10000):
            raise HarnessError("schema_error", "%s has too many or too few items" % path)
        if schema.get("uniqueItems") and len({canonical(item) for item in value}) != len(value):
            raise HarnessError("schema_error", "%s contains duplicate items" % path)
        for index, item in enumerate(value):
            if "items" in schema:
                validate_schema(item, schema["items"], contract, "%s[%d]" % (path, index), depth + 1)
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", 1000000):
            raise HarnessError("schema_error", "%s is too long or too short" % path)
        if "pattern" in schema and not re.search(schema["pattern"], value):
            raise HarnessError("schema_error", "%s has an invalid format" % path)
    if type(value) in (int, float):
        if not math.isfinite(value) or value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise HarnessError("schema_error", "%s is outside its allowed range" % path)


def object_schema(properties=None, required=()):
    return {"type": "object", "additionalProperties": False,
            "properties": properties or {}, "required": list(required)}


def validate_endpoint(endpoint):
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Harness endpoint must be http://127.0.0.1:<port>") from None
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not port or
            parsed.username or parsed.password or parsed.path not in ("", "/") or
            parsed.query or parsed.fragment or parsed.netloc != "127.0.0.1:%d" % port):
        raise ValueError("Harness endpoint must be http://127.0.0.1:<port>")
    return "http://127.0.0.1:%d" % port


def _windows_sid():
    output = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], check=True,
                            capture_output=True, text=True, creationflags=0x08000000).stdout
    for row in csv.reader(output.splitlines()):
        for field in row:
            if re.fullmatch(r"S-1-(?:\d+-)*\d+", field):
                return field
    raise OSError("Unable to determine the current Windows SID")


def _windows_private(path):
    """Verify the DACL has only allow ACEs for the current user's SID."""
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    get_security = advapi.GetNamedSecurityInfoW
    get_security.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    get_security.restype = wintypes.DWORD
    convert = advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW
    convert.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                        ctypes.POINTER(wintypes.LPWSTR), ctypes.c_void_p]
    convert.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    text = wintypes.LPWSTR()
    if get_security(str(path), 1, 4, None, None, None, None, ctypes.byref(descriptor)):
        raise OSError("Unable to inspect credential ACL")
    try:
        if not convert(descriptor, 1, 4, ctypes.byref(text), None):
            raise OSError("Unable to inspect credential ACL")
        sid = _windows_sid()
        aliases = {"S-1-5-18": "SY", "S-1-5-19": "LS", "S-1-5-20": "NS"}
        allowed_sid = aliases.get(sid, "LA" if sid.endswith("-500") else "LG" if sid.endswith("-501") else sid)
        aces = re.findall(r"\(([^)]+)\)", text.value)
        if not aces or any(ace.split(";")[0] != "A" or ace.split(";")[-1] not in (sid, allowed_sid) for ace in aces):
            raise OSError("Credential file must allow only the current Windows SID")
    finally:
        if text:
            kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))
        kernel.LocalFree(descriptor)


def assert_private_file(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise OSError("Credential/grant path must be a regular private file")
    if os.name == "nt":
        _windows_private(path)
    elif info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise OSError("Credential/grant file must be owned by this user with mode 0600")


def _windows_restrict_file(path):
    """Replace the new file's entire DACL before writing credentials.

    Removing inherited ACEs and granting the owner does not remove unrelated
    explicit ACEs on a temporary file. Use one protected, owner-only DACL.
    """
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                        ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    convert.restype = wintypes.BOOL
    get_dacl = advapi.GetSecurityDescriptorDacl
    get_dacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL)]
    get_dacl.restype = wintypes.BOOL
    set_security = advapi.SetNamedSecurityInfoW
    set_security.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    set_security.restype = wintypes.DWORD
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    descriptor = ctypes.c_void_p()
    sddl = "D:P(A;;FA;;;%s)" % _windows_sid()
    if not convert(sddl, 1, ctypes.byref(descriptor), None):
        raise OSError("Unable to create private credential ACL")
    try:
        present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ctypes.c_void_p()
        if not get_dacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)) or not present or not dacl:
            raise OSError("Unable to create private credential DACL")
        if set_security(str(path), 1, 4 | 0x80000000, None, None, dacl, None):
            raise OSError("Unable to restrict credential permissions")
    finally:
        kernel.LocalFree(descriptor)


def atomic_json(path, value, private=False):
    """Create an owner-only temporary file before writing any secret bytes."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    temporary = Path(name)
    try:
        if private:
            if os.name == "nt":
                _windows_restrict_file(temporary)
                assert_private_file(temporary)
            else:
                os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            fd = -1
            stream.write(canonical(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if private:
            assert_private_file(path)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


class HarnessBroker:
    def __init__(self, endpoint, desktop_origin="http://tauri.localhost", discovery_path=None,
                 grants_path=None, *, deadline_seconds=30, heartbeat_seconds=30,
                 approval_seconds=300, max_request_bytes=262144, clock=time.time, connector=None):
        self.endpoint = validate_endpoint(endpoint)
        self.desktop_origin = desktop_origin
        self.discovery_path = Path(discovery_path) if discovery_path else None
        self.grants_path = Path(grants_path) if grants_path else None
        self.instance_id = "instance_" + secrets.token_hex(16)
        self.contract = load_contract()
        self.tools = {tool["name"]: tool for tool in self.contract["tools"]}
        self.deadline_seconds = max(0.05, float(deadline_seconds))
        self.heartbeat_seconds = max(0.1, float(heartbeat_seconds))
        self.approval_seconds = max(0.05, float(approval_seconds))
        self.max_request_bytes = min(1048576, max(1024, int(max_request_bytes)))
        self._clock, self._lock = clock, threading.RLock()
        self._request_slots = threading.BoundedSemaphore(16)
        self._sessions, self._tokens, self._pairings = {}, {}, {}
        self._jobs, self._requests, self._approvals, self._idempotency = {}, {}, {}, {}
        self._queue, self._cancellations, self._pair_attempts = deque(), deque(maxlen=128), deque()
        self._renderer_seen = None
        self._renderers, self._session_renderers = {}, {}
        self._preferred_renderer = None
        self._enabled, self._initialized, self._closed = True, False, False
        self._stop_event = threading.Event()
        self._cleanup_thread = None
        # Advertised only to the desktop renderer so its panel can copy a ready
        # MCP client config; never exposed on the external connector routes.
        self.connector = None
        self.client_setup = None
        if isinstance(connector, dict):
            exe, credential = connector.get("exe"), connector.get("credential")
            if isinstance(exe, str) and exe and isinstance(credential, str) and credential:
                self.connector = {"exe": exe, "credential": credential}

    def initialize(self):
        with self._lock:
            if self._closed:
                raise RuntimeError("Broker is closed")
            if self._initialized:
                return self.metadata()
            self._load_grants()
            if self.discovery_path:
                atomic_json(self.discovery_path, self.metadata())
            self._initialized = True
            self._cleanup_thread = threading.Thread(target=self._housekeeping, daemon=True, name="harness-cleanup")
            self._cleanup_thread.start()
            return self.metadata()

    def metadata(self):
        return {"version": 1, "endpoint": self.endpoint, "instanceId": self.instance_id}

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed, self._enabled = True, False
            self._stop_event.set()
            for job in self._jobs.values():
                if job["state"] not in TERMINAL:
                    self._finish(job, "cancelled", "broker_stopped", "Desktop broker stopped")
            self._pairings.clear()
            self._tokens.clear()
            self._sessions.clear()
            if self.discovery_path:
                try:
                    value = strict_json(self.discovery_path.read_text(encoding="utf-8"))
                    if value.get("instanceId") == self.instance_id:
                        self.discovery_path.unlink(missing_ok=True)
                except (OSError, ValueError, AttributeError):
                    pass
        if self._cleanup_thread and self._cleanup_thread is not threading.current_thread():
            self._cleanup_thread.join(timeout=1)

    cleanup = close

    def _housekeeping(self):
        while not self._stop_event.wait(min(0.5, self.heartbeat_seconds / 2)):
            with self._lock:
                self._sweep()

    def _load_grants(self):
        if not self.grants_path or not self.grants_path.exists():
            return
        assert_private_file(self.grants_path)
        if self.grants_path.stat().st_size > 65536:
            raise ValueError("Grant store is too large")
        value = strict_json(self.grants_path.read_text(encoding="utf-8"))
        schema = object_schema({"version": {"const": 1}, "grants": {"type": "array", "maxItems": 64,
            "items": object_schema({"sessionId": self.contract["$defs"]["id"],
                "tokenHash": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                "name": DISPLAY_NAME, "clientName": DISPLAY_NAME, "alias": DISPLAY_NAME,
                "scopes": self.contract["$defs"]["scopes"], "remember": {"const": True},
                "createdAt": {"type": "number", "minimum": 0}},
                ("sessionId", "tokenHash", "name", "scopes", "remember", "createdAt"))}}, ("version", "grants"))
        validate_schema(value, schema, self.contract)
        for stored in value["grants"]:
            if "read" not in stored["scopes"] or stored["sessionId"] in self._sessions or stored["tokenHash"] in self._tokens:
                raise ValueError("Invalid remembered grant store")
            session = dict(stored, lastSeen=0, revoked=False)
            self._sessions[session["sessionId"]] = session
            self._tokens[session["tokenHash"]] = session["sessionId"]

    def _persist_grants(self):
        remembered = [{key: session[key] for key in ("sessionId", "tokenHash", "name", "scopes", "remember", "createdAt", "clientName", "alias") if key in session}
                      for session in self._sessions.values() if session["remember"] and not session["revoked"]]
        if self.grants_path:
            atomic_json(self.grants_path, {"version": 1, "grants": remembered}, private=True)
        elif remembered:
            raise HarnessError("remember_unavailable", "Remembered pairing is not configured", 503)

    def _renderer_live(self, renderer_id=None):
        if renderer_id is not None:
            seen = self._renderers.get(renderer_id)
            return seen is not None and self._clock() - seen <= self.heartbeat_seconds
        return self._renderer_seen is not None and self._clock() - self._renderer_seen <= self.heartbeat_seconds

    def _sweep(self):
        now = self._clock()
        for digest, pairing in list(self._pairings.items()):
            if pairing["expiresAt"] <= now:
                del self._pairings[digest]
        while self._pair_attempts and self._pair_attempts[0] <= now - 60:
            self._pair_attempts.popleft()
        for job in self._jobs.values():
            if job["state"] in TERMINAL:
                continue
            session = self._sessions.get(job["sessionId"])
            if job["deadline"] <= now:
                self._finish(job, "expired", "deadline_exceeded", "Request deadline expired; read revisions before retrying dispatched work")
            elif not self._renderer_live(self._session_renderers.get(job["sessionId"], self._preferred_renderer)):
                self._finish(job, "failed", "renderer_offline", "The paired application window heartbeat expired")
            elif not session or session["revoked"] or now - session["lastSeen"] > self.heartbeat_seconds:
                self._finish(job, "failed", "session_offline", "Connector heartbeat expired")

    def _public_session(self, session):
        client_name = client_display_name(session.get("clientName"))
        alias = display_name(session.get("alias"))
        return {"sessionId": session["sessionId"],
                "name": alias or client_name or client_display_name(session["name"]) or "未命名客户端",
                "clientName": client_name, "alias": alias, "scopes": list(session["scopes"]),
                "rendererId": self._session_renderers.get(session["sessionId"]),
                "remember": session["remember"], "connected": not session["revoked"] and self._clock() - session["lastSeen"] <= self.heartbeat_seconds,
                "lastSeen": session["lastSeen"], "revoked": session["revoked"]}

    def _status(self, session=None):
        value = {"ok": True, "enabled": self._enabled, "instanceId": self.instance_id,
                 "endpoint": self.endpoint, "rendererConnected": self._renderer_live()}
        if session:
            value["session"] = self._public_session(session)
        else:
            value["sessions"] = [self._public_session(item) for item in self._sessions.values()]
            value["counts"] = {"activeJobs": sum(job["state"] not in TERMINAL for job in self._jobs.values()), "pairings": len(self._pairings)}
            if self.connector:
                value["connector"] = dict(self.connector)
        return value

    def _guard(self, handler):
        if handler.client_address[0] != "127.0.0.1":
            raise HarnessError("forbidden_peer", "Only IPv4 loopback clients are accepted", 403)
        hosts = handler.headers.get_all("Host", [])
        if hosts != [urlsplit(self.endpoint).netloc]:
            raise HarnessError("forbidden_host", "Host must match the bound loopback endpoint", 403)
        origins = handler.headers.get_all("Origin", [])
        if origins and origins != [self.desktop_origin]:
            raise HarnessError("forbidden_origin", "Origin is not the desktop origin", 403)
        if "?" in handler.path or "#" in handler.path or "%" in handler.path or "\\" in handler.path:
            raise HarnessError("invalid_path", "Harness routes do not accept query strings or encoded paths", 404)
        if handler.command not in ("GET", "POST", "OPTIONS"):
            raise HarnessError("method_not_allowed", "Unsupported harness HTTP method", 405)

    def _body(self, handler):
        lengths = handler.headers.get_all("Content-Length", [])
        if handler.headers.get("Transfer-Encoding") or len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise HarnessError("invalid_length", "One Content-Length is required", 411)
        length = int(lengths[0])
        if length > self.max_request_bytes:
            raise HarnessError("request_too_large", "Request exceeds the harness byte limit", 413)
        if handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise HarnessError("invalid_content_type", "Content-Type must be application/json", 415)
        previous_timeout = handler.connection.gettimeout()
        try:
            handler.connection.settimeout(5)
            raw = handler.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request body")
            value = strict_json(raw.decode("utf-8"))
        except (ValueError, UnicodeError, RecursionError, TimeoutError, OSError):
            raise HarnessError("invalid_json", "Request must contain bounded valid UTF-8 JSON") from None
        finally:
            handler.connection.settimeout(previous_timeout)
        if not isinstance(value, dict):
            raise HarnessError("schema_error", "Request body must be an object")
        return value

    @staticmethod
    def _send(handler, value, status=200):
        body = canonical(value).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.close_connection = True
        try:
            handler.wfile.write(body)
        except (BrokenPipeError, ConnectionError, OSError):
            pass

    def _route(self, handler, prefix, renderer):
        if not (handler.path == prefix or handler.path.startswith(prefix + "/")):
            return False
        if not self._request_slots.acquire(blocking=False):
            self._send(handler, {"ok": False, "error": {"code": "capacity_exceeded", "message": "Too many concurrent harness HTTP requests"}}, 429)
            return True
        try:
            self._guard(handler)
            path = handler.path[len(prefix):]
            allowed = {"/contract": "GET", "/status": "GET", "/pairing": "POST", "/poll": "POST",
                       "/clients": "GET", "/clients/register": "POST",
                       "/result": "POST", "/approve": "POST", "/rename": "POST", "/revoke": "POST", "/stop": "POST"} if renderer else {
                           "/pair": "POST", "/status": "GET", "/heartbeat": "POST", "/call": "POST", "/revoke": "POST"}
            if path not in allowed:
                raise HarnessError("not_found", "Unknown harness endpoint", 404)
            if handler.command == "OPTIONS":
                handler.send_response(204)
                handler.send_header("Content-Length", "0")
                handler.send_header("Access-Control-Allow-Methods", allowed[path])
                handler.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-StructBoard-Token")
                handler.end_headers()
                return True
            if handler.command != allowed[path]:
                raise HarnessError("method_not_allowed", "HTTP method is not allowed for this route", 405)
            payload = self._body(handler) if handler.command == "POST" else {}
            with self._lock:
                self._sweep()
                if renderer:
                    result = self._renderer(path, payload)
                else:
                    if not self._enabled or self._closed:
                        raise HarnessError("broker_stopped", "Desktop harness has been stopped", 503)
                    if path == "/pair":
                        result = self._pair(payload)
                    else:
                        session = self._authenticate(handler)
                        result = self._external(path, payload, session)
            self._send(handler, result)
        except HarnessError as exc:
            self._send(handler, {"ok": False, "error": exc.public()}, exc.status)
        except (OSError, ValueError, TypeError, KeyError, RecursionError):
            # Never include handler headers, tokens, local paths, or payloads in diagnostics.
            self._send(handler, {"ok": False, "error": {"code": "internal_error", "message": "Harness could not complete this request"}}, 500)
        finally:
            self._request_slots.release()
        return True

    def handle_external(self, handler):
        return self._route(handler, "/harness", False)

    def handle_renderer(self, handler):
        """The embedding DesktopHandler MUST authenticate its private token first."""
        return self._route(handler, "/api/harness", True)

    def _validate(self, payload, schema):
        validate_schema(payload, schema, self.contract)

    def _renderer(self, path, payload):
        if path in ('/clients', '/clients/register'):
            if self.client_setup is None:
                raise HarnessError('desktop_required', '客户端接入向导仅在桌面版提供。', 503)
            if path == '/clients':
                return self.client_setup.list()
            self._validate(payload, object_schema({
                'clientId': {'enum': ['codex', 'workbuddy', 'claude', 'zcode', 'antigravity']},
                'scopes': self.contract['$defs']['scopes'], 'rendererId': self.contract['$defs']['id'],
            }, ('clientId', 'scopes', 'rendererId')))
            return self.client_setup.register(payload['clientId'], payload['scopes'], payload['rendererId'])
        if path == "/contract":
            return {"ok": True, "contract": copy.deepcopy(self.contract)}
        if path == "/status":
            return self._status()
        if path == "/stop":
            self._validate(payload, object_schema())
            self._enabled = False
            self._pairings.clear()
            for session in list(self._sessions.values()):
                self._revoke(session, persist=False)
            self._persist_grants()
            return self._status()
        if self._closed:
            raise HarnessError("broker_stopped", "Desktop harness has been closed", 503)
        if path == "/pairing":
            # This authenticated desktop action explicitly re-enables a stopped broker.
            self._validate(payload, object_schema({"scopes": self.contract["$defs"]["scopes"],
                "remember": {"type": "boolean"}, "sourceName": {"type": "string", "minLength": 1, "maxLength": 80},
                "rendererId": self.contract["$defs"]["id"]}))
            renderer_id = payload.get("rendererId")
            if len(self._pairings) >= 8 or sum(not s["revoked"] for s in self._sessions.values()) >= 64:
                raise HarnessError("capacity_exceeded", "Too many active pairings or sessions", 429)
            if payload.get("remember") and not self.grants_path:
                raise HarnessError("remember_unavailable", "Remembered pairing is not configured", 503)
            scopes = sorted(set(payload.get("scopes", ["read"])) | {"read"})
            self._enabled = True
            code = secrets.token_urlsafe(18)
            expires = self._clock() + 300
            self._pairings[hashlib.sha256(code.encode()).hexdigest()] = {
                "scopes": scopes, "remember": payload.get("remember", False), "expiresAt": expires,
                "sourceName": payload.get("sourceName"), "rendererId": renderer_id}
            return {"ok": True, "code": code, "expiresAt": expires, "scopes": scopes}
        if not self._enabled and path not in ("/poll", "/revoke"):
            raise HarnessError("broker_stopped", "Desktop harness has been stopped", 503)
        if path == "/poll":
            self._validate(payload, object_schema({"limit": {"type": "integer", "minimum": 1, "maximum": 32},
                "rendererId": self.contract["$defs"]["id"], "focused": {"type": "boolean"}}))
            renderer_id = payload.get("rendererId", "legacy")
            self._renderers[renderer_id] = self._clock()
            if payload.get("focused") or self._preferred_renderer is None:
                self._preferred_renderer = renderer_id
            self._renderer_seen = self._clock()
            messages = []
            examined = len(self._queue)
            while self._queue and examined > 0 and len(messages) < payload.get("limit", 16):
                examined -= 1
                request_id = self._queue.popleft()
                job_id = self._requests.get(request_id)
                job = self._jobs.get(job_id)
                if not job or job["requestId"] != request_id or job["state"] in TERMINAL:
                    continue
                owner = self._session_renderers.get(job["sessionId"])
                if owner is None:
                    owner = self._preferred_renderer or renderer_id
                    self._session_renderers[job["sessionId"]] = owner
                if owner != renderer_id:
                    self._queue.append(request_id)
                    continue
                job["_dispatched"] = True
                job["state"] = "preparing" if job["_phase"] == "prepare" else "running"
                job["updatedAt"] = self._clock()
                messages.append(self._message(job))
            approvals = [self._approval(job) for job in self._jobs.values() if job["state"] == "approval_required"
                         and self._session_renderers.get(job["sessionId"], renderer_id) == renderer_id]
            cancellations = []
            remaining = deque(maxlen=128)
            for cancel in self._cancellations:
                job = self._jobs.get(self._requests.get(cancel["requestId"]))
                if not job or self._session_renderers.get(job["sessionId"], renderer_id) == renderer_id:
                    cancellations.append(cancel)
                else:
                    remaining.append(cancel)
            self._cancellations = remaining
            return {"ok": True, "messages": messages, "sessions": [self._public_session(s) for s in self._sessions.values()
                    if self._session_renderers.get(s["sessionId"], s.get("rendererId", renderer_id)) == renderer_id],
                    "approvals": approvals, "cancellations": cancellations}
        if path == "/result":
            return self._renderer_result(payload)
        if path == "/approve":
            return self._approve(payload)
        if path == "/rename":
            self._validate(payload, object_schema({"sessionId": self.contract["$defs"]["id"],
                "rendererId": self.contract["$defs"]["id"], "alias": DISPLAY_NAME}, ("sessionId", "rendererId", "alias")))
            session = self._sessions.get(payload["sessionId"])
            owner = self._session_renderers.get(payload["sessionId"])
            if not session or session["revoked"] or (owner and owner != payload["rendererId"]):
                raise HarnessError("session_not_found", "No active grant for this window", 404)
            alias = display_name(payload["alias"])
            if not alias:
                raise HarnessError("schema_error", "Enter a display name")
            self._set_display_field(session, "alias", alias)
            return {"ok": True, "session": self._public_session(session)}
        if path == "/revoke":
            self._validate(payload, object_schema({"sessionId": self.contract["$defs"]["id"]}, ("sessionId",)))
            session = self._sessions.get(payload["sessionId"])
            if not session:
                raise HarnessError("session_not_found", "Unknown paired session", 404)
            self._revoke(session)
            return {"ok": True, "sessionId": session["sessionId"], "revoked": True}
        raise HarnessError("not_found", "Unknown renderer endpoint", 404)

    def _pair(self, payload):
        self._validate(payload, object_schema({"code": {"type": "string", "minLength": 20, "maxLength": 80,
            "pattern": "^[A-Za-z0-9_-]+$"}, "name": {"type": "string", "minLength": 1, "maxLength": 80,
            "pattern": "^[^\\x00-\\x1f]+$"}}, ("code", "name")))
        if len(self._pair_attempts) >= 30:
            raise HarnessError("rate_limited", "Too many pairing attempts; try again later", 429)
        self._pair_attempts.append(self._clock())
        digest = hashlib.sha256(payload["code"].encode()).hexdigest()
        pairing = self._pairings.pop(digest, None)
        if not pairing or pairing["expiresAt"] <= self._clock():
            raise HarnessError("invalid_pairing_code", "Pairing code is invalid, expired, or already used", 401)
        token = secrets.token_urlsafe(32)
        session_id = "session_" + secrets.token_hex(16)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        session = {"sessionId": session_id, "tokenHash": token_hash,
                   "name": display_name(pairing["sourceName"] or payload["name"]) or "MCP connector", "scopes": pairing["scopes"],
                   "remember": pairing["remember"], "createdAt": self._clock(), "lastSeen": self._clock(), "revoked": False}
        self._sessions[session_id], self._tokens[token_hash] = session, session_id
        if pairing.get("rendererId"):
            self._session_renderers[session_id] = pairing["rendererId"]
        try:
            if session["remember"]:
                self._persist_grants()
        except Exception:
            self._sessions.pop(session_id, None)
            self._tokens.pop(token_hash, None)
            raise
        return {"ok": True, "token": token, "sessionId": session_id, "scopes": session["scopes"],
                "remember": session["remember"], "instanceId": self.instance_id, "heartbeatSeconds": self.heartbeat_seconds}

    def _authenticate(self, handler):
        values = handler.headers.get_all("Authorization", [])
        if len(values) != 1 or not re.fullmatch(r"Bearer [A-Za-z0-9_-]{40,100}", values[0]):
            raise HarnessError("unauthorized", "A paired harness grant is required", 401)
        digest = hashlib.sha256(values[0][7:].encode()).hexdigest()
        session_id = self._tokens.get(digest)
        session = self._sessions.get(session_id)
        if not session or session["revoked"] or not secrets.compare_digest(digest, session["tokenHash"]):
            raise HarnessError("unauthorized", "Paired harness grant is invalid or revoked", 401)
        session["lastSeen"] = self._clock()
        return session

    def _set_display_field(self, session, field, value):
        previous = session.get(field)
        if previous == value:
            return
        session[field] = value
        if session["remember"]:
            try:
                self._persist_grants()
            except Exception:
                if previous is None:
                    session.pop(field, None)
                else:
                    session[field] = previous
                raise

    def _external(self, path, payload, session):
        if path == "/status":
            self._validate(payload, object_schema())
            return self._status(session)
        if path == "/heartbeat":
            self._validate(payload, object_schema({"clientName": DISPLAY_NAME}))
            name = client_display_name(payload.get("clientName"))
            if name:
                self._set_display_field(session, "clientName", name)
            return self._status(session)
        if path == "/revoke":
            self._validate(payload, object_schema())
            self._revoke(session)
            return {"ok": True, "revoked": True, "sessionId": session["sessionId"]}
        self._validate(payload, object_schema({"tool": {"type": "string", "enum": list(self.tools)},
            "args": {"type": "object"}}, ("tool", "args")))
        tool, args = payload["tool"], payload["args"]
        definition = self.tools[tool]
        self._validate(args, definition["inputSchema"])
        if definition["scope"] not in session["scopes"]:
            raise HarnessError("scope_denied", "This paired grant does not allow the requested tool", 403)
        if tool in ("sb_get_job", "sb_cancel_job"):
            job = self._jobs.get(args["jobId"])
            if not job or job["sessionId"] != session["sessionId"]:
                raise HarnessError("job_not_found", "No job with that ID belongs to this session", 404)
            if tool == "sb_cancel_job" and job["state"] not in TERMINAL:
                self._finish(job, "cancelled", "cancelled", "Cancellation requested; dispatched work may already have committed. Read revisions before retrying")
            return {"ok": True, "job": self._public_job(job)}
        if tool == "sb_pipeline_apply":
            for operation in args["operations"]:
                patch = operation.get("patch", {})
                for key in ("dir", "globs", "starGlobs", "files"):
                    paths = patch.get(key, [])
                    paths = [paths] if isinstance(paths, str) else paths
                    for path_value in paths:
                        path_value = path_value["path"] if isinstance(path_value, dict) else path_value
                        if (ntpath.isabs(path_value) or ntpath.splitdrive(path_value)[0] or ":" in path_value or
                                ".." in path_value.replace("\\", "/").split("/")):
                            raise HarnessError("invalid_path", "Pipeline edits accept relative paths within the existing authorized root only")
        args_hash = hashlib.sha256(canonical(args).encode()).hexdigest()
        idempotency = None
        if "idempotencyKey" in args:
            idempotency = (session["sessionId"], tool, hashlib.sha256(args["idempotencyKey"].encode()).hexdigest())
            previous = self._idempotency.get(idempotency)
            if previous:
                if previous[0] != args_hash:
                    raise HarnessError("idempotency_conflict", "That idempotency key was used with different arguments", 409)
                return {"ok": True, "job": self._public_job(self._jobs[previous[1]])}
        if not self._renderer_live():
            raise HarnessError("renderer_offline", "Desktop renderer is not polling", 503)
        bound_renderer = self._session_renderers.get(session["sessionId"])
        if bound_renderer is None:
            bound_renderer = self._preferred_renderer or "legacy"
            self._session_renderers[session["sessionId"]] = bound_renderer
        if not self._renderer_live(bound_renderer):
            raise HarnessError("renderer_offline", "The paired window is no longer available; reconnect to the intended window", 503)
        active = [job for job in self._jobs.values() if job["state"] not in TERMINAL]
        if len(active) >= 64 or sum(job["sessionId"] == session["sessionId"] for job in active) >= 8 or len(self._jobs) >= 2048:
            raise HarnessError("capacity_exceeded", "Harness request capacity is full; wait or pair a new session", 429)
        now = self._clock()
        request_id = "request_" + secrets.token_hex(16)
        job_id = "job_" + secrets.token_hex(16)
        needs_approval = tool in ("sb_pipeline_apply", "sb_canvas_undo") or (
            tool == "sb_canvas_apply" and any(op["op"] in ("node.delete", "edge.disconnect") for op in args["operations"]))
        job = {"jobId": job_id, "requestId": request_id, "sessionId": session["sessionId"], "_rendererId": bound_renderer, "tool": tool,
               "state": "queued", "createdAt": now, "updatedAt": now, "deadline": now + self.deadline_seconds,
               "_args": copy.deepcopy(args), "_phase": "prepare" if needs_approval else "execute", "_dispatched": False}
        self._jobs[job_id] = job
        self._requests[request_id] = job_id
        self._queue.append(request_id)
        if idempotency:
            self._idempotency[idempotency] = (args_hash, job_id)
        return {"ok": True, "job": self._public_job(job)}

    def _public_job(self, job):
        value = {key: copy.deepcopy(item) for key, item in job.items() if not key.startswith("_")}
        self._validate(value, {"$ref": "#/$defs/job"})
        return value

    def _message(self, job):
        session = self._sessions[job["sessionId"]]
        value = {"v": 1, "requestId": job["requestId"], "sessionId": job["sessionId"],
                 "tool": job["tool"], "args": copy.deepcopy(job["_args"]), "scopes": list(session["scopes"]),
                 "source": {"name": self._public_session(session)["name"]}, "deadline": job["deadline"], "phase": job["_phase"]}
        if job["_phase"] == "apply":
            value.update(diff=copy.deepcopy(job["diff"]), diffHash=job["diffHash"])
            if "_prepared" in job:
                value["prepared"] = job["_prepared"]
        return value

    def _approval(self, job):
        return {"requestId": job["requestId"], "sessionId": job["sessionId"], "tool": job["tool"],
                "args": copy.deepcopy(job["_args"]), "source": {"name": self._public_session(self._sessions[job["sessionId"]])["name"]},
                "diff": copy.deepcopy(job["diff"]), "diffHash": job["diffHash"], "deadline": job["deadline"]}

    def _renderer_result(self, payload):
        schema = object_schema({"requestId": self.contract["$defs"]["id"], "rendererId": self.contract["$defs"]["id"], "ok": {"type": "boolean"},
            "result": {"type": "object"}, "error": self.contract["$defs"]["error"],
            "revision": {"anyOf": [self.contract["$defs"]["revision"], self.contract["$defs"].get("canvasRevision", {})]},
            "durability": {"enum": list(DURABILITIES)}}, ("requestId", "ok"))
        self._validate(payload, schema)
        if payload["ok"] != ("result" in payload) or payload["ok"] == ("error" in payload):
            raise HarnessError("schema_error", "Renderer result must contain exactly result or error matching ok")
        job = self._jobs.get(self._requests.get(payload["requestId"]))
        if not job or job["state"] in TERMINAL or not job["_dispatched"]:
            raise HarnessError("request_not_found", "Renderer request is stale, cancelled, or was not dispatched", 409)
        if job.get("_rendererId") != payload.get("rendererId"):
            raise HarnessError("renderer_mismatch", "This request belongs to a different application window", 409)
        if not payload["ok"]:
            self._finish(job, "failed", payload["error"]["code"], payload["error"]["message"])
            return {"ok": True, "job": self._public_job(job)}
        result = payload["result"]
        try:
            if job["_phase"] == "prepare":
                self._validate(result, object_schema({"diff": self.contract["$defs"]["diff"],
                    "prepared": self.contract["$defs"]["id"]}, ("diff",)))
                bound = {"tool": job["tool"], "args": job["_args"], "diff": result["diff"], "prepared": result.get("prepared")}
                job["diff"] = copy.deepcopy(result["diff"])
                job["diffHash"] = hashlib.sha256(canonical(bound).encode()).hexdigest()
                if "prepared" in result:
                    job["_prepared"] = result["prepared"]
                job["state"], job["updatedAt"] = "approval_required", self._clock()
                job["deadline"] = self._clock() + self.approval_seconds
                self._requests.pop(job["requestId"], None)
                self._approvals[job["requestId"]] = job["jobId"]
            else:
                self._validate(result, self.tools[job["tool"]]["resultSchema"])
                if len(canonical(result).encode("utf-8")) > self.contract["limits"]["responseBytes"]:
                    raise HarnessError("schema_error", "Renderer result exceeds the response byte limit")
                if "revision" in payload and result.get("revision") != payload["revision"]:
                    raise HarnessError("schema_error", "Envelope and result revisions must match")
                job["result"] = copy.deepcopy(result)
                if "revision" in result or "revision" in payload:
                    job["revision"] = result.get("revision", payload.get("revision"))
                if "durability" in payload:
                    job["durability"] = payload["durability"]
                elif isinstance(result.get("durability"), str):
                    job["durability"] = result["durability"]
                elif isinstance(result.get("durability"), dict):
                    durability = result["durability"]
                    job["durability"] = ("error" if durability.get("localDurable") is False or
                        durability.get("notesLocalDurable") is False else
                        "queued" if durability.get("backendAck") is False else "local")
                self._finish(job, "completed")
        except HarnessError:
            self._finish(job, "failed", "invalid_renderer_result", "Desktop returned a result outside the shared contract")
            raise
        return {"ok": True, "job": self._public_job(job)}

    def _approve(self, payload):
        self._validate(payload, object_schema({"requestId": self.contract["$defs"]["id"], "rendererId": self.contract["$defs"]["id"],
            "diffHash": {"type": "string", "pattern": "^[0-9a-f]{64}$"}, "approve": {"type": "boolean"}},
            ("requestId", "diffHash", "approve")))
        job = self._jobs.get(self._approvals.get(payload["requestId"]))
        if not job or job["state"] != "approval_required":
            raise HarnessError("approval_not_found", "Approval is stale or has already been resolved", 409)
        if job.get("_rendererId") != payload.get("rendererId"):
            raise HarnessError("renderer_mismatch", "This approval belongs to a different application window", 409)
        if not secrets.compare_digest(job["diffHash"], payload["diffHash"]):
            raise HarnessError("diff_mismatch", "Approval does not match the actual prepared diff", 409)
        session = self._sessions[job["sessionId"]]
        if session["revoked"] or self.tools[job["tool"]]["scope"] not in session["scopes"]:
            raise HarnessError("scope_denied", "The paired grant no longer allows this edit", 403)
        self._approvals.pop(job["requestId"], None)
        if not payload["approve"]:
            self._finish(job, "cancelled", "approval_rejected", "Desktop user declined the prepared change")
        else:
            job["requestId"] = "request_" + secrets.token_hex(16)
            job["_phase"], job["_dispatched"], job["state"] = "apply", False, "queued"
            job["updatedAt"], job["deadline"] = self._clock(), self._clock() + self.deadline_seconds
            self._requests[job["requestId"]] = job["jobId"]
            self._queue.append(job["requestId"])
        return {"ok": True, "job": self._public_job(job)}

    def _finish(self, job, state, code=None, message=None):
        if job["state"] in TERMINAL:
            return
        if job.get("_dispatched") and state in ("cancelled", "failed", "expired"):
            self._cancellations.append({"requestId": job["requestId"], "reason": code or state})
        self._requests.pop(job["requestId"], None)
        self._approvals.pop(job["requestId"], None)
        job["state"], job["updatedAt"] = state, self._clock()
        if code:
            job["error"] = {"code": code, "message": message}

    def _revoke(self, session, persist=True):
        session["revoked"] = True
        self._tokens.pop(session["tokenHash"], None)
        for job in self._jobs.values():
            if job["sessionId"] == session["sessionId"] and job["state"] not in TERMINAL:
                self._finish(job, "cancelled", "grant_revoked", "Paired grant was revoked")
        if persist and session["remember"]:
            self._persist_grants()
