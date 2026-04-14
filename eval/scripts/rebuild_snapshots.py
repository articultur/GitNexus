#!/usr/bin/env python3
"""eval/scripts/rebuild_snapshots.py
Wrapper that re-exports from the hyphenated script.
Python cannot import hyphenated filenames, so we use this as the importable module.
"""
import importlib.util
import sys
from pathlib import Path

# Load the hyphenated script
_spec = importlib.util.spec_from_file_location(
    "rebuild_snapshots_impl",
    Path(__file__).parent / "rebuild-snapshots.py"
)
assert _spec and _spec.loader
_module = importlib.util.module_from_spec(_spec)
sys.modules["rebuild_snapshots_impl"] = _module
_spec.loader.exec_module(_module)

# Re-export all public names for convenient import
from rebuild_snapshots_impl import (
    log, warn, run,
    repo_to_bare_name, repo_to_bare_path, case_to_worktree_path, bare_repo_clone_url,
    clone_snapshot, ensure_reference, get_commit_from_ondisk_snapshot,
    main,
    SCRIPT_DIR, SNAPSHOTS_DIR, CACHE_DIR,
)
