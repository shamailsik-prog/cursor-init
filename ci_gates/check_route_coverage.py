#!/usr/bin/env python3
"""route-coverage guard (G-4, Phase 2a): every /api/d1 route must be exercised by a test.

Usage: check_route_coverage.py <router.ts> <tests-dir>

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


def routes(router_text):
    consts = dict(re.findall(r'const\s+(D1_\w+)\s*=\s*["\'](/api/d1/[\w/-]+)["\']', router_text))
    found = set()
    for var, name in re.findall(r"\$\{(D1_\w+)\}/(\w+)", router_text):
        if var in consts:
            found.add((consts[var], name))
    for base, name in re.findall(r'["\'`](/api/d1/[\w-]+)/(\w+)["\'`]', router_text):
        found.add((base, name))
    return sorted(found)


def route_entries(router_text):
    """Independent count: route-table entries (get/post/put calls) whose path is a d1 path."""
    return len(re.findall(r'^\s*(?:get|post|put)\(\s*[`"\']\$?\{?D1_\w+\}?[^,]*,|^\s*(?:get|post|put)\(\s*[`"\']/api/d1/', router_text, re.M))


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    router, tests = pathlib.Path(argv[1]), pathlib.Path(argv[2])
    rs = routes(router.read_text(encoding="utf-8"))
    if not rs:
        print(f"FAIL: no /api/d1 routes found in {router}")
        return 1
    entries = route_entries(router.read_text(encoding="utf-8"))
    print(f"d1 routes found: {len(rs)}; d1 entries in the route table: {entries}")
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
        print("FAIL: MISSING test coverage for d1 routes:")
        for m in missing:
            print(f"  {m}")
        return 1
    print(f"PASS: all {len(rs)} d1 routes are exercised by a test")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
