<!-- version: 1.6.0 -->

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
- **GitNexus rules:** Defined in [AGENTS.md](AGENTS.md) `<!-- gitnexus:start -->` block. Do NOT duplicate here.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-04-22 | 1.6.0 | Removed Serena integration harness (hooks, skills, MCP, routing rules). |
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |
