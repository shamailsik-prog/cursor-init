#!/usr/bin/env python3
"""prefix-fixture-guard — every fixture in data/courts.json must normalise as expected (G-0)."""
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from case_number_normaliser import normalise, load_courts

data = json.loads(pathlib.Path("data/courts.json").read_text())
courts = {c["id"]: c for c in data["courts"]}
failed = 0
# fixtures
for court_id, raw, expected, should_pass in data["fixtures"]:
    r = normalise(raw, court_id, courts)
    ok = (r["status"] in ("OK", "AMBIGUOUS")) == should_pass and (not should_pass or r.get("canonical") == expected)
    print(("PASS" if ok else "FAIL"), court_id, repr(raw), "->", r.get("canonical", r.get("reason")), ("[" + ",".join(r.get("flags", [])) + "]") if r.get("flags") else "")
    failed += 0 if ok else 1
# every court example must also pass
for c in data["courts"]:
    for raw, expected, flag in c.get("examples", []):
        r = normalise(raw, c["id"], courts)
        ok = r.get("canonical") == expected and (flag == "" or flag in r.get("flags", []))
        if not ok: print("FAIL example", c["id"], repr(raw), "->", r); failed += 1
# the SC C.P. rule: bare CP must never become CPLA or CONSTP
r = normalise("C.P. No. 999 of 2024", "SC_PK", courts)
if r.get("prefix") != "CP" or "AMBIGUOUS" not in r.get("flags", []): print("FAIL: SC bare C.P. must stay CP and be flagged AMBIGUOUS"); failed += 1
print("FAIL" if failed else "PASS", "case-number fixtures", f"({failed} failures)")
sys.exit(1 if failed else 0)
