# eval/lib/dual_scorer.py
from dataclasses import dataclass, field
from typing import Any
from eval.lib.difficulty_scorer import DifficultyLevel


# ─── Composite weights ────────────────────────────────────────────────────────
W_FILE = 0.30
W_SYMBOL = 0.25
W_CHAIN = 0.20
W_DATA_FLOW = 0.25

# Must-hit vs optional weighting
W_MUST = 2.0
W_OPTIONAL = 1.0

# F-beta: recall weight (2.0 = recall 4x more important than precision for impact analysis)
BETA = 2.0

# Significance
SIGNIFICANCE_DELTA_THRESHOLD = 0.15


# ─── Path normalization ──────────────────────────────────────────────────────

def normalize_path(path: str) -> str:
    p = path.strip().lower().replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    return p


def path_match(predicted: str, ground_truth: str) -> tuple[bool, str]:
    """Match paths. Returns (matched, match_type)."""
    p_norm = normalize_path(predicted)
    g_norm = normalize_path(ground_truth)
    if p_norm == g_norm:
        return True, "exact"
    if p_norm.split("/")[-1] == g_norm.split("/")[-1]:
        return True, "basename"
    if p_norm.endswith(g_norm) or g_norm.endswith(p_norm):
        return True, "suffix"
    return False, "none"


# ─── Symbol matching with type tracking ───────────────────────────────────────

def _symbol_match(pred: str, gt: str) -> tuple[bool, str]:
    """Match symbols. Returns (matched, match_type: exact|qualified|suffix|none)."""
    p = pred.strip().lower()
    g = gt.strip().lower()
    if p == g:
        return True, "exact"
    if p.split(".")[-1] == g.split(".")[-1] and "." in p or "." in g:
        return True, "qualified"
    if p.split("::")[-1] == g.split("::")[-1] and "::" in p or "::" in g:
        return True, "qualified"
    if p.endswith(g) or g.endswith(p):
        return True, "suffix"
    return False, "none"


# ─── Weighted scoring with P/R/Fβ ────────────────────────────────────────────

@dataclass
class PRFBeta:
    precision: float
    recall: float
    f_beta: float
    tp_count: int
    fp_count: int
    fn_count: int


def _weighted_prf(
    predicted: list[str], must_items: list[str], optional_items: list[str],
    match_fn,
) -> PRFBeta:
    """Compute weighted P/R/Fβ with must/optional GT layers."""
    if not must_items and not optional_items:
        return PRFBeta(0, 0, 0, 0, 0, 0)

    gt_weighted: dict[str, float] = {}
    for item in must_items:
        gt_weighted[item.lower().strip()] = W_MUST
    for item in optional_items:
        key = item.lower().strip()
        if key not in gt_weighted:
            gt_weighted[key] = W_OPTIONAL

    if not gt_weighted:
        return PRFBeta(0, 0, 0, 0, 0, 0)

    total_gt_weight = sum(gt_weighted.values())
    matched_weight = 0.0
    matched_gt_keys: set[str] = set()

    for pred in predicted:
        pred_lower = pred.lower().strip()
        for gt_key in gt_weighted:
            if gt_key in matched_gt_keys:
                continue
            matched, _ = match_fn(pred_lower, gt_key)
            if matched:
                matched_weight += gt_weighted[gt_key]
                matched_gt_keys.add(gt_key)
                break

    tp_count = len(matched_gt_keys)
    fp_count = max(0, len(predicted) - tp_count)
    fn_count = len(gt_weighted) - tp_count

    fp_weight = fp_count * W_OPTIONAL
    fn_weight = total_gt_weight - matched_weight

    precision = matched_weight / (matched_weight + fp_weight) if (matched_weight + fp_weight) > 0 else 0.0
    recall = matched_weight / total_gt_weight if total_gt_weight > 0 else 0.0

    if precision + recall == 0:
        f_beta = 0.0
    else:
        f_beta = (1 + BETA**2) * precision * recall / (BETA**2 * precision + recall)

    return PRFBeta(
        precision=round(precision, 4),
        recall=round(recall, 4),
        f_beta=round(f_beta, 4),
        tp_count=tp_count,
        fp_count=fp_count,
        fn_count=fn_count,
    )


# ─── MRR (Mean Reciprocal Rank) ───────────────────────────────────────────────

def _compute_mrr(predicted: list[str], gt_items: list[str], match_fn) -> float:
    """First correct result position → 1/rank."""
    if not gt_items:
        return 0.0
    gt_normalized = [g.lower().strip() for g in gt_items]
    for i, pred in enumerate(predicted, 1):
        pred_lower = pred.lower().strip()
        for gt in gt_normalized:
            matched, _ = match_fn(pred_lower, gt)
            if matched:
                return round(1.0 / i, 4)
    return 0.0


# ─── Chain similarity (LCS-based) ─────────────────────────────────────────────

def _flatten_chain(chain: list) -> list[str]:
    """Split chain on -> or → (unicode arrow). Handles nested lists."""
    import re
    flat = []
    for item in chain:
        if isinstance(item, list):
            flat.extend(str(x) for x in item)
        else:
            flat.append(str(item))
    return [s for item in flat for s in re.split(r"->|→", item) if s.strip()]


def _lcs_length(a: list[str], b: list[str]) -> int:
    m, n = len(a), len(b)
    if m == 0 or n == 0:
        return 0
    prev = [0] * (n + 1)
    curr = [0] * (n + 1)
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i - 1].lower().strip() == b[j - 1].lower().strip():
                curr[j] = prev[j - 1] + 1
            else:
                curr[j] = max(prev[j], curr[j - 1])
        prev, curr = curr, [0] * (n + 1)
    return prev[n]


def chain_similarity(predicted: list[str], ground_truth: list[str]) -> float:
    if not ground_truth:
        return 1.0 if not predicted else 0.0
    if not predicted:
        return 0.0
    pred_norm = [s.strip().lower() for s in predicted if s.strip()]
    gt_norm = [s.strip().lower() for s in ground_truth if s.strip()]
    if not gt_norm:
        return 1.0
    return _lcs_length(pred_norm, gt_norm) / len(gt_norm)


# ─── Data flow scoring ────────────────────────────────────────────────────────

@dataclass
class DataFlowScore:
    source_match: float   # 0 or 1
    sink_recall: float    # fraction of GT sinks found
    path_similarity: float  # LCS-based
    composite: float      # 0.3*source + 0.4*sink + 0.3*path


def _score_data_flow(predicted: dict, gt_data_flow: dict) -> DataFlowScore:
    """Score data flow prediction against GT.

    predicted: {"source": str, "sinks": [str], "path": [str]}
    gt_data_flow: {"source": str, "sinks": [str], "path": [str]}
    """
    if not gt_data_flow or not gt_data_flow.get("source"):
        # No data flow GT → neutral score (not penalizing)
        return DataFlowScore(0, 0, 0, 0)

    gt_source = gt_data_flow["source"].lower().strip()
    gt_sinks = [s.lower().strip() for s in gt_data_flow.get("sinks", [])]
    gt_path = [s.strip().lower() for s in gt_data_flow.get("path", []) if s.strip()]

    # Source match
    pred_source = (predicted.get("source") or "").lower().strip()
    source_match = 1.0 if pred_source and _symbol_match(pred_source, gt_source)[0] else 0.0

    # Sink recall
    pred_sinks = [s.lower().strip() for s in (predicted.get("sinks") or [])]
    if gt_sinks:
        matched_sinks = 0
        for gs in gt_sinks:
            for ps in pred_sinks:
                if _symbol_match(ps, gs)[0]:
                    matched_sinks += 1
                    break
        sink_recall = matched_sinks / len(gt_sinks)
    else:
        sink_recall = 1.0

    # Path similarity
    pred_path = [s.strip().lower() for s in (predicted.get("path") or []) if s.strip()]
    path_sim = chain_similarity(pred_path, gt_path) if gt_path else 1.0

    composite = 0.3 * source_match + 0.4 * sink_recall + 0.3 * path_sim
    return DataFlowScore(
        source_match=round(source_match, 4),
        sink_recall=round(sink_recall, 4),
        path_similarity=round(path_sim, 4),
        composite=round(composite, 4),
    )


# ─── Three-layer GT extraction (from old system) ─────────────────────────────

def _extract_gt_layers(case: dict, field_name: str) -> tuple[list[str], list[str]]:
    """Extract must/optional for a field with 3-layer GT support.

    Layers: edit_gt (must), root_cause_gt (must), supporting_gt (optional)
    Plus top-level gt_{field}_must / gt_{field}_optional.
    """
    must: list[str] = []
    optional: list[str] = []

    # Top-level extended fields
    top_must = case.get(f"gt_{field_name}_must", [])
    top_optional = case.get(f"gt_{field_name}_optional", [])
    if top_must or top_optional:
        must.extend(top_must)
        optional.extend(top_optional)
        return must, optional

    # Three-layer GT
    rc = case.get("root_cause_gt", {})
    if isinstance(rc, dict) and rc.get(field_name):
        must.extend(rc[field_name])

    sup = case.get("supporting_gt", {})
    if isinstance(sup, dict) and sup.get(field_name):
        optional.extend(sup[field_name])

    if must or optional:
        return must, optional

    # Fallback: nested ground_truth or top-level
    gt = case.get("ground_truth", {})
    if isinstance(gt, dict) and gt.get(field_name):
        return gt[field_name], []

    if case.get(field_name):
        return case[field_name], []

    return [], []


# ─── TripleResult (3-arm) ──────────────────────────────────────────────────────

@dataclass
class TripleResult:
    # Per-dimension P/R/Fβ for each arm
    baseline_file_prf: PRFBeta
    search_agent_file_prf: PRFBeta
    gitnexus_file_prf: PRFBeta
    baseline_symbol_prf: PRFBeta
    search_agent_symbol_prf: PRFBeta
    gitnexus_symbol_prf: PRFBeta
    baseline_chain_score: float
    search_agent_chain_score: float
    gitnexus_chain_score: float

    # Data flow
    baseline_data_flow: DataFlowScore
    search_agent_data_flow: DataFlowScore
    gitnexus_data_flow: DataFlowScore

    # MRR (ranking quality)
    baseline_mrr: float
    search_agent_mrr: float
    gitnexus_mrr: float

    # Composite impact scores
    baseline_impact: float
    search_agent_impact: float
    gitnexus_impact: float

    # Delta: tool value (gitnexus - search_agent), workflow value (search_agent - baseline), total
    delta_tool: float
    delta_workflow: float
    delta_total: float

    # Legacy (backward compat)
    baseline_f1: float
    search_agent_f1: float
    gitnexus_f1: float
    delta_f1: float

    # Significance
    difficulty: DifficultyLevel
    is_significant: bool

    # Symbol match type breakdown
    baseline_symbol_match_types: dict = field(default_factory=dict)
    search_agent_symbol_match_types: dict = field(default_factory=dict)
    gitnexus_symbol_match_types: dict = field(default_factory=dict)

    # Tool compliance breakdown
    baseline_tool_breakdown: dict = field(default_factory=dict)
    search_agent_tool_breakdown: dict = field(default_factory=dict)
    gitnexus_tool_breakdown: dict = field(default_factory=dict)

    # Breakdown
    breakdown: dict[str, Any] = field(default_factory=dict)


# ─── DualResult (full) ────────────────────────────────────────────────────────

@dataclass
class DualResult:
    # Per-dimension P/R/Fβ
    baseline_file_prf: PRFBeta
    gitnexus_file_prf: PRFBeta
    baseline_symbol_prf: PRFBeta
    gitnexus_symbol_prf: PRFBeta
    baseline_chain_score: float
    gitnexus_chain_score: float

    # Data flow
    baseline_data_flow: DataFlowScore
    gitnexus_data_flow: DataFlowScore

    # MRR (ranking quality)
    baseline_mrr: float
    gitnexus_mrr: float

    # Composite impact scores
    baseline_impact: float
    gitnexus_impact: float
    delta_impact: float

    # Legacy (backward compat)
    baseline_f1: float
    gitnexus_f1: float
    delta_f1: float

    # Significance
    difficulty: DifficultyLevel
    is_significant: bool

    # Symbol match type breakdown
    baseline_symbol_match_types: dict = field(default_factory=dict)
    gitnexus_symbol_match_types: dict = field(default_factory=dict)

    # Breakdown
    breakdown: dict[str, Any] = field(default_factory=dict)


# ─── DualScorer ───────────────────────────────────────────────────────────────

class DualScorer:
    """4-dimensional A/B scorer: file + symbol + chain + data_flow.

    Uses Fβ (recall-biased) instead of F1 for impact analysis.
    Includes MRR for ranking quality and FN/FP exposure.
    """

    def _get_gt_chain(self, case: dict) -> list[str]:
        gt = case.get("ground_truth", {})
        if isinstance(gt, dict) and gt.get("call_chain") is not None:
            chain = gt["call_chain"]
        else:
            chain = case.get("call_chain", [])
        if isinstance(chain, list):
            return _flatten_chain(chain)
        return []

    def _get_gt_data_flow(self, case: dict) -> dict:
        return case.get("data_flow", {})

    def _compute_symbol_match_types(self, predicted: list[str], gt_symbols: list[str]) -> dict:
        """Track exact/suffix/qualified/none matches."""
        counts = {"exact": 0, "qualified": 0, "suffix": 0, "none": 0}
        for g in gt_symbols:
            found = False
            for p in predicted:
                matched, mtype = _symbol_match(p, g)
                if matched:
                    counts[mtype] += 1
                    found = True
                    break
            if not found:
                counts["none"] += 1
        return counts

    def compare(
        self,
        baseline_pred: dict,
        gitnexus_pred: dict,
        ground_truth: dict,
        difficulty: DifficultyLevel,
        case: dict | None = None,
    ) -> DualResult:
        case = case or ground_truth

        # GT extraction with 3-layer support
        files_must, files_optional = _extract_gt_layers(case, "files")
        symbols_must, symbols_optional = _extract_gt_layers(case, "symbols")
        gt_chain = self._get_gt_chain(case)
        gt_data_flow = self._get_gt_data_flow(case)

        # Predictions
        b_files = baseline_pred.get("files", [])
        g_files = gitnexus_pred.get("files", [])
        b_symbols = baseline_pred.get("symbols", [])
        g_symbols = gitnexus_pred.get("symbols", [])
        b_chain = _flatten_chain(baseline_pred.get("call_chain", []))
        g_chain = _flatten_chain(gitnexus_pred.get("call_chain", []))
        b_data_flow_pred = baseline_pred.get("data_flow", {})
        g_data_flow_pred = gitnexus_pred.get("data_flow", {})

        # All GT items for MRR and match types
        all_gt_files = files_must + files_optional
        all_gt_symbols = symbols_must + symbols_optional

        # File P/R/Fβ
        b_file_prf = _weighted_prf(b_files, files_must, files_optional, path_match)
        g_file_prf = _weighted_prf(g_files, files_must, files_optional, path_match)

        # Symbol P/R/Fβ
        b_sym_prf = _weighted_prf(b_symbols, symbols_must, symbols_optional, _symbol_match)
        g_sym_prf = _weighted_prf(g_symbols, symbols_must, symbols_optional, _symbol_match)

        # Chain similarity
        b_chain_score = chain_similarity(b_chain, gt_chain)
        g_chain_score = chain_similarity(g_chain, gt_chain)

        # Data flow
        b_df = _score_data_flow(b_data_flow_pred, gt_data_flow)
        g_df = _score_data_flow(g_data_flow_pred, gt_data_flow)

        # MRR
        b_mrr = _compute_mrr(b_files, all_gt_files, path_match)
        g_mrr = _compute_mrr(g_files, all_gt_files, path_match)

        # Symbol match types
        b_sym_types = self._compute_symbol_match_types(b_symbols, all_gt_symbols)
        g_sym_types = self._compute_symbol_match_types(g_symbols, all_gt_symbols)

        # Composite impact
        has_data_flow_gt = bool(gt_data_flow and gt_data_flow.get("source"))
        if has_data_flow_gt:
            b_impact = W_FILE * b_file_prf.f_beta + W_SYMBOL * b_sym_prf.f_beta + W_CHAIN * b_chain_score + W_DATA_FLOW * b_df.composite
            g_impact = W_FILE * g_file_prf.f_beta + W_SYMBOL * g_sym_prf.f_beta + W_CHAIN * g_chain_score + W_DATA_FLOW * g_df.composite
        else:
            # No data flow GT → redistribute weight to 3 dimensions
            b_impact = (W_FILE + W_DATA_FLOW * W_FILE / (W_FILE + W_SYMBOL + W_CHAIN)) * b_file_prf.f_beta + \
                       (W_SYMBOL + W_DATA_FLOW * W_SYMBOL / (W_FILE + W_SYMBOL + W_CHAIN)) * b_sym_prf.f_beta + \
                       (W_CHAIN + W_DATA_FLOW * W_CHAIN / (W_FILE + W_SYMBOL + W_CHAIN)) * b_chain_score
            g_impact = (W_FILE + W_DATA_FLOW * W_FILE / (W_FILE + W_SYMBOL + W_CHAIN)) * g_file_prf.f_beta + \
                       (W_SYMBOL + W_DATA_FLOW * W_SYMBOL / (W_FILE + W_SYMBOL + W_CHAIN)) * g_sym_prf.f_beta + \
                       (W_CHAIN + W_DATA_FLOW * W_CHAIN / (W_FILE + W_SYMBOL + W_CHAIN)) * g_chain_score

        delta_impact = g_impact - b_impact

        # Legacy F1
        legacy_gt_files = ground_truth.get("files", [])
        b_legacy = _weighted_prf(b_files, legacy_gt_files, [], path_match)
        g_legacy = _weighted_prf(g_files, legacy_gt_files, [], path_match)

        # Significance
        is_significant = (
            abs(delta_impact) >= SIGNIFICANCE_DELTA_THRESHOLD
            or (difficulty == DifficultyLevel.COMPLEX and abs(delta_impact) > 0)
        )

        return DualResult(
            baseline_file_prf=b_file_prf,
            gitnexus_file_prf=g_file_prf,
            baseline_symbol_prf=b_sym_prf,
            gitnexus_symbol_prf=g_sym_prf,
            baseline_chain_score=round(b_chain_score, 4),
            gitnexus_chain_score=round(g_chain_score, 4),
            baseline_data_flow=b_df,
            gitnexus_data_flow=g_df,
            baseline_mrr=b_mrr,
            gitnexus_mrr=g_mrr,
            baseline_impact=round(b_impact, 4),
            gitnexus_impact=round(g_impact, 4),
            delta_impact=round(delta_impact, 4),
            baseline_f1=b_legacy.f_beta,
            gitnexus_f1=g_legacy.f_beta,
            delta_f1=round(g_legacy.f_beta - b_legacy.f_beta, 4),
            difficulty=difficulty,
            is_significant=is_significant,
            baseline_symbol_match_types=b_sym_types,
            gitnexus_symbol_match_types=g_sym_types,
            breakdown={
                "files_must": len(files_must),
                "files_optional": len(files_optional),
                "symbols_must": len(symbols_must),
                "symbols_optional": len(symbols_optional),
                "gt_chain_length": len(gt_chain),
                "has_data_flow_gt": has_data_flow_gt,
                "baseline_fn_files": b_file_prf.fn_count,
                "gitnexus_fn_files": g_file_prf.fn_count,
                "baseline_fp_files": b_file_prf.fp_count,
                "gitnexus_fp_files": g_file_prf.fp_count,
            }
        )


# ─── Tool compliance helper ──────────────────────────────────────────────────

def breakdown_tool_calls(records: list) -> dict:
    """Count tool usage from execution records.

    Accepts either:
    - tool_call_records: list of {"tool": "Name", "args": {...}} dicts
    - tool_sequence: list of tool name strings
    """
    counts = {}
    for r in records:
        if isinstance(r, dict):
            tool = r.get("tool", "unknown")
        else:
            tool = str(r) if r else "unknown"
        counts[tool] = counts.get(tool, 0) + 1
    return counts


# ─── TripleScorer (3-arm) ─────────────────────────────────────────────────────

class TripleScorer:
    """3-arm scorer: baseline vs search_agent vs gitnexus.

    Adds search_agent arm between baseline and gitnexus to measure:
    - delta_tool: gitnexus_impact - search_agent_impact (tool value)
    - delta_workflow: search_agent_impact - baseline_impact (workflow value)
    - delta_total: gitnexus_impact - baseline_impact (total)
    """

    def _get_gt_chain(self, case: dict) -> list[str]:
        gt = case.get("ground_truth", {})
        if isinstance(gt, dict) and gt.get("call_chain") is not None:
            chain = gt["call_chain"]
        else:
            chain = case.get("call_chain", [])
        if isinstance(chain, list):
            return _flatten_chain(chain)
        return []

    def _get_gt_data_flow(self, case: dict) -> dict:
        return case.get("data_flow", {})

    def _compute_symbol_match_types(self, predicted: list[str], gt_symbols: list[str]) -> dict:
        """Track exact/suffix/qualified/none matches."""
        counts = {"exact": 0, "qualified": 0, "suffix": 0, "none": 0}
        for g in gt_symbols:
            found = False
            for p in predicted:
                matched, mtype = _symbol_match(p, g)
                if matched:
                    counts[mtype] += 1
                    found = True
                    break
            if not found:
                counts["none"] += 1
        return counts

    def _compute_impact(self, file_prf: PRFBeta, sym_prf: PRFBeta, chain_score: float, data_flow: DataFlowScore, has_data_flow_gt: bool) -> float:
        """Compute composite impact score."""
        if has_data_flow_gt:
            return W_FILE * file_prf.f_beta + W_SYMBOL * sym_prf.f_beta + W_CHAIN * chain_score + W_DATA_FLOW * data_flow.composite
        else:
            return (W_FILE + W_DATA_FLOW * W_FILE / (W_FILE + W_SYMBOL + W_CHAIN)) * file_prf.f_beta + \
                   (W_SYMBOL + W_DATA_FLOW * W_SYMBOL / (W_FILE + W_SYMBOL + W_CHAIN)) * sym_prf.f_beta + \
                   (W_CHAIN + W_DATA_FLOW * W_CHAIN / (W_FILE + W_SYMBOL + W_CHAIN)) * chain_score

    def compare(
        self,
        baseline_pred: dict,
        search_agent_pred: dict,
        gitnexus_pred: dict,
        ground_truth: dict,
        difficulty: DifficultyLevel,
        case: dict | None = None,
    ) -> TripleResult:
        case = case or ground_truth

        # GT extraction with 3-layer support
        files_must, files_optional = _extract_gt_layers(case, "files")
        symbols_must, symbols_optional = _extract_gt_layers(case, "symbols")
        gt_chain = self._get_gt_chain(case)
        gt_data_flow = self._get_gt_data_flow(case)

        # Predictions for all 3 arms
        b_files = baseline_pred.get("files", [])
        s_files = search_agent_pred.get("files", [])
        g_files = gitnexus_pred.get("files", [])

        b_symbols = baseline_pred.get("symbols", [])
        s_symbols = search_agent_pred.get("symbols", [])
        g_symbols = gitnexus_pred.get("symbols", [])

        b_chain = _flatten_chain(baseline_pred.get("call_chain", []))
        s_chain = _flatten_chain(search_agent_pred.get("call_chain", []))
        g_chain = _flatten_chain(gitnexus_pred.get("call_chain", []))

        b_data_flow_pred = baseline_pred.get("data_flow", {})
        s_data_flow_pred = search_agent_pred.get("data_flow", {})
        g_data_flow_pred = gitnexus_pred.get("data_flow", {})

        # All GT items for MRR and match types
        all_gt_files = files_must + files_optional
        all_gt_symbols = symbols_must + symbols_optional

        # File P/R/Fβ
        b_file_prf = _weighted_prf(b_files, files_must, files_optional, path_match)
        s_file_prf = _weighted_prf(s_files, files_must, files_optional, path_match)
        g_file_prf = _weighted_prf(g_files, files_must, files_optional, path_match)

        # Symbol P/R/Fβ
        b_sym_prf = _weighted_prf(b_symbols, symbols_must, symbols_optional, _symbol_match)
        s_sym_prf = _weighted_prf(s_symbols, symbols_must, symbols_optional, _symbol_match)
        g_sym_prf = _weighted_prf(g_symbols, symbols_must, symbols_optional, _symbol_match)

        # Chain similarity
        b_chain_score = chain_similarity(b_chain, gt_chain)
        s_chain_score = chain_similarity(s_chain, gt_chain)
        g_chain_score = chain_similarity(g_chain, gt_chain)

        # Data flow
        b_df = _score_data_flow(b_data_flow_pred, gt_data_flow)
        s_df = _score_data_flow(s_data_flow_pred, gt_data_flow)
        g_df = _score_data_flow(g_data_flow_pred, gt_data_flow)

        # MRR
        b_mrr = _compute_mrr(b_files, all_gt_files, path_match)
        s_mrr = _compute_mrr(s_files, all_gt_files, path_match)
        g_mrr = _compute_mrr(g_files, all_gt_files, path_match)

        # Symbol match types
        b_sym_types = self._compute_symbol_match_types(b_symbols, all_gt_symbols)
        s_sym_types = self._compute_symbol_match_types(s_symbols, all_gt_symbols)
        g_sym_types = self._compute_symbol_match_types(g_symbols, all_gt_symbols)

        # Composite impact for all 3 arms
        has_data_flow_gt = bool(gt_data_flow and gt_data_flow.get("source"))
        b_impact = self._compute_impact(b_file_prf, b_sym_prf, b_chain_score, b_df, has_data_flow_gt)
        s_impact = self._compute_impact(s_file_prf, s_sym_prf, s_chain_score, s_df, has_data_flow_gt)
        g_impact = self._compute_impact(g_file_prf, g_sym_prf, g_chain_score, g_df, has_data_flow_gt)

        # Deltas
        delta_tool = g_impact - s_impact
        delta_workflow = s_impact - b_impact
        delta_total = g_impact - b_impact

        # Legacy F1 (using file-only GT for backward compat)
        legacy_gt_files = ground_truth.get("files", [])
        b_legacy = _weighted_prf(b_files, legacy_gt_files, [], path_match)
        s_legacy = _weighted_prf(s_files, legacy_gt_files, [], path_match)
        g_legacy = _weighted_prf(g_files, legacy_gt_files, [], path_match)

        # Significance
        is_significant = (
            abs(delta_total) >= SIGNIFICANCE_DELTA_THRESHOLD
            or (difficulty == DifficultyLevel.COMPLEX and abs(delta_total) > 0)
        )

        return TripleResult(
            baseline_file_prf=b_file_prf,
            search_agent_file_prf=s_file_prf,
            gitnexus_file_prf=g_file_prf,
            baseline_symbol_prf=b_sym_prf,
            search_agent_symbol_prf=s_sym_prf,
            gitnexus_symbol_prf=g_sym_prf,
            baseline_chain_score=round(b_chain_score, 4),
            search_agent_chain_score=round(s_chain_score, 4),
            gitnexus_chain_score=round(g_chain_score, 4),
            baseline_data_flow=b_df,
            search_agent_data_flow=s_df,
            gitnexus_data_flow=g_df,
            baseline_mrr=b_mrr,
            search_agent_mrr=s_mrr,
            gitnexus_mrr=g_mrr,
            baseline_impact=round(b_impact, 4),
            search_agent_impact=round(s_impact, 4),
            gitnexus_impact=round(g_impact, 4),
            delta_tool=round(delta_tool, 4),
            delta_workflow=round(delta_workflow, 4),
            delta_total=round(delta_total, 4),
            baseline_f1=b_legacy.f_beta,
            search_agent_f1=s_legacy.f_beta,
            gitnexus_f1=g_legacy.f_beta,
            delta_f1=round(g_legacy.f_beta - b_legacy.f_beta, 4),
            difficulty=difficulty,
            is_significant=is_significant,
            baseline_symbol_match_types=b_sym_types,
            search_agent_symbol_match_types=s_sym_types,
            gitnexus_symbol_match_types=g_sym_types,
            breakdown={
                "files_must": len(files_must),
                "files_optional": len(files_optional),
                "symbols_must": len(symbols_must),
                "symbols_optional": len(symbols_optional),
                "gt_chain_length": len(gt_chain),
                "has_data_flow_gt": has_data_flow_gt,
                "baseline_fn_files": b_file_prf.fn_count,
                "search_agent_fn_files": s_file_prf.fn_count,
                "gitnexus_fn_files": g_file_prf.fn_count,
                "baseline_fp_files": b_file_prf.fp_count,
                "search_agent_fp_files": s_file_prf.fp_count,
                "gitnexus_fp_files": g_file_prf.fp_count,
            }
        )
