#!/usr/bin/env python3
"""duplicate-route guard — one owner per function. Scans TS/JS and Python handlers; also the route table if present."""
import re, pathlib, sys, json
from collections import defaultdict
routes = defaultdict(list)
pat_ts = re.compile(r'(?:app|router)\.(?:post|get|put|delete|patch)\s*\(\s*["\'](/api/[^"\']+)')
pat_py = re.compile(r'@(?:app|router)\.(?:post|get|put|delete|patch)\s*\(\s*["\'](/api/[^"\']+)')
for p in pathlib.Path(".").rglob("*"):
    if p.suffix not in (".ts", ".js", ".py") or "node_modules" in p.parts or ".git" in p.parts or p.parts[0] == "ci_gates" or "corpus_service" in p.parts or ".eve" in p.parts: continue
    try: text = p.read_text(encoding="utf-8", errors="ignore")
    except Exception: continue
    for m in (pat_ts.finditer(text) if p.suffix != ".py" else pat_py.finditer(text)):
        routes[m.group(1)].append(str(p))
table = pathlib.Path("data/routes.json")
if table.exists():
    for r in json.loads(table.read_text()): routes[r["route"]].append("data/routes.json")
dups = {k: v for k, v in routes.items() if len(v) > 1}
if dups:
    print("FAIL: duplicate route registrations:"); [print("  ", k, v) for k, v in dups.items()]; sys.exit(1)
print(f"PASS: no duplicate routes ({len(routes)} registered)"); sys.exit(0)
