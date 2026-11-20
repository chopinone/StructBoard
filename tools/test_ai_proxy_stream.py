"""Run: python -I tools/test_ai_proxy_stream.py.

Extracts only the allowed AI helpers from serve.py into an isolated fixture. No
server startup, pipeline imports, provider settings, real endpoints or keys.
"""
import ast
import http.client
import io
import json
import socket
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlparse

SOURCE = Path(__file__).resolve().parent.parent / 'serve.py'
parsed = ast.parse(SOURCE.read_text(encoding='utf-8'))
handler = next(item for item in parsed.body if isinstance(item, ast.ClassDef) and item.name == 'Handler')
allowed = []
for item in handler.body:
    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and (item.name.startswith('_ai_') or item.name == '_post_ai_chat'):
        allowed.append(item)
    elif isinstance(item, ast.Assign) and any(isinstance(target, ast.Name) and target.id.startswith('_AI_') for target in item.targets):
        allowed.append(item)
fixture = ast.ClassDef(name='Handler', bases=[], keywords=[], body=allowed, decorator_list=[])
module = ast.fix_missing_locations(ast.Module(body=[fixture], type_ignores=[]))
namespace = {'http': __import__('http'), 'json': json, 'time': time, 'urlparse': urlparse}
exec(compile(module, str(SOURCE), 'exec'), namespace)
Handler = namespace['Handler']


def data(obj):
    return ('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8')


class Upstream:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.closed = False
        self.read1_calls = 0

    def read1(self, size):
        self.read1_calls += 1
        item = self.chunks.pop(0) if self.chunks else b''
        if isinstance(item, Exception):
            raise item
        return item

    def read(self, size):
        raise AssertionError('buffering read(n) must not be used for SSE')

    def close(self):
        self.closed = True


class View:
    def __init__(self, disconnect=False):
        self.parts = []
        self.disconnect = disconnect
        self.flushes = 0

    def write(self, value):
        if self.disconnect:
            raise BrokenPipeError('browser stopped')
        self.parts.append(value)

    def flush(self):
        self.flushes += 1

    def text(self):
        return b''.join(self.parts).decode('utf-8')


class AIProxyStreamTests(unittest.TestCase):
    def forward(self, fmt, chunks, disconnect=False):
        h = Handler()
        h.wfile = View(disconnect=disconnect)
        h.responses = []
        h.send_response = h.responses.append
        h.send_header = lambda *args: None
        h.end_headers = lambda: None
        upstream = Upstream(chunks)
        h._ai_stream_forward(upstream, fmt)
        self.assertTrue(upstream.closed)
        self.assertEqual(h.responses, [200])
        return h.wfile.text(), upstream, h.wfile

    def assert_failed(self, fmt, chunks, expected):
        text, upstream, view = self.forward(fmt, chunks)
        self.assertIn(expected, text)
        self.assertIn('"error"', text)
        self.assertNotIn('data: [DONE]', text)
        return text

    def test_normal_provider_terminal_closes_without_waiting_for_eof(self):
        cases = [
            ('openai-chat', [data({'choices': [{'delta': {'content': '小'}}]}), b'data: [DONE]\n\n']),
            ('openai-chat', [data({'choices': [{'delta': {'content': '小'}, 'finish_reason': 'stop'}]})]),
            ('openai-responses', [data({'type': 'response.output_text.delta', 'delta': '小'}), data({'type': 'response.completed', 'response': {'status': 'completed'}})]),
            ('anthropic', [data({'type': 'content_block_delta', 'delta': {'type': 'text_delta', 'text': '小'}}), data({'type': 'message_stop'})]),
        ]
        for fmt, chunks in cases:
            with self.subTest(fmt=fmt, chunks=len(chunks)):
                text, up, view = self.forward(fmt, chunks + [TimeoutError('must not read after terminal')])
                self.assertIn('小', text)
                self.assertIn('data: [DONE]', text)
                self.assertNotIn('error', text)
                self.assertEqual(up.read1_calls, len(chunks))
                self.assertGreaterEqual(view.flushes, len(chunks))

    def test_truncated_streams_all_formats(self):
        for fmt in ('openai-chat', 'openai-responses', 'anthropic'):
            with self.subTest(fmt=fmt):
                self.assert_failed(fmt, [], '缺少结束事件')

    def test_provider_error_events(self):
        cases = [
            ('openai-chat', {'error': {'message': 'overloaded'}}),
            ('openai-responses', {'type': 'response.failed', 'response': {'error': {'message': 'provider failed'}}}),
            ('openai-responses', {'type': 'response.incomplete', 'response': {'incomplete_details': {'reason': 'max_output_tokens'}}}),
            ('openai-responses', {'type': 'response.completed', 'response': {'status': 'failed', 'error': {'message': 'late failure'}}}),
            ('anthropic', {'type': 'error', 'error': {'message': 'overloaded'}}),
            ('anthropic', {'type': 'message_delta', 'delta': {'stop_reason': 'max_tokens'}}),
            ('openai-chat', {'choices': [{'delta': {}, 'finish_reason': 'length'}]}),
            ('openai-chat', {'choices': [{'delta': {'tool_calls': [{'id': 'x'}]}}]}),
        ]
        for fmt, event in cases:
            with self.subTest(fmt=fmt, event=event):
                self.assert_failed(fmt, [data(event), b'data: [DONE]\n\n'], 'error')

    def test_timeout_after_headers_emits_sse_error_only(self):
        text = self.assert_failed('openai-chat', [data({'choices': [{'delta': {'content': 'partial'}}]}), TimeoutError('stub timed out')], 'timed out')
        self.assertIn('partial', text)
        self.assertNotIn('HTTP/', text)

    def test_disconnect_closes_upstream(self):
        text, upstream, view = self.forward('openai-chat', [data({'choices': [{'delta': {'content': 'delta'}}]})], disconnect=True)
        self.assertEqual(text, '')
        self.assertEqual(upstream.read1_calls, 1)

    def test_fragmented_utf8_crlf_and_tail_terminal(self):
        raw = data({'choices': [{'delta': {'content': '中文'}}]}).replace(b'\n', b'\r\n') + b'data: [DONE]'
        text, _, _ = self.forward('openai-chat', [raw[i:i + 1] for i in range(len(raw))])
        self.assertIn('中文', text)
        self.assertIn('data: [DONE]', text)

    def test_invalid_json_is_error(self):
        self.assert_failed('openai-chat', [b'data: not-json\n\n'], '无效 SSE JSON')

    def test_silent_upstream_socket_is_cancelled_on_browser_abort(self):
        client, peer = socket.socketpair()
        upstream, upstream_peer = socket.socketpair()
        h = Handler()
        h.connection = client
        class Conn:
            sock = None  # HTTP/1.0 getresponse detaches this even while its response is being read.
            closed = False
            def close(self):
                self.closed = True
        conn = Conn()
        done, cancelled = threading.Event(), threading.Event()
        watcher = threading.Thread(target=h._ai_watch_disconnect, args=(conn, done, cancelled, upstream), daemon=True)
        watcher.start()
        try:
            peer.close()
            self.assertTrue(cancelled.wait(1), 'browser abort must cancel without waiting for upstream data')
            watcher.join(timeout=1)
            self.assertTrue(conn.closed)
            upstream_peer.settimeout(1)
            self.assertEqual(upstream_peer.recv(1), b'')
        finally:
            done.set()
            client.close()
            upstream.close()
            upstream_peer.close()

    def test_first_delta_is_flushed_before_next_upstream_read(self):
        h = Handler()
        h.wfile = View()
        h.send_response = lambda *args: None
        h.send_header = lambda *args: None
        h.end_headers = lambda: None
        view = h.wfile
        class Incremental(Upstream):
            def read1(self, size):
                if self.read1_calls == 1:
                    self_outer.assertIn('first', view.text())
                    self_outer.assertGreater(view.flushes, 0)
                return super().read1(size)
        self_outer = self
        upstream = Incremental([data({'choices': [{'delta': {'content': 'first'}}]}), b'data: [DONE]\n\n'])
        h._ai_stream_forward(upstream, 'openai-chat')
        self.assertTrue(upstream.closed)

    def test_nonstream_failure_and_incomplete_are_not_normalized_to_success(self):
        cases = [
            ('openai-chat', {'error': {'message': 'failed'}}),
            ('openai-chat', {'choices': [{'message': {'content': 'partial'}, 'finish_reason': 'length'}]}),
            ('openai-chat', {'choices': []}),
            ('openai-responses', {'status': 'incomplete', 'output': []}),
            ('openai-responses', {'error': {'message': 'failed'}}),
            ('anthropic', {'type': 'error', 'error': {'message': 'failed'}}),
            ('anthropic', {'stop_reason': 'max_tokens', 'content': [{'type': 'text', 'text': 'partial'}]}),
            ('anthropic', {'content': []}),
        ]
        for fmt, response in cases:
            with self.subTest(fmt=fmt, response=response):
                with self.assertRaises(ValueError):
                    Handler._ai_extract_text(fmt, response)

    def test_extra_cannot_override_protocol_or_enable_native_tools(self):
        payload = {'baseUrl': 'http://127.0.0.1:1/v1', 'model': 'stub', 'messages': [{'role': 'user', 'content': 'hello'}]}
        h = Handler()
        for key in ('stream', 'model', 'messages', 'input', 'system', 'tools', 'tool_choice'):
            with self.subTest(key=key):
                result = h._ai_validate(dict(payload, extra={key: 'override'}))
                self.assertIsNotNone(result[-1])
        self.assertIsNone(h._ai_validate(dict(payload, extra={'temperature': 0.2}))[-1])


if __name__ == '__main__':
    unittest.main(verbosity=2)
