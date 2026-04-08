"""Tests for the scoring engine module."""

from pathlib import Path

import pytest

from eval.lib.scorer import (
    CaseScore,
    GroupAggregate,
    GTLayer,
    GroundTruth,
    aggregate,
    classify_failure,
    compute_delta,
    extract_gt_layers,
    file_prf,
    load_cases,
    load_raw,
    score_case,
    symbol_hit,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _make_case(**overrides) -> dict:
    base = {
        "id": "test-001",
        "repo": "owner/repo",
        "language": "python",
        "task_type": "C1",
        "difficulty": "easy",
        "ground_truth": {
            "files": ["src/main.py"],
            "symbols": ["func_a"],
        },
    }
    base.update(overrides)
    return base


def _make_raw(**overrides) -> dict:
    base = {
        "prediction": {
            "files": ["src/main.py"],
            "symbols": ["func_a"],
            "confidence": 0.9,
        },
        "tool_calls": 3,
        "total_tokens": 1000,
        "duration_s": 5.0,
        "steps_used": 2,
    }
    base.update(overrides)
    return base


def _make_score(**overrides) -> CaseScore:
    defaults = {
        "case_id": "test-001",
        "group": "baseline",
        "task_type": "C1",
        "difficulty": "easy",
        "language": "python",
        "repo": "owner/repo",
    }
    defaults.update(overrides)
    return CaseScore(**defaults)


# ─── file_prf tests ───────────────────────────────────────────────────────────


class TestFilePrf:
    def test_file_prf_perfect(self):
        pred = ["src/main.py", "lib/util.py"]
        gt = ["src/main.py", "lib/util.py"]
        p, r, f1 = file_prf(pred, gt)
        assert p == 1.0
        assert r == 1.0
        assert f1 == 1.0

    def test_file_prf_partial(self):
        pred = ["src/main.py", "extra.py"]
        gt = ["src/main.py", "lib/util.py"]
        p, r, f1 = file_prf(pred, gt)
        # tp=1 (main.py), fp=1 (extra.py), fn=1 (util.py)
        assert p == pytest.approx(0.5, abs=0.01)
        assert r == pytest.approx(0.5, abs=0.01)
        assert f1 == pytest.approx(0.5, abs=0.01)

    def test_file_prf_empty_gt(self):
        pred = ["src/main.py"]
        gt: list[str] = []
        p, r, f1 = file_prf(pred, gt)
        assert p == 1.0
        assert r == 1.0
        assert f1 == 1.0

    def test_file_prf_no_overlap(self):
        pred = ["foo.py"]
        gt = ["bar.py"]
        p, r, f1 = file_prf(pred, gt)
        assert p == 0.0
        assert r == 0.0
        assert f1 == 0.0

    def test_file_prf_normalization(self):
        pred = ["./src/Main.PY"]
        gt = ["src/main.py"]
        p, r, f1 = file_prf(pred, gt)
        assert p == 1.0
        assert r == 1.0
        assert f1 == 1.0


# ─── symbol_hit tests ─────────────────────────────────────────────────────────


class TestSymbolHit:
    def test_symbol_hit_exact(self):
        pred = ["module.func_a", "module.func_b"]
        gt = ["module.func_a"]
        rate, breakdown = symbol_hit(pred, gt)
        assert rate == 1.0
        assert breakdown["exact"] == 1
        assert breakdown["suffix"] == 0
        assert breakdown["total"] == 1
        assert breakdown["gt_total"] == 1

    def test_symbol_hit_suffix(self):
        pred = ["module.ClassName.method"]
        gt = ["ClassName.method"]
        rate, breakdown = symbol_hit(pred, gt)
        assert rate == 1.0
        assert breakdown["exact"] == 0
        assert breakdown["suffix"] == 1

    def test_symbol_hit_suffix_reverse(self):
        pred = ["ClassName.method"]
        gt = ["module.ClassName.method"]
        rate, breakdown = symbol_hit(pred, gt)
        assert rate == 1.0
        assert breakdown["suffix"] == 1

    def test_symbol_hit_no_match(self):
        pred = ["foo"]
        gt = ["bar"]
        rate, breakdown = symbol_hit(pred, gt)
        assert rate == 0.0
        assert breakdown["exact"] == 0
        assert breakdown["suffix"] == 0
        assert breakdown["total"] == 0
        assert breakdown["gt_total"] == 1

    def test_symbol_hit_empty_gt(self):
        rate, breakdown = symbol_hit(["anything"], [])
        assert rate == 1.0
        assert breakdown["exact"] == 0
        assert breakdown["suffix"] == 0
        assert breakdown["total"] == 0
        assert breakdown["gt_total"] == 0


# ─── extract_gt_layers tests ──────────────────────────────────────────────────


class TestExtractGtLayers:
    def test_gt_layers_old_schema(self):
        case = {
            "id": "test-001",
            "ground_truth": {
                "files": ["src/main.py", "src/util.py"],
                "symbols": ["func_a", "func_b"],
            },
        }
        gt = extract_gt_layers(case)
        assert gt.edit_gt.files_must == ["src/main.py", "src/util.py"]
        assert gt.root_cause_gt.symbols_must == ["func_a", "func_b"]
        # Optional lists should be empty in old schema
        assert gt.edit_gt.files_optional == []
        assert gt.root_cause_gt.symbols_optional == []

    def test_gt_layers_new_schema(self):
        case = {
            "id": "test-001",
            "gt_files_must": ["src/main.py"],
            "gt_files_optional": ["src/util.py"],
            "gt_symbols_must": ["func_a"],
            "gt_symbols_optional": ["func_b"],
            "root_cause_gt": {
                "files": ["src/core.py"],
                "symbols": ["root_func"],
            },
            "supporting_gt": {
                "files": ["src/helper.py"],
                "symbols": ["helper_func"],
            },
        }
        gt = extract_gt_layers(case)
        assert gt.edit_gt.files_must == ["src/main.py"]
        assert gt.edit_gt.files_optional == ["src/util.py"]
        assert gt.root_cause_gt.symbols_must == ["func_a", "root_func"]  # additive from top-level + sub-object
        assert gt.root_cause_gt.symbols_optional == ["func_b"]
        # root_cause_gt sub-object files
        assert gt.root_cause_gt.files_must == ["src/core.py"]
        # supporting_gt sub-object goes to optional
        assert gt.supporting_gt.files_optional == ["src/helper.py"]
        assert gt.supporting_gt.symbols_optional == ["helper_func"]


# ─── mode tests ───────────────────────────────────────────────────────────────


class TestModes:
    def test_strict_mode(self):
        case = _make_case(
            gt_files_must=["src/main.py"],
            gt_files_optional=["src/util.py"],
            gt_symbols_must=["func_a"],
            gt_symbols_optional=["func_b"],
        )
        raw = _make_raw(
            prediction={
                "files": ["src/main.py", "src/util.py"],
                "symbols": ["func_a", "func_b"],
                "confidence": 0.9,
            }
        )
        s = score_case(raw, case, "baseline", mode="strict")
        # strict: only must items count as GT
        # GT files = ["src/main.py"], predicted = ["src/main.py", "src/util.py"]
        assert s.file_recall == 1.0  # found the must file
        assert s.file_precision == pytest.approx(0.5, abs=0.01)  # 1 tp, 1 fp

    def test_relaxed_mode(self):
        case = _make_case(
            gt_files_must=["src/main.py"],
            gt_files_optional=["src/util.py"],
            gt_symbols_must=["func_a"],
            gt_symbols_optional=["func_b"],
        )
        raw = _make_raw(
            prediction={
                "files": ["src/main.py", "src/util.py"],
                "symbols": ["func_a", "func_b"],
                "confidence": 0.9,
            }
        )
        s = score_case(raw, case, "baseline", mode="relaxed")
        # relaxed: must + optional both count
        # GT files = ["src/main.py", "src/util.py"]
        assert s.file_precision == 1.0
        assert s.file_recall == 1.0
        assert s.file_f1 == 1.0


# ─── score_case error flagging ────────────────────────────────────────────────


class TestScoreCaseErrors:
    def test_score_case_api_error(self):
        case = _make_case()
        raw = {"error": "API rate limit exceeded"}
        s = score_case(raw, case, "baseline")
        assert s.api_error is True
        assert s.failure_bucket == "api_error"

    def test_score_case_parse_error(self):
        case = _make_case()
        raw = {"parse_error": True, "prediction": None}
        s = score_case(raw, case, "baseline")
        assert s.parse_ok is False
        assert s.failure_bucket == "json_parse_error"


# ─── classify_failure tests ───────────────────────────────────────────────────


class TestClassifyFailure:
    def test_classify_failure_wrong_file(self):
        s = _make_score(file_f1=0.0, file_recall=0.0, symbol_hit_rate=0.0)
        assert classify_failure(s) == "wrong_file"

    def test_classify_failure_miss_root(self):
        s = _make_score(file_f1=0.5, file_recall=0.5, symbol_hit_rate=0.0)
        assert classify_failure(s) == "right_file_miss_root"

    def test_classify_failure_parse_error(self):
        s = _make_score(parse_ok=False)
        assert classify_failure(s) == "json_parse_error"

    def test_classify_failure_api_error(self):
        s = _make_score(api_error=True)
        assert classify_failure(s) == "api_error"

    def test_classify_failure_timeout(self):
        s = _make_score(duration_s=150.0, file_f1=0.0)
        assert classify_failure(s) == "timeout"

    def test_classify_failure_success(self):
        s = _make_score(file_f1=0.8, file_recall=0.8, symbol_hit_rate=0.5)
        assert classify_failure(s) == ""

    def test_classify_failure_incomplete(self):
        s = _make_score(
            file_f1=0.0,
            file_recall=0.5,
            symbol_hit_rate=0.0,
            duration_s=10.0,
        )
        # file_recall > 0 but symbol_hit_rate == 0 → right_file_miss_root
        assert classify_failure(s) == "right_file_miss_root"

    def test_classify_failure_incomplete_edge(self):
        s = _make_score(
            file_f1=0.0,
            file_recall=0.0,
            file_precision=0.0,
            symbol_hit_rate=0.1,
            duration_s=10.0,
        )
        # symbol_hit_rate > 0 → success
        assert classify_failure(s) == ""


# ─── aggregate tests ──────────────────────────────────────────────────────────


class TestAggregate:
    def _make_valid_scores(self, n: int, **overrides) -> list[CaseScore]:
        scores = []
        for i in range(n):
            s = _make_score(
                file_f1=0.8,
                file_precision=0.9,
                file_recall=0.7,
                symbol_hit_rate=0.6,
                tool_calls=3,
                total_tokens=1000,
                confidence=0.85,
                duration_s=5.0,
                **overrides,
            )
            scores.append(s)
        return scores

    def test_aggregate_by_language(self):
        scores = (
            self._make_valid_scores(3, language="python")
            + self._make_valid_scores(4, language="typescript")
        )
        agg = aggregate(scores)
        assert "python" in agg.by_language
        assert "typescript" in agg.by_language
        assert agg.by_language["python"]["n"] == 3
        assert agg.by_language["typescript"]["n"] == 4

    def test_aggregate_by_repo(self):
        scores = (
            self._make_valid_scores(3, repo="owner/repo-a")
            + self._make_valid_scores(3, repo="owner/repo-b")
        )
        agg = aggregate(scores)
        assert "owner/repo-a" in agg.by_repo
        assert "owner/repo-b" in agg.by_repo
        assert agg.by_repo["owner/repo-a"]["n"] == 3
        assert agg.by_repo["owner/repo-b"]["n"] == 3

    def test_aggregate_by_task_type(self):
        scores = (
            self._make_valid_scores(5, task_type="C1")
            + self._make_valid_scores(3, task_type="C2")
        )
        agg = aggregate(scores)
        assert "C1" in agg.by_task_type
        assert "C2" in agg.by_task_type
        assert agg.by_task_type["C1"]["n"] == 5
        assert agg.by_task_type["C2"]["n"] == 3

    def test_aggregate_small_n_warning(self):
        scores = self._make_valid_scores(3, language="rust")
        agg = aggregate(scores)
        assert agg.by_language["rust"]["n"] == 3
        assert agg.by_language["rust"].get("_warning") == "n<5, limited explanatory power"

    def test_aggregate_no_warning_for_5_plus(self):
        scores = self._make_valid_scores(6, language="go")
        agg = aggregate(scores)
        assert agg.by_language["go"]["n"] == 6
        assert "_warning" not in agg.by_language["go"]

    def test_aggregate_empty(self):
        agg = aggregate([])
        assert agg.n_cases == 0
        assert agg.group == ""

    def test_aggregate_averages(self):
        scores = self._make_valid_scores(2)
        # Override second score to different values
        scores[1] = _make_score(
            file_f1=0.4,
            file_precision=0.5,
            file_recall=0.3,
            symbol_hit_rate=0.2,
            tool_calls=7,
            total_tokens=3000,
            confidence=0.75,
            duration_s=15.0,
        )
        agg = aggregate(scores)
        assert agg.avg_file_f1 == pytest.approx(0.6, abs=0.01)
        assert agg.avg_tool_calls == pytest.approx(5.0, abs=0.01)

    def test_aggregate_counts_api_errors(self):
        scores = self._make_valid_scores(2)
        scores.append(_make_score(api_error=True))
        agg = aggregate(scores)
        assert agg.n_cases == 3
        assert agg.n_api_error == 1
        assert agg.n_parse_ok == 2


# ─── compute_delta tests ──────────────────────────────────────────────────────


class TestComputeDelta:
    def test_compute_delta(self):
        base = GroupAggregate(
            group="baseline",
            n_cases=10,
            avg_file_f1=0.5,
            avg_file_prec=0.6,
            avg_file_recall=0.45,
            avg_symbol_hit=0.4,
            avg_tool_calls=8.0,
            avg_tokens=2000.0,
            avg_confidence=0.7,
        )
        gn = GroupAggregate(
            group="gitnexus",
            n_cases=10,
            avg_file_f1=0.7,
            avg_file_prec=0.8,
            avg_file_recall=0.65,
            avg_symbol_hit=0.6,
            avg_tool_calls=5.0,
            avg_tokens=1500.0,
            avg_confidence=0.85,
        )
        delta = compute_delta(base, gn)
        assert delta["file_f1"]["baseline"] == 0.5
        assert delta["file_f1"]["gitnexus"] == 0.7
        assert delta["file_f1"]["delta"] == 0.2
        assert delta["file_f1"]["pct"] == pytest.approx(40.0, abs=0.1)
        # Tool calls went down (fewer is better)
        assert delta["tool_calls"]["delta"] == pytest.approx(-3.0, abs=0.01)
        assert delta["tool_calls"]["pct"] == pytest.approx(-37.5, abs=0.1)

    def test_compute_delta_zero_baseline(self):
        base = GroupAggregate(group="baseline", avg_file_f1=0.0)
        gn = GroupAggregate(group="gitnexus", avg_file_f1=0.5)
        delta = compute_delta(base, gn)
        assert delta["file_f1"]["delta"] == 0.5
        assert delta["file_f1"]["pct"] == 0.0  # 0 baseline → pct = 0.0


# ─── load_cases / load_raw tests ──────────────────────────────────────────────


class TestLoaders:
    def test_load_cases(self, tmp_path: Path):
        import json

        cases = [
            {"id": "case-1", "language": "python"},
            {"id": "case-2", "language": "go"},
        ]
        jsonl = tmp_path / "cases.jsonl"
        jsonl.write_text(
            "\n".join(json.dumps(c) for c in cases) + "\n",
            encoding="utf-8",
        )
        loaded = load_cases(jsonl)
        assert len(loaded) == 2
        assert loaded["case-1"]["language"] == "python"
        assert loaded["case-2"]["language"] == "go"

    def test_load_raw(self, tmp_path: Path):
        import json

        raw_data = {"prediction": {"files": ["a.py"]}}
        raw_file = tmp_path / "case-1_baseline.json"
        raw_file.write_text(json.dumps(raw_data), encoding="utf-8")

        result = load_raw(tmp_path, "case-1", "baseline")
        assert result is not None
        assert result["prediction"]["files"] == ["a.py"]

    def test_load_raw_missing(self, tmp_path: Path):
        result = load_raw(tmp_path, "nonexistent", "baseline")
        assert result is None
