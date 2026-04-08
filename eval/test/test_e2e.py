"""End-to-end integration test for the GitNexus eval pipeline.

Runs the full pipeline with a mock model and mock server:
  ToolLoopExecutor.run() -> RawResult -> score_case() -> CaseScore
  -> aggregate() -> GroupAggregate -> compute_delta() -> delta dict
  -> build_report() -> markdown report

All external dependencies (LLM API, GitNexus MCP server) are mocked.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ─── Imports from eval pipeline ───────────────────────────────────────────────

from eval.lib.executor import RawResult, ToolLoopExecutor
from eval.lib.scorer import (
    CaseScore,
    GroupAggregate,
    aggregate,
    compute_delta,
    score_case,
)
from eval.report import build_report


# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def tmp_env(tmp_path: Path) -> dict:
    """Create a temp directory with cases, snapshot, and prompt template."""
    # -- Cases JSONL with 2 minimal test cases --
    cases = [
        {
            "id": "e2e-001",
            "repo": "example/project-a",
            "language": "python",
            "commit_before": "aaa111",
            "commit_fix": "bbb222",
            "task_type": "C1",
            "difficulty": "easy",
            "issue_text": "Login fails when password contains special chars",
            "ground_truth": {
                "files": ["src/auth.py", "src/utils.py"],
                "symbols": ["validate_password", "hash_credential"],
            },
            "gt_source": "pr_diff",
        },
        {
            "id": "e2e-002",
            "repo": "example/project-b",
            "language": "typescript",
            "commit_before": "ccc333",
            "commit_fix": "ddd444",
            "task_type": "C3",
            "difficulty": "medium",
            "issue_text": "Race condition in concurrent request handler",
            "ground_truth": {
                "files": ["src/handler.ts"],
                "symbols": ["processRequest"],
            },
            "gt_source": "pr_diff",
        },
    ]
    cases_path = tmp_path / "cases.jsonl"
    cases_path.write_text(
        "\n".join(json.dumps(c) for c in cases) + "\n",
        encoding="utf-8",
    )

    # -- Snapshot directories --
    for case in cases:
        snap = tmp_path / "snapshots" / case["id"]
        snap.mkdir(parents=True)
        ext = "py" if case["language"] == "python" else "ts"
        (snap / f"main.{ext}").write_text(
            f"// placeholder for {case['id']}\n", encoding="utf-8"
        )

    # -- Prompt template (minimal) --
    prompt_path = tmp_path / "prompt.md"
    prompt_path.write_text(
        "Analyze {{repo}} ({{language}}). Issue: {{issue_text}}",
        encoding="utf-8",
    )

    return {
        "tmp": tmp_path,
        "cases_path": cases_path,
        "snapshots_dir": str(tmp_path / "snapshots"),
        "prompt": prompt_path.read_text(encoding="utf-8"),
        "cases": cases,
    }


# ─── Canned model responses ───────────────────────────────────────────────────

def _make_json_response(
    files: list[str], symbols: list[str], confidence: float = 0.9,
) -> dict:
    """Build a mock OpenAI-style response that contains a JSON prediction."""
    prediction = json.dumps(
        {"files": files, "symbols": symbols, "confidence": confidence}
    )
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": prediction,
                },
            }
        ],
        "usage": {
            "prompt_tokens": 120,
            "completion_tokens": 40,
            "total_tokens": 160,
        },
    }


# ─── E2E test ─────────────────────────────────────────────────────────────────


class TestE2EIntegration:
    """Full pipeline integration test with mocked external services."""

    @pytest.mark.asyncio
    async def test_full_pipeline_baseline(self, tmp_env: dict):
        """Run the full eval pipeline for the baseline group and verify output."""

        cases = tmp_env["cases"]
        snapshots_dir = tmp_env["snapshots_dir"]
        prompt = tmp_env["prompt"]

        # --- Step 1: Create executor with mock provider ---
        executor = ToolLoopExecutor(
            model="test/mock-model",
            max_steps=5,
            token_budget=10000,
            max_tokens_per_turn=512,
        )

        fake_config = {
            "source": "openai",
            "api_key": "fake-key",
            "base_url": "https://fake.api/v1",
            "transport": "openai_chat",
        }

        # --- Step 2: Run executor for each case (baseline) ---
        results: list[RawResult] = []
        for case in cases:
            if case["id"] == "e2e-001":
                mock_resp = _make_json_response(
                    ["src/auth.py", "src/utils.py"],
                    ["validate_password"],
                    confidence=0.95,
                )
            else:
                mock_resp = _make_json_response(
                    ["src/handler.ts"],
                    ["processRequest"],
                    confidence=0.85,
                )

            with (
                patch("eval.lib.executor._provider_config", return_value=fake_config),
                patch.object(executor, "_call_model", return_value=mock_resp),
            ):
                result = await executor.run(
                    case, "baseline", snapshots_dir, prompt
                )
            results.append(result)

        # --- Verify RawResult ---
        assert len(results) == 2
        for r in results:
            assert r.error == ""
            assert r.stopped_reason == "final_json"
            assert r.steps_used == 1
            assert isinstance(r.prediction, dict)
            assert "files" in r.prediction
            assert r.total_tokens > 0

        # --- Step 3: Score each result ---
        scores: list[CaseScore] = []
        for case, raw_result in zip(cases, results):
            raw_dict = asdict(raw_result)
            s = score_case(raw_dict, case, "baseline", mode="strict")
            scores.append(s)

        # --- Verify CaseScore ---
        assert len(scores) == 2
        for s in scores:
            assert s.group == "baseline"
            assert 0.0 <= s.file_f1 <= 1.0
            assert 0.0 <= s.file_precision <= 1.0
            assert 0.0 <= s.file_recall <= 1.0
            assert 0.0 <= s.symbol_hit_rate <= 1.0
            assert 0.0 <= s.confidence <= 1.0
            assert s.parse_ok is True
            assert s.api_error is False

        # e2e-001: exact file match, partial symbol match
        assert scores[0].file_f1 == 1.0
        assert scores[0].symbol_hit_rate == 0.5  # 1 of 2 GT symbols found

        # e2e-002: exact match
        assert scores[1].file_f1 == 1.0
        assert scores[1].symbol_hit_rate == 1.0

        # --- Step 4: Aggregate ---
        agg = aggregate(scores)
        assert isinstance(agg, GroupAggregate)
        assert agg.group == "baseline"
        assert agg.n_cases == 2
        assert agg.n_parse_ok == 2
        assert agg.n_api_error == 0
        assert 0.0 <= agg.avg_file_f1 <= 1.0
        assert agg.avg_file_f1 == 1.0  # both cases perfect F1

        # --- Step 5: compute_delta (with a mock gitnexus aggregate) ---
        gn_agg = GroupAggregate(
            group="gitnexus",
            n_cases=2,
            n_parse_ok=2,
            avg_file_f1=0.95,
            avg_file_prec=0.95,
            avg_file_recall=0.95,
            avg_symbol_hit=0.9,
            avg_tool_calls=4.0,
            avg_tokens=200.0,
            avg_confidence=0.9,
        )
        delta = compute_delta(agg, gn_agg)
        assert isinstance(delta, dict)
        assert "file_f1" in delta
        assert "symbol_hit" in delta
        assert "tool_calls" in delta
        for key in delta:
            assert "baseline" in delta[key]
            assert "gitnexus" in delta[key]
            assert "delta" in delta[key]
            assert "pct" in delta[key]

        # --- Step 6: Generate report ---
        summary = {
            "baseline": asdict(agg),
            "gitnexus": asdict(gn_agg),
            "delta": delta,
        }
        report = build_report(summary, [], None)
        assert isinstance(report, str)
        assert "# GitNexus Effectiveness -- Delta Report" in report
        assert "## Overall Metrics" in report
        assert "## Hypothesis Verification" in report

    @pytest.mark.asyncio
    async def test_full_pipeline_with_scorer_breakdown(self, tmp_env: dict):
        """Run pipeline for both groups, score, aggregate, delta, and report."""

        cases = tmp_env["cases"]
        snapshots_dir = tmp_env["snapshots_dir"]
        prompt = tmp_env["prompt"]

        executor = ToolLoopExecutor(
            model="test/mock-model",
            max_steps=5,
            token_budget=10000,
        )

        fake_config = {
            "source": "openai",
            "api_key": "fake-key",
            "base_url": "https://fake.api/v1",
            "transport": "openai_chat",
        }

        # --- Run both groups ---
        all_results: dict[str, list[RawResult]] = {
            "baseline": [],
            "gitnexus": [],
        }
        for group in ("baseline", "gitnexus"):
            for case in cases:
                # GitNexus group "finds" more symbols
                if group == "gitnexus":
                    if case["id"] == "e2e-001":
                        mock_resp = _make_json_response(
                            ["src/auth.py", "src/utils.py"],
                            ["validate_password", "hash_credential"],
                            confidence=0.95,
                        )
                    else:
                        mock_resp = _make_json_response(
                            ["src/handler.ts"],
                            ["processRequest"],
                            confidence=0.92,
                        )
                else:
                    if case["id"] == "e2e-001":
                        mock_resp = _make_json_response(
                            ["src/auth.py"],
                            ["validate_password"],
                            confidence=0.8,
                        )
                    else:
                        mock_resp = _make_json_response(
                            ["src/handler.ts"],
                            ["processRequest"],
                            confidence=0.85,
                        )

                mock_gn_client = MagicMock()
                mock_gn_client.start = AsyncMock()
                mock_gn_client.close = AsyncMock()
                mock_gn_client.call_tool = AsyncMock(return_value="mock result")
                mock_gn_client.get_tool_definitions_openai.return_value = []
                mock_gn_client.get_tool_definitions_anthropic.return_value = []

                with (
                    patch("eval.lib.executor._provider_config", return_value=fake_config),
                    patch.object(executor, "_call_model", return_value=mock_resp),
                    patch("eval.lib.executor.GitNexusClient", return_value=mock_gn_client),
                ):
                    result = await executor.run(
                        case, group, snapshots_dir, prompt
                    )
                all_results[group].append(result)

        # --- Score all results ---
        all_scores: list[CaseScore] = []
        for group in ("baseline", "gitnexus"):
            for case, raw_result in zip(cases, all_results[group]):
                raw_dict = asdict(raw_result)
                s = score_case(raw_dict, case, group, mode="strict")
                all_scores.append(s)

        assert len(all_scores) == 4  # 2 cases x 2 groups

        # --- Aggregate per group ---
        base_scores = [s for s in all_scores if s.group == "baseline"]
        gn_scores = [s for s in all_scores if s.group == "gitnexus"]

        base_agg = aggregate(base_scores)
        gn_agg = aggregate(gn_scores)

        assert base_agg.group == "baseline"
        assert gn_agg.group == "gitnexus"
        assert base_agg.n_cases == 2
        assert gn_agg.n_cases == 2

        # GitNexus should have equal or higher F1 (more files matched)
        assert gn_agg.avg_file_f1 >= base_agg.avg_file_f1

        # --- Delta ---
        delta = compute_delta(base_agg, gn_agg)
        assert delta["file_f1"]["delta"] >= 0  # GitNexus improves or equal

        # --- Report with scores data ---
        summary = {
            "baseline": asdict(base_agg),
            "gitnexus": asdict(gn_agg),
            "delta": delta,
        }
        scores_dicts = [asdict(s) for s in all_scores]
        report = build_report(summary, scores_dicts, None)

        # Verify expected sections
        assert "# GitNexus Effectiveness -- Delta Report" in report
        assert "## Overall Metrics" in report
        assert "## Dataset Overview" in report
        assert "## Hypothesis Verification" in report
        assert "## Data Quality" in report

        # Verify the report contains actual metric values
        assert "File F1" in report
        assert "Symbol Hit Rate" in report

    @pytest.mark.asyncio
    async def test_pipeline_with_stats_section(self, tmp_env: dict):
        """Verify report generation includes statistical significance when stats provided."""

        cases = tmp_env["cases"]
        snapshots_dir = tmp_env["snapshots_dir"]
        prompt = tmp_env["prompt"]

        executor = ToolLoopExecutor(
            model="test/mock-model",
            max_steps=5,
            token_budget=10000,
        )

        fake_config = {
            "source": "openai",
            "api_key": "fake-key",
            "base_url": "https://fake.api/v1",
            "transport": "openai_chat",
        }

        # Quick single-case baseline run
        mock_resp = _make_json_response(
            ["src/auth.py"], ["validate_password"], confidence=0.9,
        )
        with (
            patch("eval.lib.executor._provider_config", return_value=fake_config),
            patch.object(executor, "_call_model", return_value=mock_resp),
        ):
            result = await executor.run(
                cases[0], "baseline", snapshots_dir, prompt
            )

        raw_dict = asdict(result)
        s = score_case(raw_dict, cases[0], "baseline", mode="strict")
        agg = aggregate([s])

        gn_agg = GroupAggregate(
            group="gitnexus",
            n_cases=1,
            avg_file_f1=1.0,
            avg_symbol_hit=1.0,
        )
        delta = compute_delta(agg, gn_agg)

        summary = {
            "baseline": asdict(agg),
            "gitnexus": asdict(gn_agg),
            "delta": delta,
        }

        # Fake stats
        stats = {
            "language": {
                "python": {
                    "delta_mean": 0.15,
                    "ci_low": 0.05,
                    "ci_high": 0.25,
                    "p_value": 0.03,
                    "effect_size": 0.6,
                    "n": 10,
                    "symbol_delta_mean": 0.10,
                    "strength": "strong",
                },
            },
        }

        report = build_report(summary, [], stats)
        assert "## Statistical Significance" in report
        assert "python" in report
        assert "strong" in report
        assert "Strength Summary" in report
