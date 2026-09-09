#!/usr/bin/env python3
"""Case-number normaliser — Layer 18 §6 as corrected by Erratum Set No. 1 (Job B).

normalise(raw, court_id, courts) -> dict(status, canonical, prefix, bench, number, year, flags)
  status: OK | AMBIGUOUS | REJECT
Prefixes are data (data/courts.json). No regex per court; one canonical shape after normalisation.
"""
import json, re, sys, pathlib

YEAR = re.compile(r'^(19|20)\d{2}$')

def load_courts(path=None):
    p = pathlib.Path(path or "data/courts.json")
    return {c["id"]: c for c in json.loads(p.read_text())["courts"]}

def _clean(raw: str) -> str:
    s = raw.upper().strip()
    s = re.sub(r'\.', '', s)                       # C.P. -> CP, J.M. -> JM, C.P.L.A. -> CPLA, Appln. -> APPLN
    s = re.sub(r'\b(NO|NUMBER)\b', ' ', s)          # drop No / Number tokens
    s = re.sub(r'\s+OF\s+', '/', s)                 # 'of' -> '/'
    s = re.sub(r'\s*/\s*', '/', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def normalise(raw: str, court_id: str, courts: dict) -> dict:
    court = courts.get(court_id)
    if not court:
        return {"status": "REJECT", "reason": f"unknown court {court_id}"}
    s = _clean(raw)
    # split off the trailing NUMBER/YEAR (with optional bench letter before or after the number)
    m = re.search(r'(?:(?P<bench1>[A-Z])-)?(?P<num>\d{1,6})(?:-(?P<bench2>[A-Z]))?/(?P<year>\d{4})$', s)
    if not m:
        return {"status": "REJECT", "reason": "no NUMBER/YEAR found — open L17.8 follow-up", "input": raw}
    year = m.group("year")
    if not YEAR.match(year):
        return {"status": "REJECT", "reason": "year out of range", "input": raw}
    bench = m.group("bench1") or m.group("bench2")
    head = s[:m.start()].strip()
    head = re.sub(r'[-\s]+$', '', head)
    # resolve prefix through the court's synonym map: try the longest matching phrase first
    syn = {k.upper(): v for k, v in court.get("synonyms", {}).items()}
    prefix = None
    tokens = head.split(" ")
    for n in range(len(tokens), 0, -1):
        phrase = " ".join(tokens[:n]).replace("&", "&")
        if phrase in syn:
            prefix = syn[phrase]; break
    if prefix is None:
        compact = head.replace(" ", "")
        if compact in syn: prefix = syn[compact]
    if prefix is None or prefix not in court["allowed_prefixes"]:
        return {"status": "REJECT", "reason": f"prefix '{head}' not allowed for {court_id} — confirm under O-9", "input": raw}
    if bench and court.get("bench_letters") and bench not in court["bench_letters"]:
        return {"status": "REJECT", "reason": f"bench letter {bench} not known for {court_id}", "input": raw}
    if bench and not court.get("bench_letters"):
        return {"status": "REJECT", "reason": f"{court_id} has no bench letters", "input": raw}
    canonical = f"{prefix} {bench + '-' if bench else ''}{m.group('num')}/{year}"
    flags = []
    if prefix in court.get("ambiguous_prefixes", {}):
        flags.append("AMBIGUOUS")
    return {"status": "AMBIGUOUS" if flags else "OK", "canonical": canonical, "prefix": prefix, "bench": bench, "number": m.group("num"), "year": year, "flags": flags,
            "note": court.get("ambiguous_prefixes", {}).get(prefix, "")}

if __name__ == "__main__":
    courts = load_courts(sys.argv[3] if len(sys.argv) > 3 else None)
    print(json.dumps(normalise(sys.argv[1], sys.argv[2], courts), indent=2))
