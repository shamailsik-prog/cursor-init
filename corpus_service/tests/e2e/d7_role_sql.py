#!/usr/bin/env python3
"""Print the draft gate's session check (ROLE_SQL in functions/src/d4/corpusAuthorityStore.ts) as one SQL statement,
with its READABLE parameter inlined, so the compose e2e can run the adapter's own check as a reader login on the real
stack (audit F05, #51 fix round 2). It reads the TypeScript source rather than copying the SQL, so the e2e cannot drift
from what the adapter runs. Exits non-zero if the source no longer has the shape it expects."""
import re
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[3] / "functions" / "src" / "d4" / "corpusAuthorityStore.ts"


def main() -> int:
    text = SOURCE.read_text(encoding="utf-8")
    readable = re.search(r"^const READABLE = \[([^\]]*)\]$", text, re.M)
    role_sql = re.search(r"^const ROLE_SQL = `([^`]*)`$", text, re.M)
    if not readable or not role_sql:
        print(f"d7_role_sql: READABLE or ROLE_SQL not found in {SOURCE}", file=sys.stderr)
        return 1
    names = re.findall(r'"([a-z_]+)"', readable.group(1))
    sql = role_sql.group(1)
    if not names or sql.count("$1::text[]") != 1 or re.search(r"\$[2-9]", sql):
        print("d7_role_sql: unexpected READABLE or ROLE_SQL parameters", file=sys.stderr)
        return 1
    array = "ARRAY[" + ", ".join(f"'{n}'" for n in names) + "]::text[]"
    print(" ".join(sql.replace("$1::text[]", array).split()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
