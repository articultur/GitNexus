"""Tests for the case schema module."""

import json
from pathlib import Path

import pytest

from eval.lib.schema import (
    EXTENDED_DEFAULTS,
    compute_dataset_hash,
    load_schema,
    migrate_case,
    validate_case,
    validate_cases,
)


# ---------------------------------------------------------------------------
# Minimal valid case (required fields only)
# ---------------------------------------------------------------------------
def _make_minimal_case(**overrides):
    base = {
        "id": "test-001",
        "repo": "owner/repo",
        "language": "python",
        "commit_before": "a" * 40,
        "commit_fix": "b" * 40,
        "task_type": "C1",
        "difficulty": "easy",
        "issue_text": "Something is broken",
        "ground_truth": {"files": ["src/main.py"], "symbols": ["func_a"]},
        "gt_source": "pr_diff",
    }
    base.update(overrides)
    return base


def _make_full_case(**overrides):
    case = _make_minimal_case()
    case.update(
        {
            "selection_reason": "representative bug",
            "case_status": "reviewed",
            "reviewer": "alice",
            "review_notes": "looks good",
            "leakage_risk": "low",
            "task_prompt_style": "locate-fix",
            "gt_files_must": ["src/main.py"],
            "gt_files_optional": ["src/util.py"],
            "gt_symbols_must": ["func_a"],
            "gt_symbols_optional": ["helper_b"],
            "root_cause_gt": {"files": ["src/main.py"], "symbols": ["func_a"]},
            "supporting_gt": {"files": ["src/util.py"], "symbols": ["helper_b"]},
            "issue_text_variant": "Alternate phrasing of the issue.",
            "dataset_version": "2.0",
            "source_commit_range": "abc..def",
            "annotation_version": 2,
        }
    )
    case.update(overrides)
    return case


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestLoadSchema:
    def test_loads_valid_json_schema(self):
        schema = load_schema()
        assert schema["type"] == "object"
        assert "id" in schema["required"]


class TestValidateCase:
    def test_validate_minimal_case(self):
        case = _make_minimal_case()
        errors = validate_case(case)
        assert errors == []

    def test_validate_full_case(self):
        case = _make_full_case()
        errors = validate_case(case)
        assert errors == []

    def test_validate_missing_required(self):
        case = _make_minimal_case()
        del case["id"]
        errors = validate_case(case)
        assert any("id" in e for e in errors)

    def test_validate_invalid_task_type(self):
        case = _make_minimal_case(task_type="C6")
        errors = validate_case(case)
        assert any("task_type" in e for e in errors)
        assert any("C6" in e for e in errors)

    def test_validate_invalid_difficulty(self):
        case = _make_minimal_case(difficulty="expert")
        errors = validate_case(case)
        assert any("difficulty" in e for e in errors)
        assert any("expert" in e for e in errors)


class TestValidateCases:
    def test_validate_cases_jsonl(self, tmp_path: Path):
        cases = [_make_minimal_case(), _make_minimal_case(id="test-002")]
        jsonl = tmp_path / "cases.jsonl"
        jsonl.write_text(
            "\n".join(json.dumps(c) for c in cases) + "\n",
            encoding="utf-8",
        )
        results = validate_cases(jsonl)
        assert results == {}

    def test_validate_cases_catches_errors(self, tmp_path: Path):
        bad_case = _make_minimal_case()
        del bad_case["repo"]
        jsonl = tmp_path / "bad.jsonl"
        jsonl.write_text(json.dumps(bad_case) + "\n", encoding="utf-8")
        results = validate_cases(jsonl)
        assert "test-001" in results
        assert any("repo" in e for e in results["test-001"])


class TestMigrateCase:
    def test_migrate_old_case(self):
        old_case = _make_minimal_case()
        migrated = migrate_case(old_case)
        # Required fields preserved
        assert migrated["id"] == "test-001"
        # Defaults filled
        assert migrated["case_status"] == "draft"
        assert migrated["leakage_risk"] == "medium"
        assert migrated["task_prompt_style"] == "locate-fix"
        assert migrated["annotation_version"] == 1
        assert migrated["gt_files_must"] == []
        assert migrated["gt_files_optional"] == []
        assert migrated["gt_symbols_must"] == []
        assert migrated["gt_symbols_optional"] == []
        assert migrated["root_cause_gt"] == {"files": [], "symbols": []}
        assert migrated["supporting_gt"] == {"files": [], "symbols": []}

    def test_migrate_preserves_existing(self):
        case = _make_minimal_case(
            case_status="locked",
            leakage_risk="high",
            annotation_version=5,
        )
        migrated = migrate_case(case)
        assert migrated["case_status"] == "locked"
        assert migrated["leakage_risk"] == "high"
        assert migrated["annotation_version"] == 5
        # Other defaults still filled
        assert migrated["task_prompt_style"] == "locate-fix"
        assert migrated["gt_files_must"] == []

    def test_migrate_does_not_mutate_original(self):
        case = _make_minimal_case()
        original_keys = set(case.keys())
        _ = migrate_case(case)
        assert set(case.keys()) == original_keys


class TestComputeDatasetHash:
    def test_deterministic_hash(self, tmp_path: Path):
        cases = [
            _make_minimal_case(id="beta-002"),
            _make_minimal_case(id="alpha-001"),
        ]
        jsonl = tmp_path / "cases.jsonl"
        # Write in non-sorted order
        jsonl.write_text(
            "\n".join(json.dumps(c) for c in cases) + "\n",
            encoding="utf-8",
        )
        hash1 = compute_dataset_hash(jsonl)
        hash2 = compute_dataset_hash(jsonl)
        assert hash1 == hash2
        assert len(hash1) == 64  # SHA-256 hex digest

    def test_hash_changes_with_content(self, tmp_path: Path):
        jsonl_a = tmp_path / "a.jsonl"
        jsonl_b = tmp_path / "b.jsonl"
        jsonl_a.write_text(
            json.dumps(_make_minimal_case()) + "\n", encoding="utf-8"
        )
        jsonl_b.write_text(
            json.dumps(_make_minimal_case(id="different")) + "\n",
            encoding="utf-8",
        )
        assert compute_dataset_hash(jsonl_a) != compute_dataset_hash(jsonl_b)
