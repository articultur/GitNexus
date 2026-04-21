<!-- version: 1.5.0 -->

Last reviewed: 2026-04-17

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

## Claude Code hooks

Hooks configured in `.claude/settings.json`:

| Hook | Matcher | Purpose |
|------|---------|---------|
| PreToolUse | Edit/Write/Serena edits | Remind to run `gitnexus_impact` before editing |
| PreToolUse | GitNexus read tools | Suggest Serena complement for code body inspection |
| PreToolUse | `gitnexus_query` | Detect name-vs-concept misrouting, suggest `serena_find_symbol` |
| PostToolUse | GitNexus + Serena tools | Warn if 5+ consecutive single-server usage |

## Context budget

If always-on instructions grow, load deep conventions via conditional reads instead of pasting long blocks here.

## Reference Documentation

- **This repository:** [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), [GUARDRAILS.md](GUARDRAILS.md).
- **GitNexus rules:** Defined in [AGENTS.md](AGENTS.md) `<!-- gitnexus:start -->` block. Do NOT duplicate here.
- **Routing rules:** See `.claude/skills/gitnexus/gitnexus-routing/SKILL.md` for the single authoritative GitNexus + Serena routing decision tree.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-04-17 | 1.5.0 | Deduplicated GitNexus rules (removed duplicate block), added read-path hooks, cross-server tracking, routing skill. |
| 2026-04-16 | 1.4.0 | Synced GitNexus + Serena routing principles with AGENTS.md. |
| 2026-04-16 | 1.3.0 | Added Serena + GitNexus collaboration routing rules. |
| 2026-03-23 | 1.1.0 | Updated agent instructions to match AGENTS.md. |
| 2026-03-22 | 1.0.0 | Added structured header and changelog. |

---

## GitNexus + Serena Routing

**Single authoritative source:** `.claude/skills/gitnexus/gitnexus-routing/SKILL.md`

That file contains the complete routing decision tree. Summary:

| Operation | Primary Tool | Complement Tool |
|-----------|-------------|-----------------|
| Impact/Blast radius | GitNexus `impact` | — |
| Code body reading | Serena `find_symbol` | GitNexus `context` |
| Relationship discovery | GitNexus `context/query` | Serena `find_symbol` |
| Search by concept | GitNexus `query` | — |
| Search by name | Serena `find_symbol` | — |
| Rename (preview) | GitNexus `rename(dry_run)` | — |
| Rename (execute) | — | Serena `rename_symbol` |
| Precise edits | Serena `replace/insert` | GitNexus `detect_changes` |
| Code review | GitNexus `cypher/query` | Serena `get_symbols_overview` |

**Mandatory rule:** Never run an entire analysis session using only one server.

### Anti-patterns (routing failures to avoid)

| Signal | WRONG tool | RIGHT tool | Why |
|--------|-----------|------------|-----|
| "找到 X 类/函数" (exact name known) | `gitnexus_query` | `serena_find_symbol` | query is for concepts, not names |
| "影响哪些接口/API" | `gitnexus_query` only | `gitnexus_api_impact` + `gitnexus_impact` | api_impact traces public API consumers |
| "改成 SSE 会有什么影响" | `gitnexus_context` only | `gitnexus_impact` + `gitnexus_route_map` | impact is mandatory for change analysis |
| "看看代码怎么写的" (want body) | `gitnexus_context` only | `serena_find_symbol(include_body=true)` | context shows relationships, not code |
| Any edit task | skip `gitnexus_impact` | impact BEFORE edit, detect_changes AFTER | mandatory safety pipeline |

**Decision shortcut:** If the user gives you a **specific class/function name**, reach for `serena_find_symbol` first. If they describe a **concept or behavior**, use `gitnexus_query`.

### Edit Pipeline (mandatory completion)

When the task involves editing code, you MUST complete the full pipeline — do NOT stop after analysis:
1. `gitnexus_impact` → assess risk
2. `serena_find_symbol` → read current code
3. `serena_replace_symbol_body` / `serena_insert_after_symbol` / `serena_insert_before_symbol` → **perform the actual edit**
4. `gitnexus_detect_changes` → verify scope

Do NOT skip step 3. "Show the plan and wait for confirmation" is only for interactive sessions. In non-interactive mode, execute all steps.

## Serena Integration (Claude Code)

### MCP Configuration

Both MCP servers configured in `.mcp.json`, auto-enabled via `enableAllProjectMcpServers: true`.

### First-Time Setup

1. `serena_check_onboarding_performed()` → check initialization
2. If not initialized → `serena_onboarding()` → follow guided setup

### Memory System Separation

| System | Purpose | Location |
|--------|---------|----------|
| Claude Code memory | User preferences, process experience | `~/.claude/projects/.../memory/` |
| Serena memory | Technical architecture, design decisions | `.serena/memories/` |
| GitNexus memory | Graph state, index metadata | `.gitnexus/meta.json` |
