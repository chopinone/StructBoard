#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""StructBoard 本地静态服务（零依赖，只用 Python 标准库）。

默认只监听 127.0.0.1:8000，只有本机能访问。
普通导入由浏览器直接读取本地文件；管线步骤的结构由本机服务按定义读取，
经本地回环地址交给浏览器显示，数据不会上传。

额外的「设计管线」API（/api/*）会读取本机指定目录下的文件清单与 CSV 行数，
用于在界面上展示真实筛选流程；唯一的写入是便签文件 <root>/.pipeline_notes.json。
这些目录由用户在本机指定，数据不出本机。

用法：
    python serve.py                     # 起服务并自动打开系统浏览器
    python serve.py --app               # 用 Chrome/Edge 独立窗口打开（更像桌面软件）
    python serve.py --port 8080         # 换端口（不指定时端口被占会自动顺延）
    python serve.py --no-browser        # 不自动开浏览器
    python serve.py --lan               # 绑定 0.0.0.0 供局域网访问（仅可信网络）

再次双击 / 再次运行时，若 8000 端口上已经有 StructBoard 在跑，会直接把页面唤起，不会起第二个服务。
"""
import argparse
import http.client
import http.server
import json
import os
import socketserver
import sys
import threading
import time
import uuid
import webbrowser
from urllib.parse import urlparse, parse_qs

if getattr(sys, 'frozen', False):
    # 打包后（PyInstaller，--onedir）：静态文件与 pipelines/ 数据在 sys._MEIPASS（即 _internal 目录）
    ROOT = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import pipeline_api  # noqa: E402
import scaffold_pipeline  # noqa: E402

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


IMPORT_LIMIT = 128 * 1024 * 1024
IMPORT_JOBS = {}
IMPORT_LOCK = threading.RLock()

# 允许访问本地 API 的页面来源：本机回环的任意端口，以及 Tauri 的 webview 来源。
# 其它站点（哪怕运行在同一台机器上）不再被授予读取管线/文件的权限。
_ALLOWED_ORIGIN_HOSTS = ('127.0.0.1', 'localhost', '::1')


def _origin_allowed(origin):
    if not origin:
        return False  # file:// 与直接请求不带 Origin，走同源，不需要 CORS 头
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    if parsed.scheme == 'tauri' and parsed.netloc == 'localhost':
        return True
    if parsed.scheme not in ('http', 'https'):
        return False
    host = (parsed.hostname or '').lower()
    return host in _ALLOWED_ORIGIN_HOSTS or host == 'tauri.localhost'


def _running_as_plain_server():
    """True = 用 serve.py 直接对外提供页面（浏览器工作流），而不是被桌面窗口拉起的私有后端。

    桌面窗口拉起的后端一定带 STRUCTBOARD_API_TOKEN；没有 token 就说明是普通的
    serve.py 进程，此时不该允许按任意绝对路径回读本机文件。
    """
    return not os.environ.get('STRUCTBOARD_API_TOKEN')


def _start_import_job(defn, overwrite):
    with IMPORT_LOCK:
        now = time.monotonic()
        for key, old in list(IMPORT_JOBS.items()):
            if old['state'] != 'running' and now - old['updated'] > 1800:
                del IMPORT_JOBS[key]
        if sum(j['state'] == 'running' for j in IMPORT_JOBS.values()) >= 2:
            raise ValueError('已有两个导入任务正在运行，请等待完成')
        if len(IMPORT_JOBS) >= 32:
            oldest = min((k for k, j in IMPORT_JOBS.items() if j['state'] != 'running'),
                         key=lambda k: IMPORT_JOBS[k]['updated'])
            del IMPORT_JOBS[oldest]
        jid = uuid.uuid4().hex
        job = {'state': 'running', 'stage': 'validate', 'title': '校验管线定义',
               'detail': '正在检查步骤与文件路径', 'percent': 0, 'saved': False,
               'updated': now, '_cancel': threading.Event()}
        IMPORT_JOBS[jid] = job

    def update(**values):
        with IMPORT_LOCK:
            job.update(values, updated=time.monotonic())

    def run():
        try:
            ok, errors, warnings = pipeline_api.validate_definition(defn, cancel=job['_cancel'])
            if not ok:
                raise ValueError('; '.join(errors))
            pid = defn['id'].strip()
            if os.path.exists(os.path.join(pipeline_api.PIPE_DIR, pid + '.json')) and not overwrite:
                raise ValueError('已存在同名管线 %s，请勾选覆盖同名管线' % pid)
            update(id=pid, stage='scan', title='扫描管线数据', percent=0)
            last_report = [0.0]
            def report(done, total, title, scanned):
                clock = time.monotonic()
                if scanned is not None and clock - last_report[0] < .15:
                    return
                last_report[0] = clock
                update(stage='scan', title='扫描管线数据', percent=(None if scanned is not None else (done / total * 100 if total else 100)),
                       detail='步骤 %d/%d · %s%s' % (min(done + 1, total), total, title,
                              ' · 已检查 %d 个文件' % scanned if scanned is not None else ''))
            pipeline = pipeline_api.build_pipeline(pid, definition=defn, progress=report, cancel=job['_cancel'])
            with IMPORT_LOCK:
                pipeline_api._check_cancel(job['_cancel'])
                update(stage='save', title='保存管线定义', detail='正在原子写入管线定义', percent=None)
                ok, message, pid = pipeline_api.import_definition(defn, overwrite=overwrite)
                if not ok:
                    raise ValueError(message)
                update(saved=True)
                result = {'id': pid, 'pipeline': pipeline, 'pipelines': pipeline_api.list_pipelines(),
                          'message': message, 'warnings': warnings}
                update(state='done', stage='done', title='导入完成', percent=100,
                       detail='已保存管线「%s」' % pid, result=result)
        except InterruptedError:
            update(state='cancelled', stage='cancelled', title='已取消导入', percent=None,
                   detail='已停止，未保存管线定义')
        except Exception as exc:
            update(state='error', stage='error', title='导入失败', percent=None,
                   error=str(exc), detail=str(exc))
    threading.Thread(target=run, daemon=True).start()
    return jid


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows 上 .js 常被注册表映射成 text/plain，会让浏览器拒绝执行，这里显式覆盖
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.csv': 'text/csv; charset=utf-8',
        '.cif': 'text/plain; charset=utf-8',
        '.mmcif': 'text/plain; charset=utf-8',
        '.pdb': 'text/plain; charset=utf-8',
        '.gz': 'application/gzip',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 改完代码刷新即可生效，不吃浏览器缓存
        self.send_header('Cache-Control', 'no-store, max-age=0')
        # 只回显本机来源，不再用 *：否则任何本地网页都能读 /api/local/read 与管线数据。
        # 桌面版另有 token 校验；这里保证 serve.py 单跑时也不会被任意页面调用。
        origin = self.headers.get('Origin') or ''
        if _origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-StructBoard-Token')
        super().end_headers()

    def do_OPTIONS(self):
        # 预检只对允许的来源放行，避免跨站页面拿到读接口的通行证。
        origin = self.headers.get('Origin') or ''
        if origin and not _origin_allowed(origin):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

    def _local_read_allowed(self):
        """按绝对路径回读本机文件只供桌面桥使用；serve.py 直连一律拒绝。"""
        if os.environ.get('STRUCTBOARD_ALLOW_LOCAL_READ') == '1':
            return True
        return not _running_as_plain_server()

    def log_message(self, fmt, *args):
        sys.stderr.write('  %s\n' % (fmt % args))

    # ---------------------------------------------------------- 管线 API

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/ai/chat':
            return self._post_ai_chat(parsed)
        if parsed.path == '/api/notes':
            return self._post_notes(parsed)
        if parsed.path == '/api/pipeline/import':
            return self._post_pipeline_import(parsed)
        if parsed.path == '/api/pipeline/import/cancel':
            payload, err = self._read_json_body()
            if err:
                return self._send_json({'ok': False, 'error': err[1]}, err[0])
            jid = payload.get('jobId') if isinstance(payload, dict) else None
            with IMPORT_LOCK:
                job = IMPORT_JOBS.get(jid) if isinstance(jid, str) else None
                if not job:
                    return self._send_json({'ok': False, 'error': '导入任务不存在'}, 404)
                if job['state'] == 'running':
                    job['_cancel'].set()
                return self._send_json({'ok': True, 'saved': job['saved'], 'state': job['state']})
        if parsed.path == '/api/pipeline/scaffold':
            return self._post_pipeline_scaffold(parsed)
        if parsed.path == '/api/pipeline/delete':
            return self._post_pipeline_delete(parsed)
        self.send_error(404, 'unknown endpoint')

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith('/api/'):
            return self._api_get(parsed)
        super().do_GET()

    def _api_get(self, parsed):
        q = parse_qs(parsed.query)
        path = parsed.path
        try:
            if path == '/api/pipeline/import/status':
                jid = (q.get('job') or [''])[0]
                with IMPORT_LOCK:
                    job = IMPORT_JOBS.get(jid)
                    if not job:
                        return self._send_json({'ok': False, 'error': '导入任务不存在或已过期'}, 404)
                    public = {k: v for k, v in job.items() if not k.startswith('_')}
                return self._send_json({'ok': True, 'job': public})
            if path == '/api/pipelines':
                return self._send_json({'ok': True, 'pipelines': pipeline_api.list_pipelines()})
            if path == '/api/pipeline':
                pid = (q.get('id') or [''])[0]
                if (q.get('raw') or [''])[0] == '1':
                    return self._send_json({'ok': True, 'pipeline': pipeline_api.load_definition(pid)})
                data = pipeline_api.build_pipeline(pid)
                return self._send_json({'ok': True, 'pipeline': data})
            if path == '/api/pipeline/structures':
                pid, sid = (q.get('id') or [''])[0], (q.get('step') or [''])[0]
                return self._send_json({'ok': True, **pipeline_api.step_structures(pid, sid)})
            if path == '/api/pipeline/structure':
                pid, sid = (q.get('id') or [''])[0], (q.get('step') or [''])[0]
                full = pipeline_api.resolve_structure(pid, sid, (q.get('path') or [''])[0])
                # 保留 gzip 原始字节，浏览器按现有导入流程解压。
                with open(full, 'rb') as fh:
                    size = os.fstat(fh.fileno()).st_size
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Length', str(size))
                    self.end_headers()
                    remaining = size
                    while remaining:
                        chunk = fh.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                return
            if path == '/api/local/read':
                if not self._local_read_allowed():
                    return self._send_json(
                        {'ok': False, 'error': '按路径回读本机文件只在桌面版可用'}, 403)
                return self._serve_local_file((q.get('path') or [''])[0])
            if path == '/api/notes':
                pid = (q.get('id') or [''])[0]
                defn = pipeline_api.load_definition(pid)
                return self._send_json({'ok': True, 'notes': pipeline_api.read_notes(defn.get('root', ''))})
            self._send_json({'ok': False, 'error': 'unknown endpoint'}, 404)
        except FileNotFoundError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 404)
        except ValueError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 400)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            self._send_json({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 500)

    def _serve_local_file(self, raw_path):
        """桌面端选择器回读：按绝对路径流式回传本机文件（与 /api/pipeline/structure 同款字节流）。"""
        target = os.path.normpath(raw_path)
        if not target or not os.path.isabs(target):
            return self._send_json({'ok': False, 'error': '路径必须是绝对路径'}, 400)
        if not os.path.isfile(target):
            return self._send_json({'ok': False, 'error': '文件不存在：' + target}, 404)
        size = os.path.getsize(target)
        if size > 512 * 1024 * 1024:
            return self._send_json({'ok': False, 'error': '单个文件超过 512MB 上限'}, 413)
        try:
            with open(target, 'rb') as fh:
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.end_headers()
                remaining = size
                while remaining:
                    chunk = fh.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            try:
                self._send_json({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 500)
            except Exception:
                pass

    def _read_json_body(self, limit=8 * 1024 * 1024):
        """读并解析 JSON 请求体。返回 (payload, error_response)。"""
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return None, (400, 'Content-Length 非法')
        if length <= 0:
            return None, (400, '请求体为空')
        if length > limit:
            return None, (413, '请求体超过 %.0f MB 上限' % (limit / 1024 / 1024))
        try:
            raw = self.rfile.read(length).decode('utf-8-sig')
        except Exception as exc:
            return None, (400, '请求体不是 UTF-8: %s' % exc)
        try:
            return json.loads(raw), None
        except json.JSONDecodeError as exc:
            return None, (400, 'JSON 解析失败: %s' % exc)

    def _post_pipeline_import(self, parsed):
        """导入一份管线定义 JSON（校验后写入 pipelines/）。"""
        try:
            q = parse_qs(parsed.query)
            payload, err = self._read_json_body(limit=IMPORT_LIMIT)
            if err:
                return self._send_json({'ok': False, 'error': err[1]}, err[0])
            if not isinstance(payload, dict):
                return self._send_json({'ok': False, 'error': '请求体必须是 JSON 对象'}, 400)
            raw = (q.get('raw') or [''])[0] == '1'
            defn = payload if raw else payload.get('definition')
            if not isinstance(defn, dict):
                return self._send_json({'ok': False, 'error': '缺少 definition 对象'}, 400)
            overwrite = ((q.get('overwrite') or ['0'])[0] == '1') if raw else bool(payload.get('overwrite'))
            if (q.get('async') or [''])[0] == '1':
                jid = _start_import_job(defn, overwrite)
                return self._send_json({'ok': True, 'jobId': jid}, 202)
            ok, msg, pid = pipeline_api.import_definition(defn, overwrite=overwrite)
            if not ok:
                return self._send_json({'ok': False, 'error': msg, 'id': pid}, 400)
            return self._send_json({'ok': True, 'message': msg, 'id': pid,
                                    'pipelines': pipeline_api.list_pipelines()})
        except Exception as exc:
            self._send_json({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 500)

    def _post_pipeline_scaffold(self, parsed):
        """从数据目录生成管线定义草稿（只读扫描，不落盘）。"""
        try:
            payload, err = self._read_json_body()
            if err:
                return self._send_json({'ok': False, 'error': err[1]}, err[0])
            if not isinstance(payload, dict):
                return self._send_json({'ok': False, 'error': '请求体必须是 JSON 对象'}, 400)
            root = (payload.get('root') or '').strip()
            res = scaffold_pipeline.scaffold_from_dir(
                root, name=payload.get('name') or None, pid=payload.get('id') or None)
            return self._send_json({
                'ok': True,
                'definition': res['definition'],
                'warnings': res['warnings'],
                'stats': res['stats'],
            })
        except FileNotFoundError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 404)
        except ValueError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 400)
        except Exception as exc:
            self._send_json({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 500)

    def _post_pipeline_delete(self, parsed):
        """停用一条管线定义（归档为 .bak，可恢复）。"""
        try:
            payload, err = self._read_json_body()
            if err:
                return self._send_json({'ok': False, 'error': err[1]}, err[0])
            pid = (payload.get('id') or '').strip()
            path = pipeline_api.archive_definition(pid)
            return self._send_json({'ok': True,
                                    'message': '已归档 %s（重命名而非删除，可改回来）' % path,
                                    'pipelines': pipeline_api.list_pipelines()})
        except FileNotFoundError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 404)
        except Exception as exc:
            self._send_json({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 500)

    # ---------------------------------------------------------- AI 供应商代理

    _AI_EFFORTS = ('minimal', 'low', 'medium', 'high')
    _AI_FORMATS = ('openai-chat', 'openai-responses', 'anthropic')
    # Anthropic 扩展思考：effort → budget_tokens（预算必须小于 max_tokens）
    _AI_THINK_BUDGET = {'minimal': 2048, 'low': 4096, 'medium': 10000, 'high': 20000}

    def _ai_validate(self, payload):
        """校验并按接口格式适配请求。返回 (fmt, upstream_body, url, headers, error_response)。
        上游响应统一归一化回 OpenAI chat 形状，前端三种格式共用一套解析。"""
        if not isinstance(payload, dict):
            return None, None, None, None, ({'ok': False, 'error': '请求体必须是 JSON 对象'}, 400)
        fmt = payload.get('format') or 'openai-chat'
        if fmt not in self._AI_FORMATS:
            return None, None, None, None, ({'ok': False, 'error': 'format 必须是 ' + ', '.join(self._AI_FORMATS)}, 400)
        base = str(payload.get('baseUrl') or '').strip().rstrip('/')
        if not base:
            return None, None, None, None, ({'ok': False, 'error': '缺少 baseUrl'}, 400)
        parsed = urlparse(base)
        host = (parsed.hostname or '').lower()
        if parsed.scheme == 'https':
            pass
        elif parsed.scheme == 'http' and host in ('127.0.0.1', 'localhost', '::1'):
            pass  # 仅回环允许 http，便于本地网关与测试
        else:
            return None, None, None, None, ({'ok': False, 'error': 'AI 接口必须是 https（本机回环可为 http）'}, 400)
        if not str(payload.get('model') or '').strip():
            return None, None, None, None, ({'ok': False, 'error': '缺少 model'}, 400)
        messages = payload.get('messages')
        if not isinstance(messages, list) or not messages:
            return None, None, None, None, ({'ok': False, 'error': 'messages 必须是非空数组'}, 400)
        for m in messages:
            if not isinstance(m, dict) or m.get('role') not in ('system', 'user', 'assistant') \
                    or not isinstance(m.get('content'), str):
                return None, None, None, None, ({'ok': False, 'error': 'messages 每项需要 {role, content}'}, 400)
        effort = payload.get('reasoning_effort') or 'off'
        if effort != 'off' and effort not in self._AI_EFFORTS:
            return None, None, None, None, ({'ok': False, 'error': 'reasoning_effort 非法'}, 400)
        stream = bool(payload.get('stream'))
        model = str(payload['model']).strip()
        key = str(payload.get('apiKey') or '')

        if fmt == 'openai-chat':
            body = {
                'model': model,
                'messages': [{'role': m['role'], 'content': m['content']} for m in messages],
                'stream': stream,
            }
            if effort != 'off':
                body['reasoning_effort'] = effort
            path = base + '/chat/completions'
            headers = {'Authorization': 'Bearer ' + key} if key else {}
        elif fmt == 'openai-responses':
            body = {
                'model': model,
                'input': [{'role': m['role'], 'content': m['content']} for m in messages],
                'stream': stream,
            }
            if effort != 'off':
                body['reasoning'] = {'effort': effort}
            path = base + '/responses'
            headers = {'Authorization': 'Bearer ' + key} if key else {}
        else:  # anthropic
            system = '\n'.join(m['content'] for m in messages if m['role'] == 'system')
            body = {
                'model': model,
                'messages': [{'role': m['role'], 'content': m['content']}
                             for m in messages if m['role'] != 'system'],
                'max_tokens': 4096,
                'stream': stream,
            }
            if system:
                body['system'] = system
            if effort != 'off':
                budget = self._AI_THINK_BUDGET[effort]
                body['thinking'] = {'type': 'enabled', 'budget_tokens': budget}
                body['max_tokens'] = budget + 4096  # 规则：max_tokens 必须大于 budget
            path = base + '/v1/messages'
            headers = {}
            if key:
                headers['x-api-key'] = key
            headers['anthropic-version'] = '2023-06-01'
        extra = payload.get('extra')
        if extra:
            if not isinstance(extra, dict):
                return None, None, None, None, ({'ok': False, 'error': 'extra 必须是 JSON 对象'}, 400)
            # Protocol fields are controlled by the validated request, not arbitrary extra JSON.
            if any(k in extra for k in ('model', 'messages', 'input', 'system', 'stream', 'tools', 'tool_choice')):
                return None, None, None, None, ({'ok': False, 'error': 'extra 不能覆盖协议字段'}, 400)
            body.update(extra)
        headers = dict(headers)
        headers['Content-Type'] = 'application/json'
        headers['Accept'] = 'text/event-stream' if stream else 'application/json'
        return fmt, body, path, headers, None

    @staticmethod
    def _ai_stream_text(fmt, obj):
        """从上游事件里取正文；终止及错误由 _ai_stream_event 单独处理。"""
        if not isinstance(obj, dict):
            return None
        if fmt == 'openai-responses':
            return obj.get('delta') if obj.get('type') == 'response.output_text.delta' else None
        if fmt == 'anthropic':
            delta = obj.get('delta') or {}
            if obj.get('type') == 'content_block_delta' and delta.get('type') == 'text_delta':
                return delta.get('text')
            return None
        choice = (obj.get('choices') or [{}])[0]
        delta = choice.get('delta') or choice.get('message') or {}
        return delta.get('content') if isinstance(delta, dict) else None

    @staticmethod
    def _ai_error_message(error):
        if isinstance(error, str):
            return error[:1000]
        if isinstance(error, dict):
            return str(error.get('message') or error.get('reason') or error.get('code') or '供应商请求失败')[:1000]
        return '供应商请求失败'

    def _ai_stream_event(self, fmt, obj):
        """返回 (text, terminal, finish_reason, error)，绝不把失败转成正常结束。"""
        if not isinstance(obj, dict):
            return None, False, None, '供应商 SSE 事件必须是 JSON 对象'
        kind = obj.get('type') or ''
        if obj.get('error') or kind == 'error':
            return None, True, None, self._ai_error_message(obj.get('error') or obj)
        text = self._ai_stream_text(fmt, obj)
        if fmt == 'openai-responses':
            response = obj.get('response') or {}
            if kind in ('response.failed', 'response.incomplete', 'response.cancelled'):
                error = response.get('error') or response.get('incomplete_details') or {'message': kind}
                return text, True, None, self._ai_error_message(error)
            if kind in ('response.completed', 'response.done'):
                status = response.get('status')
                if response.get('error') or status in ('failed', 'incomplete', 'cancelled'):
                    return text, True, None, self._ai_error_message(response.get('error') or response.get('incomplete_details') or {'message': status})
                return text, True, 'stop', None
        elif fmt == 'anthropic':
            reason = (obj.get('delta') or {}).get('stop_reason') or obj.get('stop_reason')
            if reason and reason not in ('end_turn', 'stop_sequence'):
                return text, True, reason, '回复未完成：' + str(reason)
            if kind == 'message_stop':
                return text, True, 'stop', None
        else:
            choice = (obj.get('choices') or [{}])[0]
            if (choice.get('delta') or {}).get('tool_calls'):
                return text, True, 'tool_calls', '请使用提示中的 sb-action 格式调用工具'
            reason = choice.get('finish_reason')
            if reason:
                if reason != 'stop':
                    return text, True, reason, '回复未完成：' + str(reason)
                return text, True, reason, None
        return text, False, None, None

    def _ai_stream_forward(self, resp, fmt):
        """逐事件转发；仅观察到上游正常终止才下发 DONE，异常在当前 SSE 内报告。"""
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Accel-Buffering', 'no')
        self.close_connection = True
        self.end_headers()
        buf = b''
        terminal = False
        started = time.monotonic()

        def emit(obj):
            self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\n\n').encode('utf-8'))
            self.wfile.flush()

        def consume(line):
            nonlocal terminal
            line = line.rstrip(b'\r')
            if not line.startswith(b'data:'):
                return
            data = line[5:].strip()
            if not data:
                return
            if data == b'[DONE]':
                terminal = True
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
                return
            try:
                obj = json.loads(data.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                raise ValueError('供应商返回无效 SSE JSON')
            text, done, reason, error = self._ai_stream_event(fmt, obj)
            if text:
                emit({'choices': [{'delta': {'content': text}}]})
            if error:
                terminal = True
                emit({'ok': False, 'error': {'message': error}, 'finish_reason': reason})
            elif done:
                terminal = True
                emit({'choices': [{'delta': {}, 'finish_reason': reason or 'stop'}], 'done': True})
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()

        try:
            # HTTPResponse.read(n) can wait for n bytes. read1 returns the next available packet.
            read = getattr(resp, 'read1', None) or (lambda n: resp.read(1))
            while not terminal:
                if time.monotonic() - started > 240:
                    raise TimeoutError('供应商流超时')
                chunk = read(65536)
                if not chunk:
                    if buf.strip():
                        consume(buf)
                    if not terminal:
                        emit({'ok': False, 'error': {'message': '供应商流意外中断（缺少结束事件）'}})
                    break
                buf += chunk
                if len(buf) > 2 * 1024 * 1024:
                    raise ValueError('供应商 SSE 事件过大')
                while not terminal and b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    consume(line)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            try:
                emit({'ok': False, 'error': {'message': '%s: %s' % (type(exc).__name__, exc)}})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
        finally:
            # Closing early also cancels generation after a browser Stop/disconnect or terminal event.
            try:
                resp.close()
            except Exception:
                pass

    @staticmethod
    def _ai_extract_text(fmt, data):
        """非流式适配，失败与不完整结果保留为错误，不能归一化为空的成功。"""
        if not isinstance(data, dict):
            raise ValueError('供应商返回必须是 JSON 对象')
        if data.get('error') or data.get('type') == 'error':
            raise ValueError(Handler._ai_error_message(data.get('error') or data))
        if fmt == 'openai-chat':
            choices = data.get('choices') or []
            if not choices:
                raise ValueError('供应商未返回 choices')
            reason = choices[0].get('finish_reason')
            if reason and reason != 'stop':
                raise ValueError('回复未完成：' + str(reason))
            content = (choices[0].get('message') or {}).get('content')
            if not isinstance(content, str) or not content.strip():
                raise ValueError('供应商返回空回复')
            return data
        if fmt == 'openai-responses':
            if data.get('status') in ('failed', 'incomplete', 'cancelled') or data.get('incomplete_details'):
                raise ValueError('回复未完成：' + Handler._ai_error_message(data.get('incomplete_details') or {'message': data.get('status')}))
            texts = []
            for item in data.get('output') or []:
                if item.get('type') != 'message':
                    continue
                for part in item.get('content') or []:
                    if part.get('type') in ('output_text', 'text') and part.get('text'):
                        texts.append(part['text'])
        else:
            reason = data.get('stop_reason')
            if reason and reason not in ('end_turn', 'stop_sequence'):
                raise ValueError('回复未完成：' + str(reason))
            texts = [part['text'] for part in data.get('content') or []
                     if part.get('type') == 'text' and part.get('text')]
        if not texts:
            raise ValueError('供应商返回空回复')
        return {'choices': [{'message': {'role': 'assistant', 'content': ''.join(texts)}, 'finish_reason': 'stop'}]}

    def _ai_watch_disconnect(self, conn, done, cancelled, upstream_socket=None):
        """Browser Stop must also interrupt a silent connect/read, not just the next SSE write."""
        import select
        import socket
        client = getattr(self, 'connection', None)
        if client is None:
            return
        while not done.wait(0.1):
            try:
                ready, _, _ = select.select([client], [], [], 0)
                if not ready:
                    continue
                # The POST body has already been consumed. EOF means browser Abort/disconnect.
                if client.recv(1, socket.MSG_PEEK):
                    continue
            except (OSError, ValueError):
                pass
            cancelled.set()
            upstream_socket = upstream_socket or getattr(conn, 'sock', None)
            if upstream_socket is not None:
                try:
                    upstream_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            try:
                conn.close()
            except Exception:
                pass
            return

    def _post_ai_chat(self, parsed):
        """按配置转发，AI 请求不读写供应商设置或记录密钥。"""
        streaming_started = False
        key = ''
        done = threading.Event()
        cancelled = threading.Event()
        try:
            payload, err = self._read_json_body(limit=4 * 1024 * 1024)
            if err:
                return self._send_json({'ok': False, 'error': err[1]}, err[0])
            fmt, body, path, headers, error = self._ai_validate(payload)
            if error:
                return self._send_json(error[0], error[1])
            key = str(payload.get('apiKey') or '')
            up = urlparse(path)
            conn_type = http.client.HTTPSConnection if up.scheme == 'https' else http.client.HTTPConnection
            conn = conn_type(up.hostname, up.port or (443 if up.scheme == 'https' else 80), timeout=60)
            try:
                conn.request('POST', (up.path or '/') + (('?' + up.query) if up.query else ''),
                             body=json.dumps(body, ensure_ascii=False).encode('utf-8'), headers=headers)
                # getresponse() may detach conn.sock for HTTP/1.0; keep the live socket for Abort.
                upstream_socket = conn.sock
                threading.Thread(target=self._ai_watch_disconnect,
                                 args=(conn, done, cancelled, upstream_socket), daemon=True).start()
                resp = conn.getresponse()
                if resp.status != 200:
                    detail = resp.read(4096).decode('utf-8', 'replace')
                    if key:
                        detail = detail.replace(key, '[已隐藏密钥]')
                    return self._send_json({'ok': False, 'status': resp.status,
                                            'error': '供应商返回 %s: %s' % (resp.status, detail[:500])}, 200)
                if not body['stream']:
                    raw = resp.read(4 * 1024 * 1024 + 1)
                    if len(raw) > 4 * 1024 * 1024:
                        raise ValueError('供应商响应过大')
                    try:
                        data = json.loads(raw.decode('utf-8'))
                    except (ValueError, UnicodeDecodeError):
                        raise ValueError('供应商返回的不是 JSON')
                    return self._send_json({'ok': True, 'data': self._ai_extract_text(fmt, data)})
                streaming_started = True
                self._ai_stream_forward(resp, fmt)
                return
            finally:
                done.set()
                conn.close()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as exc:
            if cancelled.is_set():
                return
            message = '%s: %s' % (type(exc).__name__, exc)
            if key:
                message = message.replace(key, '[已隐藏密钥]')
            try:
                if streaming_started:
                    event = {'ok': False, 'error': {'message': message}}
                    self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode('utf-8'))
                    self.wfile.flush()
                else:
                    self._send_json({'ok': False, 'error': message}, 200)
            except Exception:
                pass

    def _post_notes(self, parsed):
        """{id, patch} 按键合并；兼容 {id, notes} 全量替换，两者不可同时传。"""
        try:
            payload, err = self._read_json_body()
            if err:
                return self._send_json({'ok': False, 'error': err[1]}, err[0])
            if not isinstance(payload, dict):
                return self._send_json({'ok': False, 'error': '请求体必须是 JSON 对象'}, 400)
            pid = payload.get('id')
            if not isinstance(pid, str) or not pipeline_api.ID_RE.fullmatch(pid):
                return self._send_json({'ok': False, 'error': '管线 id 非法'}, 400)
            if ('patch' in payload) == ('notes' in payload):
                return self._send_json({'ok': False, 'error': '必须且只能提供 patch 或 notes'}, 400)
            # 只允许写这条管线自己的 root 目录
            defn = pipeline_api.load_definition(pid)
            root = defn.get('root', '')
            if 'patch' in payload:
                path, notes = pipeline_api.patch_notes(root, payload['patch'])
            else:
                notes = payload['notes']
                path = pipeline_api.write_notes(root, notes)
            return self._send_json({'ok': True, 'saved': path, 'count': len(notes)})
        except FileNotFoundError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 404)
        except ValueError as exc:
            self._send_json({'ok': False, 'error': str(exc)}, 400)
        except Exception as exc:
            self._send_json({'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)}, 500)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _probe_structboard(port):
    """127.0.0.1:port 上的服务是不是 StructBoard 自己（另一个实例）。"""
    try:
        import urllib.request
        with urllib.request.urlopen('http://127.0.0.1:%d/index.html' % port, timeout=1.5) as r:
            head = r.read(4096).decode('utf-8', 'replace')
            return 'StructBoard' in head
    except Exception:
        return False


def _bind_free(host, start, tries=20):
    """从 start 开始向后找一个能绑定的端口，找不到返回 None。"""
    import socket
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    return None


def open_in_app_window(url):
    """用 Chrome / Edge 的 --app 模式开一个无地址栏的独立窗口（更像桌面软件）。"""
    import shutil
    import subprocess
    candidates = []
    for name in ('chrome', 'msedge'):
        p = shutil.which(name)
        if p:
            candidates.append(p)
    candidates += [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    ]
    for p in candidates:
        try:
            subprocess.Popen(
                [p, '--app=' + url],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return True
        except OSError:
            continue
    return False


def main():
    ap = argparse.ArgumentParser(description='StructBoard 本地静态服务')
    ap.add_argument('--port', type=int, default=8000, help='端口，默认 8000')
    ap.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    ap.add_argument('--app', action='store_true',
                    help='优先用 Chrome/Edge 独立窗口打开（无地址栏，更像桌面软件；没有就退回系统默认浏览器）')
    ap.add_argument('--lan', action='store_true', help='绑定 0.0.0.0（仅可信局域网使用）')
    args = ap.parse_args()

    host = '0.0.0.0' if args.lan else '127.0.0.1'
    explicit_port = '--port' in sys.argv

    # 默认端口上已经跑着一个 StructBoard：说明用户又双击了一次图标，
    # 此时不再起第二个服务，直接把页面唤到前台。
    if not args.lan and not explicit_port and _probe_structboard(args.port):
        url = 'http://127.0.0.1:%d/' % args.port
        print('')
        print('  检测到 StructBoard 已在运行（端口 %d）' % args.port)
        print('  直接为你打开页面：%s' % url)
        print('')
        if not args.no_browser:
            if args.app and open_in_app_window(url):
                return 0
            webbrowser.open(url)
        return 0

    port = args.port
    try:
        httpd = Server((host, port), Handler)
    except OSError:
        if explicit_port or args.lan:
            print('端口 %d 被占用。换一个端口试试：--port %d' % (port, port + 1))
            return 1
        port = _bind_free(host, args.port + 1)
        if port is None:
            print('8000–%d 全被占用，请手动指定：--port <端口号>' % (args.port + 20))
            return 1
        print('端口 %d 被占用，自动改用 %d。' % (args.port, port))

    url = 'http://127.0.0.1:%d/' % port
    print('')
    print('  StructBoard 已启动')
    print('  本目录 : %s' % ROOT)
    print('  地址   : %s' % url)
    if args.lan:
        print('  局域网 : http://<本机IP>:%d/  （仅可信网络，别暴露到公网）' % port)
    print('  停止   : 在这个窗口按 Ctrl+C，或直接关掉窗口')
    print('')
    print('  普通导入由浏览器本机读取；管线结构经本地服务读取，数据不上传。')
    print('')

    if not args.no_browser:
        def _open():
            if args.app and open_in_app_window(url):
                return
            webbrowser.open(url)
        threading.Timer(0.6, _open).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止。')
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
