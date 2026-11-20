#!/usr/bin/env python3
"""Real HTTP broker tests with an explicitly authenticated controlled renderer."""
from __future__ import annotations

import http.client
import http.server
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from harness_broker import HarnessBroker, assert_private_file, atomic_json, canonical, strict_json


class PrivateStorageTests(unittest.TestCase):
    def test_private_json_roundtrip_and_replace(self):
        with tempfile.TemporaryDirectory(prefix='structboard-private-fixture-') as directory:
            target = Path(directory) / 'synthetic-state.json'
            for version in (1, 2):
                value = {'fixture': True, 'version': version}
                atomic_json(target, value, private=True)
                assert_private_file(target)
                self.assertEqual(json.loads(target.read_text(encoding='utf-8')), value)
            self.assertEqual([p.name for p in Path(directory).iterdir()], [target.name])


class Clock:
    def __init__(self):
        self.now = 1000000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class HarnessHTTP:
    """Test adapter mirrors the integration ordering without importing serve.py."""
    def __init__(self, directory, **options):
        self.directory = Path(directory)
        self.renderer_token = secrets.token_urlsafe(40)
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                self.dispatch()

            do_POST = do_OPTIONS = do_DELETE = do_GET

            def dispatch(self):
                if fixture.broker.handle_external(self):
                    return
                if not secrets.compare_digest(self.headers.get("X-StructBoard-Token", ""), fixture.renderer_token):
                    fixture.broker._send(self, {"ok": False, "error": {"code": "unauthorized", "message": "Private renderer auth required"}}, 401)
                    return
                if not fixture.broker.handle_renderer(self):
                    fixture.broker._send(self, {"ok": False, "error": {"code": "not_found", "message": "Unknown route"}}, 404)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.endpoint = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.broker = HarnessBroker(endpoint=self.endpoint, desktop_origin="http://tauri.localhost",
            discovery_path=self.directory / "harness.json", grants_path=self.directory / "grants.json", **options)
        self.broker.initialize()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.broker.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, body=None, *, token=None, renderer=False, headers=None, raw=None, method=None):
        supplied = {"Content-Type": "application/json", "Connection": "close"}
        if token:
            supplied["Authorization"] = "Bearer " + token
        if renderer:
            supplied["X-StructBoard-Token"] = self.renderer_token
        if headers:
            supplied.update(headers)
        raw = raw if raw is not None else (canonical(body).encode("utf-8") if body is not None else None)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            connection.request(method or ("POST" if raw is not None else "GET"), path, raw, supplied)
            response = connection.getresponse()
            value = strict_json(response.read().decode("utf-8"))
            return response.status, value
        finally:
            connection.close()

    def renderer(self, route, payload=None):
        payload = dict(payload) if payload is not None else None
        if payload is None and route in ("pairing", "poll", "result", "approve"):
            payload = {}
        if payload is None:
            return self.request("/api/harness/" + route, renderer=True)
        if route == "pairing": payload.setdefault("rendererId", "legacy")
        if route == "poll":
            payload.setdefault("rendererId", "legacy")
            payload.setdefault("focused", False)
        if route in ("result", "approve"): payload.setdefault("rendererId", "legacy")
        return self.request("/api/harness/" + route, payload, renderer=True)

    def pair(self, scopes=None, remember=False, renderer_id="legacy"):
        self.renderer("poll", {"rendererId": renderer_id, "focused": True})
        status, value = self.renderer("pairing", {"scopes": scopes or ["read"], "remember": remember, "rendererId": renderer_id})
        if status != 200:
            raise AssertionError(value)
        status, grant = self.request("/harness/pair", {"code": value["code"], "name": "test connector"})
        if status != 200:
            raise AssertionError(grant)
        self.renderer("poll", {})
        return grant

    def call(self, grant, tool, args):
        return self.request("/harness/call", {"tool": tool, "args": args}, token=grant["token"])


CONTEXT = {"workspaceId": "workspace_test", "pipelineId": None, "revision": "r0",
    "counts": {"entries": 0, "steps": 0, "folders": 0, "starred": 0,
               "trash": {"entries": 0, "steps": 0, "folders": 0}}, "steps": [], "panes": [], "capabilities": []}
DEFINITION = {"pipelineId": "pipeline_test", "name": "New", "rootToken": "root_test", "steps": []}
DIFF = {"summary": "Rename the selected pipeline", "changes": [{"target": "pipeline_test", "kind": "update", "before": "Old", "after": "New"}]}


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="structboard-broker-tests-")
        self.clock = Clock()
        self.http = HarnessHTTP(self.temp.name, clock=self.clock)

    def tearDown(self):
        self.http.close()
        self.temp.cleanup()

    def job(self, grant, job_id):
        status, value = self.http.call(grant, "sb_get_job", {"jobId": job_id})
        self.assertEqual(status, 200, value)
        return value["job"]

    def test_discovery_is_public_and_cleanup_is_instance_owned(self):
        value = strict_json((Path(self.temp.name) / "harness.json").read_text())
        self.assertEqual(set(value), {"version", "endpoint", "instanceId"})
        self.assertEqual(value["endpoint"], self.http.endpoint)
        self.assertNotIn(self.http.renderer_token, canonical(value))
        self.assertFalse((Path(self.temp.name) / "grants.json").exists())
        self.http.broker.close()
        self.assertFalse((Path(self.temp.name) / "harness.json").exists())

    def test_pairing_is_one_use_five_minutes_and_independent_from_renderer_token(self):
        status, value = self.http.renderer("pairing", {})
        self.assertEqual(status, 200)
        self.assertEqual(value["scopes"], ["read"])
        self.assertEqual(value["expiresAt"], self.clock() + 300)
        status, paired = self.http.request("/harness/pair", {"code": value["code"], "name": "native"})
        self.assertEqual(status, 200, paired)
        self.assertNotEqual(paired["token"], self.http.renderer_token)
        self.assertEqual(self.http.request("/harness/pair", {"code": value["code"], "name": "again"})[0], 401)
        self.assertEqual(self.http.request("/harness/status", token=self.http.renderer_token)[0], 401)
        self.assertEqual(self.http.request("/api/harness/status", token=paired["token"])[0], 401)
        self.assertEqual(self.http.request("/harness/status", token=paired["token"])[0], 200)
        _, other = self.http.renderer("pairing", {})
        self.clock.advance(301)
        self.assertEqual(self.http.request("/harness/pair", {"code": other["code"], "name": "late"})[0], 401)
        _, state = self.http.renderer("status")
        public = canonical(state)
        self.assertNotIn(paired["token"], public)
        self.assertNotIn(value["code"], public)

    def test_multiple_windows_pin_each_connector_to_its_initial_renderer(self):
        grant = self.http.pair(renderer_id="window_main")
        self.http.renderer("poll", {"rendererId": "window_main", "focused": True})
        status, call = self.http.call(grant, "sb_get_context", {})
        self.assertEqual(status, 200, call)
        _, background = self.http.renderer("poll", {"rendererId": "window_detached", "focused": False})
        self.assertEqual(background["messages"], [])
        _, first = self.http.renderer("poll", {"rendererId": "window_main", "focused": True})
        self.assertEqual(len(first["messages"]), 1)
        message = first["messages"][0]
        _, result = self.http.renderer("result", {"requestId": message["requestId"], "rendererId": "window_main", "ok": True, "result": CONTEXT})
        self.assertTrue(result["ok"], result)
        self.http.renderer("poll", {"rendererId": "window_detached", "focused": True})
        status, second = self.http.call(grant, "sb_get_context", {})
        self.assertEqual(status, 200, second)
        _, wrong = self.http.renderer("poll", {"rendererId": "window_detached", "focused": True})
        self.assertEqual(wrong["messages"], [], 'focus changes must not reinterpret existing opaque handles in a different window')
        _, correct = self.http.renderer("poll", {"rendererId": "window_main", "focused": False})
        self.assertEqual(correct["messages"][0]["sessionId"], grant["sessionId"])

    def test_connection_names_and_alias_survive_existing_grants(self):
        grant = self.http.pair(remember=True, renderer_id="window_main")
        _, legacy = self.http.request("/harness/status", token=grant["token"])
        self.assertEqual(legacy["session"]["name"], "test connector")
        session_id = grant["sessionId"]
        try_rename = {"sessionId": session_id, "rendererId": "window_other", "alias": "工作用 Codex"}
        self.assertEqual(self.http.renderer("rename", try_rename)[0], 404)
        self.assertEqual(self.http.request("/harness/rename", try_rename, token=grant["token"])[0], 404)
        status, value = self.http.renderer("rename", {**try_rename, "rendererId": "window_main"})
        self.assertEqual(status, 200, value)
        _, named = self.http.request("/harness/heartbeat", {"clientName": "codex-mcp-client"}, token=grant["token"])
        self.assertEqual(named["session"]["name"], "工作用 Codex")
        self.assertEqual(named["session"]["clientName"], "Codex")
        self.assertEqual(named["session"]["sessionId"], session_id)
        self.assertEqual(named["session"]["scopes"], grant["scopes"])
        self.http.broker.close()
        self.http.broker = HarnessBroker(endpoint=self.http.endpoint, grants_path=self.http.directory / "grants.json", clock=self.clock)
        self.http.broker.initialize()
        _, reopened = self.http.request("/harness/status", token=grant["token"])
        self.assertEqual(reopened["session"]["name"], "工作用 Codex")
        self.assertEqual(reopened["session"]["clientName"], "Codex")

    def test_host_origin_paths_and_methods_are_strict(self):
        grant = self.http.pair()
        for host in ("localhost", "127.0.0.1:1", "evil.example", "127.0.0.1"):
            self.assertEqual(self.http.request("/harness/status", token=grant["token"], headers={"Host": host})[0], 403)
        for origin in ("http://evil.example", "null", "http://localhost:8000", "https://tauri.localhost"):
            self.assertEqual(self.http.request("/harness/status", token=grant["token"], headers={"Origin": origin})[0], 403)
        self.assertEqual(self.http.request("/harness/status", token=grant["token"], headers={"Origin": "http://tauri.localhost"})[0], 200)
        for route in ("status?token=x", "%73tatus", "status/", "../api/harness/status"):
            self.assertEqual(self.http.request("/harness/" + route, token=grant["token"])[0], 404)
        self.assertEqual(self.http.request("/harness/status", token=grant["token"], method="DELETE")[0], 405)
        self.assertEqual(self.http.request("/harness/pair", method="GET")[0], 405)
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server.server_address[1], timeout=5)
        try:
            connection.putrequest("GET", "/harness/status", skip_host=True)
            connection.putheader("Host", self.http.endpoint[7:])
            connection.putheader("Host", self.http.endpoint[7:])
            connection.putheader("Authorization", "Bearer " + grant["token"])
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
        finally:
            connection.close()

    def test_scopes_schema_and_revision_types_are_enforced_before_dispatch(self):
        grant = self.http.pair()
        self.assertEqual(self.http.call(grant, "sb_view_open", {"paneId": "pane_test", "entryIds": ["entry_test"], "mode": "grid"})[0], 403)
        args = {"stepId": "step_test", "text": "note", "expectedRevision": "r0", "idempotencyKey": "notes-test-1"}
        self.assertEqual(self.http.call(grant, "sb_notes_set", args)[0], 403)
        self.assertEqual(self.http.call(grant, "sb_get_context", {"approved": True})[0], 400)
        self.assertEqual(self.http.call(grant, "sb_list_entries", {"limit": 201})[0], 400)
        self.assertEqual(self.http.call(grant, "sb_get_canvas", {"canvasId": "C:\\private\\data"})[0], 400)
        edit = self.http.pair(["read", "edit"])
        self.assertEqual(self.http.call(edit, "sb_notes_set", dict(args, expectedRevision=0))[0], 400)
        self.assertEqual(self.http.call(edit, "sb_notes_set", dict(args, approved=True))[0], 400)
        canvas = {"canvasId": "canvas_test", "expectedRevision": "r0", "operations": [{"op": "node.delete", "id": "node_test"}], "idempotencyKey": "canvas-test-1"}
        self.assertEqual(self.http.call(edit, "sb_canvas_apply", canvas)[0], 400)
        self.assertEqual(self.http.call(edit, "sb_view_open", {"paneId": "pane_test", "stepId": "step_test", "mode": "grid"})[0], 403)
        _, polled = self.http.renderer("poll", {})
        self.assertEqual(polled["messages"], [])

    def test_real_queue_result_output_schema_and_job_ownership(self):
        first, second = self.http.pair(), self.http.pair()
        status, value = self.http.call(first, "sb_get_context", {})
        self.assertEqual(status, 200, value)
        job = value["job"]
        self.assertEqual(job["state"], "queued")
        self.assertEqual(self.http.call(second, "sb_get_job", {"jobId": job["jobId"]})[0], 404)
        _, poll = self.http.renderer("poll", {})
        self.assertEqual(len(poll["messages"]), 1)
        request = poll["messages"][0]
        self.assertEqual(request["sessionId"], first["sessionId"])
        self.assertEqual(request["scopes"], ["read"])
        self.assertEqual(request["phase"], "execute")
        self.assertNotIn(first["token"], canonical(poll))
        status, done = self.http.renderer("result", {"requestId": request["requestId"], "ok": True, "result": CONTEXT})
        self.assertEqual(status, 200, done)
        self.assertEqual(self.job(first, job["jobId"])["result"], CONTEXT)
        self.assertNotIn("durability", self.job(first, job["jobId"]))
        self.assertEqual(self.http.renderer("result", {"requestId": request["requestId"], "ok": True, "result": CONTEXT})[0], 409)
        _, bad = self.http.call(first, "sb_get_context", {})
        _, messages = self.http.renderer("poll", {})
        self.assertEqual(self.http.renderer("result", {"requestId": messages["messages"][0]["requestId"], "ok": True,
            "result": dict(CONTEXT, root="C:/private")})[0], 400)
        self.assertEqual(self.job(first, bad["job"]["jobId"])["error"]["code"], "invalid_renderer_result")

    def test_idempotency_is_once_and_cannot_change_arguments(self):
        grant = self.http.pair(["edit"])
        args = {"stepId": "step_test", "text": "note", "expectedRevision": "r0", "idempotencyKey": "notes-test-1"}
        _, first = self.http.call(grant, "sb_notes_set", args)
        _, duplicate = self.http.call(grant, "sb_notes_set", args)
        self.assertEqual(first["job"]["jobId"], duplicate["job"]["jobId"])
        self.assertEqual(self.http.call(grant, "sb_notes_set", dict(args, text="changed"))[0], 409)
        _, poll = self.http.renderer("poll", {})
        self.assertEqual(len(poll["messages"]), 1)
        self.http.renderer("result", {"requestId": poll["messages"][0]["requestId"], "ok": True,
            "result": {"stepId": "step_test", "saved": True, "revision": "r1", "durability": "queued"}, "revision": "r1", "durability": "queued"})
        _, completed = self.http.call(grant, "sb_notes_set", args)
        self.assertEqual(completed["job"]["state"], "completed")
        self.assertEqual(completed["job"]["durability"], "queued")
        self.assertEqual(self.http.renderer("poll", {})[1]["messages"], [])

    def test_approval_binds_actual_diff_args_and_opaque_preparation(self):
        grant = self.http.pair(["edit"])
        args = {"pipelineId": "pipeline_test", "expectedRevision": "r0", "operations": [{"op": "set_name", "name": "New"}], "idempotencyKey": "pipeline-test-1"}
        _, initial = self.http.call(grant, "sb_pipeline_apply", args)
        _, poll = self.http.renderer("poll", {})
        message = poll["messages"][0]
        self.assertEqual(message["phase"], "prepare")
        self.assertEqual(self.http.renderer("approve", {"requestId": message["requestId"], "diffHash": "a" * 64, "approve": True})[0], 409)
        status, waiting = self.http.renderer("result", {"requestId": message["requestId"], "ok": True,
            "result": {"diff": DIFF, "prepared": "prepared_test"}})
        self.assertEqual(status, 200, waiting)
        job = waiting["job"]
        self.assertEqual(job["state"], "approval_required")
        self.assertEqual(self.http.renderer("poll", {})[1]["messages"], [])
        approval = self.http.renderer("poll", {})[1]["approvals"][0]
        self.assertEqual(approval["diff"], DIFF)
        self.assertEqual(self.http.request("/harness/approve", {"requestId": job["requestId"], "diffHash": job["diffHash"], "approve": True}, token=grant["token"])[0], 404)
        self.assertEqual(self.http.renderer("approve", {"requestId": job["requestId"], "diffHash": "0" * 64, "approve": True})[0], 409)
        _, approved = self.http.renderer("approve", {"requestId": job["requestId"], "diffHash": job["diffHash"], "approve": True})
        self.assertEqual(approved["job"]["jobId"], initial["job"]["jobId"])
        self.assertNotEqual(approved["job"]["requestId"], job["requestId"])
        _, poll = self.http.renderer("poll", {})
        applied = poll["messages"][0]
        self.assertEqual(applied["args"], args)
        self.assertEqual(applied["diffHash"], job["diffHash"])
        self.assertEqual(applied["prepared"], "prepared_test")
        self.assertEqual(applied["phase"], "apply")
        self.http.renderer("result", {"requestId": applied["requestId"], "ok": True,
            "result": {"applied": True, "diff": {"pipelineId": "pipeline_test", "before": DEFINITION, "after": DEFINITION},
                       "definition": DEFINITION, "revision": "r1", "durability": "pipeline"}})
        self.assertEqual(self.job(grant, initial["job"]["jobId"])["state"], "completed")

    def test_pipeline_path_constraints_and_destructive_canvas_requires_approval(self):
        grant = self.http.pair(["edit"])
        for path in ("C:/secret", "../secret", "/secret", "sub/../secret", "sub\\..\\secret", "file:secret", "\\\\host\\share"):
            args = {"pipelineId": "pipeline_test", "expectedRevision": "r0", "idempotencyKey": "pipeline-path-1",
                "operations": [{"op": "update_step", "stepId": "step_test", "patch": {"dir": path}}]}
            self.assertEqual(self.http.call(grant, "sb_pipeline_apply", args)[0], 400, path)
        args = {"canvasId": "canvas_test", "expectedRevision": 0, "operations": [{"op": "node.delete", "id": "node_test"}], "idempotencyKey": "canvas-delete-1"}
        self.assertEqual(self.http.call(grant, "sb_canvas_apply", args)[0], 200)
        self.assertEqual(self.http.renderer("poll", {})[1]["messages"][0]["phase"], "prepare")

    def test_deadline_cancellation_revocation_and_liveness(self):
        grant = self.http.pair()
        _, value = self.http.call(grant, "sb_get_context", {})
        self.clock.advance(31)
        self.assertEqual(self.job(grant, value["job"]["jobId"])["state"], "expired")
        self.http.renderer("poll", {})
        _, value = self.http.call(grant, "sb_get_context", {})
        self.assertEqual(self.http.call(grant, "sb_cancel_job", {"jobId": value["job"]["jobId"]})[1]["job"]["state"], "cancelled")
        self.assertEqual(self.http.renderer("poll", {})[1]["messages"], [])
        _, value = self.http.call(grant, "sb_get_context", {})
        _, poll = self.http.renderer("poll", {})
        request = poll["messages"][0]
        self.http.renderer("revoke", {"sessionId": grant["sessionId"]})
        self.assertEqual(self.http.request("/harness/status", token=grant["token"])[0], 401)
        self.assertEqual(self.http.renderer("result", {"requestId": request["requestId"], "ok": True, "result": CONTEXT})[0], 409)
        cancellations = self.http.renderer("poll", {})[1]["cancellations"]
        self.assertEqual(cancellations[0]["requestId"], request["requestId"])
        other = self.http.pair()
        self.clock.advance(31)
        self.assertEqual(self.http.call(other, "sb_get_context", {})[0], 503)
        self.http.renderer("poll", {})
        self.assertEqual(self.http.call(other, "sb_get_context", {})[0], 200)
        self.assertEqual(self.http.renderer("stop", {})[0], 200)
        self.assertEqual(self.http.request("/harness/status", token=other["token"])[0], 503)

    def test_concurrency_and_request_bytes_are_bounded(self):
        grant = self.http.pair()
        for _ in range(8):
            self.assertEqual(self.http.call(grant, "sb_get_context", {})[0], 200)
        self.assertEqual(self.http.call(grant, "sb_get_context", {})[0], 429)
        self.assertEqual(self.http.request("/harness/call", raw=b"x" * 262145, token=grant["token"])[0], 413)
        self.assertEqual(self.http.request("/harness/call", raw=b'{"tool":"sb_get_context","tool":"sb_get_context","args":{}}', token=grant["token"])[0], 400)
        self.assertEqual(self.http.request("/harness/call", raw=b'{"tool":"sb_get_context","args":{"x":NaN}}', token=grant["token"])[0], 400)
        self.assertEqual(self.http.request("/harness/heartbeat", {}, token=grant["token"], headers={"Content-Type": "text/plain"})[0], 415)
        for _ in range(16):
            self.assertTrue(self.http.broker._request_slots.acquire(blocking=False))
        try:
            self.assertEqual(self.http.request("/harness/heartbeat", {}, token=grant["token"])[0], 429)
        finally:
            for _ in range(16):
                self.http.broker._request_slots.release()

    def test_stop_requires_explicit_new_pairing_and_never_revives_old_grants(self):
        grant = self.http.pair(["edit"])
        self.assertEqual(self.http.renderer("stop", {})[0], 200)
        self.assertEqual(self.http.renderer("poll", {})[0], 200)
        self.assertFalse(self.http.renderer("status")[1]["enabled"])
        self.assertEqual(self.http.request("/harness/status", token=grant["token"])[0], 503)
        status, pairing = self.http.renderer("pairing", {})
        self.assertEqual(status, 200, pairing)
        self.assertTrue(self.http.renderer("status")[1]["enabled"])
        self.assertEqual(self.http.request("/harness/status", token=grant["token"])[0], 401)
        status, fresh = self.http.request("/harness/pair", {"code": pairing["code"], "name": "fresh connector"})
        self.assertEqual(status, 200, fresh)
        self.assertNotEqual(fresh["sessionId"], grant["sessionId"])
        self.assertEqual(fresh["scopes"], ["read"])

    def test_canvas_result_preserves_snapshot_ownership_and_layered_durability(self):
        grant = self.http.pair(["edit"])
        _, queued = self.http.call(grant, "sb_get_canvas", {"canvasId": "canvas_test"})
        _, poll = self.http.renderer("poll", {})
        snapshot = {"canvasId": "canvas_test", "revision": 1, "viewRevision": 2,
            "nodes": [{"id": "node_test", "title": "Node", "tool": "", "desc": "", "note": "", "x": 10, "y": 20,
                "ownership": "base", "manual": False, "base": True, "binding": {"stepId": "step_test"}}],
            "edges": [], "selection": ["node_test"], "viewport": {"scale": 0.85, "tx": 16, "ty": 16},
            "durability": {"rendererApplied": True, "localDurable": True, "backendAck": None}}
        status, done = self.http.renderer("result", {"requestId": poll["messages"][0]["requestId"], "ok": True, "result": snapshot})
        self.assertEqual(status, 200, done)
        self.assertEqual(self.job(grant, queued["job"]["jobId"])["result"], snapshot)
        self.assertEqual(done["job"]["durability"], "local")
        args = {"canvasId": "canvas_test", "expectedRevision": 1, "operations": [{"op": "node.move", "id": "node_test", "x": 20, "y": 30}], "idempotencyKey": "canvas-move-1"}
        self.http.call(grant, "sb_canvas_apply", args)
        _, poll = self.http.renderer("poll", {})
        result = {"canvasId": "canvas_test", "revision": 2, "viewRevision": 2, "changeId": "change_test", "kind": "apply",
            "contentChanged": True, "viewChanged": False, "changedNodeIds": ["node_test"], "rendererApplied": True,
            "localDurable": True, "backendAck": False, "notesLocalDurable": True,
            "durability": {"rendererApplied": True, "localDurable": True, "backendAck": False, "notesLocalDurable": True}}
        status, done = self.http.renderer("result", {"requestId": poll["messages"][0]["requestId"], "ok": True, "result": result})
        self.assertEqual(status, 200, done)
        self.assertEqual(done["job"]["result"], result)
        self.assertEqual(done["job"]["durability"], "queued")

    def test_pipeline_file_objects_and_entry_metrics_use_strict_named_results(self):
        grant = self.http.pair(["edit"])
        args = {"pipelineId": "pipeline_test", "expectedRevision": "r0", "operations": [
            {"op": "update_step", "stepId": "step_test", "patch": {"dir": "", "files": [{"name": "model.pdb", "path": "models/model.pdb"}]}}], "idempotencyKey": "pipeline-files-1"}
        self.assertEqual(self.http.call(grant, "sb_pipeline_apply", args)[0], 200)
        args["operations"][0]["patch"]["files"][0]["path"] = "../private.pdb"
        self.assertEqual(self.http.call(grant, "sb_pipeline_apply", args)[0], 400)
        _, queued = self.http.call(grant, "sb_list_entries", {"includeMetrics": True})
        _, poll = self.http.renderer("poll", {})
        request = next(message for message in poll["messages"] if message["tool"] == "sb_list_entries")
        row = {"entryId": "entry_test", "stepId": "step_test", "name": "model.pdb", "star": False, "format": "pdb", "size": 10,
               "modelIndex": None, "folderId": None, "metrics": {"score": 1.5, "passed": True, "label": "ok"}}
        result = {"revision": "r0", "items": [row], "total": 1, "offset": 0, "nextCursor": None}
        status, done = self.http.renderer("result", {"requestId": request["requestId"], "ok": True, "result": result})
        self.assertEqual(status, 200, done)
        self.assertEqual(self.job(grant, queued["job"]["jobId"])["result"], result)

    def test_remembered_grants_are_hashed_private_and_revocable_across_instances(self):
        grant = self.http.pair(remember=True)
        store = Path(self.temp.name) / "grants.json"
        assert_private_file(store)
        serialized = store.read_text(encoding="utf-8")
        self.assertNotIn(grant["token"], serialized)
        self.assertNotIn(self.http.renderer_token, serialized)
        self.assertIn("tokenHash", serialized)
        self.http.broker.close()
        other = HarnessBroker(endpoint=self.http.endpoint, discovery_path=Path(self.temp.name) / "harness.json", grants_path=store, clock=self.clock)
        other.initialize()
        self.http.broker = other
        self.assertEqual(self.http.request("/harness/status", token=grant["token"])[0], 200)
        self.assertEqual(self.http.renderer("revoke", {"sessionId": grant["sessionId"]})[0], 200)
        self.assertEqual(strict_json(store.read_text())["grants"], [])
        self.assertEqual(self.http.request("/harness/status", token=grant["token"])[0], 401)

    def test_connector_advertisement_reaches_only_the_private_renderer(self):
        self.assertNotIn("connector", self.http.renderer("status")[1])
        self.assertNotIn("connector", self.http.request("/harness/status", token=self.http.pair()["token"])[1])
        exe = str(Path(self.temp.name) / "StructBoardBackend.exe")
        credential = str(Path(self.temp.name) / "connector.json")
        self.http.broker.close()
        configured = HarnessBroker(endpoint=self.http.endpoint, desktop_origin="http://tauri.localhost",
            discovery_path=self.http.directory / "harness.json", grants_path=self.http.directory / "grants.json",
            clock=self.clock, connector={"exe": exe, "credential": credential})
        configured.initialize()
        self.http.broker = configured
        status = self.http.renderer("status")[1]
        self.assertEqual(status["connector"], {"exe": exe, "credential": credential})
        self.assertNotIn("connector", self.http.request("/harness/status", token=self.http.pair()["token"])[1])
        configured.close()
        ignored = HarnessBroker(endpoint=self.http.endpoint, desktop_origin="http://tauri.localhost",
            discovery_path=self.http.directory / "harness.json", grants_path=self.http.directory / "grants.json",
            clock=self.clock, connector={"exe": 7, "credential": None})
        ignored.initialize()
        self.http.broker = ignored
        self.assertNotIn("connector", self.http.renderer("status")[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
