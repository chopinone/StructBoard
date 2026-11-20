"""The shared, explicit input contract for desktop and browser distributions.

Only named files are packaged. Approved new files may be used in a working-tree
candidate, but are never described as tracked or as a clean-checkout build.
"""
import ast
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
from urllib.parse import unquote, urlsplit


CONTRACT = {
    "version": 1,
    "tracked_required": [
        "index.html", "pipeline.html", "styles.css", "app.js", "desktop_bridge.js",
        "io.js", "align.js", "metrics.js", "zip.js", "lineage.js",
        "session_migration.js", "session_store.js", "workspace_org.js", "overview.js",
        "app_icon.ico", "app_icon_64.png", "app_icon_128.png",
        "structboard-splash-white.svg", "structboard-splash-dark.svg",
        "structboard-protein-logo.svg", "structboard-icon.svg", "structboard-logo-compact.svg",
        "vendor/molstar.css", "vendor/molstar.js",
    ],
    "approved_new_required": [
        "actions.js", "ai_chat.js", "ai_logo.png", "notes_edit.js", "notes_sync.js",
        "pane_runtime.js", "workspace_save.js", "app_operations.js",
        "harness.css", "harness_bridge.js", "harness_ui.js", "canvas_bridge.js", "canvas_document.js",
        "pipeline_tabs.js", "startup.js", "route-map.css",
        "ui/shell.js", "ui/build.json",
    ],
    "approved_optional": [],
    "backend_data": ["pipelines/SCHEMA.md", "harness_contract.json"],
    "build_sources": [
        "build_desktop.py", "build_exe.py", "StructBoard.spec", "resource_contract.py",
        "desktop_backend.py", "serve.py", "pipeline_api.py", "scaffold_pipeline.py",
        "harness_broker.py", "mcp_server.py", "requirements-mcp.txt",
        "client_setup.py", "demo_data.py",
        "desktop/Cargo.toml", "desktop/Cargo.lock", "desktop/build.rs",
        "desktop/src/main.rs", "desktop/tauri.conf.json", "desktop/capabilities/main.json",
        "package.json", "package-lock.json", "frontend/vite.config.mjs", "frontend/main.mjs",
        "frontend/application/tab-controller.mjs", "frontend/components/PipelineTabs.vue",
        "frontend/application/membership-refresh.mjs", "frontend/application/workspace-service.mjs", "frontend/components/StepNavigation.vue",
        "frontend/domain/step-navigation.mjs", "frontend/domain/bench-arrangement.mjs",
        "frontend/components/PromptDialog.vue", "frontend/components/TrashList.vue", "frontend/views/dialog-host.mjs",
        "frontend/components/WorkbenchToolbar.vue", "frontend/components/GroupChips.vue", "frontend/components/EntryList.vue", "frontend/components/MetricsPanel.vue", "frontend/views/mount-view.mjs",
        "frontend/components/AssistantSettings.vue", "frontend/components/AssistantPanel.vue", "frontend/components/HarnessPanel.vue", "frontend/components/GridCell.vue", "frontend/components/OverviewCard.vue", "frontend/components/OverviewSection.vue", "frontend/views/surfaces.json", "frontend/views/surfaces.mjs",
        "frontend/views/transcript-tree.mjs", "frontend/views/transcript.mjs", "frontend/views/split-motion.mjs",
        "frontend/components/PipelineNodes.vue", "frontend/components/PipelineSidebar.vue",
        "frontend/canvas/runtime.mjs", "frontend/canvas/route-editor.mjs", "frontend/canvas/route-geometry.mjs",
        "tools/check_frontend_build.mjs",
        "frontend/runtime/workspace-state.mjs",
        "frontend/runtime/structure-engine.mjs",
        "frontend/runtime/structure-audit.mjs",
        "frontend/runtime/structure-data.mjs",
        "frontend/runtime/file-import.mjs",
        "frontend/runtime/metrics.mjs",
        "frontend/runtime/notes.mjs",
        "frontend/runtime/step-organization.mjs",
        "frontend/runtime/sidebar.mjs",
        "frontend/runtime/viewer-navigation.mjs",
        "frontend/runtime/grid-view.mjs",
        "frontend/runtime/overview-controller.mjs",
        "frontend/runtime/pane-controller.mjs",
        "frontend/runtime/app-operations.mjs",
        "frontend/runtime/pipeline-assist.mjs",
        "frontend/runtime/dialogs.mjs",
        "frontend/runtime/app-bindings.mjs",
        "frontend/runtime/registry.mjs",
        "frontend/runtime/manifest.json",

    ],
    # This is deliberately bounded: generated URLs and API/user-data requests are
    # not a dependency graph. Literal loaders are checked as well as this known edge.
    "dynamic_references": {"ai_chat.js": ["ai_logo.png"]},
    "approved_new_support": [
        "CHANGELOG.md",
        "docs/MEDIA.md",
        "docs/images/ai-connection.png",
        "docs/images/demo-preview.gif",
        "docs/images/model-comparison.png",
        "docs/images/route-map.png",
        "docs/images/split-view.png",

        ".gitattributes",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "PRIVACY.md",
        "ARCHITECTURE.md",
        "CONTRIBUTING.md",
        "RELEASING.md",
        "public-source.json",
        "tools/check_public_source.py",
        "tools/test_public_source.py",
        ".github/workflows/source-check.yml",
        "licenses/Apache-2.0.txt",
        "licenses/Molstar-bundled-notices.txt",
        "licenses/Molstar-MIT.txt",
        "licenses/React-MIT.txt",
        "licenses/Vue-MIT.txt",

        "tools/app_source.cjs", "tools/surface_fixture.cjs", "tools/test_ui_architecture.js", "frontend/tests/tab-controller.test.mjs",
        "frontend/tests/route-geometry.test.mjs", "frontend/tests/workspace-service.test.mjs", "frontend/tests/step-navigation.test.mjs", "frontend/tests/membership-refresh.test.mjs",
        "frontend/tests/workspace-fixture.mjs", "frontend/tests/bench-arrangement.test.mjs",
        "frontend/tests/workspace.spec.mjs", "frontend/playwright.config.mjs",
        "tools/migration_workspace.py",
        "resource_contract.py", "tools/create_release_candidate.py", "tools/test_desktop_release.py",
        "tools/run_all_tests.py", "tools/test_pane_runtime.js", "tools/test_pane_controls.js",
        "tools/test_workspace_save.js", "tools/test_session_store.js", "tools/test_folder_notes.js", "tools/test_overview_lifecycle.js", "tools/test_overview_demand.js",
        "tools/test_parsed_retention.js", "tools/test_pipeline_merge.js",
        "tools/test_actions.js", "tools/test_pipeline_assist.js", "tools/test_ai_chat.js",
        "tools/test_search_filter.js", "tools/test_notes_sync.js", "tools/test_step_note_edit.js",
        "tools/test_session_badge.js", "tools/test_pipeline_notes.py", "tools/test_ai_proxy.py",
        "harness_contract.json", "harness_broker.py", "mcp_server.py", "requirements-mcp.txt",
        "tools/test_ai_chat_engine.js", "tools/test_ai_chat_ui.js", "tools/test_ai_proxy_stream.py",
        "tools/test_app_operations.js", "tools/test_canvas_document.js", "tools/test_canvas_bridge.js",
        "tools/test_harness_broker.py", "tools/test_mcp_server.py", "tools/test_overview_performance.html",
        "tools/test_harness_ui.js",
        "tools/test_pipeline_tabs.js",
        "tools/test_blank_tabs.js",
        "tools/test_external_drop.js",
        "tools/test_startup.js",
        "client_setup.py", "demo_data.py", "tools/test_client_setup.py", "tools/test_demo_data.py",
        "tools/build_public_release.py", "tools/public_installer.nsi", "README.md",
        "requirements-dev.txt", ".github/workflows/windows-release.yml",
    ],
    "approved_tracked_support_changes": [
        ".gitignore", "app.js", "desktop_bridge.js", "index.html", "overview.js", "pipeline.html", "styles.css", "tools/run_all_tests.py",
        "tools/test_overview_queue.js", "tools/test_workspace_org.js", "tools/test_workspace_org_identity.js",
        "tools/test_toolbar_geometry.js", "session_store.js", "tools/test_session_store.html",
        "pipelines/SCHEMA.md", "io.js", "tools/test_mcp_server.py",
    ],
}
CANDIDATE_RECORD = "candidate-provenance.json"
_HASH = re.compile(r"^[0-9a-f]{64}$")
_DYNAMIC = re.compile(
    r"(?:\.(?:src|href)\s*=\s*|"
    r"\bsetAttribute\(\s*['\"](?:src|href)['\"]\s*,\s*|"
    r"\b(?:fetch|import|importScripts)\s*\(\s*|"
    r"\bnew\s+(?:Worker|SharedWorker|URL)\s*\(\s*)"
    r"(?P<quote>['\"])(?P<url>[^'\"\r\n]+)(?P=quote)"
)
_CSS_URL = re.compile(r"url\(\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s)]*))\s*\)", re.IGNORECASE)
_CSS_IMPORT = re.compile(r"@import\s+['\"]([^'\"]+)['\"]", re.IGNORECASE)
_ASSET_SUFFIXES = {".js", ".mjs", ".css", ".html", ".png", ".svg", ".ico", ".jpg", ".jpeg", ".webp", ".gif", ".woff", ".woff2", ".ttf", ".wasm", ".json"}


class ResourceError(ValueError):
    """The source or packaged resource set violates the release contract."""


def validate_frontend_build(source):
    """Reject a stale generated UI before building or packaging a release."""
    try:
        subprocess.run(['node', str(Path(source) / 'tools/check_frontend_build.mjs')],
                       cwd=str(source), check=True, capture_output=True, text=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ResourceError('Vue bundle check failed. Run npm ci && npm run build:ui && npm run check:ui.') from exc


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")).hexdigest()


def contract_digest():
    return canonical_digest(CONTRACT)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_name(name):
    if not isinstance(name, str) or not name or "\\" in name or ":" in name or "\x00" in name:
        raise ResourceError(f"Invalid resource path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in (".", "..") for part in name.split("/")) or path.as_posix() != name:
        raise ResourceError(f"Invalid resource path: {name!r}")
    return name


def plain_file(root, name):
    path = Path(root) / relative_name(name)
    current = path
    while current != Path(root):
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            return False
        current = current.parent
    return path.is_file()


def required_resources():
    return set(CONTRACT["tracked_required"] + CONTRACT["approved_new_required"])


def approved_new_files():
    return set(CONTRACT["approved_new_required"] + CONTRACT["approved_optional"] + CONTRACT["approved_new_support"])


def resource_paths(source):
    source = Path(source)
    required = required_resources()
    missing = [source / name for name in sorted(required) if not plain_file(source, name)]
    invalid_optional = [source / name for name in CONTRACT["approved_optional"]
                        if (source / name).exists() and not plain_file(source, name)]
    if missing or invalid_optional:
        raise ResourceError("Missing or non-regular required source resources:\n" + "\n".join(str(path) for path in missing + invalid_optional))
    return sorted(required | {name for name in CONTRACT["approved_optional"] if plain_file(source, name)})


def _local_reference(owner, url):
    url = url.strip()
    if not url or url.startswith("#"):
        return None
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise ResourceError(f"Invalid URL in {owner}: {url}") from exc
    if parsed.scheme or parsed.netloc:
        return None
    path = unquote(parsed.path)
    if not path:
        return None
    if "\\" in path or "\x00" in path:
        raise ResourceError(f"Invalid local URL in {owner}: {url}")
    parts = [] if path.startswith("/") else list(PurePosixPath(owner).parent.parts)
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                raise ResourceError(f"Local URL escapes resource root in {owner}: {url}")
            parts.pop()
        else:
            parts.append(part)
    return relative_name("/".join(parts))


class _HTMLReferences(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = []
        self.styles = []
        self.in_style = False

    def handle_starttag(self, tag, attrs):
        if tag == "style":
            self.in_style = True
        for key, value in attrs:
            if key in ("src", "href") and value is not None:
                self.references.append(value)
            elif key == "style" and value is not None:
                self.styles.append(value)

    def handle_endtag(self, tag):
        if tag == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self.styles.append(data)

    handle_startendtag = handle_starttag


def validate_references(root, names):
    """Check HTML links, CSS URLs, and bounded first-party literal loaders."""
    root = Path(root)
    allowed = set(names)
    errors = set()
    for name in sorted(allowed):
        suffix = PurePosixPath(name).suffix.lower()
        if suffix not in (".html", ".css", ".js"):
            continue
        if name.startswith("vendor/") and suffix == ".js":
            continue
        text = (root / name).read_text(encoding="utf-8-sig")
        urls = []
        css_text = text if suffix == ".css" else ""
        if suffix == ".html":
            parser = _HTMLReferences()
            parser.feed(text)
            urls.extend(parser.references)
            css_text = "\n".join(parser.styles)
        if css_text:
            urls.extend(next(value for value in match.groups() if value is not None) for match in _CSS_URL.finditer(css_text))
            urls.extend(match.group(1) for match in _CSS_IMPORT.finditer(css_text))
        if suffix in (".html", ".js"):
            for match in _DYNAMIC.finditer(text):
                url = match.group("url")
                # APIs, user-provided URLs, and literal prefixes of computed URLs
                # are outside this bounded static-resource check.
                if url.startswith("/api/") or text[match.end():].lstrip().startswith("+"):
                    continue
                if PurePosixPath(urlsplit(url).path).suffix.lower() not in _ASSET_SUFFIXES:
                    continue
                urls.append(url)
        urls.extend(CONTRACT["dynamic_references"].get(name, ()))
        for url in urls:
            relative = _local_reference(name, url)
            if relative is not None and (relative not in allowed or not plain_file(root, relative)):
                errors.add(f"{name}: {url} -> {root / relative}")
    if errors:
        raise ResourceError("Missing or undeclared local resource references:\n" + "\n".join(sorted(errors)))


def resource_hashes(source):
    names = resource_paths(source)
    validate_references(source, names)
    return {name: file_hash(Path(source) / name) for name in names}


def validate_assets(root, expected):
    root = Path(root)
    required = required_resources()
    allowed = required | set(CONTRACT["approved_optional"])
    if required - set(expected) or set(expected) - allowed:
        raise ResourceError("Resource inventory does not match the required contract: " + ", ".join(sorted((required - set(expected)) | (set(expected) - allowed))))
    missing = [str(root / name) for name in sorted(expected) if not plain_file(root, name)]
    actual_files = set()
    actual_dirs = set()
    invalid = []
    for path in root.rglob("*"):
        name = path.relative_to(root).as_posix()
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            invalid.append(name)
        elif path.is_file():
            actual_files.add(name)
        elif path.is_dir():
            actual_dirs.add(name)
        else:
            invalid.append(name)
    expected_dirs = {parent.as_posix() for name in expected for parent in PurePosixPath(name).parents if parent.as_posix() != "."}
    extras = (actual_files - set(expected)) | (actual_dirs - expected_dirs) | set(invalid)
    if missing or extras:
        raise ResourceError("Incomplete or polluted asset tree; missing: " + ", ".join(missing) + "; unexpected: " + ", ".join(sorted(extras)))
    changed = [name for name in sorted(expected) if file_hash(root / name) != expected[name]]
    if changed:
        raise ResourceError("Asset/source hash mismatch: " + ", ".join(changed))
    validate_references(root, expected)


def web_datas(source):
    """PyInstaller browser distribution data, from the same bounded contract."""
    names = list(resource_hashes(source)) + CONTRACT["backend_data"]
    missing = [str(Path(source) / name) for name in names if not plain_file(source, name)]
    if missing:
        raise ResourceError("Missing package source files:\n" + "\n".join(missing))
    return [(str(Path(source) / name), str(PurePosixPath(name).parent)) for name in sorted(names)]


def _git(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args], check=True, capture_output=True)
    text = result.stdout.decode("utf-8")
    if "-z" in args:
        return text.rstrip("\x00").split("\x00") if text else []
    return text.strip()


def _git_inventory(source):
    return {
        "head": _git(source, "rev-parse", "HEAD"),
        "tracked_files": sorted(_git(source, "ls-files", "-z")),
        "changed_tracked_files": sorted(_git(source, "diff", "--name-only", "-z", "HEAD", "--")),
    }


def validate_runner_references(source, files):
    runner = Path(source) / "tools/run_all_tests.py"
    if "tools/run_all_tests.py" not in files:
        return
    tree = ast.parse(runner.read_text(encoding="utf-8-sig"), filename=str(runner))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            value = node.value
            if re.fullmatch(r"(?:tools/)?test_[A-Za-z0-9_]+\.(?:js|py|html)", value):
                names.add(value if value.startswith("tools/") else "tools/" + value)
    missing = [str(Path(source) / name) for name in sorted(names) if name not in files or not plain_file(source, name)]
    if missing:
        raise ResourceError("Test runner references missing candidate suites:\n" + "\n".join(missing))


def _tracked_required_names():
    return set(CONTRACT["tracked_required"] + CONTRACT["backend_data"] + CONTRACT["build_sources"]) - approved_new_files()


def _build_input_names(resources):
    return sorted(set(resources) | set(CONTRACT["build_sources"]) | set(CONTRACT["backend_data"]))


def validate_provenance(data):
    if not isinstance(data, dict) or data.get("schema") != 1 or data.get("contract_digest") != contract_digest():
        raise ResourceError("Missing or incompatible source provenance/resource contract")
    files = data.get("files")
    if not isinstance(files, dict) or not files:
        raise ResourceError("Source provenance has no file inventory")
    for name, digest in files.items():
        relative_name(name)
        if not isinstance(digest, str) or not _HASH.fullmatch(digest):
            raise ResourceError(f"Invalid source hash: {name}")
    if len({name.casefold() for name in files}) != len(files):
        raise ResourceError("Source provenance contains case-colliding paths")
    groups = [data.get(key) for key in ("tracked_files", "approved_untracked_files", "changed_tracked_files", "build_inputs")]
    if any(not isinstance(group, list) or any(not isinstance(name, str) for name in group) or group != sorted(set(group)) for group in groups):
        raise ResourceError("Invalid source provenance path groups")
    tracked, approved, changed, build_inputs = map(set, groups)
    if tracked & approved or tracked | approved != set(files) or approved - approved_new_files():
        raise ResourceError("Source provenance contains unapproved or misclassified files")
    tracked_required = _tracked_required_names()
    if tracked_required - tracked or changed - tracked:
        raise ResourceError("Tracked-required source resources are not tracked")
    approved_changes = set(CONTRACT["approved_new_required"] + CONTRACT["approved_optional"] + CONTRACT["build_sources"] + CONTRACT["approved_new_support"] + CONTRACT["approved_tracked_support_changes"])
    if changed - approved_changes:
        raise ResourceError("Unapproved tracked changes: " + ", ".join(sorted(changed - approved_changes)))
    resource_names = required_resources() | (set(CONTRACT["approved_optional"]) & set(files))
    if set(_build_input_names(resource_names)) != build_inputs or build_inputs - set(files):
        raise ResourceError("Source provenance is missing required build inputs")
    if data.get("candidate_digest") != canonical_digest(files) or data.get("source_digest") != canonical_digest({name: files[name] for name in sorted(build_inputs)}):
        raise ResourceError("Source/candidate provenance digest mismatch")
    if not isinstance(data.get("head"), str) or not re.fullmatch(r"[0-9a-f]{40,64}", data["head"]):
        raise ResourceError("Source provenance has no valid Git HEAD")
    committed_clean = not changed and not approved
    if data.get("committed_clean") is not committed_clean:
        raise ResourceError("Source provenance incorrectly claims clean-checkout reproduction")
    return data


def capture_source(source):
    """Read tracked working files plus explicitly approved new files; never write Git."""
    source = Path(source).resolve()
    resources = resource_hashes(source)
    marker = source / CANDIDATE_RECORD
    if marker.is_file() and not (source / ".git").exists():
        data = validate_provenance(json.loads(marker.read_text(encoding="utf-8")))
        missing = [str(source / name) for name in data["files"] if not plain_file(source, name)]
        if missing:
            raise ResourceError("Missing candidate files:\n" + "\n".join(missing))
        actual = {name: file_hash(source / name) for name in data["files"]}
        if actual != data["files"]:
            raise ResourceError("Exported candidate files changed after snapshot")
        validate_runner_references(source, data["files"])
        return data
    try:
        inventory = _git_inventory(source)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ResourceError(f"Cannot establish Git source provenance for {source}") from exc
    tracked = set(inventory["tracked_files"])
    if _tracked_required_names() - tracked:
        raise ResourceError("Tracked-required source resources are not tracked: " + ", ".join(sorted(_tracked_required_names() - tracked)))
    approved = {name for name in approved_new_files() - tracked if plain_file(source, name)}
    public_names = (required_resources() | set(CONTRACT['build_sources']) | set(CONTRACT['backend_data']) |
                    approved_new_files() | set(CONTRACT['approved_tracked_support_changes']))
    tracked &= public_names
    names = sorted(tracked | approved)
    missing = [str(source / name) for name in sorted(set(names) | set(_build_input_names(resources))) if not plain_file(source, name)]
    if missing:
        raise ResourceError("Missing or non-regular candidate source files:\n" + "\n".join(missing))
    files = {name: file_hash(source / name) for name in names}
    validate_runner_references(source, files)
    inputs = _build_input_names(resources)
    data = {
        "schema": 1,
        "head": inventory["head"],
        "contract_digest": contract_digest(),
        "tracked_files": sorted(tracked),
        "approved_untracked_files": sorted(approved),
        "changed_tracked_files": sorted(set(inventory["changed_tracked_files"]) & tracked),
        "committed_clean": not (set(inventory["changed_tracked_files"]) & tracked) and not approved,
        "files": files,
        "build_inputs": inputs,
        "source_digest": canonical_digest({name: files[name] for name in inputs}),
        "candidate_digest": canonical_digest(files),
    }
    return validate_provenance(data)


def assert_current_source(source, expected):
    validate_provenance(expected)
    actual = capture_source(source)
    if actual != expected:
        raise ResourceError("Release source provenance does not match the current source/candidate snapshot")
    return actual
