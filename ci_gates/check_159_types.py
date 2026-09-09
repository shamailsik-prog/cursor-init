#!/usr/bin/env python3
"""seed-clone-guard — data/documentTypes.json must be the posture-based v1.1 seed (Job C ACCEPT)."""
import json, sys, pathlib
d = json.loads(pathlib.Path("data/documentTypes.json").read_text())
types = d["types"]; failed = []
ids = [t["id"] for t in types]
if len(types) != 159: failed.append(f"expected 159 VERIFIED types, got {len(types)}")
if len(set(ids)) != len(ids): failed.append("duplicate ids")
if any(t.get("status") != "VERIFIED" for t in types): failed.append("non-VERIFIED row in live seed")
if "court_fee_calculation" in ids: failed.append("removed type court_fee_calculation present in live seed")
if not all("posture" in t and t["posture"] for t in types): failed.append("posture column missing")
if not all(isinstance(t["requiredFields"], list) and isinstance(t["checklist"], list) and isinstance(t["courtIds"], list) for t in types): failed.append("array fields exported as strings")
la = [t["id"] for t in types if "law-abiding" in " ".join(t["checklist"]).lower() or "law-abiding" in t.get("firstGroundRule","").lower()]
if set(la) != {"bail_application_497", "pre_arrest_bail_498"}: failed.append(f"antecedents ground cloned onto {sorted(set(la)-{'bail_application_497','pre_arrest_bail_498'})}")
eld = [t for t in types if any("exact land description" in x.lower() for x in t["checklist"])]
if any(t["category"] != "property" for t in eld): failed.append("'Exact land description' outside property: " + ",".join(t["id"] for t in eld if t["category"] != "property"))
w = next(t for t in types if t["id"] == "will_wasiyat")
if any(f in w["requiredFields"] for f in ("plaintiffOrApplicant", "jurisdictionFacts")): failed.append("will_wasiyat carries suit fields")
n = next(t for t in types if t["id"] == "court_nazir_application")
if "fundamentalRightOrJurisdictionGround" in n["requiredFields"]: failed.append("court_nazir_application carries writ field")
banned = ("calculatecourtfee", "getfeerule", "insertfeememo", "courtfeebasis", "fee memo")
blob = json.dumps(d).lower()
if any(b in blob for b in banned): failed.append("banned fee identifiers present in seed")
for t in types:
    for x in t["checklist"]:
        xl = x.lower()
        if ("court fee" in xl or "stamp duty" in xl) and "manual" not in xl: failed.append(f"{t['id']}: fee/duty item not marked MANUAL")
if len(set(json.dumps(t["checklist"]) for t in types)) < 12: failed.append("fewer than 12 distinct checklists — stencil clones")
print("\n".join("FAIL: " + f for f in failed) if failed else "PASS: 159 types; posture present; clone guards clean")
sys.exit(1 if failed else 0)
