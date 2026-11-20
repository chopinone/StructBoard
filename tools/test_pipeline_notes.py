#!/usr/bin/env python3
"""Run: python -I -B tools/test_pipeline_notes.py

Standard-library notes regression tests. All definitions, notes, and lock files
live under TemporaryDirectory; no production pipeline or structure files are used.
"""
import http.client
import json
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

sys.dont_write_bytecode = True
PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
import pipeline_api
import serve


MARKS_KEY = '__structboard_marks__'


def _process_patch_worker(root, worker, rounds, barrier):
    # Spawned Windows workers have independent module globals/thread locks.
    for round_index in range(rounds):
        barrier.wait(timeout=20)
        patch = {'process-%d-%d' % (worker, round_index): '并发 %d' % round_index}
        if worker == 0:
            patch[MARKS_KEY] = {'count': round_index, 'items': [{'name': '优选结构'}]}
        pipeline_api.patch_notes(root, patch)


def _process_write_worker(root, started, done):
    started.set()
    pipeline_api.write_notes(root, {'replacement': '完成'})
    done.set()


class QuietHandler(serve.Handler):
    def log_message(self, fmt, *args):
        pass


class NotesFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='structboard-notes-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / '项目数据'
        self.root.mkdir()
        self.notes_file = self.root / pipeline_api.NOTES_NAME
        self.initial = {
            'step-a': '原始 A',
            'step-b': '原始 B',
            'untouched': '  保留换行\n café  ',
            'legacy': {'nested': [1, None, {'文本': '保持原样'}]},
            MARKS_KEY: {'updatedAt': 'before', 'count': 1, 'items': [{'name': '基线'}]},
        }
        self.notes_file.write_text(json.dumps(self.initial, ensure_ascii=False), encoding='utf-8')

    def assert_no_temps(self):
        self.assertEqual(list(self.root.glob(pipeline_api.NOTES_NAME + '-*.tmp')), [])


class NotesStorageTests(NotesFixture):
    def test_missing_file_empty_patch_clearing_and_unicode(self):
        self.notes_file.unlink()
        self.assertEqual(pipeline_api.read_notes(str(self.root)), {})
        path, notes = pipeline_api.patch_notes(str(self.root), {'step-a': '中文 café\nΔ'})
        self.assertEqual(path, str(self.notes_file))
        self.assertEqual(notes, {'step-a': '中文 café\nΔ'})
        pipeline_api.patch_notes(str(self.root), {'step-a': ''})
        self.assertEqual(pipeline_api.read_notes(str(self.root)), {'step-a': ''})
        _, notes = pipeline_api.patch_notes(str(self.root), {})
        self.assertEqual(notes, {'step-a': ''})
        self.assert_no_temps()

    def test_threads_merge_steps_and_marks_preserving_untouched_keys(self):
        barrier = threading.Barrier(3)
        # An alias must use the same per-root lock, including Windows case folding.
        (self.root / 'child').mkdir()
        alias = str(self.root / 'child' / '..')
        if os.name == 'nt':
            alias = alias.swapcase()
        rounds = 20

        def update(worker):
            for round_index in range(rounds):
                barrier.wait(timeout=10)
                key = ('step-a', 'step-b', MARKS_KEY)[worker]
                value = ('便签 A %d' % round_index, '便签 B %d' % round_index,
                         {'count': round_index, 'items': [{'name': '标记 %d' % round_index}]})[worker]
                root = alias if worker == 1 else str(self.root)
                pipeline_api.patch_notes(root, {key: value})

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(update, worker) for worker in range(3)]
            failures = []
            for future in futures:
                try:
                    future.result(timeout=30)
                except Exception as error:
                    failures.append(error)
            if failures:
                raise ExceptionGroup('Concurrent note writes failed', failures)
        notes = pipeline_api.read_notes(str(self.root))
        self.assertEqual(notes['step-a'], '便签 A 19')
        self.assertEqual(notes['step-b'], '便签 B 19')
        self.assertEqual(notes[MARKS_KEY], {'count': 19, 'items': [{'name': '标记 19'}]})
        for key in ('untouched', 'legacy'):
            self.assertEqual(notes[key], self.initial[key])
        self.assert_no_temps()

    def test_legacy_replace_contract_and_shared_lock_with_patch(self):
        entered = threading.Event()
        release = threading.Event()
        patch_started = threading.Event()
        original_write = pipeline_api._write_notes_unlocked

        def hold_replacement(root, notes):
            if notes == {'replacement': '替换'}:
                entered.set()
                if not release.wait(10):
                    raise TimeoutError('test replacement was not released')
            return original_write(root, notes)

        def patch_after_start():
            patch_started.set()
            return pipeline_api.patch_notes(str(self.root), {'step-b': '后来'})

        with mock.patch.object(pipeline_api, '_write_notes_unlocked', side_effect=hold_replacement):
            with ThreadPoolExecutor(max_workers=2) as executor:
                replacement = executor.submit(pipeline_api.write_notes, str(self.root), {'replacement': '替换'})
                patched = None
                try:
                    self.assertTrue(entered.wait(5))
                    patched = executor.submit(patch_after_start)
                    self.assertTrue(patch_started.wait(5))
                    self.assertFalse(patched.done())
                finally:
                    release.set()
                self.assertEqual(replacement.result(timeout=10), str(self.notes_file))
                self.assertEqual(patched.result(timeout=10)[1], {'replacement': '替换', 'step-b': '后来'})
        self.assertEqual(pipeline_api.read_notes(str(self.root)), {'replacement': '替换', 'step-b': '后来'})

    def test_atomic_writer_uses_unique_temps_fsync_and_cleans_failures(self):
        fixed_temp = Path(str(self.notes_file) + '.tmp')
        fixed_temp.write_bytes(b'unrelated existing temp')
        original_fsync = pipeline_api.os.fsync
        original_replace = pipeline_api.os.replace
        temps = []
        flushed = []

        def sync(descriptor):
            flushed.append(descriptor)
            return original_fsync(descriptor)

        def replace(source, target):
            if source not in temps:
                self.assertEqual(len(flushed), len(temps) + 1)
            self.assertNotEqual(str(source), str(fixed_temp))
            self.assertEqual(Path(source).parent.resolve(), self.root.resolve())
            self.assertEqual(Path(target).resolve(), self.notes_file.resolve())
            json.loads(Path(source).read_text(encoding='utf-8'))
            if source not in temps:
                temps.append(source)
            return original_replace(source, target)

        with mock.patch.object(pipeline_api.os, 'fsync', side_effect=sync), \
                mock.patch.object(pipeline_api.os, 'replace', side_effect=replace):
            pipeline_api.patch_notes(str(self.root), {'step-a': '保存一'})
            pipeline_api.patch_notes(str(self.root), {'step-b': '保存二'})
        self.assertEqual(len(set(temps)), 2)
        self.assertEqual(fixed_temp.read_bytes(), b'unrelated existing temp')
        before = self.notes_file.read_bytes()
        with mock.patch.object(pipeline_api.os, 'replace', side_effect=OSError('replace failed')):
            with self.assertRaisesRegex(OSError, 'replace failed'):
                pipeline_api.patch_notes(str(self.root), {'step-a': '不能落盘'})
        self.assertEqual(self.notes_file.read_bytes(), before)
        with mock.patch.object(pipeline_api.os, 'fsync', side_effect=OSError('fsync failed')):
            with self.assertRaisesRegex(OSError, 'fsync failed'):
                pipeline_api.write_notes(str(self.root), {'replacement': '不能落盘'})
        self.assertEqual(self.notes_file.read_bytes(), before)
        self.assert_no_temps()

    @unittest.skipUnless(os.name == 'nt', 'Windows replacement handle retry')
    def test_transient_replace_denial_retries_same_fsynced_file(self):
        original = pipeline_api.os.replace
        before = self.notes_file.read_bytes()
        sources = []
        def replace(source, target):
            sources.append(source)
            self.assertNotIn('..', Path(target).parts)
            if len(sources) < 3:
                self.assertEqual(self.notes_file.read_bytes(), before)
                error = PermissionError('temporary handle')
                error.winerror = 32
                raise error
            return original(source, target)
        (self.root / 'child').mkdir()
        alias = str(self.root / 'child' / '..')
        with mock.patch.object(pipeline_api.os, 'replace', side_effect=replace), mock.patch.object(pipeline_api.time, 'sleep') as sleep:
            pipeline_api.patch_notes(alias, {'step-a': 'retried'})
        self.assertEqual(len(sources), 3)
        self.assertEqual(len(set(sources)), 1)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(pipeline_api.read_notes(str(self.root))['step-a'], 'retried')
        self.assert_no_temps()

    @unittest.skipUnless(os.name == 'nt', 'Windows replacement handle retry')
    def test_permanent_replace_denial_is_bounded_and_preserves_original(self):
        before = self.notes_file.read_bytes()
        error = PermissionError('permanent denial')
        error.winerror = 5
        with mock.patch.object(pipeline_api.os, 'replace', side_effect=error) as replace, mock.patch.object(pipeline_api.time, 'sleep') as sleep:
            with self.assertRaises(PermissionError):
                pipeline_api.patch_notes(str(self.root), {'step-a': 'must not replace'})
        self.assertEqual(replace.call_count, 6)
        self.assertEqual(sleep.call_count, 5)
        self.assertEqual(self.notes_file.read_bytes(), before)
        self.assert_no_temps()

    def test_invalid_patch_or_serialization_preserves_original(self):
        invalid = [None, [], 'text', 1, {1: 'text'}, {'': 'text'}, {'  ': 'text'},
                   {'step-a': None}, {'step-a': False}, {'step-a': 1},
                   {'step-a': []}, {'step-a': {}}, {MARKS_KEY: 'text'},
                   {MARKS_KEY: []}, {'step-a': 'valid', 'step-b': None}]
        before = self.notes_file.read_bytes()
        for patch in invalid:
            with self.subTest(patch=patch):
                with self.assertRaises(ValueError):
                    pipeline_api.patch_notes(str(self.root), patch)
                self.assertEqual(self.notes_file.read_bytes(), before)
        for notes in ([1], {'step': object()}, {'step': float('nan')}):
            with self.subTest(notes=notes):
                with self.assertRaises((ValueError, TypeError)):
                    pipeline_api.write_notes(str(self.root), notes)
                self.assertEqual(self.notes_file.read_bytes(), before)
        self.assert_no_temps()

    def test_malformed_disk_is_not_read_as_empty_or_overwritten(self):
        for contents in (b'{broken json', b'[]', b'null', b'"string"', b'42', b'\xff', b''):
            with self.subTest(contents=contents):
                self.notes_file.write_bytes(contents)
                for operation in (
                    lambda: pipeline_api.read_notes(str(self.root)),
                    lambda: pipeline_api.patch_notes(str(self.root), {'step-a': 'new'}),
                    lambda: pipeline_api.write_notes(str(self.root), {'step-a': 'new'}),
                ):
                    with self.assertRaises(ValueError):
                        operation()
                    self.assertEqual(self.notes_file.read_bytes(), contents)
        self.assert_no_temps()

    def test_unreadable_disk_and_missing_root_do_not_overwrite(self):
        before = self.notes_file.read_bytes()
        original_open = open

        def denied(path, *args, **kwargs):
            if os.path.normcase(os.path.realpath(path)) == os.path.normcase(os.path.realpath(self.notes_file)):
                raise PermissionError('notes access denied')
            return original_open(path, *args, **kwargs)

        with mock.patch('builtins.open', side_effect=denied):
            for operation in (
                lambda: pipeline_api.read_notes(str(self.root)),
                lambda: pipeline_api.patch_notes(str(self.root), {'step-a': 'new'}),
                lambda: pipeline_api.write_notes(str(self.root), {'step-a': 'new'}),
            ):
                with self.assertRaisesRegex(PermissionError, 'access denied'):
                    operation()
        self.assertEqual(self.notes_file.read_bytes(), before)
        for root in ('', str(self.base / 'missing')):
            for operation in (pipeline_api.write_notes, pipeline_api.patch_notes):
                with self.assertRaises(FileNotFoundError):
                    operation(root, {})
        self.assertFalse((self.base / 'missing').exists())
        self.assert_no_temps()

    def test_spawned_processes_merge_same_root(self):
        context = multiprocessing.get_context('spawn')
        workers, rounds = 3, 8
        barrier = context.Barrier(workers)
        processes = [context.Process(target=_process_patch_worker,
                                     args=(str(self.root), worker, rounds, barrier))
                     for worker in range(workers)]
        for process in processes:
            process.start()
        try:
            deadline = time.monotonic() + 45
            for process in processes:
                process.join(max(0, deadline - time.monotonic()))
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                process.join(5)
                process.close()
        notes = pipeline_api.read_notes(str(self.root))
        for worker in range(workers):
            for round_index in range(rounds):
                self.assertEqual(notes['process-%d-%d' % (worker, round_index)],
                                 '并发 %d' % round_index)
        for key in ('step-a', 'step-b', 'untouched', 'legacy'):
            self.assertEqual(notes[key], self.initial[key])
        self.assertEqual(notes[MARKS_KEY]['count'], rounds - 1)
        self.assert_no_temps()

    def test_legacy_write_obeys_another_process_lock(self):
        context = multiprocessing.get_context('spawn')
        started, done = context.Event(), context.Event()
        process = context.Process(target=_process_write_worker, args=(str(self.root), started, done))
        try:
            with pipeline_api._notes_lock(str(self.root)):
                process.start()
                self.assertTrue(started.wait(10))
                self.assertFalse(done.wait(.2))
                self.assertEqual(json.loads(self.notes_file.read_text(encoding='utf-8')), self.initial)
            process.join(15)
            self.assertEqual(process.exitcode, 0)
            self.assertTrue(done.is_set())
            self.assertEqual(pipeline_api.read_notes(str(self.root)), {'replacement': '完成'})
        finally:
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                process.join(5)
            process.close()


class NotesHTTPTests(NotesFixture):
    def setUp(self):
        super().setUp()
        self.pipe_dir = self.base / 'pipelines'
        self.pipe_dir.mkdir()
        for pid, root in (('notes-test', self.root), ('shared-root', self.root),
                          ('missing-root', self.base / 'missing')):
            definition = {'id': pid, 'name': '临时管线', 'root': str(root),
                          'steps': [{'id': 'step-a', 'title': 'A'}, {'id': 'step-b', 'title': 'B'}]}
            (self.pipe_dir / (pid + '.json')).write_text(json.dumps(definition), encoding='utf-8')
        pipe_override = mock.patch.object(pipeline_api, 'PIPE_DIR', str(self.pipe_dir))
        pipe_override.start()
        self.addCleanup(pipe_override.stop)
        self.server = serve.Server(('127.0.0.1', 0), QuietHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)

    def request(self, method='POST', payload=None, raw=None, headers=None, path='/api/notes'):
        body = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=15)
        try:
            connection.request(method, path, body=body if method == 'POST' else None,
                               headers={'Content-Type': 'application/json', **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode('utf-8'))
        finally:
            connection.close()

    def test_http_patch_and_legacy_replace_contract(self):
        status, data = self.request(payload={'id': 'notes-test', 'patch': {'step-a': '', 'new-step': '中文 café'}})
        self.assertEqual(status, 200)
        self.assertEqual(data, {'ok': True, 'saved': str(self.notes_file), 'count': len(self.initial) + 1})
        status, data = self.request('GET', path='/api/notes?id=notes-test')
        self.assertEqual(status, 200)
        expected = {**self.initial, 'step-a': '', 'new-step': '中文 café'}
        self.assertEqual(data, {'ok': True, 'notes': expected})
        status, data = self.request(payload={'id': 'notes-test', 'patch': {}})
        self.assertEqual((status, data['count']), (200, len(expected)))
        # Full replacements retain the legacy object schema and path return contract.
        replacement = {'legacy-key': {'extra': [True, 3]}, 'step-a': '全量替换'}
        status, data = self.request(payload={'id': 'notes-test', 'notes': replacement})
        self.assertEqual((status, data), (200, {'ok': True, 'saved': str(self.notes_file), 'count': 2}))
        self.assertEqual(pipeline_api.read_notes(str(self.root)), replacement)

    def test_http_concurrent_step_and_marks_patches_share_root(self):
        barrier = threading.Barrier(3)
        rounds = 10

        def update(worker):
            for round_index in range(rounds):
                barrier.wait(timeout=10)
                key = ('step-a', 'step-b', MARKS_KEY)[worker]
                value = ('页面 A %d' % round_index, '页面 B %d' % round_index,
                         {'count': round_index, 'items': [{'name': '优选'}]})[worker]
                pid = 'shared-root' if worker == 1 else 'notes-test'
                status, data = self.request(payload={'id': pid, 'patch': {key: value}})
                self.assertEqual(status, 200, data)
                self.assertTrue(data['ok'])
                self.assertEqual(data['count'], len(self.initial))

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(update, worker) for worker in range(3)]
            for future in futures:
                future.result(timeout=30)
        notes = pipeline_api.read_notes(str(self.root))
        self.assertEqual(notes['step-a'], '页面 A 9')
        self.assertEqual(notes['step-b'], '页面 B 9')
        self.assertEqual(notes[MARKS_KEY], {'count': 9, 'items': [{'name': '优选'}]})
        for key in ('untouched', 'legacy'):
            self.assertEqual(notes[key], self.initial[key])

    def test_http_bad_payloads_return_ok_false_without_changes(self):
        invalid = [None, [], 'text', 5, {}, {'id': 'notes-test'},
                   {'id': None, 'patch': {}}, {'id': [], 'patch': {}},
                   {'id': 5, 'patch': {}}, {'id': '../bad', 'patch': {}},
                   {'id': 'notes-test', 'patch': {}, 'notes': {}},
                   *({'id': 'notes-test', 'patch': patch}
                     for patch in (None, [], 'text', {'': 'text'}, {'  ': 'text'},
                                   {'step-a': None}, {'step-a': False}, {'step-a': 2},
                                   {'step-a': []}, {'step-a': {}}, {MARKS_KEY: None},
                                   {MARKS_KEY: []}, {MARKS_KEY: 'text'},
                                   {MARKS_KEY: {'score': float('nan')}})),
                   *({'id': 'notes-test', 'notes': notes} for notes in (None, [], 'text'))]
        before = self.notes_file.read_bytes()
        for payload in invalid:
            with self.subTest(payload=payload):
                status, data = self.request(payload=payload)
                self.assertEqual(status, 400)
                self.assertFalse(data['ok'])
                self.assertTrue(data['error'])
                self.assertEqual(self.notes_file.read_bytes(), before)
        for raw in (b'{broken', b'\xff', b''):
            with self.subTest(raw=raw):
                status, data = self.request(raw=raw)
                self.assertEqual(status, 400)
                self.assertFalse(data['ok'])
                self.assertEqual(self.notes_file.read_bytes(), before)
        for length, expected in (('bad', 400), ('0', 400), ('-1', 400), (str(8 * 1024 * 1024 + 1), 413)):
            status, data = self.request(raw=b'{}', headers={'Content-Length': length})
            self.assertEqual(status, expected)
            self.assertFalse(data['ok'])
        self.assert_no_temps()

    def test_http_disk_errors_and_missing_definition_propagate(self):
        for contents in (b'{broken', b'[]', b'null', b'\xff'):
            with self.subTest(contents=contents):
                self.notes_file.write_bytes(contents)
                for method, payload in (
                    ('GET', None),
                    ('POST', {'id': 'notes-test', 'patch': {'step-a': 'new'}}),
                    ('POST', {'id': 'notes-test', 'notes': {'step-a': 'new'}}),
                ):
                    status, data = self.request(method, payload, path='/api/notes?id=notes-test')
                    self.assertEqual(status, 400)
                    self.assertFalse(data['ok'])
                    self.assertTrue(data['error'])
                    self.assertEqual(self.notes_file.read_bytes(), contents)
        for pid in ('not-found', 'missing-root'):
            status, data = self.request(payload={'id': pid, 'patch': {'step-a': 'new'}})
            self.assertEqual(status, 404)
            self.assertFalse(data['ok'])
        self.notes_file.write_text(json.dumps(self.initial), encoding='utf-8')
        before = self.notes_file.read_bytes()
        with mock.patch.object(pipeline_api.os, 'replace', side_effect=OSError('replace failed')):
            status, data = self.request(payload={'id': 'notes-test', 'patch': {'step-a': 'new'}})
        self.assertEqual(status, 500)
        self.assertFalse(data['ok'])
        self.assertIn('replace failed', data['error'])
        self.assertEqual(self.notes_file.read_bytes(), before)
        self.assert_no_temps()


if __name__ == '__main__':
    multiprocessing.freeze_support()
    unittest.main(verbosity=2)
