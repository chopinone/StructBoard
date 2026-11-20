"""Run: python tools/test_ai_proxy.py

Starts the REAL serve.py on a local port and a stub multi-format upstream on
another port, then verifies the /api/ai/chat proxy end to end for all three
interface formats (openai-chat / openai-responses / anthropic):
request adaptation (path, auth headers, body shape, thinking budget),
response normalization (JSON + streamed SSE), upstream error shaping,
validation errors, and the http-only loopback rule.
"""
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent
PORT = 8797
UPSTREAM = 8798

SEEN = {'headers': {}, 'bodies': {}}


class StubHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length).decode('utf-8'))
        SEEN['headers'][self.path] = dict(self.headers)
        SEEN['bodies'][self.path] = body
        model = body.get('model') or ''
        stream = bool(body.get('stream'))

        if model == 'boom':
            payload = json.dumps({'error': {'message': 'upstream exploded'}}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if self.path.endswith('/v1/messages'):  # anthropic
            if stream:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.end_headers()
                events = [
                    {'type': 'message_start', 'message': {}},
                    {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': '安'}},
                    {'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': '好'}},
                    {'type': 'message_stop'},
                ]
                for ev in events:
                    self.wfile.write(('event: x\ndata: ' + json.dumps(ev, ensure_ascii=False) + '\n\n').encode('utf-8'))
                    self.wfile.flush()
                return
            payload = json.dumps({'content': [{'type': 'text', 'text': 'OK-echo:' + body['messages'][-1]['content']}]}, ensure_ascii=False).encode('utf-8')
            self._json(payload)
            return

        if self.path.endswith('/responses'):  # openai responses
            if stream:
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.end_headers()
                events = [
                    {'type': 'response.output_text.delta', 'delta': '响'},
                    {'type': 'response.output_text.delta', 'delta': '应好'},
                    {'type': 'response.completed', 'response': {}},
                ]
                for ev in events:
                    self.wfile.write(('data: ' + json.dumps(ev, ensure_ascii=False) + '\n\n').encode('utf-8'))
                    self.wfile.flush()
                return
            payload = json.dumps({'output': [{'type': 'message', 'content': [
                {'type': 'output_text', 'text': 'OK-echo:' + body['input'][-1]['content']}]}]}, ensure_ascii=False).encode('utf-8')
            self._json(payload)
            return

        # openai chat
        if stream:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.end_headers()
            for piece in ('你', '好'):
                self.wfile.write(('data: ' + json.dumps({'choices': [{'delta': {'content': piece}}]}) + '\n\n').encode('utf-8'))
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
            return
        payload = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': 'OK-echo:' + body['messages'][-1]['content']}}]}).encode('utf-8')
        self._json(payload)

    def _json(self, payload):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def post(path, payload):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (PORT, path),
                                 data=json.dumps(payload).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.headers.get('Content-Type', ''), r.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get('Content-Type', ''), exc.read().decode('utf-8', 'replace')


stub = http.server.ThreadingHTTPServer(('127.0.0.1', UPSTREAM), StubHandler)
threading.Thread(target=stub.serve_forever, daemon=True).start()

env = dict(os.environ)
env['STRUCTBOARD_PIPE_DIR'] = str(SRC / 'tmp-ai-test-pipes')
env.pop('STRUCTBOARD_API_TOKEN', None)
server = subprocess.Popen([sys.executable, '-I', str(SRC / 'serve.py'), '--port', str(PORT), '--no-browser'],
                          cwd=str(SRC), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen('http://127.0.0.1:%d/index.html' % PORT, timeout=1).read()
            break
        except Exception:
            time.sleep(0.2)
    else:
        raise SystemExit('serve.py did not start')

    base = 'http://127.0.0.1:%d/v1' % UPSTREAM        # openai 系：地址填到 /v1
    base_anthropic = 'http://127.0.0.1:%d' % UPSTREAM  # anthropic：地址填根，/v1/messages 自动拼
    messages = [{'role': 'system', 'content': '你是助手'},
                {'role': 'user', 'content': '你好'}]

    def mk(fmt, **kw):
        body = {'format': fmt, 'baseUrl': base_anthropic if fmt == 'anthropic' else base,
                'apiKey': 'sk-test-' + fmt,
                'model': 'stub-model', 'messages': messages, 'stream': False}
        body.update(kw)
        return body

    # 1. openai-chat passthrough (path, bearer, body shape)
    status, ctype, raw = post('/api/ai/chat', mk('openai-chat'))
    data = json.loads(raw)
    assert data['data']['choices'][0]['message']['content'] == 'OK-echo:你好', raw[:200]
    hdr = SEEN['headers']['/v1/chat/completions']
    assert hdr.get('Authorization') == 'Bearer sk-test-openai-chat'
    assert SEEN['bodies']['/v1/chat/completions']['messages'][0]['role'] == 'system'
    print('openai-chat ok')

    # 2. openai-responses: input shape, reasoning mapping, normalization out
    status, ctype, raw = post('/api/ai/chat', mk('openai-responses', reasoning_effort='medium'))
    data = json.loads(raw)
    assert data['data']['choices'][0]['message']['content'] == 'OK-echo:你好', raw[:200]
    b = SEEN['bodies']['/v1/responses']
    assert b['input'][0]['role'] == 'system' and b['input'][-1]['role'] == 'user'
    assert b['reasoning'] == {'effort': 'medium'}, b
    assert 'messages' not in b and 'reasoning_effort' not in b
    print('openai-responses ok (reasoning:{effort}, normalized text out)')

    # 3. anthropic: path, x-api-key + version (no bearer), system lifted out,
    #    thinking budget < max_tokens, normalized text out
    status, ctype, raw = post('/api/ai/chat', mk('anthropic', reasoning_effort='high'))
    data = json.loads(raw)
    assert data['data']['choices'][0]['message']['content'] == 'OK-echo:你好', raw[:200]
    hdr = SEEN['headers']['/v1/messages']
    assert hdr.get('x-api-key') == 'sk-test-anthropic'
    assert hdr.get('anthropic-version') == '2023-06-01'
    assert not hdr.get('Authorization')
    b = SEEN['bodies']['/v1/messages']
    assert b['system'] == '你是助手'
    assert all(m['role'] != 'system' for m in b['messages'])
    print('  anthropic body keys:', sorted(b.keys()), 'thinking=', b.get('thinking'), 'max_tokens=', b.get('max_tokens'))
    assert b.get('thinking') == {'type': 'enabled', 'budget_tokens': 20000}, b.get('thinking')
    assert b['max_tokens'] > b['thinking']['budget_tokens']
    print('anthropic ok (x-api-key, system lift, thinking budget)')

    # 4. Streaming normalization for both non-chat formats -> unified chat chunks
    for fmt, expect in [('openai-responses', '响应好'), ('anthropic', '安好')]:
        req = urllib.request.Request('http://127.0.0.1:%d/api/ai/chat' % PORT,
                                     data=json.dumps(mk(fmt, stream=True)).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=20) as r:
            assert 'text/event-stream' in r.headers.get('Content-Type', '')
            whole = r.read().decode('utf-8', 'replace')
        assert 'data: [DONE]' in whole
        deltas = []
        for line in whole.splitlines():
            if line.startswith('data:') and line[5:].strip() not in ('', '[DONE]'):
                obj = json.loads(line[5:].strip())
                d = obj['choices'][0]['delta'].get('content')
                if d:
                    deltas.append(d)
        assert ''.join(deltas) == expect, (fmt, deltas)
    print('stream normalization ok (responses + anthropic -> chat chunks, [DONE])')

    # 5. openai-chat stream stays a raw passthrough (keeps upstream event shape)
    req = urllib.request.Request('http://127.0.0.1:%d/api/ai/chat' % PORT,
                                 data=json.dumps(mk('openai-chat', stream=True)).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        whole = r.read().decode('utf-8', 'replace')
    assert '"delta"' in whole and 'data: [DONE]' in whole and '响应好' not in whole
    print('chat stream passthrough ok')

    # 6. Upstream 5xx shaping + validation errors (format checked too)
    status, ctype, raw = post('/api/ai/chat', mk('openai-chat', model='boom'))
    data = json.loads(raw)
    assert data['ok'] is False and 'upstream exploded' in data['error'], raw[:200]
    for payload, expect in [
        (mk('nope'), 'format'),
        (mk('openai-chat', baseUrl=''), 'baseUrl'),
        (mk('openai-chat', model=''), 'model'),
        (mk('openai-chat', messages=[]), 'messages'),
        (mk('openai-chat', reasoning_effort='turbo'), 'reasoning_effort'),
        (mk('openai-chat', baseUrl='http://10.0.0.5/v1'), 'https'),
        (mk('openai-chat', extra={'temperature': 0.3}), None),
    ]:
        status, ctype, raw = post('/api/ai/chat', payload)
        data = json.loads(raw)
        if expect is None:
            assert data.get('ok') is True, raw[:200]
        else:
            assert data.get('ok') is False and expect in data.get('error', ''), (expect, raw[:200])
    print('error shaping + validation ok')

    print('AI PROXY OK (3 formats)')
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
    stub.shutdown()
