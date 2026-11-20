"""Desktop-only MCP onboarding. Fixed client paths; no commands or arbitrary paths."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import time
import tomllib

from harness_broker import HarnessError, atomic_json, assert_private_file

CLIENTS = {
    'codex': ('Codex', '.codex/config.toml', ('mcp_servers',)),
    'workbuddy': ('WorkBuddy', '.workbuddy-ai/mcp.json', ('mcpServers',)),
    'claude': ('Claude Code', '.claude.json', ('mcpServers',)),
    'zcode': ('ZCode', '.zcode/cli/config.json', ('mcp', 'servers')),
    'antigravity': ('Antigravity', '.gemini/config/mcp_config.json', ('mcpServers',)),
}


def _plain_path(path):
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise HarnessError('unsafe_config_path', '配置路径是链接，请在客户端中手动添加。', 409)


def _read(path):
    _plain_path(path)
    if not path.exists():
        return {}, b''
    if path.stat().st_size > 32 * 1024 * 1024:
        raise HarnessError('invalid_client_config', '客户端配置过大，请在客户端中检查。', 409)
    raw = path.read_bytes()
    try:
        text = raw.decode('utf-8-sig')
        value = tomllib.loads(text) if path.suffix == '.toml' else json.loads(text) if text.strip() else {}
        if not isinstance(value, dict):
            raise ValueError()
        return value, raw
    except (ValueError, UnicodeError):
        raise HarnessError('invalid_client_config', '客户端配置格式有误，原文件已保留，请先修复。', 409) from None


def _map(document, keys):
    node = document
    for key in keys:
        node = node.setdefault(key, {})
        if not isinstance(node, dict):
            raise HarnessError('invalid_client_config', 'MCP 配置项必须是对象，原文件已保留。', 409)
    return node


def _toml(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ', '.join(_toml(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{' + ', '.join(_toml(str(k)) + ' = ' + _toml(v) for k, v in value.items()) + '}'
    if isinstance(value, (int, float)):
        return str(value)
    raise HarnessError('invalid_client_config', '现有配置包含不支持的值，请手动添加。', 409)


def merge_config(document, raw, client_id, entry):
    """Replace just this server; assert every unrelated setting survives."""
    updated = copy.deepcopy(document)
    keys = CLIENTS[client_id][2]
    old = _map(updated, keys).get('structboard', {})
    if not isinstance(old, dict):
        raise HarnessError('config_conflict', '已有同名配置，请先在客户端检查 structboard。', 409)
    server = {**old, **entry}
    server.pop('disabled', None)
    if client_id != 'codex':
        server.pop('enabled', None)
    server.pop('url', None)
    server.pop('serverUrl', None)
    _map(updated, keys)['structboard'] = server
    if client_id != 'codex':
        return updated, json.dumps(updated, ensure_ascii=False, indent=2) + '\n'
    text = raw.decode('utf-8-sig')
    # Match quoted as well as ordinary table names. The final parse/equality
    # check rejects unsupported layouts instead of damaging the user's file.
    pattern = re.compile(r'^\s*\[mcp_servers\.(?:structboard|"structboard"|\'structboard\')(?:\.[^\]]+)?\]\s*(?:#.*)?$', re.M)
    starts = list(pattern.finditer(text))
    for start in reversed(starts):
        following = re.search(r'^\s*\[', text[start.end():], re.M)
        end = start.end() + following.start() if following else len(text)
        text = text[:start.start()] + text[end:]
    section = '\n[mcp_servers.structboard]\n' + ''.join(_toml(k) + ' = ' + _toml(v) + '\n' for k, v in server.items())
    text = text.rstrip() + '\n' + section
    try:
        if tomllib.loads(text) != updated:
            raise ValueError()
    except ValueError:
        raise HarnessError('unsupported_client_config', '此 TOML 布局需要手动添加，原文件已保留。', 409) from None
    return updated, text


class ClientSetup:
    def __init__(self, broker, home, credential_dir, executable):
        self.broker = broker
        self.home = Path(home)
        self.credential_dir = Path(credential_dir)
        self.executable = Path(executable)

    def path(self, client_id):
        if client_id not in CLIENTS:
            raise HarnessError('unknown_client', '不支持这个客户端。')
        path = self.home / CLIENTS[client_id][1]
        # Old Antigravity releases used this location. Prefer it only when the
        # new location does not exist, preserving existing user profiles.
        legacy = self.home / '.gemini/antigravity/mcp_config.json'
        if client_id == 'antigravity' and not path.exists() and legacy.exists():
            return legacy
        return path

    def _credential(self, server, client_id):
        if not isinstance(server, dict):
            return None
        args = server.get('args', [])
        if not isinstance(args, list) or '--credential-file' not in args:
            return None
        try:
            path = Path(args[args.index('--credential-file') + 1])
            if path.parent.resolve() != self.credential_dir.resolve():
                return None
            assert_private_file(path)
            value = json.loads(path.read_text(encoding='utf-8'))
            session = self.broker._sessions.get(value['sessionId'])
            digest = hashlib.sha256(value['token'].encode()).hexdigest()
            if not session or session['revoked'] or session['tokenHash'] != digest:
                return None
            # A copied grant belonging to a different client is never reused.
            if session['name'] != CLIENTS[client_id][0]:
                return None
            return path, value, session
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            return None

    def list(self):
        rows = []
        for client_id, (name, relative, keys) in CLIENTS.items():
            path = self.path(client_id)
            row = {'id': client_id, 'name': name, 'configPath': str(path), 'configured': False,
                   'connected': False, 'authorized': False, 'message': ''}
            try:
                document, _ = _read(path)
                server = _map(document, keys).get('structboard')
                row['configured'] = isinstance(server, dict)
                grant = self._credential(server, client_id)
                row['authorized'] = bool(grant)
                if grant:
                    row['connected'] = self.broker._public_session(grant[2])['connected']
                row['message'] = '已连接' if row['connected'] else '已添加，等待客户端加载' if grant else '需要修复授权' if server else '未添加'
            except HarnessError as exc:
                row['error'] = exc.code
                row['message'] = exc.message
            rows.append(row)
        return {'ok': True, 'clients': rows}

    def register(self, client_id, scopes, renderer_id):
        path = self.path(client_id)
        existed = path.exists()
        document, raw = _read(path)
        server = _map(document, CLIENTS[client_id][2]).get('structboard')
        if server and (not isinstance(server, dict) or
                Path(str(server.get('command', ''))).name.casefold() != 'structboardbackend.exe'):
            raise HarnessError('config_conflict', '已有同名的其他服务；请先在客户端处理，未覆盖配置。', 409)
        grant = self._credential(server, client_id)
        requested = sorted(set(scopes) | {'read'})
        if (grant and sorted(grant[2]['scopes']) == requested and
                server.get('command') == str(self.executable) and server.get('enabled') is not False and
                server.get('disabled') is not True):
            return {'ok': True, 'clientId': client_id, 'configPath': str(path), 'reused': True,
                    'message': '已添加。若当前客户端未连接，请刷新 MCP 或重启客户端。'}
        _plain_path(self.credential_dir)
        self.credential_dir.mkdir(parents=True, exist_ok=True)
        credential_path = self.credential_dir / ('connector-' + client_id + '-' + secrets.token_hex(6) + '.json')
        entry = {'command': str(self.executable), 'args': ['--mcp', '--credential-file', str(credential_path),
                                                       '--name', CLIENTS[client_id][0]]}
        if client_id == 'codex':
            entry['enabled'] = True
        else:
            entry['type'] = 'stdio'
        _, text = merge_config(document, raw, client_id, entry)
        # Backup original bytes privately, including a missing-file marker.
        backup = self.credential_dir / 'configuration-backups' / (client_id + '-' + str(time.time_ns()) + '.json')
        atomic_json(backup, {'path': str(path), 'existed': path.exists(), 'bytesHex': raw.hex()}, private=True)
        pairing = self.broker._renderer('/pairing', {'scopes': requested, 'remember': True,
                  'sourceName': CLIENTS[client_id][0], 'rendererId': renderer_id})
        value = self.broker._pair({'code': pairing['code'], 'name': CLIENTS[client_id][0]})
        # Onboarding is a local registration, not a client heartbeat. Only an
        # actual connector request may turn this connection's lamp on.
        self.broker._sessions[value['sessionId']]['lastSeen'] = 0
        config_written = False
        try:
            credential = {'version': 1, **{key: value[key] for key in ('token', 'sessionId', 'scopes', 'remember')}}
            atomic_json(credential_path, credential, private=True)
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() != existed or (path.exists() and path.read_bytes() != raw):
                raise OSError('Configuration changed concurrently')
            # JSON config and TOML share an owner-only atomic byte writer.
            if client_id != 'codex':
                atomic_json(path, json.loads(text), private=True)
            else:
                _atomic_text(path, text)
            config_written = True
            if client_id == 'workbuddy':
                approval_path = path.with_name('mcp-approvals.json')
                approvals, approval_raw = _read(approval_path)
                material = '|'.join([entry['command'], ','.join(sorted(entry['args'])), ''])
                approvals[hashlib.sha256(material.encode()).hexdigest() + '::structboard'] = int(time.time() * 1000)
                atomic_json(backup.with_name(backup.stem + '-trust.json'),
                            {'path': str(approval_path), 'existed': approval_path.exists(), 'bytesHex': approval_raw.hex()}, private=True)
                atomic_json(approval_path, approvals, private=True)
        except Exception:
            # The existing grant remains usable when an update cannot commit.
            self.broker._revoke(self.broker._sessions[value['sessionId']])
            credential_path.unlink(missing_ok=True)
            if config_written:
                if existed:
                    _atomic_text(path, raw.decode('utf-8-sig'))
                else:
                    path.unlink(missing_ok=True)
            raise HarnessError('client_setup_failed', '添加失败，原配置已保留，请检查目录写入权限。', 409) from None
        # Revoke the replaced grant only after the new config is fully saved.
        if grant:
            self.broker._revoke(grant[2])
        return {'ok': True, 'clientId': client_id, 'configPath': str(path), 'reused': False,
                'message': '已添加并保存独立授权。请在客户端刷新 MCP；若没有刷新入口，重启客户端。'}


def _atomic_text(path, text):
    """Protect the file before text is written; credentials never go into TOML."""
    temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(8))
    try:
        atomic_json(temporary, {}, private=True)
        with temporary.open('w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
