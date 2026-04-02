# ArkTS / ETS Support Plan (GitNexus)

Date: 2026-04-01
Owner: GitNexus core team
Status: Phase B completed (current scope)

## 1. Executive conclusion

Current state is not supported, not just undocumented.

Why:
- Language enum does not contain an ArkTS/ETS language id.
- Extension mapping does not include `.ets`.
- Parser loader has TypeScript/TSX wiring but no `.ets` path.
- Language provider registry has no ArkTS provider.

## 2. Evidence (code references)

- Supported language enum currently ends at Dart/Cobol/Objective-C, no ArkTS/ETS:
  - gitnexus-shared/src/languages.ts:7
  - gitnexus-shared/src/languages.ts:21
  - gitnexus-shared/src/languages.ts:24
- Extension map includes `.ts/.tsx` and `.m/.mm`, but no `.ets`:
  - gitnexus-shared/src/language-detection.ts:31
  - gitnexus-shared/src/language-detection.ts:45
- Tree-sitter loader only wires TypeScript/TSX and Objective-C branches:
  - gitnexus/src/core/tree-sitter/parser-loader.ts:43
  - gitnexus/src/core/tree-sitter/parser-loader.ts:44
  - gitnexus/src/core/tree-sitter/parser-loader.ts:57
  - gitnexus/src/core/tree-sitter/parser-loader.ts:75
- Provider registry has TypeScript and Objective-C providers, no ArkTS provider:
  - gitnexus/src/core/ingestion/languages/index.ts:29
  - gitnexus/src/core/ingestion/languages/index.ts:31
  - gitnexus/src/core/ingestion/languages/index.ts:45
- Public README supported-languages list does not include ETS/ArkTS:
  - gitnexus/README.md:215
  - gitnexus/README.md:217

## 3. Goal

Index `.ets` source under HarmonyOS projects (for example `ohosProject/src/main/ets/**`) with call/import/heritage extraction quality comparable to TypeScript baseline, while avoiding regressions on existing TypeScript projects.

## 3.1 Feature coverage target matrix

| Capability | Phase A (MVP) | Phase B (Hardening) | Final target |
|-----------|----------------|---------------------|--------------|
| File discovery (`.ets`) | yes | yes | yes |
| Symbol extraction (class/function/method/interface) | yes | yes | yes |
| Imports/exports | yes | yes | yes |
| Call graph | yes (TS-compatible subset) | yes (ArkTS-tuned) | yes |
| Heritage/type extraction | yes (TS-compatible subset) | yes (ArkTS-tuned) | yes |
| ArkUI decorators/components semantics | partial | yes | yes |
| Harmony entry-point/framework detection | no | yes | yes |
| Data-flow/taint tuning for ArkTS idioms | no | optional | optional |
| Capability disclosure in docs | yes | yes | yes |

## 4. Delivery strategy

### Phase A (MVP): ETS alias on TypeScript pipeline

Objective: make `.ets` files indexable quickly with minimal blast radius.

Changes:
1. Add language id:
   - Add `ArkTS = 'arkts'` in `gitnexus-shared/src/languages.ts`.
2. Add extension mapping:
   - Map `.ets` to `SupportedLanguages.ArkTS` in `gitnexus-shared/src/language-detection.ts`.
3. Parser loader wiring:
   - In `gitnexus/src/core/tree-sitter/parser-loader.ts`, map `SupportedLanguages.ArkTS` to `TypeScript.typescript`.
   - Add `.ets` branch where `.tsx` special-case currently exists.
4. Provider registration:
   - Create `gitnexus/src/core/ingestion/languages/arkts.ts` as a thin wrapper over TypeScript provider configs.
   - Register it in `gitnexus/src/core/ingestion/languages/index.ts`.
5. Docs:
   - Update supported language list and matrix in `gitnexus/README.md`.

Expected behavior:
- `.ets` files are discovered and parsed.
- Basic imports/calls/symbol extraction works for TS-like syntax.
- ArkTS-specific constructs may be partially supported.

### Phase B (Hardening): ArkTS-specific semantics

Objective: reduce false negatives/positives for ArkTS idioms.

Changes:
1. Add ArkTS-specific language config:
   - Type extraction rules for ArkUI decorators/components.
   - Framework pattern detectors for HarmonyOS entry points.
2. Add ArkTS-specific taint/source/sink patterns if security flows are needed.
3. Add optional compatibility toggles:
   - Feature flags for strict ArkTS mode vs TS-compatible mode.
4. Performance and quality tuning:
   - Ensure parse speed and graph size remain acceptable.

## 5. Test plan

### Unit tests
- `gitnexus-shared/src/language-detection.ts`:
  - `.ets` resolves to `SupportedLanguages.ArkTS`.
- Parser loader:
  - ArkTS key resolves without `Unsupported language` errors.
- Provider lookup:
  - `.ets` returns ArkTS provider.

### Integration fixtures
- Add fixture project with:
  - `ohosProject/src/main/ets/entryability/EntryAbility.ets`
  - `ohosProject/src/main/ets/pages/Index.ets`
  - Cross-file imports and at least one class/function call chain.
- Assertions:
  - Files appear in graph.
  - Symbols and CALLS/IMPORTS edges present.

### Regression
- Run existing TypeScript and mixed-language suites to confirm no behavior drift.

## 6. Acceptance criteria

- `npx gitnexus analyze` indexes `.ets` files and stores them in graph nodes.
- `context` and `impact` can resolve symbols from `.ets` files.
- No regression in existing TypeScript parsing and TSX behavior.
- README and skills mention ArkTS support level (MVP vs full).

### 6.1 Phase A acceptance gates

- Detection gate: `.ets` files map to `SupportedLanguages.ArkTS`.
- Parse gate: `.ets` fixture parses with non-zero symbol extraction.
- Graph gate: `.ets` symbols produce IMPORTS/CALLS edges in integration fixture.
- Safety gate: existing TypeScript and TSX suites remain green.
- Disclosure gate: docs mark ArkTS as partial/compatibility support (not full semantic parity).

### 6.2 Phase B acceptance gates

- ArkTS semantics gate: ArkUI patterns and Harmony entry points are detected with fixture coverage.
- Precision gate: false positive/negative rate for ArkTS-specific constructs is tracked and improved release-over-release.
- Confidence gate: capability matrix updated to reflect promoted support tier.

## 7. Risks and mitigations

- Risk: ArkTS grammar diverges from TS enough to break parse.
  - Mitigation: Phase A uses TS compatibility baseline; Phase B introduces ArkTS-specific handling.
- Risk: false confidence from partial support.
  - Mitigation: clearly label support tier in docs and context output.
- Risk: performance cost on large HarmonyOS projects.
  - Mitigation: benchmark fixture and parser coverage metrics before release.

## 8. Rollout recommendation

- Ship Phase A behind a minor release flag if needed.
- Collect parse success/error telemetry from sample HarmonyOS repos.
- Promote to default after Phase B quality gates pass.

## 9. Scope boundary and non-goals (initial rollout)

- Phase A does not guarantee full ArkTS language parity.
- If parsing fails on ArkTS-specific grammar not accepted by TS parser, file-level warnings are acceptable in MVP.
- Security-rule and taint policy customization for ArkTS is deferred unless required by product priorities.

## 10. Completion snapshot

Delivered in this rollout:

- ArkTS language id and `.ets` detection are implemented.
- ArkTS parser/provider/query mappings are wired into ingestion.
- ArkTS compatibility preprocessing (`struct` -> `class`) is active in both sequential and worker parsing paths.
- ArkTS entry-point scoring patterns are implemented (`build`, `onCreate`, `onWindowStageCreate`, `aboutToAppear`, `aboutToDisappear`).
- ArkTS framework detection is implemented:
  - Path-based Harmony patterns (`entryability`, `pages`, `src/main/ets`).
  - AST-based ArkUI patterns (`@Entry`, `@Component`, `@State`, `@Builder`, lifecycle/build tokens).
- Unit/integration tests cover detection, parsing compatibility, framework detection, and entry scoring.

Remaining optional enhancements (not blockers for current support tier):

- Deeper ArkUI DSL semantic extraction (component tree semantics beyond current AST text patterns).
- ArkTS-specific taint/source/sink policy tuning.
- Additional fixture corpus from large Harmony projects for recall/precision benchmarking.
