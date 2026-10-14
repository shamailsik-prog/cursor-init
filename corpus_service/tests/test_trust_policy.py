"""Audit F20: the corpus trust vocabulary fails closed (pure unit tests, no database).

FINAL_CORPUS_SERVICE_PROMPT_2.md :252-253 fixes the vocabulary as trusted | review | blocked with
default review, and :894-898 the promotion rule: only a trusted source with confidence >= 0.5 is
auto-promoted, review is always quarantined, blocked is never harvested. Anything outside the
vocabulary (None, '', a legacy value, a different case) is unknown and must never publish.
"""

import ast
import re
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper import trust  # noqa: E402
from scraper.trust import (  # noqa: E402
    DEFAULT_TRUST_LEVEL,
    PROMOTION_MIN_CONFIDENCE,
    TRUST_LEVELS,
    PublicationDecision,
    may_harvest,
    normalise_legacy_trust,
    publication_decision,
    trust_check_sql,
)


class VocabularyTests(unittest.TestCase):
    def test_vocabulary_is_exactly_the_spec_set(self):
        self.assertEqual(TRUST_LEVELS, ("trusted", "review", "blocked"))

    def test_default_is_review(self):
        self.assertEqual(DEFAULT_TRUST_LEVEL, "review")
        self.assertIn(DEFAULT_TRUST_LEVEL, TRUST_LEVELS)

    def test_promotion_threshold(self):
        self.assertEqual(PROMOTION_MIN_CONFIDENCE, 0.5)

    def test_check_sql_is_built_from_the_vocabulary(self):
        self.assertEqual(trust_check_sql(), "trust_level IN ('trusted','review','blocked')")

    def test_decision_is_immutable(self):
        decision = publication_decision("trusted", 0.9)
        with self.assertRaises(Exception):
            decision.promote = False  # type: ignore[misc]


class PublicationDecisionTests(unittest.TestCase):
    CASES = [
        # (trust_raw, confidence, promote, reason)
        ("trusted", 0.5, True, None),
        ("trusted", 1.0, True, None),
        ("trusted", 0.49, False, "low_confidence"),
        ("trusted", 0.0, False, "low_confidence"),
        ("trusted", None, False, "low_confidence"),
        ("review", 0.99, False, "review_source"),
        ("review", None, False, "review_source"),
        ("blocked", 0.99, False, "blocked_source"),
        (None, 0.99, False, "unknown_source"),
        ("", 0.99, False, "unknown_source"),
        ("semi_trusted", 0.99, False, "unknown_source"),
        ("untrusted", 0.99, False, "unknown_source"),
        ("quarantined", 0.99, False, "unknown_source"),
        # Matching is exact: case and whitespace are not normalised.
        ("TRUSTED", 0.99, False, "unknown_source"),
        ("Trusted", 0.99, False, "unknown_source"),
        (" trusted", 0.99, False, "unknown_source"),
        ("trusted ", 0.99, False, "unknown_source"),
        ("Review", 0.99, False, "unknown_source"),
    ]

    def test_every_branch_of_the_promotion_rule(self):
        for trust_raw, confidence, promote, reason in self.CASES:
            with self.subTest(trust=trust_raw, confidence=confidence):
                decision = publication_decision(trust_raw, confidence)
                self.assertIsInstance(decision, PublicationDecision)
                self.assertEqual(decision.promote, promote)
                self.assertEqual(decision.reason, reason)

    def test_non_string_trust_is_unknown(self):
        for raw in (1, True, b"trusted", ["trusted"]):
            with self.subTest(raw=raw):
                self.assertEqual(publication_decision(raw, 0.99).reason, "unknown_source")  # type: ignore[arg-type]

    def test_unusable_confidence_never_promotes(self):
        for confidence in (float("nan"), float("-inf"), "0.9", -0.1, True):
            with self.subTest(confidence=confidence):
                decision = publication_decision("trusted", confidence)  # type: ignore[arg-type]
                self.assertFalse(decision.promote)
                self.assertEqual(decision.reason, "low_confidence")

    def test_a_promote_decision_carries_no_reason_and_a_quarantine_always_does(self):
        for trust_raw, confidence, _promote, _reason in self.CASES:
            decision = publication_decision(trust_raw, confidence)
            with self.subTest(trust=trust_raw, confidence=confidence):
                self.assertEqual(decision.reason is None, decision.promote)


class MayHarvestTests(unittest.TestCase):
    def test_trusted_and_review_may_be_harvested(self):
        self.assertTrue(may_harvest("trusted"))
        self.assertTrue(may_harvest("review"))

    def test_blocked_and_unknown_may_not(self):
        for raw in ("blocked", None, "", "x", "semi_trusted", "untrusted", "quarantined", "TRUSTED", " review"):
            with self.subTest(raw=raw):
                self.assertFalse(may_harvest(raw))


class LegacyMappingTests(unittest.TestCase):
    def test_legacy_values_become_review(self):
        for legacy in ("semi_trusted", "untrusted", "quarantined"):
            with self.subTest(legacy=legacy):
                self.assertEqual(normalise_legacy_trust(legacy), "review")

    def test_current_values_are_kept(self):
        for level in TRUST_LEVELS:
            with self.subTest(level=level):
                self.assertEqual(normalise_legacy_trust(level), level)

    def test_anything_else_becomes_review(self):
        for raw in (None, "", "TRUSTED", " trusted", "x", "Blocked"):
            with self.subTest(raw=raw):
                self.assertEqual(normalise_legacy_trust(raw), "review")

    def test_result_is_always_in_the_vocabulary(self):
        for raw in (None, "", "trusted", "review", "blocked", "semi_trusted", "untrusted", "quarantined", "zzz"):
            with self.subTest(raw=raw):
                self.assertIn(normalise_legacy_trust(raw), TRUST_LEVELS)


class ModuleSurfaceTests(unittest.TestCase):
    def test_reasons_are_the_documented_set(self):
        self.assertEqual(
            set(trust.QUARANTINE_REASONS),
            {"review_source", "low_confidence", "blocked_source", "unknown_source", "citation_missing"},
        )
        # Round-2 L3: a promotable duplicate is attached (FINAL_2 DEDUPLICATION), never queued.
        self.assertFalse(hasattr(trust, "REASON_DUPLICATE_CITATION"))

    def test_a_record_that_raises_gets_a_class_only_reason(self):
        class ExplodingRowError(Exception):
            pass

        reason = trust.promotion_error_reason(ExplodingRowError("row data 2099 X 1"))
        self.assertEqual(reason, "promotion_error:ExplodingRowError")
        self.assertNotIn("2099", reason)


class MayPublishDirectlyTests(unittest.TestCase):
    """FINAL_2 :897 (review -> always quarantine): a harvester that writes a master table itself
    bypasses promotion, so only a trusted source may run it."""

    def test_only_trusted_may_publish_without_promotion(self):
        from scraper.trust import may_publish_directly

        self.assertTrue(may_publish_directly("trusted"))
        for raw in ("review", "blocked", None, "", "TRUSTED", " trusted", "semi_trusted", 1, True):
            with self.subTest(raw=raw):
                self.assertFalse(may_publish_directly(raw))


class SourceStampTests(unittest.TestCase):
    """Harvesters stamp the scraper_sources row a staged record came from (audit F20 MEDIUM-1)."""

    class _Source:
        def __init__(self, source_id, name):
            self.id = source_id
            self.source_name = name

    def test_stamp_adds_id_and_name_and_overrides_conflicting_keys(self):
        import uuid

        from scraper.source_identity import stamp_metadata

        sid = uuid.uuid4()
        given = {"listing_url": "https://f20.example.invalid/l", "source_name": "Spoofed", "source_id": "x"}
        stamped = stamp_metadata(self._Source(sid, "SupremeCourtPublic"), given)
        self.assertEqual(
            stamped,
            {"listing_url": "https://f20.example.invalid/l", "source_id": str(sid), "source_name": "SupremeCourtPublic"},
        )
        self.assertEqual(given["source_name"], "Spoofed", "the caller's dict must not be modified")
        self.assertEqual(stamp_metadata(self._Source(sid, "NasirLawSite")),
                         {"source_id": str(sid), "source_name": "NasirLawSite"})


class TransientDatabaseErrorTests(unittest.TestCase):
    """Round-2 L2: what promotion treats as transient (leave the record pending) rather than the
    record's own fault (quarantine it as promotion_error)."""

    class _Orig(Exception):
        def __init__(self, sqlstate=None):
            super().__init__("driver error")
            if sqlstate is not None:
                self.sqlstate = sqlstate

    def _err(self, sqlstate=None, invalidated=False, nested=False):
        from sqlalchemy.exc import DBAPIError

        orig = self._Orig(None if nested else sqlstate)
        if nested:  # SQLAlchemy's asyncpg adapter: the SQLSTATE sits on the driver exception it wraps
            orig.__cause__ = self._Orig(sqlstate)
        return DBAPIError("SELECT 1", {}, orig, connection_invalidated=invalidated)

    def test_transient_and_permanent_errors(self):
        from scraper.tasks.promotion import is_transient_db_error

        transient = ["08000", "08003", "08006", "08P01", "40001", "40P01", "53000", "53100", "53200", "53300",
                     "57014", "57P01", "57P03", "55P03"]
        permanent = ["23505", "23514", "22001", "42501", "42P01", "55000", "55006", "XX000", "P0001", None]
        wrong = {s for s in transient if not is_transient_db_error(self._err(s))}
        wrong |= {s for s in transient if not is_transient_db_error(self._err(s, nested=True))}
        wrong |= {s for s in permanent if is_transient_db_error(self._err(s))}
        self.assertEqual(wrong, set())
        self.assertTrue(is_transient_db_error(self._err(None, invalidated=True)), "an invalidated connection")
        for exc in (RuntimeError("x"), ValueError("40001"), LookupError()):
            self.assertFalse(is_transient_db_error(exc), exc)


TASKS_DIR = PROJECT_ROOT / "scraper" / "tasks"

# ---------------------------------------------------------------------------------------------
# Master-table write scan (round-2 L1, round-3 LOW-A/B6). Reviewed allowlists: a module here may
# touch case_law_master / statutes_master without being a `direct` dispatcher route.
# ---------------------------------------------------------------------------------------------
MASTER_WRITER_ALLOWLIST = {
    # The promotion step itself: the F20 trust decision runs before every master write.
    "scraper.tasks.promotion": "promotion (F20 trust decision)",
    # Manual reviewer promotion endpoint; audit F23, deliberately out of scope for F20.
    "scraper.routers.quarantine": "manual quarantine promotion (F23)",
}
# Updaters only: they change rows already in a master table by assigning attributes on instances
# they loaded, which the scan does not count as a write. Their scanned `writes` must stay empty, so
# a new insert, instantiation, update()/delete() or write SQL in one of them fails the test (round-3
# LOW-A, re-audit mutant B8) instead of riding on the module's allowlist entry.
MASTER_UPDATER_ALLOWLIST = {
    # Writes embedding vectors onto rows that are already in a master table.
    "scraper.tasks.embeddings": "embedding vectors on existing master rows",
    # Updates citation_count / is_landmark on rows that are already in case_law_master.
    "scraper.tasks.cross_reference": "citation counts on existing master rows",
}
MASTER_READ_ONLY_ALLOWLIST = {
    "scraper.main": "/health counts case_law_master rows",
    "scraper.routers.search": "read-only search",
    "scraper.routers.export": "read-only export",
}

MASTER_CLASSES = {"scraper.models.CaseLawMaster", "scraper.models.StatutesMaster"}
MASTER_TABLES = ("case_law_master", "statutes_master")
_IDENT = r'(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)'
_MASTER_TABLE_RE = r'"?(?:case_law_master|statutes_master)"?'
_SQL_WRITE_RE = re.compile(
    r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY|ALTER\s+TABLE|DROP\s+TABLE)"
    rf"\s+(?:ONLY\s+)?(?:{_IDENT}\s*\.\s*)?{_MASTER_TABLE_RE}(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_TABLE_NAME_RE = re.compile(rf"^\s*(?:{_IDENT}\s*\.\s*)?{_MASTER_TABLE_RE}\s*$")


def _import_aliases(tree, module):
    """Every name a module binds by import (at any depth), mapped to its dotted target."""
    package = module.split(".")[:-1]
    aliases = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for name in node.names:
                if name.asname:
                    aliases[name.asname] = name.name
                else:
                    aliases[name.name.split(".")[0]] = name.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parent = package[: len(package) - (node.level - 1)] if node.level > 1 else package
                base = ".".join(parent + ([node.module] if node.module else []))
            for name in node.names:
                if name.name == "*":
                    if base == "scraper.models":
                        for cls in MASTER_CLASSES:
                            aliases[cls.rsplit(".", 1)[1]] = cls
                    continue
                aliases[name.asname or name.name] = f"{base}.{name.name}"
    return aliases


def _dotted(node, aliases):
    if isinstance(node, ast.Name):
        return aliases.get(node.id)
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value, aliases)
        return f"{base}.{node.attr}" if base else None
    return None


def scan_source_for_master_tables(source, module):
    """{'refs': ..., 'writes': ...} for one module's source: references to a master ORM class or
    table name, and the subset that are writes (instantiation, insert/update/delete(...),
    .__table__.insert/update/delete(), SQL write text, a lightweight table('...') construct)."""
    tree = ast.parse(source)
    aliases = _import_aliases(tree, module)
    refs, writes = set(), set()

    def is_master(expr):
        return _dotted(expr, aliases) in MASTER_CLASSES or (
            isinstance(expr, ast.Constant) and isinstance(expr.value, str) and bool(_TABLE_NAME_RE.match(expr.value))
        )

    for node in ast.walk(tree):
        if isinstance(node, (ast.Name, ast.Attribute)) and _dotted(node, aliases) in MASTER_CLASSES:
            refs.add(f"class {_dotted(node, aliases)} line {node.lineno}")
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in ("CaseLawMaster", "StatutesMaster") or _TABLE_NAME_RE.match(node.value):
                refs.add(f"name {node.value!r} line {node.lineno}")
            if _SQL_WRITE_RE.search(node.value):
                refs.add(f"sql line {node.lineno}")
                writes.add(f"sql line {node.lineno}")
        if isinstance(node, ast.Call):
            func = node.func
            if _dotted(func, aliases) in MASTER_CLASSES:
                writes.add(f"instantiation line {node.lineno}")
            fname = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            target = (_dotted(func, aliases) or fname).rsplit(".", 1)[-1]
            if target in ("insert", "update", "delete", "table", "Table") and node.args and is_master(node.args[0]):
                writes.add(f"{target}() line {node.lineno}")
            if (isinstance(func, ast.Attribute) and func.attr in ("insert", "update", "delete")
                    and isinstance(func.value, ast.Attribute) and func.value.attr == "__table__"
                    and _dotted(func.value.value, aliases) in MASTER_CLASSES):
                writes.add(f"__table__.{func.attr}() line {node.lineno}")
    return {"refs": refs, "writes": writes}


def scan_corpus_for_master_tables():
    """scan_source_for_master_tables for every non-test module under corpus_service/ (scraper/,
    root scripts such as bootstrap_harvest.py, migrations/) except the models themselves. A writer
    outside scraper/ is scanned too (round-3 B6)."""
    out = {}
    for path in sorted(PROJECT_ROOT.rglob("*.py")):
        if path.relative_to(PROJECT_ROOT).parts[0] == "tests":
            continue
        module = ".".join(path.relative_to(PROJECT_ROOT).with_suffix("").parts)
        if module.endswith(".__init__"):
            module = module[: -len(".__init__")]
        if module == "scraper.models":
            continue
        out[module] = scan_source_for_master_tables(path.read_text(), module)
    return out


class HarvesterStaticGuardTests(unittest.TestCase):
    """Every write path in scraper/tasks is accounted for, so no harvester is missed."""

    def test_every_staging_row_a_harvester_creates_is_stamped_with_its_source(self):
        import ast

        sites = []
        for path in sorted(TASKS_DIR.glob("*.py")):
            if path.name == "promotion.py":
                continue
            for node in ast.walk(ast.parse(path.read_text())):
                if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "ScraperStaging":
                    kw = {k.arg: ast.unparse(k.value) for k in node.keywords}
                    sites.append((path.name, kw.get("source_id"), kw.get("parsing_metadata", "")))
        self.assertEqual(len(sites), 7, sites)
        self.assertEqual(
            sorted(name for name, _sid, _meta in sites),
            ["balochistanhighcourt.py", "islamabadhighcourt.py", "lahorehighcourt.py", "nasirlawsite.py",
             "peshawarhighcourt.py", "shc.py", "supremecourt.py"],
        )
        unstamped = {
            name: {"source_id": sid, "parsing_metadata": meta}
            for name, sid, meta in sites
            if sid != "source.id" or not meta.startswith("stamp_metadata(source")
        }
        self.assertEqual(unstamped, {}, "staging rows written without the source stamp")

    def test_every_route_declares_staging_or_direct(self):
        """Round-2 L1(a): the dispatcher gates by the kind each route declares, not a deny-list."""
        from scraper.tasks import dispatcher

        self.assertEqual(
            set(dispatcher.ROUTES),
            {"PakistanLawSite", "NasirLawSite", "PakistanCode", "SindhHighCourt", "SindhHighCourtPublic",
             "SupremeCourt", "SupremeCourtPublic", "LahoreHighCourt", "PeshawarHighCourt",
             "PeshawarHighCourtPublic", "BalochistanHighCourt", "BalochistanHighCourtPublic",
             "IslamabadHighCourt", "IslamabadHighCourtPublic", "NationalAssembly"},
        )
        kinds = {name: (route[2] if isinstance(route, tuple) and len(route) == 3 else None)
                 for name, route in dispatcher.ROUTES.items()}
        self.assertEqual({k for k in kinds.values()} - {"staging", "direct"}, set(), kinds)
        self.assertEqual({name for name, kind in kinds.items() if kind == "direct"}, {"PakistanCode", "NationalAssembly"})

    def test_every_master_table_writer_is_a_direct_route_or_explicitly_allowed(self):
        """Round-2 L1(b), round-3 LOW-A/B6: an AST scan of every non-test module under
        corpus_service/ (import aliases resolved) finds every module that touches case_law_master /
        statutes_master. Each must be a `direct` route module (gated on trusted) or on the reviewed
        allowlists above; updater-only and read-only modules must show no write at all."""
        from scraper.tasks import dispatcher

        direct = {route[0] for route in dispatcher.ROUTES.values() if route[2] == "direct"}
        staging = {route[0] for route in dispatcher.ROUTES.values() if route[2] == "staging"}
        scanned = scan_corpus_for_master_tables()
        self.assertIn("bootstrap_harvest", scanned, "the scan must cover modules outside scraper/")
        found = {module: scan for module, scan in scanned.items() if scan["refs"]}
        allowed = set(MASTER_WRITER_ALLOWLIST) | set(MASTER_UPDATER_ALLOWLIST) | set(MASTER_READ_ONLY_ALLOWLIST)
        unexpected = sorted(set(found) - direct - allowed)
        self.assertEqual(unexpected, [], {m: sorted(found[m]["refs"])[:5] for m in unexpected})
        self.assertEqual(sorted(staging & set(found)), [], "a staging harvester touches a master table")
        writing_updaters = {m: sorted(found[m]["writes"]) for m in MASTER_UPDATER_ALLOWLIST if found.get(m, {}).get("writes")}
        self.assertEqual(writing_updaters, {}, "an updater-only module gained a master-table write")
        writing_readers = {m: sorted(found[m]["writes"]) for m in MASTER_READ_ONLY_ALLOWLIST if found.get(m, {}).get("writes")}
        self.assertEqual(writing_readers, {}, "a read-only module writes a master table")
        # The scan is not vacuous: it sees the known writers.
        self.assertEqual(direct - set(found), set(), "the scan missed a direct publisher")
        stale = (set(MASTER_WRITER_ALLOWLIST) | set(MASTER_UPDATER_ALLOWLIST)) - set(found)
        self.assertEqual(stale, set(), "stale allowlist entry")

    def test_the_scan_sees_aliased_core_sql_and_helper_writes(self):
        """The scanner itself, on the shapes a regex missed (re-audit mutants S1-S6) and more."""
        caught = {
            "plain": "from scraper.models import StatutesMaster\ndb.add(StatutesMaster(statute_name='x'))\n",
            "aliased": "from scraper.models import StatutesMaster as _SM\ndb.add(_SM(statute_name='x'))\n",
            "module_alias": "import scraper.models as m\ndb.add(m.CaseLawMaster())\n",
            "package_import": "from scraper import models\ndb.add(models.StatutesMaster())\n",
            "dotted_import": "import scraper.models\ndb.add(scraper.models.CaseLawMaster())\n",
            "relative": "from ..models import CaseLawMaster as C\nC()\n",
            "star": "from scraper.models import *\nCaseLawMaster()\n",
            "core_insert": "from sqlalchemy import insert\nfrom scraper.models import StatutesMaster\ninsert(StatutesMaster)\n",
            "schema_sql": "text(\"INSERT INTO public.statutes_master (statute_name) VALUES ('x')\")\n",
            "quoted_schema_sql": "text('UPDATE \"public\".\"case_law_master\" SET is_promoted = true')\n",
            "update_sql": "text(\"UPDATE case_law_master SET is_promoted = true\")\n",
            "delete_sql": "q = 'delete from statutes_master where true'\n",
            "lightweight_table": "from sqlalchemy import table\ntable('statutes_master')\n",
            "getattr_name": "getattr(models, 'CaseLawMaster')\n",
        }
        scans = {name: scan_source_for_master_tables(source, "scraper.tasks.example") for name, source in caught.items()}
        missed = {name for name, scan in scans.items() if not scan["refs"]}
        self.assertEqual(missed, set(), "references the scan did not see")
        # Every shape but the bare getattr name is a write.
        unwritten = {name for name, scan in scans.items() if name != "getattr_name" and not scan["writes"]}
        self.assertEqual(unwritten, set(), "writes the scan did not classify as writes")
        quiet = {
            "log_text": "logger.info('%s publishes to statutes_master/case_law_master directly; skip', n)\n",
            "read_sql": "text('SELECT count(*) FROM case_law_master')\n",
            "other_model": "from scraper.models import ScraperStaging\nScraperStaging()\n",
        }
        noisy = {name for name, source in quiet.items()
                 if any(scan_source_for_master_tables(source, "scraper.tasks.example").values())}
        self.assertEqual(noisy, set(), "false positives")


if __name__ == "__main__":
    unittest.main()
