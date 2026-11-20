"""Export or verify a bounded release candidate without building or writing Git.

Export: python -I -B tools/create_release_candidate.py --output NEW_DIRECTORY
Verify: python -I -B tools/create_release_candidate.py --verify-only CANDIDATE
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

SRC = Path(__file__).resolve().parents[1]
_contract_spec = importlib.util.spec_from_file_location("structboard_resource_contract", SRC / "resource_contract.py")
resources = importlib.util.module_from_spec(_contract_spec)
_contract_spec.loader.exec_module(resources)


def verify_candidate(candidate, expected=None):
    candidate = Path(candidate).resolve()
    marker = candidate / resources.CANDIDATE_RECORD
    if not marker.is_file():
        raise resources.ResourceError(f"Candidate provenance is missing: {marker}")
    data = resources.validate_provenance(json.loads(marker.read_text(encoding="utf-8")))
    if expected is not None and data != expected:
        raise resources.ResourceError("Candidate provenance differs from the approved source snapshot")
    expected_files = set(data["files"]) | {resources.CANDIDATE_RECORD}
    actual_files, actual_dirs, invalid = set(), set(), []
    for path in candidate.rglob("*"):
        name = path.relative_to(candidate).as_posix()
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            invalid.append(name)
        elif path.is_file():
            actual_files.add(name)
        elif path.is_dir():
            actual_dirs.add(name)
        else:
            invalid.append(name)
    expected_dirs = {parent.as_posix() for name in expected_files for parent in Path(name).parents if parent.as_posix() != "."}
    if actual_files != expected_files or actual_dirs != expected_dirs or invalid:
        missing = sorted(expected_files - actual_files)
        extra = sorted((actual_files - expected_files) | (actual_dirs - expected_dirs) | set(invalid))
        raise resources.ResourceError("Candidate inventory mismatch; missing: " + ", ".join(missing) + "; unexpected: " + ", ".join(extra))
    actual = {name: resources.file_hash(candidate / name) for name in data["files"]}
    if actual != data["files"]:
        raise resources.ResourceError("Candidate source/candidate digest mismatch")
    assets = resources.resource_hashes(candidate)
    if any(data["files"].get(name) != digest for name, digest in assets.items()):
        raise resources.ResourceError("Candidate assets differ from source provenance")
    resources.validate_runner_references(candidate, data["files"])
    return data


def export_candidate(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination == source or source in destination.parents or destination in source.parents:
        raise resources.ResourceError("Candidate destination and source must not overlap")
    if destination.exists():
        raise resources.ResourceError(f"Candidate destination must be new: {destination}")
    data = resources.capture_source(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".structboard-candidate-", dir=str(destination.parent)))
    try:
        for name in data["files"]:
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
        (staging / resources.CANDIDATE_RECORD).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        verify_candidate(staging, data)
        resources.assert_current_source(source, data)
        # rename deliberately refuses to merge with a destination created meanwhile.
        staging.rename(destination)
        return data
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--output", type=Path, help="Export tracked working files plus approved new files to a new directory")
    choice.add_argument("--verify-only", type=Path, metavar="CANDIDATE", help="Verify candidate inventory and provenance without executing candidate code")
    parser.add_argument("--source", type=Path, default=SRC, help="Source repository for export (default: this repository)")
    args = parser.parse_args(argv)
    try:
        if args.verify_only:
            data = verify_candidate(args.verify_only)
            destination = args.verify_only
        else:
            data = export_candidate(args.source, args.output)
            destination = args.output
    except (resources.ResourceError, OSError, ValueError, SyntaxError) as exc:
        parser.exit(1, str(exc) + "\n")
    print("Validated candidate:", destination)
    print("source_digest:", data["source_digest"])
    print("candidate_digest:", data["candidate_digest"])
    print("tracked HEAD:", data["head"])
    if data["committed_clean"]:
        print("All candidate files are tracked and unchanged at HEAD.")
    else:
        print("Candidate uses approved working changes/new files; committed clean-checkout reproduction requires the user to commit them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
