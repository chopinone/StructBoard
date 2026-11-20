#!/usr/bin/env python3
"""Connector HTTP/credential tests and an official SDK full stdio subprocess test.

Run with the dedicated environment that installed requirements-mcp.txt. With no
SDK present, stdlib checks still run and the integration test reports the exact
install command instead of implementing an alternate protocol.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness_broker import HarnessError, assert_private_file, canonical, strict_json
from mcp_server import (BrokerClient, CONTEXT_URI, default_discovery_path, discover_endpoint,
                        load_credential, save_credential)
from test_harness_broker import CONTEXT, DIFF, HarnessHTTP

SDK_AVAILABLE = importlib.util.find_spec("mcp") is not None
SDK_INSTRUCTIONS = 'Official SDK unavailable: install with python -m pip install -r "' + str(ROOT / 'requirements-mcp.txt') + '" (mcp==1.26.0)'


class FakeRenderer:
    def __init__(self, http):
        self.http, self.stop_event = http, threading.Event()
        self.failure, self.received = None, []
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while not self.stop_event.is_set():
                status, poll = self.http.renderer("poll", {})
                if status != 200:
                    raise AssertionError(poll)
                for message in poll["messages"]:
                    self.received.append(message)
                    if message["phase"] == "prepare":
                        result = {"diff": DIFF, "prepared": "prepared_test"}
                    elif message["tool"] == "sb_get_context":
                        result = CONTEXT
                    elif message["tool"] == "sb_notes_set":
                        result = {"stepId": message["args"]["stepId"], "saved": True, "revision": "r1", "durability": "queued"}
                    elif message["tool"] == "sb_list_entries":
                        result = {"items": [], "total": 0, "offset": 0, "nextCursor": None, "revision": "r0"}
                    else:
                        status, _ = self.http.renderer("result", {"requestId": message["requestId"], "ok": False,
                            "error": {"code": "NOT_FOUND", "message": "Fake renderer has no matching business object"}})
                        continue
                    status, reply = self.http.renderer("result", {"requestId": message["requestId"], "ok": True, "result": result})
                    if status != 200:
                        raise AssertionError(reply)
                self.stop_event.wait(0.025)
        except Exception as exc:
            self.failure = repr(exc)

    def close(self):
        self.stop_event.set()
        self.thread.join(timeout=3)


class ConnectorTests(unittest.TestCase):
    def test_running_connector_rediscovers_restarted_desktop_without_repairing(self):
        grant = self.http.pair(remember=True)
        credential = {'version': 1, **{key: grant[key] for key in ('token', 'sessionId', 'scopes', 'remember')}}
        discovery = Path(self.temp.name) / 'harness.json'
        client = BrokerClient(self.http.endpoint, credential, self.http.broker.instance_id, discovery=discovery)
        old_instance = client.instance_id
        self.http.close()
        self.http = HarnessHTTP(self.temp.name)
        self.assertNotEqual(old_instance, self.http.broker.instance_id)
        client._heartbeat_seconds = .1
        client.start_heartbeat()
        try:
            deadline = time.monotonic() + 5
            while client.instance_id == old_instance and time.monotonic() < deadline:
                time.sleep(.04)
            self.assertEqual(client.instance_id, self.http.broker.instance_id)
            self.assertEqual(client.status()['session']['sessionId'], credential['sessionId'])
            self.assertEqual(self.http.broker._jobs, {}, 'Reconnect must not replay workspace edits')
        finally:
            client.close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="structboard-mcp-tests-")
        self.http = HarnessHTTP(self.temp.name)
        self.credential_path = Path(self.temp.name) / "connector-credential.json"

    def tearDown(self):
        self.http.close()
        self.temp.cleanup()

    def client(self, scopes=None):
        grant = self.http.pair(scopes)
        save_credential(self.credential_path, grant)
        return BrokerClient(self.http.endpoint, load_credential(self.credential_path), self.http.broker.instance_id), grant

    def test_credential_file_is_explicit_owner_only_and_round_trips(self):
        client, grant = self.client()
        assert_private_file(self.credential_path)
        self.assertEqual(load_credential(self.credential_path)["token"], grant["token"])
        self.assertEqual(client.status()["session"]["sessionId"], grant["sessionId"])
        self.assertNotIn(self.http.renderer_token, self.credential_path.read_text())
        client.close()
        if os.name != "nt":
            os.chmod(self.credential_path, 0o644)
            with self.assertRaises(OSError):
                load_credential(self.credential_path)

    def test_discovery_exact_loopback_and_default_environment(self):
        endpoint, instance = discover_endpoint(discovery=Path(self.temp.name) / "harness.json")
        self.assertEqual((endpoint, instance), (self.http.endpoint, self.http.broker.instance_id))
        for bad in ("http://localhost:8123", "http://127.0.0.2:8123", "https://127.0.0.1:8123", "http://127.0.0.1:8123/path", "http://user:pass@127.0.0.1:8123", "http://127.0.0.1:8123?token=x"):
            with self.assertRaises(ValueError):
                discover_endpoint(endpoint=bad)
        with patch.dict(os.environ, {"STRUCTBOARD_HARNESS_DISCOVERY": str(Path(self.temp.name) / "override.json")}):
            self.assertEqual(default_discovery_path(), Path(self.temp.name) / "override.json")

    def test_client_validates_input_output_and_preserves_real_durability(self):
        client, grant = self.client(["edit"])
        renderer = FakeRenderer(self.http)
        try:
            with self.assertRaises(HarnessError):
                client.call_tool("sb_get_context", {"approved": True})
            job = client.call_tool("sb_get_context", {})
            job = client.wait_job(job)
            self.assertEqual(job["state"], "completed")
            self.assertEqual(job["result"], CONTEXT)
            self.assertNotIn("durability", job)
            mutation = client.call_tool("sb_notes_set", {"stepId": "step_test", "text": "literal note", "expectedRevision": "r0", "idempotencyKey": "connector-note-1"})
            mutation = client.wait_job(mutation)
            self.assertEqual(mutation["state"], "completed")
            self.assertEqual(mutation["durability"], "queued")
            self.assertIsNone(renderer.failure)
        finally:
            renderer.close()
            client.close()

    def test_cli_pair_status_revoke_never_put_secrets_on_stdout(self):
        _, pairing = self.http.renderer("pairing", {"scopes": ["read"]})
        command = [sys.executable, str(ROOT / "mcp_server.py")]
        options = ["--endpoint", self.http.endpoint, "--credential-file", str(self.credential_path)]
        paired = subprocess.run(command + ["pair"] + options, input=pairing["code"] + "\n", text=True,
                                capture_output=True, timeout=15, cwd=str(ROOT.parent))
        self.assertEqual(paired.returncode, 0, paired.stderr)
        self.assertEqual(paired.stdout, "")
        self.assertNotIn(pairing["code"], paired.stderr)
        credential = load_credential(self.credential_path)
        status = subprocess.run(command + ["status"] + options, text=True, capture_output=True, timeout=15, cwd=str(ROOT.parent))
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(status.stdout, "")
        self.assertNotIn(credential["token"], status.stderr)
        revoke = subprocess.run(command + ["revoke"] + options, text=True, capture_output=True, timeout=15, cwd=str(ROOT.parent))
        self.assertEqual(revoke.returncode, 0, revoke.stderr)
        self.assertEqual(revoke.stdout, "")
        self.assertFalse(self.credential_path.exists())
        self.assertEqual(self.http.request("/harness/status", token=credential["token"])[0], 401)

    @unittest.skipUnless(SDK_AVAILABLE, SDK_INSTRUCTIONS)
    def test_stdio_pair_code_auto_pairs_first_launch_via_official_sdk(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.types import Implementation
        self.assertFalse(self.credential_path.exists())
        issued_code = '-' + secrets.token_urlsafe(18)[1:]
        with patch('harness_broker.secrets.token_urlsafe', return_value=issued_code):
            status, pairing = self.http.renderer("pairing", {"scopes": ["read"], "remember": True})
        self.assertEqual(status, 200, pairing)
        error_path = Path(self.temp.name) / "pair-code-stderr.txt"

        async def exercise():
            parameters = StdioServerParameters(command=sys.executable, args=[str(ROOT / "mcp_server.py"), "stdio",
                "--discovery", str(Path(self.temp.name) / "harness.json"), "--credential-file", str(self.credential_path),
                "--pair-code", pairing["code"]], cwd=str(ROOT.parent))
            with error_path.open("w", encoding="utf-8") as error_stream:
                async with stdio_client(parameters, errlog=error_stream) as (read, write):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=15),
                                             client_info=Implementation(name="codex-mcp-client", version="test")) as session:
                        initialized = await session.initialize()
                        self.assertEqual(initialized.serverInfo.name, "structboard")
                        self.assertEqual(len((await session.list_tools()).tools), 14)
                        for _ in range(50):
                            _, state = self.http.renderer("status")
                            if any(item.get("clientName") == "Codex" for item in state["sessions"]):
                                break
                            await asyncio.sleep(0.04)
                        else:
                            self.fail("An idle initialized MCP client did not report its name")

        try:
            asyncio.run(exercise())
        finally:
            pass
        diagnostics = error_path.read_text(encoding="utf-8")
        self.assertIn("paired via one-time code", diagnostics)
        self.assertNotIn(pairing["code"], diagnostics)
        assert_private_file(self.credential_path)
        grant = load_credential(self.credential_path)
        self.assertEqual(self.http.request("/harness/status", token=grant["token"])[0], 200)

    def test_stdio_pair_code_is_inert_once_a_credential_exists(self):
        grant = self.http.pair()
        save_credential(self.credential_path, grant)
        command = [sys.executable, str(ROOT / "mcp_server.py")]
        options = ["--endpoint", self.http.endpoint, "--credential-file", str(self.credential_path)]
        stale = subprocess.run(command + ["stdio"] + options + ["--pair-code", secrets.token_urlsafe(18)],
                               input="", text=True, capture_output=True, timeout=15, cwd=str(ROOT.parent))
        self.assertEqual(stale.returncode, 0, stale.stderr)
        self.assertEqual(stale.stdout, "")
        self.assertIn("--pair-code ignored", stale.stderr)
        self.assertEqual(load_credential(self.credential_path)["token"], grant["token"])

    def test_stdio_pair_code_invalid_first_launch_fails_clean_without_credential(self):
        status, pairing = self.http.renderer("pairing", {"scopes": ["read"]})
        self.assertEqual(status, 200, pairing)
        command = [sys.executable, str(ROOT / "mcp_server.py")]
        options = ["--endpoint", self.http.endpoint, "--credential-file", str(self.credential_path)]
        unissued = '-' + secrets.token_urlsafe(18)[1:]
        self.assertNotEqual(unissued, pairing["code"])
        failed = subprocess.run(command + ["stdio"] + options + ["--pair-code", unissued], input="", text=True,
                                capture_output=True, timeout=15, cwd=str(ROOT.parent))
        self.assertEqual(failed.returncode, 2, failed.stderr)
        self.assertEqual(failed.stdout, "")
        self.assertIn("invalid_pairing_code", failed.stderr)
        self.assertNotIn(unissued, failed.stderr)
        self.assertFalse(self.credential_path.exists())

    @unittest.skipUnless(SDK_AVAILABLE, SDK_INSTRUCTIONS)
    def test_official_sdk_initialize_tools_jobs_resources_prompts_over_stdio_subprocess(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS
        client, grant = self.client(["view", "edit"])
        client.close()
        renderer = FakeRenderer(self.http)
        error_path = Path(self.temp.name) / "sdk-child-stderr.txt"

        async def exercise():
            parameters = StdioServerParameters(command=sys.executable, args=[str(ROOT / "mcp_server.py"),
                "--discovery", str(Path(self.temp.name) / "harness.json"), "--credential-file", str(self.credential_path)], cwd=str(ROOT.parent))
            with error_path.open("w", encoding="utf-8") as error_stream:
                async with stdio_client(parameters, errlog=error_stream) as (read, write):
                    async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=15)) as session:
                        initialized = await session.initialize()
                        self.assertIn(initialized.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS)
                        self.assertEqual(initialized.serverInfo.name, "structboard")
                        self.assertIsNotNone(initialized.capabilities.tools)
                        self.assertIsNotNone(initialized.capabilities.resources)
                        self.assertIsNotNone(initialized.capabilities.prompts)
                        tools = await session.list_tools()
                        self.assertEqual(len(tools.tools), 14)
                        public_names = {tool.name for tool in tools.tools}
                        self.assertIn("sb_canvas_apply", public_names)
                        self.assertNotIn("sb_execute_code", public_names)
                        context = await session.call_tool("sb_get_context", {})
                        self.assertFalse(context.isError)
                        job = context.structuredContent
                        for _ in range(100):
                            if job["state"] in ("completed", "failed", "expired"):
                                break
                            await asyncio.sleep(0.03)
                            result = await session.call_tool("sb_get_job", {"jobId": job["jobId"]})
                            self.assertFalse(result.isError)
                            job = result.structuredContent
                        self.assertEqual(job["state"], "completed", job)
                        self.assertEqual(job["result"], CONTEXT)
                        bad = await session.call_tool("sb_notes_set", {"stepId": "step_test", "text": "note", "expectedRevision": "r0", "idempotencyKey": "sdk-note-1", "approved": True})
                        self.assertTrue(bad.isError)
                        resources = await session.list_resources()
                        self.assertEqual(str(resources.resources[0].uri), CONTEXT_URI)
                        readback = await session.read_resource(CONTEXT_URI)
                        self.assertEqual(strict_json(readback.contents[0].text), CONTEXT)
                        prompts = await session.list_prompts()
                        self.assertEqual(prompts.prompts[0].name, "structboard_context")
                        prompt = await session.get_prompt("structboard_context", {})
                        self.assertIn('"workspaceId":"workspace_test"', prompt.messages[0].content.text)
                        self.assertIsNone(renderer.failure)
        try:
            asyncio.run(exercise())
        finally:
            renderer.close()
        diagnostics = error_path.read_text(encoding="utf-8")
        self.assertNotIn(grant["token"], diagnostics)
        self.assertNotIn(self.http.renderer_token, diagnostics)


if __name__ == "__main__":
    unittest.main(verbosity=2)
