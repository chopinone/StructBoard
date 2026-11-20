"""Real isolated HTTP onboarding and preservation/rollback checks."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(Path(__file__).parent)]
from client_setup import CLIENTS, ClientSetup, merge_config
from harness_broker import assert_private_file, HarnessError
from test_harness_broker import HarnessHTTP


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='structboard-onboarding-')
        self.base = Path(self.temp.name)
        self.http = HarnessHTTP(self.base / 'broker')
        self.setup = ClientSetup(self.http.broker, self.base / '用户 空格', self.base / 'private', self.base / 'app/StructBoardBackend.exe')
        self.http.broker.client_setup = self.setup

    def tearDown(self):
        self.http.close()
        self.temp.cleanup()

    def add(self, client_id, scopes=None):
        return self.http.renderer('clients/register', {'clientId': client_id,
            'scopes': scopes or ['read', 'view'], 'rendererId': 'window_main'})

    def test_all_five_clients_independent_and_preserve_other_settings(self):
        sessions = []
        for client_id in CLIENTS:
            path = self.setup.path(client_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            if client_id == 'codex':
                path.write_text('theme = "dark"\n[mcp_servers.other]\ncommand="other"\n', encoding='utf-8')
            else:
                path.write_text(json.dumps({'untouched': {'value': [1, 2]}}), encoding='utf-8')
            status, result = self.add(client_id)
            self.assertEqual(status, 200, result)
            data = tomllib.loads(path.read_text(encoding='utf-8')) if client_id == 'codex' else json.loads(path.read_text(encoding='utf-8'))
            servers = data
            for key in CLIENTS[client_id][2]:
                servers = servers[key]
            entry = servers['structboard']
            credential = Path(entry['args'][entry['args'].index('--credential-file') + 1])
            assert_private_file(credential)
            grant = json.loads(credential.read_text())
            sessions.append(grant['sessionId'])
            code, value = self.http.request('/harness/status', token=grant['token'])
            self.assertEqual(code, 200, value)
            self.assertEqual(value['session']['name'], CLIENTS[client_id][0])
            self.assertEqual(set(grant['scopes']), {'read', 'view'})
            self.assertNotIn('--pair-code', entry['args'])
            if client_id == 'codex':
                self.assertEqual(data['mcp_servers']['other']['command'], 'other')
                self.assertEqual(data['theme'], 'dark')
            else:
                self.assertEqual(data['untouched'], {'value': [1, 2]})
            self.assertTrue(self.add(client_id)[1]['reused'])
        self.assertEqual(len(set(sessions)), 5)
        status, listing = self.http.renderer('clients')
        self.assertEqual(status, 200)
        self.assertTrue(all(row['authorized'] for row in listing['clients']))
        self.assertEqual(len(self.http.broker._sessions), 5)
        for file in (self.base / 'private/configuration-backups').glob('*.json'):
            assert_private_file(file)

    def test_invalid_config_and_name_conflict_do_not_create_grants(self):
        path = self.setup.path('claude')
        path.parent.mkdir(parents=True, exist_ok=True)
        for text in ('{broken', json.dumps({'mcpServers': {'structboard': {'url': 'https://example.com/mcp'}}})):
            path.write_text(text, encoding='utf-8')
            self.assertEqual(self.add('claude')[0], 409)
            self.assertEqual(path.read_text(encoding='utf-8'), text)
            self.assertFalse(self.http.broker._sessions)

    def test_registration_stays_offline_until_actual_connector_request(self):
        self.assertEqual(self.add('codex')[0], 200)
        _, listing = self.http.renderer('clients')
        row = next(row for row in listing['clients'] if row['id'] == 'codex')
        self.assertTrue(row['authorized'])
        self.assertFalse(row['connected'])
        self.assertIn('等待客户端加载', row['message'])

    def test_endpoints_are_private_and_scope_and_client_are_validated(self):
        self.assertEqual(self.http.request('/api/harness/clients')[0], 401)
        self.assertEqual(self.http.request('/harness/clients')[0], 404)
        self.assertEqual(self.add('arbitrary')[0], 400)
        self.assertEqual(self.add('codex', ['admin'])[0], 400)
        self.assertFalse(self.http.broker._sessions)

    def test_config_write_failure_revokes_only_new_grant(self):
        path = self.setup.path('codex')
        path.parent.mkdir(parents=True, exist_ok=True)
        before = 'theme="dark"\n'
        path.write_text(before, encoding='utf-8')
        with patch('client_setup._atomic_text', side_effect=PermissionError()):
            self.assertEqual(self.add('codex')[0], 409)
        self.assertEqual(path.read_text(encoding='utf-8'), before)
        self.assertFalse(list((self.base / 'private').glob('connector-*.json')))
        self.assertTrue(all(s['revoked'] for s in self.http.broker._sessions.values()))

    def test_toml_preserves_subtables_and_rejects_unsupported_layout(self):
        text = '[mcp_servers.structboard]\ncommand="old"\n[mcp_servers.structboard.env]\nX="yes"\n[features]\nabc=true\n'
        data, merged = merge_config(tomllib.loads(text), text.encode(), 'codex', {'command': 'new', 'args': ['--mcp']})
        self.assertEqual(tomllib.loads(merged)['mcp_servers']['structboard']['env']['X'], 'yes')
        self.assertTrue(data['features']['abc'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
