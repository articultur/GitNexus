You are an expert software engineer analyzing a codebase to locate a bug.

## Repository
Repo:     {{repo}}
Language: {{language}}
Commit:   {{commit_before}}

The snapshot of the repository is available at: {{snapshot_dir}}

## Issue Description
{{issue_text}}

## Your Task
Based on the issue description above, identify:

1. Which files in the repository need to be modified to fix this issue?
2. Which specific functions, methods, or classes are the root cause?
3. What is the call chain from the user-facing entry point to the root cause?

## Rules
- Analyze the codebase **as it exists at commit {{commit_before}}** (before the fix was applied).
- Do NOT look up the fix commit or any later history.
- You may read files, search for patterns, and list directories.
- Be precise: only list files that genuinely need changing, not every file you read.
- Use the minimum number of tool calls needed to reach a confident answer.

## IMPORTANT: How to Output Your Answer
After you have gathered enough information to answer, you MUST:
1. Stop calling any more tools
2. Respond with ONLY a JSON object (no tool calls, no text before/after) in this exact format:

```json
{
  "files": ["path/to/file1.py", "path/to/file2.py"],
  "symbols": ["ClassName.method_name", "standalone_function"],
  "call_chain": ["entry_function → intermediate → root_cause"],
  "confidence": 0.85,
  "reasoning": "One-paragraph explanation."
}
```

Do NOT output `[TOOL_CALL]` blocks or any other format. The answer must be valid JSON.

## Available Tools
- `read_file(path, start_line?, end_line?)` — Read file contents
- `grep_search(query, is_regexp?, include_pattern?)` — Search by exact string or regex
- `file_search(query)` — Find files by name/glob pattern
- `list_dir(path)` — List directory contents

## Output Format
Respond **only** with a JSON object matching this exact schema — no prose before or after:

```json
{
  "files": ["path/to/file1.py", "path/to/file2.py"],
  "symbols": ["ClassName.method_name", "standalone_function"],
  "call_chain": ["entry_function → intermediate → root_cause"],
  "confidence": 0.85,
  "reasoning": "One-paragraph explanation of why these files/symbols are the cause."
}
```

Field definitions:
- `files`: workspace-relative paths of files that need to change (only code files, no docs/tests)
- `symbols`: qualified names of functions/methods/classes at the root cause
- `call_chain`: ordered list of call steps from entry point to root cause (use `→` separator)
- `confidence`: your confidence in this answer from 0.0 to 1.0
- `reasoning`: brief evidence-based explanation (1-3 sentences)
