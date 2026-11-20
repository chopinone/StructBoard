"""Run isolated fixture checks: python -I -B tools/test_desktop_release.py

No real desktop build, deployment, Git write, AppData access, or process stop.
Every staged asset/release/target is created below TemporaryDirectory.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SRC = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load_module("release_fixture_build", SRC / "build_desktop.py")
candidate = load_module("release_fixture_candidate", SRC / "tools/create_release_candidate.py")
contract = build.resources
TOOL_VERSIONS = {"python": "Python fixture", "pyinstaller": "6.fixture", "cargo": "cargo fixture",
                 "rustc": "rustc fixture", "git": "git fixture"}


def put(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    return path


def tree_bytes(root):
    return {path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="structboard-release-fixture-", dir=str(SRC.parent))
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.source.mkdir()
        names = (contract.required_resources() | set(contract.CONTRACT["build_sources"])
                 | set(contract.CONTRACT["backend_data"]) | {"tools/run_all_tests.py", "tools/test_overview_queue.js"})
        for name in sorted(names):
            put(self.source, name, "fixture " + name + "\n")
        scripts = sorted(name for name in contract.required_resources() if name.endswith(".js") and not name.startswith("vendor/"))
        put(self.source, "index.html", '<link href="styles.css?v=1"><script src="vendor/molstar.js"></script>\n'
            + "\n".join(f'<script src="{name}?fixture=1"></script>' for name in scripts))
        put(self.source, "pipeline.html", '<img src="app_icon_64.png"><a href="index.html#home">home</a>')
        put(self.source, "styles.css", 'body { background: url("structboard-splash-white.svg"); }')
        put(self.source, "vendor/molstar.css", "body {}")
        put(self.source, "ai_chat.js", "logo.src = 'ai_logo.png'; fetch('/api/chat');")
        put(self.source, "tools/run_all_tests.py", "JS_SUITES = ['test_overview_queue.js']\nPY_SUITES = []\n")
        self.tracked = sorted(names - contract.approved_new_files())
        self.inventory = {"head": "a" * 40, "tracked_files": self.tracked,
                          "changed_tracked_files": ["app.js", "build_desktop.py", "index.html"]}
        self.desktop = self.source / "desktop"
        self.patches = [
            mock.patch.object(build, "SRC", self.source), mock.patch.object(build, "DESKTOP", self.desktop),
            mock.patch.object(build, "TEST", self.base / "build-work"), mock.patch.object(build, "OUTPUT", self.base / "output"),
            mock.patch.object(build, "_BACKEND_BUILT", False), mock.patch.object(build, "_BACKEND_SOURCE_DIGEST", None),
            mock.patch.object(build, "_BUILD_TOOLS", None), mock.patch.object(build, "_appdata_roots", return_value=[]),
            mock.patch.object(build.resources, "validate_frontend_build"),
            mock.patch.object(contract, "_git_inventory", side_effect=lambda source: copy.deepcopy(self.inventory)),
            mock.patch.object(candidate.resources, "_git_inventory", side_effect=lambda source: copy.deepcopy(self.inventory)),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def stage(self):
        return build.stage_assets()

    def release(self):
        assets = self.stage()
        exe = put(self.base, "built/StructBoard.exe", b"fixture desktop exe")
        backend = self.base / "built/backend"
        put(backend, "StructBoardBackend.exe", b"fixture backend exe")
        for name in contract.CONTRACT["backend_data"]:
            put(backend, "_internal/" + name, (self.source / name).read_bytes())
        return build.stage_release(exe, assets, backend, parent=self.base / "releases",
                                   source_provenance=build._source_provenance(), tools=TOOL_VERSIONS)

    def rewrite_hashes(self, release, mutate=None):
        path = release / "manifest.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if mutate:
            mutate(data)
        data["hashes"] = build._release_hashes(release)
        path.write_text(json.dumps(data), encoding="utf-8")

    def assert_no_staging(self):
        self.assertEqual(list(self.desktop.glob(".structboard-assets-*")), [])

    def test_missing_sources_report_all_paths_and_preserve_existing_stage(self):
        old = self.desktop / "bootstrap"
        put(old, "old.txt", b"keep me")
        for name in ("actions.js", "vendor/molstar.js", "pane_runtime.js", "workspace_save.js"):
            (self.source / name).unlink()
        with self.assertRaises(build.DeploymentError) as caught:
            self.stage()
        for name in ("actions.js", "vendor/molstar.js", "pane_runtime.js", "workspace_save.js"):
            self.assertIn(str(self.source / name), str(caught.exception))
        self.assertEqual(tree_bytes(old), {"old.txt": b"keep me"})
        self.assert_no_staging()

    def test_fresh_stage_removes_old_pollution_and_ignores_source_vendor_extras(self):
        put(self.desktop / "bootstrap", "old.js", "stale")
        put(self.desktop / "bootstrap", "vendor/old.js", "stale vendor")
        put(self.source, "vendor/private/cache.js", "do not package")
        assets = self.stage()
        self.assertEqual(set(tree_bytes(assets)), contract.required_resources())
        contract.validate_assets(assets, contract.resource_hashes(self.source))
        self.assert_no_staging()

    def test_copy_failure_preserves_previous_stage(self):
        assets = self.stage()
        before = tree_bytes(assets)
        original = build._copy_path

        def fail_copy(src, dest):
            if Path(src).name == "app.js":
                raise OSError("injected asset copy failure")
            return original(src, dest)

        with mock.patch.object(build, "_copy_path", side_effect=fail_copy):
            with self.assertRaisesRegex(build.DeploymentError, "injected asset copy failure"):
                self.stage()
        self.assertEqual(tree_bytes(assets), before)
        self.assert_no_staging()

    def test_install_move_failure_restores_previous_stage(self):
        assets = self.stage()
        before = tree_bytes(assets)
        original = build._move_path

        def fail_install(src, dest):
            if Path(src).name == "incoming" and Path(dest) == assets:
                raise PermissionError("injected asset replace failure")
            return original(src, dest)

        with mock.patch.object(build, "_move_path", side_effect=fail_install):
            with self.assertRaisesRegex(build.DeploymentError, "previous bootstrap preserved"):
                self.stage()
        self.assertEqual(tree_bytes(assets), before)
        self.assert_no_staging()

    def test_html_and_literal_dynamic_references_are_checked(self):
        for name, extra in (("index.html", '<script src="missing.js?v=3"></script>'),
                            ("ai_chat.js", "logo.src = 'missing.png';"),
                            ("styles.css", "a { background: url('missing.svg'); }")):
            original = (self.source / name).read_bytes()
            with self.subTest(owner=name):
                with (self.source / name).open("ab") as stream:
                    stream.write(extra.encode("utf-8"))
                with self.assertRaisesRegex(build.DeploymentError, "Missing or undeclared"):
                    self.stage()
            (self.source / name).write_bytes(original)
        put(self.source, "index.html", '<script src="../outside.js"></script>')
        with self.assertRaisesRegex(build.DeploymentError, "escapes resource root"):
            self.stage()

    def test_inline_worker_revoke_url_is_not_a_css_dependency(self):
        put(self.source, "pipeline.html", '<style>body{color:black}</style><script>URL.revokeObjectURL(url); const worker = new Worker(blobURL);</script>')
        self.stage()

    def test_tracked_required_cannot_be_satisfied_by_untracked_file(self):
        self.inventory["tracked_files"].remove("vendor/molstar.js")
        with self.assertRaisesRegex(build.DeploymentError, "Tracked-required"):
            self.stage()

    def test_release_records_source_candidate_and_tool_versions(self):
        release = self.release()
        data = build.validate_release(release)
        self.assertEqual(data["tools"], TOOL_VERSIONS)
        self.assertEqual(data["resource_contract"]["digest"], contract.contract_digest())
        self.assertEqual(data["source"]["source_digest"], build._source_provenance()["source_digest"])
        self.assertIn("pane_runtime.js", data["resource_contract"]["files"])
        self.assertIn("workspace_save.js", data["resource_contract"]["files"])
        self.assertFalse(data["source"]["committed_clean"])

    def test_missing_resource_rejected_even_after_manifest_hashes_are_recomputed(self):
        release = self.release()
        (release / "bootstrap/actions.js").unlink()
        self.rewrite_hashes(release)
        with self.assertRaisesRegex(build.DeploymentError, "actions.js"):
            build.validate_release(release)
        self.rewrite_hashes(release, lambda data: data["resource_contract"]["files"].pop("actions.js"))
        with self.assertRaisesRegex(build.DeploymentError, "resource inventory"):
            build.validate_release(release)

    def test_changed_asset_rejected_even_after_hashes_and_inventory_are_recomputed(self):
        release = self.release()
        put(release, "bootstrap/app.js", "tampered")
        self.rewrite_hashes(release, lambda data: data["resource_contract"]["files"].update({"app.js": build._sha256_file(release / "bootstrap/app.js")}))
        with self.assertRaisesRegex(build.DeploymentError, "resource inventory"):
            build.validate_release(release)

    def test_release_source_snapshot_must_match_current_candidate(self):
        release = self.release()
        put(self.source, "app.js", "changed since release")
        with self.assertRaisesRegex(build.DeploymentError, "source provenance"):
            build.validate_release(release)

    def test_backend_data_contract_rejects_missing_data_after_rehash(self):
        release = self.release()
        (release / "backend/_internal/pipelines/SCHEMA.md").unlink()
        self.rewrite_hashes(release)
        with self.assertRaisesRegex(build.DeploymentError, "Backend data/source mismatch"):
            build.validate_release(release)

    def test_multi_target_rollback_restores_every_previous_managed_item(self):
        release = self.release()
        targets = [(self.base / "installed/a").resolve(), (self.base / "installed/b").resolve()]
        snapshots = []
        for index, target in enumerate(targets):
            put(target, "StructBoard.exe", f"old exe {index}")
            put(target, "bootstrap/old.js", f"old assets {index}")
            put(target, "backend/old.dll", f"old backend {index}")
            put(target, "manifest.json", f"old manifest {index}")
            put(target, "personal.txt", "untouched")
            snapshots.append(tree_bytes(target))
        original = build._move_path
        failed = False

        def fail_second_target(src, dest):
            nonlocal failed
            if not failed and Path(dest) == targets[1] / "bootstrap" and Path(src).parent.name == "incoming":
                failed = True
                raise PermissionError("injected second target failure")
            return original(src, dest)

        with mock.patch.object(build, "_move_path", side_effect=fail_second_target):
            with self.assertRaisesRegex(build.DeploymentError, "second target failure"):
                build.deploy_release_to_targets(release, targets)
        self.assertTrue(failed)
        for target, snapshot in zip(targets, snapshots):
            self.assertEqual(tree_bytes(target), snapshot)
        self.assertEqual(list((self.base / "installed").glob(".structboard-transaction-*")), [])

    def test_deploy_preserves_unrelated_target_files_and_refuses_appdata(self):
        release = self.release()
        target = self.base / "installed/new"
        put(target, "personal.txt", "untouched")
        build.install_release(release, target)
        self.assertEqual((target / "personal.txt").read_text(), "untouched")
        build.validate_release(target, managed_only=True)
        blocked = (self.base / "fake-appdata").resolve()
        with mock.patch.object(build, "_appdata_roots", return_value=[blocked]):
            with self.assertRaisesRegex(build.DeploymentError, "AppData"):
                build.deploy_release_to_targets(release, [blocked / "app"])
        self.assertFalse(blocked.exists())

    def test_candidate_export_uses_whitelist_and_verify_rejects_changes(self):
        put(self.source, "tools/_tmp/secret.txt", "excluded")
        put(self.source, "tools/unapproved_test.js", "excluded")
        put(self.source, "tools/test_pane_controls.js", "approved if present")
        out = self.base / "candidate"
        data = candidate.export_candidate(self.source, out)
        self.assertNotIn("tools/_tmp/secret.txt", data["files"])
        self.assertNotIn("tools/unapproved_test.js", data["files"])
        self.assertIn("tools/test_pane_controls.js", data["files"])
        self.assertNotIn("tools/test_folder_notes.js", data["files"])
        self.assertEqual(candidate.verify_candidate(out), data)
        put(out, "app.js", "tampered")
        with self.assertRaisesRegex(candidate.resources.ResourceError, "digest mismatch"):
            candidate.verify_candidate(out)

    def test_runner_referenced_missing_suite_blocks_candidate(self):
        put(self.source, "tools/run_all_tests.py", "JS_SUITES = ['test_folder_notes.js']\n")
        with self.assertRaisesRegex(candidate.resources.ResourceError, "missing candidate suites"):
            candidate.export_candidate(self.source, self.base / "candidate")

    def test_unapproved_tracked_change_blocks_candidate(self):
        self.inventory["changed_tracked_files"].append("vendor/molstar.js")
        self.inventory["changed_tracked_files"].sort()
        with self.assertRaisesRegex(candidate.resources.ResourceError, "Unapproved tracked changes"):
            candidate.export_candidate(self.source, self.base / "candidate")

    def test_web_packaging_uses_same_resource_contract(self):
        datas = contract.web_datas(self.source)
        packaged = {Path(source).relative_to(self.source).as_posix() for source, _ in datas}
        self.assertEqual(packaged, contract.required_resources() | set(contract.CONTRACT["backend_data"]))
        self.assertNotIn("tools/run_all_tests.py", packaged)

    def test_backend_build_checks_sdk_and_packages_mcp_entrypoint_metadata_and_contract(self):
        provenance = build._source_provenance()
        real_run = subprocess.run

        def fixture_command(argv, **kwargs):
            if argv[3:4] == ["-c"]:
                # Check the real SDK in the selected interpreter, but never run PyInstaller.
                return real_run(argv, **kwargs)
            self.assertEqual(argv[:5], [sys.executable, "-I", "-B", "-m", "PyInstaller"])
            backend = build._backend_dist()
            put(backend, "StructBoardBackend.exe", b"fixture backend exe")
            for name in contract.CONTRACT["backend_data"]:
                put(backend, "_internal/" + name, (self.source / name).read_bytes())
            return subprocess.CompletedProcess(argv, 0)

        with mock.patch.object(build, "BUILD_PYTHON", sys.executable), \
             mock.patch.object(build.subprocess, "run", side_effect=fixture_command) as command:
            backend = build.build_backend(provenance)
        self.assertEqual(command.call_count, 2)
        probe = command.call_args_list[0]
        self.assertEqual(probe.args[0][:4], [sys.executable, "-I", "-B", "-c"])
        self.assertEqual(probe.kwargs["cwd"], str(self.source))
        self.assertTrue(probe.kwargs["check"])
        argv = command.call_args_list[1].args[0]
        hidden = {argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--hidden-import"}
        self.assertTrue({"pipeline_api", "serve", "scaffold_pipeline", "harness_broker", "mcp_server"} <= hidden)
        metadata = {argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--copy-metadata"}
        self.assertIn("mcp", metadata)
        data = {argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--add-data"}
        self.assertIn(str(self.source / "harness_contract.json") + os.pathsep + ".", data)
        self.assertEqual(backend, build._backend_dist())
        self.assertTrue(build._BACKEND_BUILT)
        self.assertEqual(build._BACKEND_SOURCE_DIGEST, provenance["source_digest"])

    def test_missing_backend_sdk_dependencies_or_metadata_fail_before_replacing_output(self):
        dist = build.TEST / "tauri-backend-v2-dist"
        work = build.TEST / "tauri-backend-work"
        put(dist, "StructBoardBackend/StructBoardBackend.exe", b"previous backend")
        put(work, "previous.txt", b"previous build work")
        before = tree_bytes(build.TEST)
        real_run = subprocess.run
        missing = {
            "SDK": "import sys; sys.modules['mcp'] = None\n",
            "SDK dependency": "import sys; sys.modules['pydantic'] = None\n",
            "SDK metadata": (
                "import importlib.metadata\n"
                "_real_version = importlib.metadata.version\n"
                "def _missing_mcp_metadata(name):\n"
                "    if name == 'mcp': raise importlib.metadata.PackageNotFoundError(name)\n"
                "    return _real_version(name)\n"
                "importlib.metadata.version = _missing_mcp_metadata\n"
            ),
        }
        for label, prefix in missing.items():
            with self.subTest(missing=label):
                def missing_dependency(argv, **kwargs):
                    self.assertEqual(argv[:4], [sys.executable, "-I", "-B", "-c"])
                    return real_run([*argv[:-1], prefix + argv[-1]], **kwargs)

                with mock.patch.object(build, "BUILD_PYTHON", sys.executable), \
                     mock.patch.object(build.subprocess, "run", side_effect=missing_dependency) as command:
                    with self.assertRaisesRegex(build.DeploymentError, "official MCP SDK") as caught:
                        build.build_backend()
                self.assertEqual(command.call_count, 1)
                self.assertIn(sys.executable, str(caught.exception))
                self.assertIn(str(self.source / "requirements-mcp.txt"), str(caught.exception))
                self.assertIn("STRUCTBOARD_BUILD_PYTHON", str(caught.exception))
                self.assertEqual(tree_bytes(build.TEST), before)
                self.assertFalse(build._BACKEND_BUILT)
                self.assertIsNone(build._BACKEND_SOURCE_DIGEST)

    def test_build_window_always_stages_once_and_uses_locked_cargo(self):
        self.stage()
        target = self.base / "cargo-target"
        put(target, "release/StructBoard.exe", "mocked built exe")
        backend = self.base / "mocked-backend"
        backend.mkdir()
        with mock.patch.object(build, "_source_provenance", return_value=build._source_provenance()), \
             mock.patch.object(build, "stage_assets", wraps=build.stage_assets) as stage, \
             mock.patch.object(build, "build_backend") as build_backend, \
             mock.patch.object(build, "_tool_versions", return_value=TOOL_VERSIONS), \
             mock.patch.object(build, "_cargo_environment", return_value=({}, Path("cargo"), target)), \
             mock.patch.object(build.subprocess, "run") as command, \
             mock.patch.object(build, "_backend_dist", return_value=backend), \
             mock.patch.object(build, "stage_release", return_value=self.base / "mock-release"), \
             mock.patch.object(build, "_configured_deploy_targets", return_value=([], True)), \
             mock.patch.object(build, "deploy_release_to_targets") as deploy:
            build.build_window()
        self.assertEqual(stage.call_count, 1)
        self.assertEqual(build_backend.call_count, 1)
        self.assertIn("--locked", command.call_args.args[0])
        self.assertEqual(deploy.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
