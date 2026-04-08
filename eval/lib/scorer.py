"""Scoring engine with GT layering, strict/relaxed modes, failure buckets."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ─── Data structures ─────────────────────────────────────────────────────────


@dataclass
class GTLayer:
    """A single layer of ground truth with must-hit and optional items."""

    files_must: list[str] = field(default_factory=list)
    files_optional: list[str] = field(default_factory=list)
    symbols_must: list[str] = field(default_factory=list)
    symbols_optional: list[str] = field(default_factory=list)


@dataclass
class GroundTruth:
    """Three-layer ground truth."""

    edit_gt: GTLayer = field(default_factory=GTLayer)
    root_cause_gt: GTLayer = field(default_factory=GTLayer)
    supporting_gt: GTLayer = field(default_factory=GTLayer)


@dataclass
class CaseScore:
    case_id: str
    group: str
    task_type: str
    difficulty: str
    language: str
    repo: str

    file_precision: float = 0.0
    file_recall: float = 0.0
    file_f1: float = 0.0
    symbol_hit_rate: float = 0.0
    symbol_match_types: dict = field(default_factory=dict)  # {exact: n, suffix: n}

    tool_calls: int = 0
    total_tokens: int = 0
    confidence: float = 0.0
    duration_s: float = 0.0
    steps_used: int = 0

    parse_ok: bool = True
    api_error: bool = False
    failure_bucket: str = ""  # empty = success


@dataclass
class GroupAggregate:
    group: str
    n_cases: int = 0
    n_parse_ok: int = 0
    n_api_error: int = 0
    avg_file_f1: float = 0.0
    avg_file_prec: float = 0.0
    avg_file_recall: float = 0.0
    avg_symbol_hit: float = 0.0
    avg_tool_calls: float = 0.0
    avg_tokens: float = 0.0
    avg_confidence: float = 0.0
    avg_duration_s: float = 0.0
    by_task_type: dict = field(default_factory=dict)
    by_language: dict = field(default_factory=dict)
    by_repo: dict = field(default_factory=dict)
    by_difficulty: dict = field(default_factory=dict)


# ─── Normalisation helpers ────────────────────────────────────────────────────


def _norm_path(p: str) -> str:
    """Normalise to lowercase, forward-slashes, strip leading ./"""
    return p.lower().replace("\\", "/").lstrip("./")


def _norm_symbol(s: str) -> str:
    """Lowercase, collapse whitespace."""
    return s.lower().strip()


# ─── GT layer extraction ──────────────────────────────────────────────────────


def extract_gt_layers(case: dict) -> GroundTruth:
    """Extract GT layers from a case.

    Supports both:
      - Old schema: ground_truth.files / ground_truth.symbols
      - New schema: gt_files_must, gt_files_optional, gt_symbols_must,
        gt_symbols_optional, root_cause_gt, supporting_gt
    """
    gt = GroundTruth()

    # ── New schema: top-level structured fields ──
    has_new = False

    gt_files_must = case.get("gt_files_must")
    if isinstance(gt_files_must, list) and gt_files_must:
        gt.edit_gt.files_must = gt_files_must
        has_new = True

    gt_files_optional = case.get("gt_files_optional")
    if isinstance(gt_files_optional, list) and gt_files_optional:
        gt.edit_gt.files_optional = gt_files_optional
        has_new = True

    gt_symbols_must = case.get("gt_symbols_must")
    if isinstance(gt_symbols_must, list) and gt_symbols_must:
        gt.root_cause_gt.symbols_must = gt_symbols_must
        has_new = True

    gt_symbols_optional = case.get("gt_symbols_optional")
    if isinstance(gt_symbols_optional, list) and gt_symbols_optional:
        gt.root_cause_gt.symbols_optional = gt_symbols_optional
        has_new = True

    # root_cause_gt sub-object — extends the root_cause_gt layer
    rc = case.get("root_cause_gt")
    if isinstance(rc, dict):
        has_new = True
        rc_files = rc.get("files", [])
        rc_syms = rc.get("symbols", [])
        if rc_files:
            gt.root_cause_gt.files_must.extend(rc_files)
        if rc_syms:
            gt.root_cause_gt.symbols_must.extend(rc_syms)

    # supporting_gt sub-object
    sup = case.get("supporting_gt")
    if isinstance(sup, dict):
        has_new = True
        sup_files = sup.get("files", [])
        sup_syms = sup.get("symbols", [])
        if sup_files:
            gt.supporting_gt.files_optional = sup_files
        if sup_syms:
            gt.supporting_gt.symbols_optional = sup_syms

    # ── Old schema: ground_truth.files / ground_truth.symbols ──
    if not has_new:
        old_gt = case.get("ground_truth", {})
        if isinstance(old_gt, dict):
            old_files = old_gt.get("files", [])
            old_symbols = old_gt.get("symbols", [])
            if old_files:
                gt.edit_gt.files_must = list(old_files)
            if old_symbols:
                gt.root_cause_gt.symbols_must = list(old_symbols)

    return gt


# ─── Metric functions ─────────────────────────────────────────────────────────


def file_prf(
    pred_files: list[str], gt_files: list[str]
) -> tuple[float, float, float]:
    """Return (precision, recall, F1) for file lists."""
    if not gt_files:
        return 1.0, 1.0, 1.0

    pred_set = {_norm_path(f) for f in pred_files}
    gt_set = {_norm_path(f) for f in gt_files}

    tp = len(pred_set & gt_set)
    fp = len(pred_set - gt_set)
    fn = len(gt_set - pred_set)

    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (
        (2 * precision * recall / (precision + recall))
        if (precision + recall)
        else 0.0
    )
    return round(precision, 4), round(recall, 4), round(f1, 4)


def symbol_hit(
    pred_symbols: list[str], gt_symbols: list[str]
) -> tuple[float, dict]:
    """Symbol hit rate with match type breakdown.

    Returns (hit_rate, {"exact": n, "suffix": n, "total": n, "gt_total": n}).
    """
    if not gt_symbols:
        return 1.0, {"exact": 0, "suffix": 0, "total": 0, "gt_total": 0}

    pred_norm = [_norm_symbol(s) for s in pred_symbols]
    exact = 0
    suffix = 0
    total = 0

    for g in gt_symbols:
        gn = _norm_symbol(g)
        found = False
        for p in pred_norm:
            if gn == p:
                exact += 1
                total += 1
                found = True
                break
        if not found:
            for p in pred_norm:
                if p.endswith("." + gn) or gn.endswith("." + p) or p.endswith(gn) or gn.endswith(p):
                    suffix += 1
                    total += 1
                    found = True
                    break
        # If not found at all, nothing to increment

    hit_rate = round(total / len(gt_symbols), 4)
    return hit_rate, {
        "exact": exact,
        "suffix": suffix,
        "total": total,
        "gt_total": len(gt_symbols),
    }


# ─── Failure classification ───────────────────────────────────────────────────


def classify_failure(score: CaseScore) -> str:
    """Classify failure bucket. Empty string means success."""
    if score.api_error:
        return "api_error"
    if not score.parse_ok:
        return "json_parse_error"
    if score.duration_s > 120:
        return "timeout"
    if score.file_recall == 0 and score.file_f1 == 0 and score.symbol_hit_rate == 0:
        return "wrong_file"
    if score.file_recall > 0 and score.symbol_hit_rate == 0:
        return "right_file_miss_root"
    if score.file_f1 > 0 or score.symbol_hit_rate > 0:
        return ""
    return "incomplete"


# ─── Case scoring ─────────────────────────────────────────────────────────────


def score_case(
    raw: dict, case: dict, group: str, mode: str = "strict"
) -> CaseScore:
    """Score a single case.

    Args:
        raw: Raw result dict from the runner.
        case: Case definition from the dataset.
        group: "baseline" or "gitnexus".
        mode: "strict" (must items only) or "relaxed" (must + optional).
    """
    s = CaseScore(
        case_id=case["id"],
        group=group,
        task_type=case.get("task_type", ""),
        difficulty=case.get("difficulty", ""),
        language=case.get("language", ""),
        repo=case.get("repo", ""),
    )

    if raw.get("error"):
        s.api_error = True
        s.failure_bucket = classify_failure(s)
        return s

    pred = raw.get("prediction") or {}
    if not pred or raw.get("parse_error"):
        s.parse_ok = False
        s.tool_calls = raw.get("tool_calls", 0)
        s.total_tokens = raw.get("total_tokens", 0)
        s.duration_s = raw.get("duration_s", 0.0)
        s.failure_bucket = classify_failure(s)
        return s

    # Extract GT layers
    gt_layers = extract_gt_layers(case)

    # Collect GT files and symbols based on mode
    gt_files: list[str] = []
    gt_symbols: list[str] = []

    for layer in [gt_layers.edit_gt, gt_layers.root_cause_gt, gt_layers.supporting_gt]:
        gt_files.extend(layer.files_must)
        gt_symbols.extend(layer.symbols_must)
        if mode == "relaxed":
            gt_files.extend(layer.files_optional)
            gt_symbols.extend(layer.symbols_optional)

    pred_files = pred.get("files", [])
    pred_symbols = pred.get("symbols", [])

    s.file_precision, s.file_recall, s.file_f1 = file_prf(pred_files, gt_files)
    s.symbol_hit_rate, s.symbol_match_types = symbol_hit(pred_symbols, gt_symbols)
    s.confidence = float(pred.get("confidence", 0.0))
    s.tool_calls = int(raw.get("tool_calls", 0))
    s.total_tokens = int(raw.get("total_tokens", 0))
    s.duration_s = float(raw.get("duration_s", 0.0))
    s.steps_used = int(raw.get("steps_used", 0))

    s.failure_bucket = classify_failure(s)
    return s


# ─── Aggregation ──────────────────────────────────────────────────────────────


def aggregate(scores: list[CaseScore]) -> GroupAggregate:
    """Aggregate scores with breakdowns by task_type, language, repo, difficulty."""
    if not scores:
        return GroupAggregate(group="")

    group = scores[0].group
    agg = GroupAggregate(group=group, n_cases=len(scores))

    valid = [s for s in scores if not s.api_error and s.parse_ok]
    agg.n_parse_ok = len(valid)
    agg.n_api_error = sum(1 for s in scores if s.api_error)

    def mean(vals: list[float]) -> float:
        return round(sum(vals) / len(vals), 4) if vals else 0.0

    agg.avg_file_f1 = mean([s.file_f1 for s in valid])
    agg.avg_file_prec = mean([s.file_precision for s in valid])
    agg.avg_file_recall = mean([s.file_recall for s in valid])
    agg.avg_symbol_hit = mean([s.symbol_hit_rate for s in valid])
    agg.avg_tool_calls = mean([float(s.tool_calls) for s in scores])
    agg.avg_tokens = mean([float(s.total_tokens) for s in scores])
    agg.avg_confidence = mean([s.confidence for s in valid])
    agg.avg_duration_s = mean([s.duration_s for s in scores])

    def _breakdown(key: str) -> dict:
        buckets: dict[str, list[CaseScore]] = {}
        for s in valid:
            val = getattr(s, key, "")
            if val:
                buckets.setdefault(val, []).append(s)
        result: dict[str, dict] = {}
        for k in sorted(buckets):
            sub = buckets[k]
            entry: dict = {
                "n": len(sub),
                "file_f1": mean([s.file_f1 for s in sub]),
                "symbol_hit": mean([s.symbol_hit_rate for s in sub]),
                "tool_calls": mean([float(s.tool_calls) for s in sub]),
                "tokens": mean([float(s.total_tokens) for s in sub]),
            }
            if len(sub) < 5:
                entry["_warning"] = "n<5, limited explanatory power"
            result[k] = entry
        return result

    agg.by_task_type = _breakdown("task_type")
    agg.by_language = _breakdown("language")
    agg.by_repo = _breakdown("repo")
    agg.by_difficulty = _breakdown("difficulty")

    return agg


# ─── Delta computation ────────────────────────────────────────────────────────


def compute_delta(base_agg: GroupAggregate, gn_agg: GroupAggregate) -> dict:
    """Compute delta between baseline and gitnexus aggregates.

    For each metric returns {baseline, gitnexus, delta, pct}.
    """

    def d(a: float, b: float) -> dict:
        delta = round(b - a, 4)
        pct = round((delta / a * 100) if a else 0.0, 1)
        return {"baseline": a, "gitnexus": b, "delta": delta, "pct": pct}

    return {
        "file_f1": d(base_agg.avg_file_f1, gn_agg.avg_file_f1),
        "file_prec": d(base_agg.avg_file_prec, gn_agg.avg_file_prec),
        "file_recall": d(base_agg.avg_file_recall, gn_agg.avg_file_recall),
        "symbol_hit": d(base_agg.avg_symbol_hit, gn_agg.avg_symbol_hit),
        "tool_calls": d(base_agg.avg_tool_calls, gn_agg.avg_tool_calls),
        "tokens": d(base_agg.avg_tokens, gn_agg.avg_tokens),
        "confidence": d(base_agg.avg_confidence, gn_agg.avg_confidence),
    }


# ─── Loaders ──────────────────────────────────────────────────────────────────


def load_cases(path: Path) -> dict[str, dict]:
    """Load cases from JSONL file. Returns {case_id: case_dict}."""
    cases: dict[str, dict] = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                c = json.loads(line)
                cases[c["id"]] = c
    return cases


def load_raw(raw_dir: Path, case_id: str, group: str) -> Optional[dict]:
    """Load raw result for a case/group."""
    p = raw_dir / f"{case_id}_{group}.json"
    if not p.exists():
        return None
    with p.open(encoding="utf-8") as f:
        return json.load(f)
