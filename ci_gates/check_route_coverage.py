#!/usr/bin/env python3
"""route-coverage guard (G-4, Phase 2a): every /api/d1 route must be exercised by a test.

Usage: check_route_coverage.py [--domain D] <router.ts> <tests-dir>   (D defaults to d1; prefix /api/<D>)

A route is covered only when a test file under <tests-dir> calls viaApi("<name>") (the generic
helper may carry a type argument). A bare path literal does not count: lists of paths (boot
checks, probe tables) would satisfy it without exercising the route. The number of routes found
is cross-checked against the number of get/post/put entries of the router that name a d1 path.
Routes are read from the router: `${D1_X}/<name>` template paths (D1_X = "/api/d1/<service>")
and full "/api/d1/<service>/<name>" literals.
"""
import pathlib
import re
import sys


def _consts(router_text, prefix):
    pat = r'const\s+(\w+)\s*=\s*["\'](' + re.escape(prefix) + r'(?:/[\w-]+)?)["\']'
    return dict(re.findall(pat, router_text))


def routes(router_text, domain="d1"):
    prefix = f"/api/{domain}"
    consts = _consts(router_text, prefix)
    found = set()
    for var, name in re.findall(r"\$\{(\w+)\}/(\w+)", router_text):
        if var in consts:
            found.add((consts[var], name))
    bare = re.sub(r"const\s+\w+\s*=\s*[\"'][^\"'\n]*[\"']", "", router_text)  # a route constant is not a route
    for base, name in re.findall(r'["\'`](' + re.escape(prefix) + r'(?:/[\w-]+)?)/(\w+)["\'`]', bare):
        found.add((base, name))
    return sorted(found)


def route_entries(router_text, domain="d1"):
    """Independent count: route-table entries (get/post/put calls) whose path is under /api/<domain>."""
    prefix = f"/api/{domain}"
    names = [re.escape(n) for n in _consts(router_text, prefix)]
    if domain == "d1":
        names.append(r"D1_\w+")
    const_alt = "|".join(names) if names else None
    parts = [r'^\s*(?:get|post|put)\(\s*[`"\']' + re.escape(prefix) + "/"]
    if const_alt:
        parts.insert(0, r'^\s*(?:get|post|put)\(\s*[`"\']\$?\{?(?:' + const_alt + r')\}?[^,]*,')
    return len(re.findall("|".join(parts), router_text, re.M))


def main(argv):
    args = argv[1:]
    domain = "d1"
    if len(args) >= 2 and args[0] == "--domain":
        domain, args = args[1], args[2:]
    if len(args) != 2:
        print(__doc__)
        return 2
    router, tests = pathlib.Path(args[0]), pathlib.Path(args[1])
    rs = routes(router.read_text(encoding="utf-8"), domain)
    if not rs:
        print(f"FAIL: no /api/{domain} routes found in {router}")
        return 1
    entries = route_entries(router.read_text(encoding="utf-8"), domain)
    print(f"{domain} routes found: {len(rs)}; {domain} entries in the route table: {entries}")
    if entries != len(rs):
        print("FAIL: the route extraction and the route-table count disagree")
        return 1
    corpus = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore") for p in sorted(tests.rglob("*.ts")) if p.is_file()
    )
    missing = []
    for base, name in rs:
        via = re.search(r'viaApi\s*(?:<[^()]*>)?\s*\(\s*["\']' + re.escape(name) + r'["\']', corpus)
        if not via:
            missing.append(f"{base}/{name}")
    if missing:
        print(f"FAIL: MISSING test coverage for {domain} routes:")
        for m in missing:
            print(f"  {m}")
        return 1
    print(f"PASS: all {len(rs)} {domain} routes are exercised by a test")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
