#!/usr/bin/env python3
"""Data inventory gate (audit F42): every store that can hold matter or client data is inventoried.

The inventory (`infra/retention/inventory.json`) names every Firestore collection, object-key prefix, Postgres
table, external processor and backup set, each with a profile (classification, retention class, who may delete,
how deletion is acknowledged) and a key (how a matter's rows are found). The retention policy
(`infra/retention/policy.json`) defines the retention classes.

This gate fails when:
  1. a Firestore collection is in the tree but not inventoried. A collection is "in the tree" when a segment of a
     `firestore.rules` match path names it (nested and one-line blocks alike), or when a source file outside tests,
     build output, docs and the gates (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, anywhere in
     the tree) names it: `.collection(x)`, `.collectionGroup(x)`, Python's `.collection_group(x)`, modular
     `collection(h, x)`, `collectionGroup(h, x)`, `doc(h, x, ...)` with any handle (`db`, `this.db`, `firestore`), a
     helper call `(db, x`, or a constant named `*COLLECTION*`. The argument `x` is resolved: a string or template
     literal, a constant of any name (the file's own or an exported one, through `export { A as B }`), a `+`
     concatenation of those. Names may be camelCase (FA-F42-R1-008, spec R28);
  1b. a name built at run time (a template with interpolation, an unresolved part) has a static prefix that begins no
     inventoried collection;
  1c. an inventoried collection whose rules block is server-only is found only through that block (a server-only store
     needs no block, so the code scan must see it);
  2. an object key segment after any expression naming a firm id (`${firmId}/<seg>/`, `${input.firmId}/<seg>/`,
     `firmId + "/<seg>/"`) is not an inventoried object prefix;
  3. a Postgres relation (`CREATE [GLOBAL|LOCAL] [TEMP|TEMPORARY|UNLOGGED] TABLE`, views, top-level `SELECT ... INTO`
     in any `.sql` file; table and view DDL in a string of a `.py` or JS/TS file; `__tablename__` or
     `create_table("x")` in Python) is not inventoried. A relation outside the `public` schema keeps its schema:
     `client_private.judgment` is not the public `judgment`;
  4. an inventory entry is malformed, duplicated, names an unknown profile, retention class or store, or is stale
     (found by none of the scans above) without a `pending` finding;
  5. the policy is malformed (unknown action, a non-boolean hold, a bad period, a reason-code list that is not a
     closed list of codes), a class that may anonymise has a matter-keyed store with no `anonymise` fields, or a backup
     window disagrees with infra/backup.
With `--runtime` (inside `firebase emulators:exec`, after the Functions suite): every root collection of the emulator
must be inventoried (or be one of the suite's named fixture collections), so a store no static scan can read still
fails CI once a test writes it.

A `pending` entry (a store another finding is adding, e.g. F34's `p1_decisions`) passes whether or not it is in the
tree yet; once it lands the gate prints a note to drop the flag.

Usage: python3 ci_gates/check_data_inventory.py [--root DIR] [--runtime]. Exit 0 PASS, 1 FAIL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

INVENTORY = "infra/retention/inventory.json"
POLICY = "infra/retention/policy.json"

STORE_KINDS = {"firestore", "objectPrefix", "postgres", "external", "backup"}
# A store's id is `<prefix>:<name>`.
ID_PREFIX = {"firestore": "firestore", "objectPrefix": "objects", "postgres": "postgres", "external": "external", "backup": "backup"}
KEY_KINDS = {
    "firestore": {"docId", "field", "none", "ttl"},
    "objectPrefix": {"objects"},
    "postgres": {"none"},
    "external": {"traceExport"},
    "backup": {"backup"},
}
ACTIONS = {"retain", "purge", "anonymise", "expiry", "external", "lock"}
PERIODIC_ACTIONS = {"retain", "purge", "anonymise"}
# FA-F42-R1-011 (spec R31): what a class's period ages from. `row_age`: each row's own `ageField`. `matter_closure`: the
# matter's closure (Module 9 frames retention for closed matters); not built, so a deleting period on it is refused.
PERIOD_BASES = {"row_age", "matter_closure"}
PROFILE_FIELDS = ("classification", "retentionClass", "deleter", "acknowledgement")
NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
# FA-F42-R1-008: a Firestore collection may be camelCase, and a Postgres relation outside `public` keeps its schema.
NAME_RES = {
    "firestore": re.compile(r"^[A-Za-z][A-Za-z0-9_]*$"),
    "postgres": re.compile(r"^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$"),
}
SEGMENT_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
PENDING_RE = re.compile(r"^F\d{2,3}$")

WEEKS_DAYS_RE = re.compile(r"^(\d+)([dw])$")
# A reason code (spec R25): the policy lists them; a request or a hold may give only a listed one.
REASON_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{2,63}$")


@dataclass(frozen=True)
class Finding:
    check: str
    message: str


def _fail(check: str, message: str) -> Finding:
    return Finding(check, message)


MAX_STORE_KEY = 80


def store_key(store_id: str) -> str:
    """The key a store's acknowledgement is filed under, as functions/src/retention/config.ts storeKey computes it."""
    plain = re.sub(r"[^A-Za-z0-9]", "_", store_id)
    if len(plain) <= MAX_STORE_KEY:
        return plain
    return f"{plain[:48]}_h{hashlib.sha256(store_id.encode('utf-8')).hexdigest()[:24]}"


# --- FA-F42-R1-008 (spec R28): the scan reads the whole tree, resolves names and finds every planted shape. ---
# Every source file outside tests, build output, docs and the gates is scanned, so a new root (components/, a script)
# is covered without a list to keep up. The gates are excluded because they name collections as data, not as stores.
SOURCE_SUFFIXES = {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sql"}
SKIP_DIR_PARTS = {"node_modules", "test", "tests", "__tests__", ".stryker-tmp", ".next", "reports", "coverage", ".git", ".claude"}
SKIP_TOP_DIRS = {"docs", "ci_gates", "artifacts", "public"}
# A Firestore collection id as the code may spell it: camelCase is allowed.
FS_NAME = r"[A-Za-z_][A-Za-z0-9_-]*"
FS_NAME_RE = re.compile(rf"^{FS_NAME}$")
# The handle a modular call takes first: `db`, `this.db`, `firestore`, `getFirestore()`, `adminDb()`.
HANDLE = r"(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\s*\))?)"
# Where a collection name is the argument that follows (the argument is read up to its own `,` or `)`).
CALL_PATTERNS = (
    re.compile(r"\.collection\(\s*"),
    re.compile(r"\.collectionGroup\(\s*"),
    re.compile(r"\.collection_group\(\s*"),
    re.compile(rf"(?<![\w$.])collection\(\s*{HANDLE}\s*,\s*"),
    re.compile(rf"(?<![\w$.])collectionGroup\(\s*{HANDLE}\s*,\s*"),
    re.compile(rf"(?<![\w$.])doc\(\s*{HANDLE}\s*,\s*"),
    # A helper that takes the handle first and the collection second (`getById(db, "x", ...)`). Its second argument may
    # also be a document id (`letterRef(db, `outbox_${id}`)`), so only a resolved name counts from it, never a prefix.
    re.compile(r"\(\s*(?:this\.)?db\s*,\s*"),
)
HELPER_PATTERN = CALL_PATTERNS[-1]
# A constant named as a collection (`OPS_COLLECTION = "x"`, `COLLECTION_X = "x"`) is one even before it is used.
NAMED_COLLECTION_RE = re.compile(r"\b[A-Z0-9_]*COLLECTION[A-Z0-9_]*\s*(?::\s*[\w$<>\[\]| ]+)?=\s*[\"'`]([A-Za-z_][A-Za-z0-9_-]*)[\"'`]")
# A string constant of any name: `const X = "x"`, `export const X: string = 'x'`, a template with no interpolation.
CONST_RE = re.compile(r"""(?:^|[\s;])(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$<>\[\]| ]+)?=\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\]*)`)""", re.M)
# `export { A as B } from "..."` and `export { A as B }`: B is A.
REEXPORT_RE = re.compile(r"export\s*\{([^}]*)\}")
# An object key segment after any expression that names a firm id: `${firmId}/x/`, `${input.firmId}/x/`, `firmId + "/x/"`.
OBJECT_SEGMENT_RES = (
    re.compile(r"\$\{[^}]*\b\w*[fF]irm[iI]d\b[^}]*\}/([a-z][a-z0-9_-]*)/"),
    re.compile(r"\b\w*[fF]irm[iI]d\b\s*\+\s*[\"'`]/([a-z][a-z0-9_-]*)/"),
)
# A rules `match` path: every literal segment of it is a collection (nested and one-line blocks alike).
RULES_PATH_RE = re.compile(r"\bmatch\s+((?:/(?:[A-Za-z0-9_-]+|\{[^}/]+\}))+)\s*\{")
RULES_BLOCK_RE = re.compile(r"\bmatch\s+/([A-Za-z0-9_-]+)/\{[^}]*\}\s*\{")
# A relation name, optionally schema-qualified. `public.x` is `x`; any other schema keeps it (`client_private.judgment`
# is not the public `judgment`).
SQL_NAME = r'(?:"?([A-Za-z_][A-Za-z0-9_]*)"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?'
DDL_TABLE_RE = re.compile(r"CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?" + SQL_NAME, re.I)
# Views are relations too (FA-D5-003's research views, the corpus contract's v_* views): each is inventoried.
DDL_VIEW_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:RECURSIVE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?" + SQL_NAME,
    re.I,
)
# `SELECT ... INTO [TEMP|UNLOGGED] [TABLE] x FROM` creates a table, at top level of a .sql file (outside $$ bodies,
# where INTO names variables).
SELECT_INTO_RE = re.compile(r"\bSELECT\b[^;]*?\bINTO\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE\s+)?" + SQL_NAME + r"\s+FROM\b", re.I | re.S)
DOLLAR_BODY_RE = re.compile(r"\$([A-Za-z_]*)\$.*?\$\1\$", re.S)
PY_TABLENAME_RE = re.compile(r"__tablename__\s*=\s*[\"']([a-z_][a-z0-9_]*)[\"']")
PY_CREATE_TABLE_RE = re.compile(r"create_table\(\s*[\"']([a-z_][a-z0-9_]*)[\"']")


def _skipped(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    parts = rel.parts
    if set(parts) & SKIP_DIR_PARTS or (parts and parts[0] in SKIP_TOP_DIRS) or parts[:2] == ("functions", "lib"):
        return True
    name = path.name
    return (
        ".test." in name or ".spec." in name or name.endswith(".d.ts")
        or (path.suffix == ".py" and (name.startswith("test_") or name == "conftest.py"))
    )


def _source_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        rel = Path(dirpath).relative_to(root)
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIR_PARTS and not (rel == Path(".") and d in SKIP_TOP_DIRS) and (rel / d).parts[:2] != ("functions", "lib")
        )
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if path.suffix in SOURCE_SUFFIXES and path.is_file() and not _skipped(path, root):
                yield path


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def _argument(text: str, start: int) -> str:
    """The call argument that begins at `start`, up to its own top-level `,` or `)` (quotes and brackets respected)."""
    depth = 0
    i = start
    quote: str | None = None
    while i < len(text):
        c = text[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
            elif quote == "`" and c == "$" and text[i + 1:i + 2] == "{":
                # an interpolation: skip to its closing brace
                close = text.find("}", i)
                i = close if close != -1 else len(text)
        elif c in "\"'`":
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                break
            depth -= 1
        elif c == "," and depth == 0:
            break
        i += 1
    return text[start:i].strip()


class Constants:
    """String constants by name: each file's own, then the tree's exported ones (with `export { A as B }` aliases)."""

    def __init__(self, files: dict[str, str]):
        self.local: dict[str, dict[str, set[str]]] = {}
        self.exported: dict[str, set[str]] = {}
        aliases: list[tuple[str, str]] = []
        for rel, text in files.items():
            table: dict[str, set[str]] = {}
            for m in CONST_RE.finditer(text):
                value = next(v for v in m.groups()[1:] if v is not None)
                table.setdefault(m.group(1), set()).add(value)
                if re.search(r"export\s+const\s+" + re.escape(m.group(1)) + r"\b", text):
                    self.exported.setdefault(m.group(1), set()).add(value)
            self.local[rel] = table
            for block in REEXPORT_RE.findall(text):
                for item in block.split(","):
                    m = re.match(r"\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$", item)
                    if m:
                        aliases.append((m.group(1), m.group(2)))
        for _ in range(3):
            for src, dst in aliases:
                if src in self.exported:
                    self.exported.setdefault(dst, set()).update(self.exported[src])

    def resolve(self, rel: str, name: str) -> set[str]:
        name = name.split(".")[-1] if name.split(".")[0] in ("this",) else name
        found = self.local.get(rel, {}).get(name)
        return set(found) if found else set(self.exported.get(name, set()))


_DYNAMIC = object()


def _evaluate(arg: str, rel: str, consts: Constants) -> tuple[set[str], set[str]]:
    """The collection names an argument can be (`static`), and the static prefixes of the dynamic ones (`prefixes`)."""
    parts: list[str] = []
    depth = 0
    quote: str | None = None
    cur = ""
    for c in arg:
        if quote:
            cur += c
            if c == quote:
                quote = None
            continue
        if c in "\"'`":
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "+" and depth == 0:
            parts.append(cur.strip())
            cur = ""
        else:
            cur += c
    parts.append(cur.strip())
    # Each part is a set of possible strings, or dynamic (with what static text it starts with).
    values: list[set[str]] = [set()]
    prefix_only: str | None = None
    for part in parts:
        options: set[str] | object
        m = re.fullmatch(r"\"([^\"\\]*)\"|'([^'\\]*)'", part)
        if m:
            options = {m.group(1) if m.group(1) is not None else m.group(2)}
        elif part.startswith("`") and part.endswith("`") and len(part) >= 2:
            body = part[1:-1]
            if "${" in body:
                options = _DYNAMIC
                head = body.split("${", 1)[0]
                values = [{v + head for v in values[0]} or {head}]
            else:
                options = {body}
        elif re.fullmatch(r"[A-Za-z_$][\w$.]*", part):
            resolved = consts.resolve(rel, part)
            options = resolved if resolved else _DYNAMIC
        else:
            options = _DYNAMIC
        if options is _DYNAMIC:
            prefix_only = next(iter(values[0]), "") if values[0] else (prefix_only or "")
            break
        values = [{a + b for a in (values[0] or {""}) for b in options}]  # type: ignore[union-attr]
    if prefix_only is not None:
        return set(), {prefix_only} if prefix_only else set()
    return {v for v in values[0] if FS_NAME_RE.match(v)}, set()


def _code_texts(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): _read(p) for p in _source_files(root) if p.suffix != ".sql"}


def discover_firestore_code(root: Path, texts: dict[str, str] | None = None) -> tuple[dict[str, str], dict[str, str]]:
    """From code alone: collection name -> where; and dynamic-name static prefix -> where."""
    texts = texts if texts is not None else _code_texts(root)
    consts = Constants(texts)
    found: dict[str, str] = {}
    dynamic: dict[str, str] = {}
    for rel, text in texts.items():
        for name in NAMED_COLLECTION_RE.findall(text):
            found.setdefault(name, rel)
        for pattern in CALL_PATTERNS:
            for m in pattern.finditer(text):
                arg = _argument(text, m.end())
                if not arg:
                    continue
                names, prefixes = _evaluate(arg, rel, consts)
                for name in names:
                    found.setdefault(name, rel)
                if pattern is not HELPER_PATTERN:
                    for prefix in prefixes:
                        dynamic.setdefault(prefix, rel)
    return found, dynamic


def rules_collections(root: Path) -> dict[str, bool]:
    """Every collection a `firestore.rules` match path names -> whether every block naming it is server-only."""
    rules = root / "firestore.rules"
    if not rules.is_file():
        return {}
    text = rules.read_text(encoding="utf-8")
    out: dict[str, bool] = {}
    for m in RULES_PATH_RE.finditer(text):
        path = m.group(1)
        if path.startswith("/databases/"):
            continue  # the service root, `/databases/{database}/documents`
        for name in (s for s in path.split("/") if s and not s.startswith("{")):
            out.setdefault(name, True)
    # A top-level block is server-only when every allow in it is `if false`.
    for m in RULES_BLOCK_RE.finditer(text):
        name = m.group(1)
        if name == "databases":
            continue
        start, depth, j = m.end(), 1, m.end()
        while j < len(text) and depth > 0:
            depth += {"{": 1, "}": -1}.get(text[j], 0)
            j += 1
        body = re.sub(r"//[^\n]*", "", text[start:j - 1])
        conds = re.findall(r"allow\s+[a-z, ]+:\s*if\s+(.*?);", body, re.S)
        if any(" ".join(c.split()) != "false" for c in conds):
            out[name] = False
    return out


def discover_firestore(root: Path) -> dict[str, str]:
    """Collection name -> the first place it was found (for the failure message): rules and code."""
    found: dict[str, str] = {name: "firestore.rules" for name in rules_collections(root)}
    code, _dynamic = discover_firestore_code(root)
    for name, where in code.items():
        found.setdefault(name, where)
    return found


def discover_object_prefixes(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for rel, text in _code_texts(root).items():
        for pattern in OBJECT_SEGMENT_RES:
            for segment in pattern.findall(text):
                found.setdefault(segment, rel)
    return found


def _relation(schema: str | None, name: str) -> str:
    return name.lower() if schema is None or schema.lower() == "public" else f"{schema.lower()}.{name.lower()}"


def discover_postgres(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for path in _source_files(root):
        rel = path.relative_to(root).as_posix()
        text = _read(path)
        if path.suffix == ".sql":
            top = DOLLAR_BODY_RE.sub("", text)
            for pattern in (DDL_TABLE_RE, DDL_VIEW_RE, SELECT_INTO_RE):
                for schema, name in pattern.findall(top if pattern is SELECT_INTO_RE else text):
                    found.setdefault(_relation(schema or None, name), rel)
        elif path.suffix in (".py", ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"):
            # DDL in a string of code: a table or view it creates is a store like any other.
            for pattern in (DDL_TABLE_RE, DDL_VIEW_RE):
                for schema, name in pattern.findall(text):
                    found.setdefault(_relation(schema or None, name), rel)
            if path.suffix == ".py":
                for pattern in (PY_TABLENAME_RE, PY_CREATE_TABLE_RE):
                    for name in pattern.findall(text):
                        found.setdefault(name, rel)
    return found
# --- end of the R1-008 scan block ---


def load_json(root: Path, rel: str) -> dict:
    return json.loads((root / rel).read_text(encoding="utf-8"))


def _days(value: str) -> int | None:
    m = WEEKS_DAYS_RE.match(value.strip())
    if not m:
        return None
    n = int(m.group(1))
    return n * 7 if m.group(2) == "w" else n


def expected_backup_window(root: Path, name: str) -> int | None:
    """The longest retention of the F33 backup set `name`, in days, from infra/backup (None when unknown)."""
    try:
        if name == "firestore":
            cfg = load_json(root, "infra/backup/firestore-backup.json")
            sched = _days(str(cfg["schedule"]["retention"]))
            export = int(cfg["exportBucket"]["retentionDays"])
            return max(d for d in (sched, export, 7) if d is not None)
        if name == "postgres":
            return int(load_json(root, "infra/backup/postgres-backup.json")["baseBackupRetentionDays"])
    except (OSError, KeyError, ValueError, TypeError):
        return None
    return None


def _reason_codes(value: object) -> bool:
    """A closed list of reason codes: non-empty, each code-shaped, no duplicate (spec R25, FA-F42-R1-005)."""
    return (isinstance(value, list) and bool(value) and all(isinstance(c, str) and REASON_CODE_RE.match(c) for c in value)
            and len(set(value)) == len(value))


def check_policy(policy: dict) -> list[Finding]:
    out: list[Finding] = []
    if not isinstance(policy.get("policyVersion"), str) or not policy["policyVersion"]:
        out.append(_fail("policy", "policyVersion must be a non-empty string"))
    if policy.get("ratifiedBy") is None and "PROPOSED" not in str(policy.get("status", "")):
        out.append(_fail("policy", "an unratified policy must say PROPOSED in status"))
    deletion = policy.get("deletion")
    if not isinstance(deletion, dict):
        out.append(_fail("policy", "deletion settings missing"))
    else:
        # approverMinTenureDays: FA-F42-R1-006 (spec R26), as validatePolicy.
        for field in ("approvalWindowHours", "ackDeadlineHours", "maxMembersRevokedAtApproval", "storesPerPurgeJob", "approverMinTenureDays"):
            value = deletion.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                out.append(_fail("policy", f"deletion.{field} must be a positive integer"))
        if not _reason_codes(deletion.get("reasonCodes")):
            out.append(_fail("policy", "deletion.reasonCodes must be a closed, non-empty list of distinct codes"))
    hold = policy.get("legalHold")
    if not isinstance(hold, dict) or not _reason_codes(hold.get("reasonCodes")):
        out.append(_fail("policy", "legalHold.reasonCodes must be a closed, non-empty list of distinct codes"))
    classes = policy.get("classes")
    if not isinstance(classes, dict) or not classes:
        return out + [_fail("policy", "classes missing")]
    for name, cls in classes.items():
        if not isinstance(cls, dict):
            out.append(_fail("policy", f"class {name} is not an object"))
            continue
        if cls.get("onMatterDeletion") not in ACTIONS:
            out.append(_fail("policy", f"class {name}: onMatterDeletion must be one of {sorted(ACTIONS)}"))
        if not isinstance(cls.get("legalHold"), bool):
            out.append(_fail("policy", f"class {name}: legalHold must be true or false"))
        period = cls.get("periodDays")
        if period is not None and (not isinstance(period, int) or isinstance(period, bool) or period <= 0):
            out.append(_fail("policy", f"class {name}: periodDays must be null or a positive integer"))
        if cls.get("periodicAction") not in PERIODIC_ACTIONS:
            out.append(_fail("policy", f"class {name}: periodicAction must be one of {sorted(PERIODIC_ACTIONS)}"))
        if period is None and cls.get("periodicAction") != "retain":
            out.append(_fail("policy", f"class {name}: a periodic deletion needs periodDays"))
        if not isinstance(cls.get("basis"), str) or not cls["basis"]:
            out.append(_fail("policy", f"class {name}: basis is required"))
        if cls.get("periodBasis") not in PERIOD_BASES:
            out.append(_fail("policy", f"class {name}: periodBasis must be one of {sorted(PERIOD_BASES)}"))
        elif period is not None and cls.get("periodicAction") in ("purge", "anonymise") and cls["periodBasis"] == "matter_closure":
            out.append(_fail("policy", f"class {name}: a deleting period aged from matter closure is not built (FU-8); it cannot be adopted"))
    return out


def check_inventory(root: Path, inventory: dict, policy: dict) -> list[Finding]:
    out: list[Finding] = []
    if inventory.get("inventoryVersion") != 1:
        out.append(_fail("inventory", "inventoryVersion must be 1"))
    classes = policy.get("classes") if isinstance(policy.get("classes"), dict) else {}
    profiles = inventory.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        return out + [_fail("inventory", "profiles missing")]
    for pid, profile in profiles.items():
        for field in PROFILE_FIELDS:
            if not isinstance(profile.get(field), str) or not profile[field].strip():
                out.append(_fail("inventory", f"profile {pid}: {field} is required"))
        if profile.get("retentionClass") not in classes:
            out.append(_fail("inventory", f"profile {pid}: unknown retention class {profile.get('retentionClass')}"))
    stores = inventory.get("stores")
    if not isinstance(stores, list) or not stores:
        return out + [_fail("inventory", "stores missing")]
    ids: set[str] = set()
    keys: set[str] = set()
    by_id = {s.get("id"): s for s in stores if isinstance(s, dict)}
    for store in stores:
        if not isinstance(store, dict):
            out.append(_fail("inventory", "a store entry is not an object"))
            continue
        sid, kind, name = store.get("id"), store.get("kind"), store.get("name")
        label = sid if isinstance(sid, str) else repr(sid)
        if kind not in STORE_KINDS:
            out.append(_fail("inventory", f"{label}: unknown kind {kind}"))
            continue
        name_ok = isinstance(name, str) and (SEGMENT_RE.match(name) if kind == "objectPrefix" else NAME_RES.get(kind, NAME_RE).match(name))
        if not name_ok:
            out.append(_fail("inventory", f"{label}: bad name"))
            continue
        if sid != f"{ID_PREFIX[kind]}:{name}":
            out.append(_fail("inventory", f"{label}: id must be {ID_PREFIX[kind]}:{name}"))
        if sid in ids:
            out.append(_fail("inventory", f"{label}: duplicate store"))
        ids.add(sid)
        skey = store_key(str(sid))
        if skey in keys:
            out.append(_fail("inventory", f"{label}: store key {skey} collides"))
        keys.add(skey)
        profile = profiles.get(store.get("profile"))
        if profile is None:
            out.append(_fail("inventory", f"{label}: unknown profile {store.get('profile')}"))
        key = store.get("key")
        if not isinstance(key, dict) or key.get("kind") not in KEY_KINDS[kind]:
            out.append(_fail("inventory", f"{label}: key.kind must be one of {sorted(KEY_KINDS[kind])}"))
            continue
        kk = key["kind"]
        if kk == "field" and not (isinstance(key.get("field"), str) and re.match(r"^[A-Za-z][A-Za-z0-9_.]*$", key["field"])):
            out.append(_fail("inventory", f"{label}: key.field is required"))
        if kk == "ttl" and not (isinstance(key.get("windowHours"), int) and key["windowHours"] > 0):
            out.append(_fail("inventory", f"{label}: key.windowHours must be a positive integer"))
        if kk == "objects":
            via = by_id.get(key.get("via"))
            if not via or via.get("kind") != "firestore" or not isinstance(key.get("pathField"), str):
                out.append(_fail("inventory", f"{label}: key.via must name a firestore store and key.pathField a field"))
        if kk == "traceExport":
            sources = key.get("sources")
            if not isinstance(sources, list) or not sources:
                out.append(_fail("inventory", f"{label}: key.sources must list at least one source"))
                sources = []
            for i, ts in enumerate(sources):
                ts = ts if isinstance(ts, dict) else {}
                src = by_id.get(ts.get("source"))
                # The saga finds the copies by the matter: the source must be a field-keyed Firestore store.
                if not src or src.get("kind") != "firestore" or (src.get("key") or {}).get("kind") != "field":
                    out.append(_fail("inventory", f"{label}: key.sources[{i}].source must name a field-keyed firestore store"))
                for field in ("idField", "statusField"):
                    if not isinstance(ts.get(field), str) or not ts[field]:
                        out.append(_fail("inventory", f"{label}: key.sources[{i}].{field} is required"))
                values = ts.get("exportedValues")
                if not isinstance(values, list) or not values or not all(isinstance(v, str) and v for v in values):
                    out.append(_fail("inventory", f"{label}: key.sources[{i}].exportedValues must list the exported states"))
        if kk == "backup":
            window = key.get("windowDays")
            if not (isinstance(window, int) and window > 0):
                out.append(_fail("inventory", f"{label}: key.windowDays must be a positive integer"))
            elif not isinstance(key.get("config"), str) or not (root / key["config"]).is_file():
                out.append(_fail("inventory", f"{label}: key.config must name an infra/backup file"))
            else:
                expected = expected_backup_window(root, name)
                if expected is not None and expected != window:
                    out.append(_fail("inventory", f"{label}: windowDays {window} disagrees with {key['config']} ({expected})"))
        anonymise = store.get("anonymise")
        if anonymise is not None and (not isinstance(anonymise, dict) or not anonymise
                                      or any(not isinstance(v, (str, int, float, type(None))) or isinstance(v, bool) for v in anonymise.values())):
            out.append(_fail("inventory", f"{label}: anonymise must map fields to null, a string or a number"))
        elif isinstance(anonymise, dict) and kk == "field" and anonymise.get(key.get("field"), "absent") is not None:
            out.append(_fail("inventory", f"{label}: anonymise must set the key field {key.get('field')} to null"))
        age = store.get("ageField")
        if age is not None and (not isinstance(age, dict) or not isinstance(age.get("field"), str) or age.get("type") not in ("timestamp", "millis")):
            out.append(_fail("inventory", f"{label}: ageField must be {{field, type: timestamp|millis}}"))
        pending = store.get("pending")
        if pending is not None and not (isinstance(pending, str) and PENDING_RE.match(pending)):
            out.append(_fail("inventory", f"{label}: pending must name a finding (F34, ...)"))
        if profile is not None and kk in ("docId", "field"):
            cls = classes.get(profile.get("retentionClass"), {})
            if "anonymise" in (cls.get("onMatterDeletion"), cls.get("periodicAction")) and anonymise is None:
                out.append(_fail("inventory", f"{label}: its class may anonymise, so anonymise fields are required"))
        # FA-F42-R1-011 (spec R31): a deleting period covers every store of its class, or it is not adoptable. Only a
        # Firestore store keyed by matter (doc id or field) with an ageField is aged by retention.apply (as validatePolicy).
        if profile is not None:
            cls = classes.get(profile.get("retentionClass"), {})
            ageable = kind == "firestore" and kk in ("docId", "field") and store.get("ageField") is not None
            if cls.get("periodDays") is not None and cls.get("periodicAction") in ("purge", "anonymise") and not ageable:
                out.append(_fail("inventory", f"{label}: its class {profile.get('retentionClass')} has a deleting period, "
                                              "which retention.apply can age only in a Firestore store keyed by matter with an ageField"))
    return out


def check_coverage(root: Path, inventory: dict) -> tuple[list[Finding], list[str]]:
    out: list[Finding] = []
    notes: list[str] = []
    stores = [s for s in inventory.get("stores", []) if isinstance(s, dict)]
    inv = {kind: {s.get("name"): s for s in stores if s.get("kind") == kind} for kind in STORE_KINDS}
    rules = rules_collections(root)
    code, dynamic = discover_firestore_code(root)
    firestore = {name: "firestore.rules" for name in rules}
    for name, where in code.items():
        firestore.setdefault(name, where)
    scans = {
        "firestore": firestore,
        "objectPrefix": discover_object_prefixes(root),
        "postgres": discover_postgres(root),
    }
    # A name built at run time (`audit_plant_${k}`): its static prefix must begin an inventoried collection.
    for prefix, where in sorted(dynamic.items()):
        if not any(isinstance(n, str) and n.startswith(prefix) for n in inv["firestore"]):
            out.append(_fail("coverage", f"dynamic Firestore collection name {prefix}... (found in {where}): no inventoried collection begins with it; name it in {INVENTORY}"))
    # A server-only collection needs no rules block (default deny), so the code scan alone must see it; one that only
    # its server-only rules block reveals is named in code in a form the scan cannot read.
    for name in sorted(n for n, server_only in rules.items() if server_only and n not in code):
        out.append(_fail("coverage", f"server-only Firestore collection {name} is found only through its firestore.rules block: the code scan cannot see how the code names it"))
    what = {"firestore": "Firestore collection", "objectPrefix": "object key prefix", "postgres": "Postgres table"}
    for kind, found in scans.items():
        for name, where in sorted(found.items()):
            if name not in inv[kind]:
                out.append(_fail("coverage", f"uninventoried {what[kind]} {name} (found in {where}); add it to {INVENTORY}"))
        for name, store in sorted(inv[kind].items()):
            pending = store.get("pending")
            if name in found:
                if pending:
                    notes.append(f"NOTE: {kind}:{name} is pending on {pending} and is now in the tree; drop the pending flag")
                continue
            if not pending:
                out.append(_fail("coverage", f"stale inventory entry {kind}:{name}: no rule, code or DDL names it"))
    return out, notes


# The run-time check (FA-F42-R1-008, spec R28): after the Functions emulator suite (`npm --prefix functions run
# test:emu`), every root collection in the emulator must be inventoried, so a store the static scan cannot read (a name
# built at run time, a helper's argument) still fails CI once a test writes it. These are the suite's own fixture
# collections, written only by tests (functions/test/jobs.ts and the P2 suites), never by the product.
RUNTIME_TEST_COLLECTIONS: tuple[str, ...] = ()


def list_emulator_collections(host: str, project: str) -> list[str]:
    """The root collection ids of the Firestore emulator at `host` for `project` (every page)."""
    url = f"http://{host}/v1/projects/{project}/databases/(default)/documents:listCollectionIds"
    ids: list[str] = []
    token: str | None = None
    while True:
        body = json.dumps({"pageSize": 300, **({"pageToken": token} if token else {})}).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer owner"})
        with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - the local emulator only
            out = json.loads(resp.read().decode("utf-8"))
        ids.extend(out.get("collectionIds", []))
        token = out.get("nextPageToken")
        if not token:
            return ids


def check_runtime_collections(names: list[str], inventory: dict) -> list[Finding]:
    inv = {s.get("name") for s in inventory.get("stores", []) if isinstance(s, dict) and s.get("kind") == "firestore"}
    allowed = set(RUNTIME_TEST_COLLECTIONS)
    return [
        _fail("runtime", f"run-time: Firestore collection {name} exists after the emulator suite but is not inventoried; add it to {INVENTORY}")
        for name in sorted(set(names))
        if name not in inv and name not in allowed
    ]


def run(root: Path) -> tuple[list[Finding], list[str]]:
    try:
        inventory = load_json(root, INVENTORY)
        policy = load_json(root, POLICY)
    except (OSError, json.JSONDecodeError) as err:
        return [_fail("load", f"cannot read the inventory or policy: {err}")], []
    findings = check_policy(policy) + check_inventory(root, inventory, policy)
    coverage, notes = check_coverage(root, inventory)
    return findings + coverage, notes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--runtime", action="store_true", help="also compare the Firestore emulator's root collections (FIRESTORE_EMULATOR_HOST, GCLOUD_PROJECT) with the inventory")
    args = parser.parse_args(argv)
    findings, notes = run(Path(args.root))
    if args.runtime:
        host, project = os.environ.get("FIRESTORE_EMULATOR_HOST"), os.environ.get("GCLOUD_PROJECT")
        if not host or not project:
            findings.append(_fail("runtime", "the run-time check needs FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT (run it inside firebase emulators:exec)"))
        else:
            try:
                names = list_emulator_collections(host, project)
            except OSError as err:
                findings.append(_fail("runtime", f"cannot list the emulator's collections: {err}"))
            else:
                findings.extend(check_runtime_collections(names, load_json(Path(args.root), INVENTORY)))
                print(f"data-inventory gate: run-time check read {len(names)} root collections from {host} ({project})")
    for note in notes:
        print(note)
    for f in findings:
        print(f"FAIL [{f.check}] {f.message}")
    if findings:
        print(f"data-inventory gate: FAIL ({len(findings)} finding(s))")
        return 1
    inventory = load_json(Path(args.root), INVENTORY)
    print(f"data-inventory gate: PASS ({len(inventory['stores'])} stores inventoried)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
