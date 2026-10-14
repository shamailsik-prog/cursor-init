"""Audit F20: the corpus trust vocabulary fails closed (pure unit tests, no database).

FINAL_CORPUS_SERVICE_PROMPT_2.md :252-253 fixes the vocabulary as trusted | review | blocked with
default review, and :894-898 the promotion rule: only a trusted source with confidence >= 0.5 is
auto-promoted, review is always quarantined, blocked is never harvested. Anything outside the
vocabulary (None, '', a legacy value, a different case) is unknown and must never publish.
"""

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
            {"review_source", "low_confidence", "blocked_source", "unknown_source", "citation_missing",
             "duplicate_citation"},
        )

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


TASKS_DIR = PROJECT_ROOT / "scraper" / "tasks"


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

    def test_every_direct_master_writer_is_gated_on_trusted(self):
        import re

        from scraper.tasks import dispatcher

        writes = re.compile(r"\b(?:StatutesMaster|CaseLawMaster)\s*\(|INSERT\s+INTO\s+(?:case_law_master|statutes_master)", re.I)
        writers = {
            f"scraper.tasks.{path.stem}"
            for path in TASKS_DIR.glob("*.py")
            if path.name != "promotion.py" and writes.search(path.read_text())
        }
        self.assertEqual(writers, {"scraper.tasks.pakistancode", "scraper.tasks.nationalassembly"})
        self.assertTrue(writers <= set(dispatcher.DIRECT_PUBLISHER_MODULES), writers)
        routed = {module for module, _func in dispatcher.ROUTES.values()}
        self.assertTrue(writers <= routed)
        self.assertEqual(
            set(dispatcher.ROUTES),
            {"PakistanLawSite", "NasirLawSite", "PakistanCode", "SindhHighCourt", "SindhHighCourtPublic",
             "SupremeCourt", "SupremeCourtPublic", "LahoreHighCourt", "PeshawarHighCourt",
             "PeshawarHighCourtPublic", "BalochistanHighCourt", "BalochistanHighCourtPublic",
             "IslamabadHighCourt", "IslamabadHighCourtPublic", "NationalAssembly"},
        )


if __name__ == "__main__":
    unittest.main()
