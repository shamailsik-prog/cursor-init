#!/usr/bin/env python3
"""Data inventory gate (audit F42): every store that can hold matter or client data is inventoried.

The inventory (`infra/retention/inventory.json`) names every Firestore collection, object-key prefix, Postgres
table, external processor and backup set, each with a profile (classification, retention class, who may delete,
how deletion is acknowledged) and a key (how a matter's rows are found). The retention policy
(`infra/retention/policy.json`) defines the retention classes.

This gate fails when:
  1. a Firestore collection is in the tree but not inventoried. A collection is "in the tree" when a
     `firestore.rules` match block names it, or when TypeScript outside tests names it in a collection literal:
     `.collection("x")`, `collectionGroup("x")`, `collection(db, "x")`, `doc(db, "x", ...)`, a helper call
     `(db, "x"`, or a `...COLLECTION = "x"` constant;
  2. an object key segment `${firmId}/<segment>/` in TypeScript outside tests is not an inventoried object prefix;
  3. a Postgres table (`CREATE TABLE` in postgres/ddl/*.sql; `__tablename__` or `create_table("x")` in
     corpus_service outside tests) is not inventoried;
  4. an inventory entry is malformed, duplicated, names an unknown profile, retention class or store, or is stale
     (found by none of the scans above) without a `pending` finding;
  5. the policy is malformed (unknown action, a non-boolean hold, a bad period), a class that may anonymise has a
     matter-keyed store with no `anonymise` fields, or a backup window disagrees with infra/backup.

A `pending` entry (a store another finding is adding, e.g. F34's `p1_decisions`) passes whether or not it is in the
tree yet; once it lands the gate prints a note to drop the flag.

Usage: python3 ci_gates/check_data_inventory.py [--root DIR]. Exit 0 PASS, 1 FAIL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
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
PROFILE_FIELDS = ("classification", "retentionClass", "deleter", "acknowledgement")
NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SEGMENT_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
PENDING_RE = re.compile(r"^F\d{2,3}$")

# TypeScript roots scanned for collection literals and object key segments (tests excluded).
TS_ROOTS = ("functions/src", "platform", "services", "app", "lib", "scripts", "ops", "core", "agent")
SKIP_DIR_PARTS = {"node_modules", "test", "tests", "__tests__", ".stryker-tmp", ".next", "reports", "coverage"}
COLLECTION_PATTERNS = (
    re.compile(r"\.collection\(\s*[\"']([a-z][a-z0-9_]*)[\"']"),
    re.compile(r"\bcollectionGroup\(\s*[\"']([a-z][a-z0-9_]*)[\"']"),
    re.compile(r"\(\s*db\s*,\s*[\"']([a-z][a-z0-9_]*)[\"']"),
    re.compile(r"COLLECTION\s*=\s*[\"']([a-z][a-z0-9_]*)[\"']"),
)
OBJECT_SEGMENT_RE = re.compile(r"\$\{firmId\}/([a-z][a-z0-9_-]*)/")
RULES_MATCH_RE = re.compile(r"^\s*match /([a-z][a-z0-9_]*)/\{", re.M)
DDL_TABLE_RE = re.compile(r"CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\"?([a-z_][a-z0-9_]*)\"?", re.I)
PY_TABLENAME_RE = re.compile(r"__tablename__\s*=\s*[\"']([a-z_][a-z0-9_]*)[\"']")
PY_CREATE_TABLE_RE = re.compile(r"create_table\(\s*[\"']([a-z_][a-z0-9_]*)[\"']")
WEEKS_DAYS_RE = re.compile(r"^(\d+)([dw])$")


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


def _skipped(path: Path, root: Path) -> bool:
    parts = set(path.relative_to(root).parts)
    if parts & SKIP_DIR_PARTS:
        return True
    name = path.name
    return name.endswith((".test.ts", ".test.tsx", ".spec.ts")) or name.endswith(".d.ts")


def _ts_files(root: Path):
    for base in TS_ROOTS:
        top = root / base
        if not top.is_dir():
            continue
        for path in sorted(top.rglob("*")):
            if path.suffix in (".ts", ".tsx", ".mts", ".mjs") and path.is_file() and not _skipped(path, root):
                # functions/lib is the build output, never source.
                if path.relative_to(root).parts[:2] == ("functions", "lib"):
                    continue
                yield path


def discover_firestore(root: Path) -> dict[str, str]:
    """Collection name -> the first place it was found (for the failure message)."""
    found: dict[str, str] = {}
    rules = root / "firestore.rules"
    if rules.is_file():
        for name in RULES_MATCH_RE.findall(rules.read_text(encoding="utf-8")):
            if name != "databases":
                found.setdefault(name, "firestore.rules")
    for path in _ts_files(root):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for pattern in COLLECTION_PATTERNS:
            for name in pattern.findall(text):
                found.setdefault(name, path.relative_to(root).as_posix())
    return found


def discover_object_prefixes(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for path in _ts_files(root):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for segment in OBJECT_SEGMENT_RE.findall(text):
            found.setdefault(segment, path.relative_to(root).as_posix())
    return found


def discover_postgres(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    ddl = root / "postgres/ddl"
    if ddl.is_dir():
        for path in sorted(ddl.glob("*.sql")):
            for name in DDL_TABLE_RE.findall(path.read_text(encoding="utf-8")):
                found.setdefault(name.lower(), path.relative_to(root).as_posix())
    corpus = root / "corpus_service"
    if corpus.is_dir():
        for path in sorted(corpus.rglob("*.py")):
            if _skipped(path, root) or path.name.startswith("test_"):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for pattern in (PY_TABLENAME_RE, PY_CREATE_TABLE_RE):
                for name in pattern.findall(text):
                    found.setdefault(name, path.relative_to(root).as_posix())
    return found


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
        for field in ("approvalWindowHours", "ackDeadlineHours", "maxMembersRevokedAtApproval", "storesPerPurgeJob"):
            value = deletion.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                out.append(_fail("policy", f"deletion.{field} must be a positive integer"))
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
        name_ok = isinstance(name, str) and (SEGMENT_RE.match(name) if kind == "objectPrefix" else NAME_RE.match(name))
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
    return out


def check_coverage(root: Path, inventory: dict) -> tuple[list[Finding], list[str]]:
    out: list[Finding] = []
    notes: list[str] = []
    stores = [s for s in inventory.get("stores", []) if isinstance(s, dict)]
    inv = {kind: {s.get("name"): s for s in stores if s.get("kind") == kind} for kind in STORE_KINDS}
    scans = {
        "firestore": discover_firestore(root),
        "objectPrefix": discover_object_prefixes(root),
        "postgres": discover_postgres(root),
    }
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
    args = parser.parse_args(argv)
    findings, notes = run(Path(args.root))
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
