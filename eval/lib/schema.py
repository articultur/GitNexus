"""Case schema validation and migration for the GitNexus eval framework."""

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).parent.parent / "schemas" / "case-schema.json"

REQUIRED_FIELDS = [
    "id",
    "repo",
    "language",
    "commit_before",
    "commit_fix",
    "task_type",
    "difficulty",
    "issue_text",
    "ground_truth",
    "gt_source",
]

VALID_TASK_TYPES = {"C1", "C2", "C3", "C4", "C5"}
VALID_DIFFICULTIES = {"easy", "medium", "hard"}
VALID_CASE_STATUSES = {"draft", "reviewed", "locked", "retired"}
VALID_LEAKAGE_RISKS = {"low", "medium", "high"}
VALID_PROMPT_STYLES = {"locate-fix", "trace-call-chain", "impact-analysis"}

EXTENDED_DEFAULTS: dict[str, Any] = {
    "case_status": "draft",
    "leakage_risk": "medium",
    "task_prompt_style": "locate-fix",
    "annotation_version": 1,
    "gt_files_must": [],
    "gt_files_optional": [],
    "gt_symbols_must": [],
    "gt_symbols_optional": [],
    "root_cause_gt": {"files": [], "symbols": []},
    "supporting_gt": {"files": [], "symbols": []},
}


def load_schema() -> dict:
    """Load the JSON Schema for cases."""
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def validate_case(case: dict) -> list[str]:
    """Validate a case against the schema. Returns a list of error strings."""
    errors: list[str] = []

    # Check required fields
    for field in REQUIRED_FIELDS:
        if field not in case:
            errors.append(f"missing required field: {field}")

    # If required fields are missing, skip deeper checks that would crash
    if errors:
        return errors

    # Validate task_type
    if case["task_type"] not in VALID_TASK_TYPES:
        errors.append(
            f"invalid task_type: {case['task_type']!r} "
            f"(must be one of {sorted(VALID_TASK_TYPES)})"
        )

    # Validate difficulty
    if case["difficulty"] not in VALID_DIFFICULTIES:
        errors.append(
            f"invalid difficulty: {case['difficulty']!r} "
            f"(must be one of {sorted(VALID_DIFFICULTIES)})"
        )

    # Validate ground_truth structure
    gt = case.get("ground_truth", {})
    if not isinstance(gt, dict):
        errors.append("ground_truth must be an object")
    else:
        if "files" not in gt:
            errors.append("ground_truth missing required field: files")
        elif not isinstance(gt["files"], list):
            errors.append("ground_truth.files must be an array")

        if "symbols" not in gt:
            errors.append("ground_truth missing required field: symbols")
        elif not isinstance(gt["symbols"], list):
            errors.append("ground_truth.symbols must be an array")

    # Validate extended enum fields if present
    if "case_status" in case and case["case_status"] not in VALID_CASE_STATUSES:
        errors.append(
            f"invalid case_status: {case['case_status']!r} "
            f"(must be one of {sorted(VALID_CASE_STATUSES)})"
        )

    if "leakage_risk" in case and case["leakage_risk"] not in VALID_LEAKAGE_RISKS:
        errors.append(
            f"invalid leakage_risk: {case['leakage_risk']!r} "
            f"(must be one of {sorted(VALID_LEAKAGE_RISKS)})"
        )

    if "task_prompt_style" in case and case["task_prompt_style"] not in VALID_PROMPT_STYLES:
        errors.append(
            f"invalid task_prompt_style: {case['task_prompt_style']!r} "
            f"(must be one of {sorted(VALID_PROMPT_STYLES)})"
        )

    return errors


def validate_cases(path: Path) -> dict[str, list[str]]:
    """Validate all cases in a JSONL file. Returns {case_id: [errors]}."""
    results: dict[str, list[str]] = {}

    with open(path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as exc:
                results[f"line_{line_num}"] = [f"invalid JSON: {exc}"]
                continue

            case_id = case.get("id", f"line_{line_num}")
            errors = validate_case(case)
            if errors:
                results[case_id] = errors

    return results


def migrate_case(case: dict) -> dict:
    """Migrate an old-format case to the current schema.

    Fills in defaults for missing extended fields. Does not overwrite
    existing values.
    """
    migrated = dict(case)

    for field, default in EXTENDED_DEFAULTS.items():
        if field not in migrated:
            # Deep-copy mutable defaults to avoid shared references
            migrated[field] = (
                json.loads(json.dumps(default)) if isinstance(default, (dict, list))
                else default
            )

    return migrated


def load_cases(path: Path, *, status_filter: str = "") -> list[dict]:
    """Load and migrate all cases from a JSONL file.

    Each line is parsed as JSON, validated, and migrated to the current
    schema. Cases with validation errors are skipped (a warning is printed).

    Args:
        path: Path to JSONL file.
        status_filter: If non-empty, only include cases whose case_status
            matches this value (e.g. "locked"). Empty string means no filter.
    """
    cases: list[dict] = []

    with open(path, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                case = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"WARNING: line {line_num}: invalid JSON: {exc}", file=sys.stderr)
                continue

            errors = validate_case(case)
            if errors:
                case_id = case.get("id", f"line_{line_num}")
                print(
                    f"WARNING: case {case_id}: validation errors: {errors}",
                    file=sys.stderr,
                )
                continue

            cases.append(migrate_case(case))

    # Apply case_status filter
    if status_filter:
        before = len(cases)
        cases = [c for c in cases if c.get("case_status") == status_filter]
        skipped = before - len(cases)
        if skipped:
            print(
                f"INFO: filtered {skipped} cases with case_status != {status_filter!r}",
                file=sys.stderr,
            )

    return cases


def compute_dataset_hash(path: Path) -> str:
    """SHA256 of concatenated JSONL lines sorted by case id for determinism."""
    cases: list[tuple[str, str]] = []

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            case = json.loads(line)
            case_id = case.get("id", "")
            cases.append((case_id, line))

    # Sort by id for deterministic ordering
    cases.sort(key=lambda pair: pair[0])

    hasher = hashlib.sha256()
    for _case_id, raw_line in cases:
        hasher.update(raw_line.encode("utf-8"))
        hasher.update(b"\n")

    return hasher.hexdigest()
