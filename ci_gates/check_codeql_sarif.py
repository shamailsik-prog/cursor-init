#!/usr/bin/env python3
"""Fail on CodeQL results at or above a security-severity threshold.

Code scanning (SARIF upload) needs GitHub Code Security on a private repo,
which is not enabled here; the workflow analyses without uploading and this
gate reads the SARIF files instead. Usage: check_codeql_sarif.py DIR [MIN]
"""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "sarif")
minimum = float(sys.argv[2]) if len(sys.argv) > 2 else 7.0  # 7.0 = "high"

files = sorted(root.rglob("*.sarif"))
if not files:
    print(f"FAIL: no SARIF files under {root}")
    sys.exit(1)

blocking, total = [], 0
for path in files:
    doc = json.loads(path.read_text(encoding="utf-8"))
    for run in doc.get("runs", []):
        rules = {}
        for component in [run["tool"]["driver"], *run["tool"].get("extensions", [])]:
            for rule in component.get("rules", []):
                rules[rule["id"]] = rule
        for result in run.get("results", []):
            total += 1
            rule = rules.get(result.get("ruleId"), {})
            severity = float(rule.get("properties", {}).get("security-severity") or 0)
            if severity >= minimum or result.get("level") == "error":
                loc = result["locations"][0]["physicalLocation"]
                where = f'{loc["artifactLocation"]["uri"]}:{loc.get("region", {}).get("startLine", "?")}'
                blocking.append(f'{result.get("ruleId")} (severity {severity}) {where}')

print(f"{total} CodeQL result(s) in {len(files)} file(s); {len(blocking)} at severity >= {minimum} or level error")
for line in blocking:
    print("  " + line)
sys.exit(1 if blocking else 0)
