import re

raw = '{"type": "tool_use", "path": "/src/flask/globals.py"}'
pat = r'"path"\s*:\s*"([^"]+)"'
m = re.search(pat, raw)
print(f"Pattern works: {m.group(1) if m else None}")
