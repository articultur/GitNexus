#!/usr/bin/env python3
"""
eval/scripts/harvest-cases.py
──────────────────────────────
Harvest PR-based evaluation cases from GitHub.

For each configured repo, fetches closed PRs that meet inclusion criteria,
extracts ground truth (files, symbols) from the diff, and writes JSONL cases.

Usage:
    python eval/scripts/harvest-cases.py \
        --repos flask gin polly \
        --output eval/dataset/cases.jsonl \
        --max-per-repo 10 \
        --github-token $GITHUB_TOKEN
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.parse
import urllib.error

# ─── Repo catalog ────────────────────────────────────────────────────────────

REPO_CATALOG: dict[str, dict] = {
    "flask":          {"owner": "pallets",          "repo": "flask",               "language": "python"},
    "gin":            {"owner": "gin-gonic",         "repo": "gin",                 "language": "go"},
    "polly":          {"owner": "App-vNext",         "repo": "Polly",               "language": "csharp"},
    "express":        {"owner": "expressjs",         "repo": "express",             "language": "javascript"},
    "retrofit":       {"owner": "square",            "repo": "retrofit",            "language": "java"},
    "alamofire":      {"owner": "Alamofire",         "repo": "Alamofire",           "language": "swift"},
    "tokio":          {"owner": "tokio-rs",          "repo": "tokio",               "language": "rust"},
    "libuv":          {"owner": "libuv",             "repo": "libuv",               "language": "c"},
    "sinatra":        {"owner": "sinatra",           "repo": "sinatra",             "language": "ruby"},
    "laravel":        {"owner": "laravel",           "repo": "framework",           "language": "php"},
    "kotlin-wrappers":{"owner": "JetBrains",         "repo": "kotlin-wrappers",     "language": "kotlin"},
    "http4s":         {"owner": "http4s",            "repo": "http4s",              "language": "scala"},
    "phoenix":        {"owner": "phoenixframework",  "repo": "phoenix",             "language": "elixir"},
    "cabal":          {"owner": "haskell",           "repo": "cabal",               "language": "haskell"},
    "awesome":        {"owner": "awesomeWM",         "repo": "awesome",             "language": "lua"},
    "vueuse":         {"owner": "vueuse",            "repo": "vueuse",              "language": "vue"},
    "vscode-eslint":  {"owner": "microsoft",         "repo": "vscode-eslint",       "language": "typescript"},
    "cobol-course":   {"owner": "openmainframeproject", "repo": "cobol-programming-course", "language": "cobol"},
}

# ─── Inclusion / exclusion filters ───────────────────────────────────────────

# PR labels to include (at least one must match, OR label checking is skipped
# if the PR has no labels at all — we fall back to title/body heuristics)
INCLUDE_LABELS = {"bug", "fix", "bugfix", "regression", "refactor", "breaking-change", "feature"}

# Patterns that indicate a non-code PR → exclude
EXCLUDE_TITLE_PATTERNS = re.compile(
    r"\b(typo|fmt|format|lint|changelog|readme|license|docs?|bump\s+version|"
    r"dependency|dependencies|dependabot|ci:|chore:|style:|release\s+v)\b",
    re.IGNORECASE,
)

# File extension whitelist — at least one changed file must match
CODE_EXTENSIONS = {
    ".py", ".go", ".cs", ".js", ".ts", ".java", ".swift", ".rs",
    ".c", ".h", ".cpp", ".rb", ".php", ".kt", ".scala", ".ex", ".exs",
    ".hs", ".lua", ".vue", ".tsx", ".jsx",
}

# Hard limits on changed file count (too narrow or too broad)
MIN_FILES = 1
MAX_FILES = 5

# Only consider PRs with a linked issue or explanatory body
MIN_BODY_WORDS = 10

# ─── Data types ───────────────────────────────────────────────────────────────

@dataclass
class GroundTruth:
    files: list[str] = field(default_factory=list)
    symbols: list[str] = field(default_factory=list)
    call_chain: list[str] = field(default_factory=list)

@dataclass
class EvalCase:
    id: str
    repo: str                    # "owner/repo"
    language: str
    commit_before: str           # SHA of the base commit (before the fix)
    commit_fix: str              # SHA of the merge commit
    task_type: str               # C1-C5
    difficulty: str              # easy | medium | hard
    issue_text: str              # PR title + body excerpt
    issue_url: str
    pr_number: int
    ground_truth: GroundTruth
    gt_source: str = "pr_diff"
    case_status: str = "draft"
    leakage_risk: str = "medium"
    task_prompt_style: str = "locate-fix"
    dataset_version: str = "round-01"
    annotation_version: int = 1

# ─── Leakage risk and prompt style helpers ──────────────────────────────────

def _classify_leakage_risk(pr: dict) -> str:
    """Heuristic leakage risk based on repo popularity and PR engagement."""
    # Note: stars/comment counts are not always available from PR data.
    # Default to "medium" when insufficient info.
    comments = pr.get("comments", 0) + pr.get("review_comments", 0)
    # Repos in catalog are well-known open-source; use comment count as proxy
    if comments > 50:
        return "high"
    if comments > 10:
        return "medium"
    return "low"


_TASK_PROMPT_STYLE_MAP: dict[str, str] = {
    "C1": "locate-fix",
    "C3": "trace-call-chain",
    "C5": "impact-analysis",
}


def _task_type_to_prompt_style(task_type: str) -> str:
    """Map task_type (C1-C5) to prompt style name."""
    return _TASK_PROMPT_STYLE_MAP.get(task_type, "locate-fix")


# ─── GitHub API helpers ───────────────────────────────────────────────────────

def gh_get(path: str, token: str, retries: int = 4) -> dict | list:
    """Make a GitHub REST API call with retry on transient network errors."""
    url = f"https://api.github.com{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitnexus-eval/1.0",
    })

    delay_s = 1.0
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            # Retry on GitHub transient/rate-limit style statuses, fail fast otherwise.
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                time.sleep(delay_s)
                delay_s *= 2
                last_err = e
                continue
            body = e.read().decode(errors="replace")
            raise RuntimeError(f"GitHub API {e.code} for {url}: {body}") from e
        except urllib.error.URLError as e:
            last_err = e
            if attempt < retries:
                time.sleep(delay_s)
                delay_s *= 2
                continue
            raise RuntimeError(f"GitHub API network error for {url}: {e}") from e

    # Should be unreachable, but keep a defensive fallback.
    raise RuntimeError(f"GitHub API failed after {retries} attempts for {url}: {last_err}")


def paginate(path: str, token: str, max_pages: int = 5) -> list[dict]:
    """Fetch up to max_pages pages of results from a GitHub list endpoint."""
    results: list[dict] = []
    for page in range(1, max_pages + 1):
        sep = "&" if "?" in path else "?"
        data = gh_get(f"{path}{sep}per_page=100&page={page}", token)
        if not isinstance(data, list) or not data:
            break
        results.extend(data)
        time.sleep(0.3)  # stay well within primary rate limit
    return results

# ─── Task type classification ──────────────────────────────────────────────

def classify_task(pr: dict, files: list[dict]) -> str:
    """
    Heuristically classify the PR into one of 5 task types:
      C1 — Bug fix            (fix/bug labels or keywords)
      C2 — Interface change   (rename/signature/breaking)
      C3 — New call chain     (feat + cross-file callers)
      C4 — Interface impl     (implement/add impl)
      C5 — Dependency swap    (replace/migrate/switch)
    """
    title = (pr.get("title") or "").lower()
    body  = (pr.get("body")  or "").lower()
    text  = title + " " + body

    labels = {(lb.get("name") or "").lower() for lb in (pr.get("labels") or [])}

    if any(w in text for w in ("replace", "migrate", "switch to", "swap")):
        return "C5"
    if any(w in text for w in ("implement", "add impl", "fulfil", "fulfill")):
        return "C4"
    if any(w in text for w in ("rename", "breaking change", "signature", "breaking:")):
        return "C2"
    if labels & {"feature", "feat", "enhancement"} or title.startswith("feat"):
        return "C3"
    return "C1"  # default to bug fix


def classify_difficulty(files: list[dict]) -> str:
    n = len(files)
    if n == 1:
        return "easy"
    if n <= 3:
        return "medium"
    return "hard"


# ─── Ground-truth extraction ──────────────────────────────────────────────

_SYMBOL_RE = re.compile(
    r"(?:^|\s)(?:def|func|function|class|interface|struct|trait|impl|type|enum|fn)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)",
    re.MULTILINE,
)

def extract_symbols_from_patch(patch: str) -> list[str]:
    """
    Extract added/modified symbol names from a unified diff patch.
    Only looks at '+' lines (additions in the fix).
    """
    added_lines = "\n".join(
        line[1:] for line in patch.splitlines() if line.startswith("+") and not line.startswith("+++")
    )
    return list(dict.fromkeys(_SYMBOL_RE.findall(added_lines)))  # unique, order-preserving


def build_ground_truth(pr_files: list[dict]) -> GroundTruth:
    files: list[str] = []
    symbols: list[str] = []

    for f in pr_files:
        filename = f.get("filename", "")
        ext = Path(filename).suffix.lower()
        if ext not in CODE_EXTENSIONS:
            continue
        if f.get("status") == "removed":
            continue
        files.append(filename)
        patch = f.get("patch") or ""
        symbols.extend(extract_symbols_from_patch(patch))

    return GroundTruth(
        files=files,
        symbols=list(dict.fromkeys(symbols)),
        call_chain=[],  # populated manually or by a later enrichment pass
    )


# ─── Inclusion check ──────────────────────────────────────────────────────────

def is_eligible(pr: dict, pr_files: list[dict]) -> tuple[bool, str]:
    """Return (eligible, rejection_reason)."""
    title = pr.get("title") or ""
    body  = pr.get("body")  or ""

    # Must be merged
    if not pr.get("merged_at"):
        return False, "not merged"

    # Title must not match exclusion pattern
    if EXCLUDE_TITLE_PATTERNS.search(title):
        return False, f"excluded title: {title[:60]}"

    # Body must exist and be meaningful enough
    if len((body or "").split()) < MIN_BODY_WORDS:
        return False, "body too short"

    # File count window
    code_files = [
        f for f in pr_files
        if Path(f.get("filename", "")).suffix.lower() in CODE_EXTENSIONS
        and f.get("status") != "removed"
    ]
    if not (MIN_FILES <= len(code_files) <= MAX_FILES):
        return False, f"code file count {len(code_files)} out of [{MIN_FILES},{MAX_FILES}]"

    return True, ""


# ─── Main harvesting logic ─────────────────────────────────────────────────

def harvest_repo(alias: str, meta: dict, token: str, max_cases: int) -> list[EvalCase]:
    owner, repo_name, language = meta["owner"], meta["repo"], meta["language"]
    full_repo = f"{owner}/{repo_name}"
    print(f"  → {full_repo} ({language})", flush=True)

    cases: list[EvalCase] = []
    prs = paginate(
        f"/repos/{owner}/{repo_name}/pulls?state=closed&sort=updated&direction=desc",
        token,
        max_pages=3,
    )

    for pr in prs:
        if len(cases) >= max_cases:
            break

        pr_number = pr["number"]

        # Fetch file list for this PR
        try:
            pr_files = gh_get(f"/repos/{owner}/{repo_name}/pulls/{pr_number}/files", token)
            if not isinstance(pr_files, list):
                continue
        except RuntimeError as e:
            print(f"    [warn] PR #{pr_number} files error: {e}", file=sys.stderr)
            continue

        eligible, reason = is_eligible(pr, pr_files)
        if not eligible:
            continue

        gt = build_ground_truth(pr_files)
        if not gt.files:
            continue

        # Build issue text from title + first 400 chars of body
        body_excerpt = (pr.get("body") or "")[:400].replace("\r\n", " ").replace("\n", " ")
        issue_text = f"{pr['title']}\n\n{body_excerpt}"

        # Determine base commit (head of the base branch before merge)
        commit_before = pr.get("base", {}).get("sha") or ""
        commit_fix    = pr.get("merge_commit_sha") or ""

        case_id = f"{alias}-{pr_number:05d}"
        task_type  = classify_task(pr, pr_files)
        difficulty = classify_difficulty(pr_files)

        # Compute extended fields
        case_status = "draft"
        leakage_risk = _classify_leakage_risk(pr)
        task_prompt_style = _task_type_to_prompt_style(task_type)
        dataset_version = "round-01"
        annotation_version = 1

        cases.append(EvalCase(
            id=case_id,
            repo=full_repo,
            language=language,
            commit_before=commit_before,
            commit_fix=commit_fix,
            task_type=task_type,
            difficulty=difficulty,
            issue_text=issue_text,
            issue_url=pr.get("html_url") or "",
            pr_number=pr_number,
            ground_truth=gt,
            case_status=case_status,
            leakage_risk=leakage_risk,
            task_prompt_style=task_prompt_style,
            dataset_version=dataset_version,
            annotation_version=annotation_version,
        ))
        print(f"    [+] #{pr_number} {task_type}/{difficulty} → {len(gt.files)} files, {len(gt.symbols)} symbols")
        time.sleep(0.2)

    return cases


def main() -> None:
    parser = argparse.ArgumentParser(description="Harvest GitNexus eval cases from GitHub PRs")
    parser.add_argument("--repos", nargs="+", choices=list(REPO_CATALOG.keys()),
                        default=["flask", "gin", "polly"],
                        help="Repo aliases to harvest (default: flask gin polly)")
    parser.add_argument("--output", default="eval/dataset/cases.jsonl",
                        help="Output JSONL path")
    parser.add_argument("--max-per-repo", type=int, default=10,
                        help="Max cases to collect per repo (default: 10)")
    parser.add_argument("--github-token", default=os.environ.get("GITHUB_TOKEN", ""),
                        help="GitHub personal access token (or set GITHUB_TOKEN env var)")
    args = parser.parse_args()

    if not args.github_token:
        print("ERROR: --github-token or GITHUB_TOKEN env var is required", file=sys.stderr)
        sys.exit(1)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    all_cases: list[EvalCase] = []
    for alias in args.repos:
        meta = REPO_CATALOG[alias]
        try:
            repo_cases = harvest_repo(alias, meta, args.github_token, args.max_per_repo)
            all_cases.extend(repo_cases)
        except RuntimeError as e:
            print(f"  [error] {alias}: {e}", file=sys.stderr)

    with out_path.open("w", encoding="utf-8") as f:
        for case in all_cases:
            d = asdict(case)
            # Flatten GroundTruth back to dict (asdict already does this)
            f.write(json.dumps(d, ensure_ascii=False) + "\n")

    print(f"\n✓ Wrote {len(all_cases)} cases to {out_path}")

    # Summary
    by_type: dict[str, int] = {}
    by_lang: dict[str, int] = {}
    by_diff: dict[str, int] = {}
    for c in all_cases:
        by_type[c.task_type]   = by_type.get(c.task_type, 0)   + 1
        by_lang[c.language]    = by_lang.get(c.language, 0)    + 1
        by_diff[c.difficulty]  = by_diff.get(c.difficulty, 0)  + 1
    print(f"  By type:       {by_type}")
    print(f"  By language:   {by_lang}")
    print(f"  By difficulty: {by_diff}")


if __name__ == "__main__":
    main()
