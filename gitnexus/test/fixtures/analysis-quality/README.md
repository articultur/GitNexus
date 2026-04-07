# Analysis Quality Fixtures

These fixtures are for benchmarking GitNexus analysis accuracy directly, rather than benchmarking agent task completion.

## Purpose

Each case provides:

- A tiny source repository fixture
- A machine-readable manifest of expected analysis results
- A stable case id for reporting over time

This lets the project measure graph quality separately from SWE-bench patch success.

## Proposed Layout

Each case lives in its own directory:

```text
analysis-quality/
  README.md
  typescript-symbol-resolution-basic/
    case.json
    src/
      app.ts
      math.ts
```

## Manifest Shape

The initial manifest format is intentionally simple:

```json
{
  "id": "typescript-symbol-resolution-basic",
  "language": "typescript",
  "repoPath": ".",
  "capabilities": ["resolved_symbol", "call_edge", "import_edge"],
  "assertions": {
    "resolvedSymbols": [],
    "callEdges": [],
    "importEdges": []
  }
}
```

## Initial Assertion Categories

- `resolved_symbol`: a symbol reference resolves to the expected declaration
- `call_edge`: a source symbol calls a target symbol
- `import_edge`: a file imports the expected target file or module
- `inherits_edge`: a class/type inherits from the expected parent
- `changed_symbol`: a diff is mapped to the expected changed symbol
- `process_membership`: a symbol belongs to the expected detected process

## Guidelines

- Keep fixtures minimal and single-purpose.
- Set `repoPath` relative to the case directory. Use `.` when the case directory is the repo root.
- Prefer explicit source paths in assertions.
- One case should target one main capability, even if it incidentally exercises others.
- Reuse naming conventions from existing fixture directories where practical.

## Next Step

Once the runner exists, these manifests should be consumed by a focused vitest suite or dedicated benchmark command.
