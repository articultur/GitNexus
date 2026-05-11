<!-- version: 1.7.0 -->

Last reviewed: 2026-04-22

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

Follow **AGENTS.md** for the canonical rules; this file adds Claude Code–specific deltas. Cursor-specific notes live only in `AGENTS.md`.

## Scope

See the **Scope** table in [AGENTS.md](AGENTS.md) for read/write/execute/off-limits boundaries.

## Model Configuration

- **Primary:** Pin per **Claude Code** / Anthropic org policy (explicit model id).
- **Fallback:** As configured in Claude Code (organization default or user override).
- **Notes:** The GitNexus CLI analyzer does not call an LLM.

## Execution Sequence (complex tasks)

Same discipline as [AGENTS.md](AGENTS.md): before large multi-step work, state which **AGENTS.md** / **GUARDRAILS.md** rules apply, current **Scope**, and planned validation commands (`npm test`, `tsc`, etc.).

## Context budget

If always-on instructions grow, load deep conventions via conditional reads instead of pasting long blocks here.

## Reference Documentation

- **This repository:** [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
- **Call-resolution DAG:** See ARCHITECTURE.md § Call-Resolution DAG. Shared pipeline code in `gitnexus/src/core/ingestion/` must not name languages — use `LanguageProvider` hooks instead (see AGENTS.md).
- **GitNexus rules:** Defined in [AGENTS.md](AGENTS.md) `<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **gitnexus** (21817 symbols, 30657 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/gitnexus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/gitnexus/clusters` | All functional areas |
| `gitnexus://repo/gitnexus/processes` | All execution flows |
| `gitnexus://repo/gitnexus/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->` block in **[AGENTS.md](AGENTS.md)** for the canonical MCP tools, impact analysis rules, and index instructions.
