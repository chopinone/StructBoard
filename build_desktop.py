"""Build, stage, validate, and deploy the StructBoard desktop release."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SRC = Path(__file__).resolve().parent
# Loading by the exact sibling path also supports `python -I -B build_desktop.py`.
_contract_spec = importlib.util.spec_from_file_location("structboard_resource_contract", SRC / "resource_contract.py")
resources = importlib.util.module_from_spec(_contract_spec)
_contract_spec.loader.exec_module(resources)
WORKSPACE = SRC.parent
DESKTOP = SRC / "desktop"
TEST = Path(os.environ.get("STRUCTBOARD_WORK_DIR", WORKSPACE / "_test")).expanduser().resolve()
OUTPUT = Path(os.environ.get("STRUCTBOARD_OUTPUT_DIR", SRC / "dist/StructBoardTauri")).expanduser().resolve()
RUST = Path(os.environ.get("STRUCTBOARD_RUST_DIR", Path.home() / '.cargo')).expanduser()
_DEFAULT_BUILD_PYTHON = WORKSPACE / "_test" / "pyinstaller-venv" / "Scripts" / "python.exe"
BUILD_PYTHON = os.environ.get("STRUCTBOARD_BUILD_PYTHON") or os.environ.get("STRUCTBOARD_PYTHON") or (
    str(_DEFAULT_BUILD_PYTHON) if _DEFAULT_BUILD_PYTHON.is_file() else sys.executable
)

_DEFAULT_DEPLOY_TARGETS = ()  # Builds only write their output; installation is explicit.
_MANAGED_RELEASE_ITEMS = ("StructBoard.exe", "bootstrap", "backend", "manifest.json")
_BACKEND_BUILT = False
_BACKEND_SOURCE_DIGEST = None
_BUILD_TOOLS = None


class DeploymentError(RuntimeError):
    """Raised when a complete release cannot be installed at a target."""


def _copy_path(src, dest):
    src = Path(src)
    dest = Path(dest)
    if src.is_dir():
        shutil.copytree(src, dest, dirs_exist_ok=True)
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def _move_path(src, dest):
    """A small seam for rollback tests and platform-specific replacement behavior."""
    return shutil.move(str(src), str(dest))


def _remove_path(path):
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink()


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_tree(path):
    """Hash a directory including relative names, so additions and removals matter."""
    root = Path(path)
    digest = hashlib.sha256()
    for item in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.relative_to(root).as_posix()):
        relative = item.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(_sha256_file(item).encode("ascii"))
    return digest.hexdigest()


def _build_id():
    return os.environ.get("STRUCTBOARD_BUILD_ID") or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _release_hashes(release):
    release = Path(release)
    return {
        "exe": _sha256_file(release / "StructBoard.exe"),
        "assets": _sha256_tree(release / "bootstrap"),
        "backend": _sha256_tree(release / "backend"),
    }


def _manifest(release):
    release = Path(release)
    manifest_path = release / "manifest.json"
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DeploymentError(f"Cannot read release manifest: {manifest_path}") from exc
    if not isinstance(data, dict) or not data.get("build_id"):
        raise DeploymentError(f"Release manifest has no build_id: {manifest_path}")
    hashes = data.get("hashes")
    if not isinstance(hashes, dict) or set(("exe", "assets", "backend")) - set(hashes):
        raise DeploymentError(f"Release manifest has incomplete hashes: {manifest_path}")
    return data


def _source_provenance():
    try:
        return resources.capture_source(SRC)
    except (resources.ResourceError, OSError, ValueError, SyntaxError) as exc:
        raise DeploymentError(str(exc)) from exc


def _asset_inventory(provenance):
    names = resources.required_resources() | (set(resources.CONTRACT["approved_optional"]) & set(provenance["files"]))
    return {name: provenance["files"][name] for name in sorted(names)}


def _validate_backend(backend, provenance):
    backend = Path(backend)
    invalid = [str(path) for path in backend.rglob("*")
               if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())]
    if invalid or not (backend / "StructBoardBackend.exe").is_file():
        raise DeploymentError("Invalid desktop backend files: " + ", ".join(invalid or [str(backend / "StructBoardBackend.exe")]))
    for name in resources.CONTRACT["backend_data"]:
        path = backend / "_internal" / name
        if not resources.plain_file(backend, "_internal/" + name) or _sha256_file(path) != provenance["files"][name]:
            raise DeploymentError(f"Backend data/source mismatch: {path}")


def _validate_tools(tools):
    required = {"python", "pyinstaller", "cargo", "rustc", "git"}
    if not isinstance(tools, dict) or set(tools) != required or any(not isinstance(value, str) or not value.strip() for value in tools.values()):
        raise DeploymentError("Release provenance must record Python, PyInstaller, Cargo, rustc, and Git versions")


def validate_release(release, source_provenance=None, *, managed_only=False):
    """Check contract, source provenance, and hashes before any target is changed.

    Callers may pin a prior source snapshot explicitly; otherwise validation is
    anchored to the current source/candidate, never to manifest assertions alone.
    """
    release = Path(release)
    missing = [str(release / item) for item in _MANAGED_RELEASE_ITEMS if not (release / item).exists()]
    invalid = [str(release / item) for item in _MANAGED_RELEASE_ITEMS if (release / item).is_symlink()]
    if missing or invalid or not (release / "StructBoard.exe").is_file() or not (release / "backend").is_dir():
        raise DeploymentError("Incomplete or invalid desktop release: " + ", ".join(missing + invalid or [str(release)]))
    if not managed_only:
        extra = sorted(path.name for path in release.iterdir() if path.name not in _MANAGED_RELEASE_ITEMS)
        if extra:
            raise DeploymentError("Unexpected staged release files: " + ", ".join(extra))
    data = _manifest(release)
    expected = source_provenance if source_provenance is not None else _source_provenance()
    try:
        resources.validate_provenance(expected)
        resources.validate_provenance(data.get("source"))
        if data["source"] != expected:
            raise resources.ResourceError("Release source provenance does not match the approved source/candidate snapshot")
        assets = _asset_inventory(expected)
        if data.get("resource_contract") != {"version": resources.CONTRACT["version"], "digest": resources.contract_digest(), "files": assets}:
            raise resources.ResourceError("Release resource inventory does not match the source contract")
        resources.validate_assets(release / "bootstrap", assets)
    except (resources.ResourceError, OSError, ValueError, KeyError, TypeError) as exc:
        raise DeploymentError(str(exc)) from exc
    _validate_backend(release / "backend", expected)
    _validate_tools(data.get("tools"))
    if data["hashes"] != _release_hashes(release):
        raise DeploymentError(f"Release hash validation failed for {release}")
    return data


def stage_release(window_exe, bootstrap, backend, parent=None, *, source_provenance=None, tools=None):
    """Create and validate a complete release against an approved source snapshot."""
    window_exe, bootstrap, backend = map(Path, (window_exe, bootstrap, backend))
    for path, label in ((window_exe, "window executable"), (bootstrap, "bootstrap assets"), (backend, "backend")):
        if not path.exists():
            raise DeploymentError(f"Missing {label}: {path}")
    source_provenance = source_provenance if source_provenance is not None else _source_provenance()
    tools = tools if tools is not None else (_BUILD_TOOLS or _tool_versions())
    _validate_tools(tools)
    parent = Path(parent or OUTPUT.parent)
    if _refuses_appdata(parent):
        raise DeploymentError(f"Refusing to stage a release into AppData: {parent}")
    parent.mkdir(parents=True, exist_ok=True)
    release = Path(tempfile.mkdtemp(prefix=".structboard-release-", dir=str(parent)))
    try:
        _copy_path(window_exe, release / "StructBoard.exe")
        _copy_path(bootstrap, release / "bootstrap")
        _copy_path(backend, release / "backend")
        manifest = {
            "build_id": _build_id(),
            "hashes": _release_hashes(release),
            "files": {"exe": "StructBoard.exe", "assets": "bootstrap/", "backend": "backend/"},
            "resource_contract": {"version": resources.CONTRACT["version"], "digest": resources.contract_digest(),
                                  "files": _asset_inventory(source_provenance)},
            "source": source_provenance,
            "tools": tools,
        }
        (release / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        validate_release(release, source_provenance)
        return release
    except Exception:
        _remove_path(release)
        raise


def _appdata_roots():
    roots = []
    for name in ("APPDATA", "LOCALAPPDATA"):
        value = os.environ.get(name)
        if value:
            roots.append(Path(value).expanduser().resolve())
    return roots


def _refuses_appdata(target):
    try:
        resolved = Path(target).expanduser().resolve()
    except OSError:
        resolved = Path(target).expanduser().absolute()
    return any(resolved == root or root in resolved.parents for root in _appdata_roots())


def _install_release_transaction(release, target, container=None):
    """Install one complete release transactionally; caller owns multi-target rollback."""
    release = Path(release)
    target = Path(target).expanduser().resolve()
    if target == release or target in release.parents or release in target.parents:
        raise DeploymentError(f"Release and deployment paths overlap: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    existed = target.exists()
    target.mkdir(parents=True, exist_ok=True)
    container = Path(container) if container else Path(tempfile.mkdtemp(prefix=".structboard-transaction-", dir=str(target.parent)))
    incoming = container / "incoming"
    backup = container / "backup"
    incoming.mkdir(parents=True, exist_ok=True)
    backup.mkdir(parents=True, exist_ok=True)
    backed_up = []
    installed = []
    try:
        for item in _MANAGED_RELEASE_ITEMS:
            _copy_path(release / item, incoming / item)
        validate_release(incoming)
        for item in _MANAGED_RELEASE_ITEMS:
            destination = target / item
            if destination.exists() or destination.is_symlink():
                _move_path(destination, backup / item)
                backed_up.append(item)
        for item in _MANAGED_RELEASE_ITEMS:
            _move_path(incoming / item, target / item)
            installed.append(item)
        validate_release(target, managed_only=True)
        return {"target": target, "container": container, "existed": existed,
                "backed_up": backed_up, "installed": installed}
    except Exception:
        _rollback_release_transaction({"target": target, "container": container, "existed": existed,
                                       "backed_up": backed_up, "installed": installed})
        raise


def _rollback_release_transaction(state):
    target = state["target"]
    for item in reversed(state["installed"]):
        _remove_path(target / item)
    for item in reversed(state["backed_up"]):
        if (state["container"] / "backup" / item).exists():
            _move_path(state["container"] / "backup" / item, target / item)
    if not state["existed"] and target.exists() and not any(target.iterdir()):
        target.rmdir()


def install_release(release, target):
    """Install one complete release transactionally, preserving unrelated target files."""
    release = Path(release).resolve()
    target = Path(target).expanduser().resolve()
    validate_release(release)
    if _refuses_appdata(target):
        raise DeploymentError(f"Refusing to deploy into AppData: {target}")
    if target == release or target in release.parents or release in target.parents:
        raise DeploymentError(f"Release and deployment paths overlap: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    container = Path(tempfile.mkdtemp(prefix=".structboard-transaction-", dir=str(target.parent)))
    try:
        _install_release_transaction(release, target, container)
    except PermissionError as exc:
        raise DeploymentError(
            f"{target}: cannot replace an in-use release; close the running desktop/backend and retry; no process was stopped"
        ) from exc
    finally:
        _remove_path(container)
    return target


def _configured_deploy_targets():
    raw = os.environ.get("STRUCTBOARD_DEPLOY_TARGETS")
    if raw:
        return [Path(value).expanduser() for value in raw.split(os.pathsep) if value.strip()], True
    return list(_DEFAULT_DEPLOY_TARGETS), False


def deploy_release_to_targets(release, targets):
    """Prepare all targets first, then replace managed entries with global rollback."""
    release = Path(release).resolve()
    validate_release(release)
    targets = list(dict.fromkeys(Path(p).expanduser().resolve() for p in targets))
    for target in targets:
        if _refuses_appdata(target):
            raise DeploymentError(f"Refusing to deploy into AppData: {target}")
        if target == release or target in release.parents or release in target.parents:
            raise DeploymentError(f"Release and deployment paths overlap: {target}")
        if any(other != target and (other in target.parents or target in other.parents) for other in targets):
            raise DeploymentError(f"Deployment targets overlap: {target}")
    transactions = []
    current = release
    rollback_failed = False
    try:
        for target in targets:
            current = target
            target.parent.mkdir(parents=True, exist_ok=True)
            container = Path(tempfile.mkdtemp(prefix=".structboard-transaction-", dir=str(target.parent)))
            state = {"target": target, "container": container, "existed": target.exists(),
                     "backed_up": [], "installed": []}
            transactions.append(state)
            incoming = container / "incoming"
            incoming.mkdir()
            (container / "backup").mkdir()
            for item in _MANAGED_RELEASE_ITEMS:
                _copy_path(release / item, incoming / item)
            validate_release(incoming)
        for state in transactions:
            current = target = state["target"]
            target.mkdir(parents=True, exist_ok=True)
            for item in _MANAGED_RELEASE_ITEMS:
                destination = target / item
                if destination.exists() or destination.is_symlink():
                    _move_path(destination, state["container"] / "backup" / item)
                    state["backed_up"].append(item)
            for item in _MANAGED_RELEASE_ITEMS:
                _move_path(state["container"] / "incoming" / item, target / item)
                state["installed"].append(item)
            validate_release(target, managed_only=True)
    except Exception as exc:
        failures = []
        for state in reversed(transactions):
            target = state["target"]
            try:
                for item in reversed(state["installed"]):
                    _remove_path(target / item)
                for item in reversed(state["backed_up"]):
                    _move_path(state["container"] / "backup" / item, target / item)
                if not state["existed"] and target.exists() and not any(target.iterdir()):
                    target.rmdir()
            except Exception as rollback_exc:
                rollback_failed = True
                failures.append(f"{target}: rollback failed ({rollback_exc}); retained recovery files at {state['container']}")
        detail = f"Desktop deployment failed at {current}: {exc}"
        if isinstance(exc, PermissionError):
            detail += ". Close the running desktop/backend and retry; no user process was stopped"
        if failures:
            detail += "; " + "; ".join(failures)
        print(detail, flush=True)
        raise DeploymentError(detail) from exc
    finally:
        if not rollback_failed:
            for state in transactions:
                try:
                    _remove_path(state["container"])
                except PermissionError as cleanup_error:
                    # Running backend processes can retain DLLs from the old backup tree.
                    # Deployment is already validated; retain the recovery directory and report it.
                    print(f"Warning: retained deployment recovery files at {state['container']}: {cleanup_error}", flush=True)
    for target in targets:
        print("Desktop deployed to:", target, flush=True)
    return True


def stage_assets(source_provenance=None):
    """Replace bootstrap with a verified, fresh sibling stage; preserve old on failure."""
    # Preflight everything together before even creating the staging directory.
    try:
        hashes = resources.resource_hashes(SRC)
        source_provenance = source_provenance if source_provenance is not None else _source_provenance()
        resources.validate_provenance(source_provenance)
        if hashes != _asset_inventory(source_provenance):
            raise resources.ResourceError("Asset sources differ from the approved source snapshot")
    except (resources.ResourceError, OSError, ValueError) as exc:
        raise DeploymentError(str(exc)) from exc
    assets = DESKTOP / "bootstrap"
    if _refuses_appdata(assets):
        raise DeploymentError(f"Refusing to stage assets into AppData: {assets}")
    assets.parent.mkdir(parents=True, exist_ok=True)
    container = Path(tempfile.mkdtemp(prefix=".structboard-assets-", dir=str(assets.parent)))
    incoming, backup = container / "incoming", container / "backup"
    incoming.mkdir()
    backed_up = installed = rollback_failed = False
    try:
        for name in hashes:
            _copy_path(SRC / name, incoming / name)
        resources.validate_assets(incoming, hashes)
        if _source_provenance() != source_provenance:
            raise DeploymentError("Source/candidate changed during asset staging")
        if assets.exists() or assets.is_symlink():
            _move_path(assets, backup)
            backed_up = True
        _move_path(incoming, assets)
        installed = True
        resources.validate_assets(assets, hashes)
    except Exception as exc:
        try:
            if installed:
                _remove_path(assets)
            if backed_up:
                _move_path(backup, assets)
        except Exception as rollback_exc:
            rollback_failed = True
            raise DeploymentError(f"Asset staging failed: {exc}; rollback failed: {rollback_exc}; recovery files retained at {container}") from exc
        raise DeploymentError(f"Asset staging failed; previous bootstrap preserved: {exc}") from exc
    finally:
        if not rollback_failed:
            try:
                _remove_path(container)
            except PermissionError as exc:
                print(f"Warning: retained asset recovery files at {container}: {exc}", flush=True)
    return assets


def _cargo_environment():
    env = os.environ.copy()
    if os.environ.get('STRUCTBOARD_RUST_DIR'):
        env["CARGO_HOME"] = str(RUST / "cargo")
        env["RUSTUP_HOME"] = str(RUST / "rustup")
    target = Path(os.environ.get("STRUCTBOARD_CARGO_TARGET_DIR", SRC / 'desktop/target'))
    env["CARGO_TARGET_DIR"] = str(target)
    env["CARGO_BUILD_JOBS"] = "2"
    cargo_bin = Path(os.environ.get("STRUCTBOARD_CARGO_BIN") or shutil.which('cargo') or
                     (RUST / ('cargo/bin/cargo.exe' if os.environ.get('STRUCTBOARD_RUST_DIR') else 'bin/cargo.exe')))
    env["PATH"] = str(cargo_bin.parent) + os.pathsep + env.get("PATH", "")
    return env, cargo_bin, target


def _version(argv, *, env=None):
    try:
        result = subprocess.run(argv, cwd=str(SRC), env=env, check=True, capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise DeploymentError(f"Cannot record tool version: {argv[0]}") from exc
    version = result.stdout.strip() or result.stderr.strip()
    if not version:
        raise DeploymentError(f"Tool returned no version: {argv[0]}")
    return version


def _tool_versions():
    env, cargo_bin, _ = _cargo_environment()
    rustc_bin = cargo_bin.with_name("rustc.exe" if cargo_bin.suffix.lower() == ".exe" else "rustc")
    return {
        "python": _version([BUILD_PYTHON, "-I", "-B", "--version"]),
        "pyinstaller": _version([BUILD_PYTHON, "-I", "-B", "-m", "PyInstaller", "--version"]),
        "cargo": _version([str(cargo_bin), "--version"], env=env),
        "rustc": _version([str(rustc_bin), "--version"], env=env),
        "git": _version(["git", "--version"]),
    }


def _backend_dist():
    return TEST / "tauri-backend-v2-dist" / "StructBoardBackend"


def _check_backend_dependencies():
    """Fail before replacing output if the selected build Python cannot run MCP."""
    probe = ("from importlib.metadata import version; "
             "import mcp.types; "
             "from mcp.server.lowlevel import Server; "
             "from mcp.server.lowlevel.helper_types import ReadResourceContents; "
             "from mcp.server.stdio import stdio_server; "
             "from pydantic import AnyUrl; "
             "version('mcp')")
    try:
        subprocess.run([BUILD_PYTHON, "-I", "-B", "-c", probe], cwd=str(SRC), check=True,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise DeploymentError(
            f"Desktop backend requires the official MCP SDK, its dependencies, and package metadata in build Python: {BUILD_PYTHON}. "
            f"Use an environment containing {SRC / 'requirements-mcp.txt'} dependencies via STRUCTBOARD_BUILD_PYTHON."
        ) from exc


def build_backend(source_provenance=None):
    """Always rebuild PyInstaller output so changed Python sources cannot use stale installed files."""
    global _BACKEND_BUILT, _BACKEND_SOURCE_DIGEST
    source_provenance = source_provenance if source_provenance is not None else _source_provenance()
    _check_backend_dependencies()
    TEST.mkdir(parents=True, exist_ok=True)
    dist_path = TEST / "tauri-backend-v2-dist"
    work_path = TEST / "tauri-backend-work"
    _remove_path(dist_path)
    _remove_path(work_path)
    opts = [str(SRC / "desktop_backend.py"), "--name", "StructBoardBackend", "--onedir", "--clean", "--noconfirm",
            "--distpath", str(dist_path), "--workpath", str(work_path), "--specpath", str(TEST),
            "--paths", str(SRC), "--hidden-import", "pipeline_api", "--hidden-import", "serve",
            "--hidden-import", "scaffold_pipeline", "--hidden-import", "harness_broker",
            "--hidden-import", "mcp_server", "--copy-metadata", "mcp", "--log-level", "WARN"]
    opts += ['--hidden-import', 'client_setup', '--hidden-import', 'demo_data']
    for name in resources.CONTRACT["backend_data"]:
        opts += ["--add-data", str(SRC / name) + os.pathsep + str(Path(name).parent)]
    subprocess.run([BUILD_PYTHON, "-I", "-B", "-m", "PyInstaller", *opts], cwd=str(SRC), check=True)
    backend = _backend_dist()
    if not backend.is_dir() or not (backend / "StructBoardBackend.exe").is_file():
        raise DeploymentError(f"Fresh PyInstaller backend output is missing: {backend}")
    _validate_backend(backend, source_provenance)
    _BACKEND_BUILT = True
    _BACKEND_SOURCE_DIGEST = source_provenance["source_digest"]
    return backend


def build_window():
    global _BACKEND_BUILT, _BUILD_TOOLS
    resources.validate_frontend_build(SRC)
    provenance = _source_provenance()
    # Always replace assets, including when an old bootstrap directory exists.
    assets = stage_assets(provenance)
    if not _BACKEND_BUILT or _BACKEND_SOURCE_DIGEST != provenance["source_digest"]:
        build_backend(provenance)
    _BUILD_TOOLS = _tool_versions()
    env, cargo_bin, target = _cargo_environment()
    subprocess.run([str(cargo_bin), "build", "--locked", "--release", "--manifest-path", str(DESKTOP / "Cargo.toml")], env=env, check=True)
    if _source_provenance() != provenance:
        raise DeploymentError("Source/candidate changed during desktop build; repeat from a fixed snapshot")
    window_exe = target / "release" / "StructBoard.exe"
    if not window_exe.is_file():
        raise DeploymentError(f"Cargo did not produce the desktop executable: {window_exe}")
    backend = _backend_dist()
    if not backend.is_dir():
        raise DeploymentError(f"Fresh backend output is missing: {backend}")
    release = stage_release(window_exe, assets, backend, parent=OUTPUT.parent,
                            source_provenance=provenance, tools=_BUILD_TOOLS)
    try:
        targets = [OUTPUT]
        external, explicit = _configured_deploy_targets()
        if os.environ.get("STRUCTBOARD_SKIP_DEPLOY"):
            print("Skipping configured external desktop deployment", flush=True)
        else:
            for target_dir in external:
                # Keep the historical local defaults usable on machines without the M: drive.
                if not explicit and not target_dir.exists():
                    print("Skipping unavailable desktop target:", target_dir, flush=True)
                else:
                    targets.append(target_dir)
        deploy_release_to_targets(release, targets)
        print("Desktop build:", OUTPUT, flush=True)
        return OUTPUT
    finally:
        _remove_path(release)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets-only", action="store_true")
    parser.add_argument("--validate-release", type=Path, metavar="DIR", help="Verify a release against this source/candidate without building or deploying")
    parser.add_argument("--work-dir", type=Path, help="Use a fresh directory for backend build artifacts")
    parser.add_argument("--output-dir", type=Path, help="Write a separate desktop distribution")
    args = parser.parse_args()
    if args.work_dir:
        TEST = args.work_dir.expanduser().resolve()
        TEST.mkdir(parents=True, exist_ok=True)
        _BACKEND_BUILT = False
    if args.output_dir:
        OUTPUT = args.output_dir.expanduser().resolve()
    if args.validate_release:
        data = validate_release(args.validate_release)
        print("Validated desktop release:", args.validate_release, data["source"]["source_digest"], flush=True)
    elif args.assets_only:
        print("Staged desktop assets:", stage_assets(), flush=True)
    else:
        build_window()
