"""Audit F19: the closed publication vocabularies (pure unit tests, no database).

The expected values are written out from the sources, not imported from the code under test:

* Annex A (postgres/ddl/001_corpus_contract.sql): judgment.bench_type and treatment.treatment CHECKs,
  source_provenance.extraction_method CHECK; Annex A A.4: the eight jurisdictions and the statute
  status set (in_force | repealed | lapsed).
* services/d4-2/citations.ts:58-73: the court canonicals and their literal alternatives
  (Karachi -> Sindh; Balochistan and Quetta -> Quetta).
* Plan decisions D18-D21: blank bench is missing_bench; "Full Court" and "single judge" are invalid;
  jurisdictions match case-insensitively with no aliases (PK, KPK, Islamabad are refused).
"""

import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper import trust  # noqa: E402
from scraper.publication import vocabulary as v  # noqa: E402

BENCH_KEYS = {
    "single": "single", "singlebench": "single", "sb": "single",
    "division": "division", "divisionbench": "division", "db": "division",
    "full": "full", "fullbench": "full", "fb": "full",
    "larger": "larger", "largerbench": "larger", "lb": "larger",
}

COURT_KEYS = {
    "SC": ["sc", "supremecourt", "supremecourtofpakistan"],
    "FSC": ["fsc", "federalshariatcourt"],
    "Lahore": ["lahore", "lahorehighcourt", "lah", "lhc"],
    "Sindh": ["sindh", "sindhhighcourt", "karachi", "kar", "shc"],
    "Peshawar": ["peshawar", "peshawarhighcourt", "pesh", "phc"],
    "Quetta": ["balochistan", "balochistanhighcourt", "quetta", "bal", "bhc"],
    "Islamabad": ["islamabad", "islamabadhighcourt", "isl", "ihc"],
    "AJ&K": ["aj&k", "ajk", "azadjammuandkashmir", "azadjammu&kashmir", "azadj&k"],
    "GB": ["gb", "gilgitbaltistan"],
    "Civil": ["civil"],
    "Criminal": ["criminal", "crl"],
    "Tax": ["tax"],
    "Revenue": ["revenue"],
}


class ClosedSetTests(unittest.TestCase):
    def test_sets_are_exactly_the_annex_a_values(self):
        self.assertEqual(v.BENCH_TYPES, ("single", "division", "full", "larger"))
        self.assertEqual(
            v.TREATMENT_KINDS,
            ("followed", "applied", "distinguished", "doubted", "overruled", "per_incuriam", "referred"),
        )
        self.assertEqual(v.JURISDICTIONS, ("Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK"))
        self.assertEqual(v.STATUTE_STATUSES, ("in_force", "repealed", "lapsed"))
        self.assertEqual(v.EXTRACTION_METHODS, ("html", "pdf", "ocr", "manual", "api", "export"))
        self.assertEqual(
            v.COURT_CANONICALS,
            ("SC", "FSC", "Lahore", "Sindh", "Peshawar", "Quetta", "Islamabad", "AJ&K", "GB",
             "Civil", "Criminal", "Tax", "Revenue"),
        )

    def test_thresholds(self):
        self.assertEqual(v.TREATMENT_MIN_CONFIDENCE, 0.7)  # B-7
        self.assertEqual(v.CURRENT_TEXT_ONLY_CONFIDENCE, 0.5)  # B-5

    def test_squash(self):
        self.assertEqual(v.squash(" Division  Bench "), "divisionbench")
        self.assertEqual(v.squash("D.B."), "db")
        self.assertEqual(v.squash("Gilgit-Baltistan"), "gilgitbaltistan")
        self.assertEqual(v.squash("AJ & K"), "aj&k")


class BenchTests(unittest.TestCase):
    def test_every_alias_key_maps(self):
        self.assertEqual(dict(v.BENCH_ALIASES), BENCH_KEYS)
        for key, bench in BENCH_KEYS.items():
            self.assertEqual(v.canonical_bench(key), bench, key)
            self.assertEqual(v.canonical_bench(key.upper()), bench, key)

    def test_spelled_and_dotted_forms(self):
        for raw in ("Division  Bench", "D.B.", "db", "Division-Bench", " division "):
            self.assertEqual(v.canonical_bench(raw), "division", raw)
        self.assertEqual(v.canonical_bench("Larger Bench"), "larger")
        self.assertEqual(v.canonical_bench("S.B."), "single")

    def test_missing(self):
        for raw in (None, "", "  ", "\t"):
            self.assertTrue(v.bench_is_missing(raw), repr(raw))
            self.assertIsNone(v.canonical_bench(raw), repr(raw))
        self.assertTrue(v.bench_is_missing(3))

    def test_invalid_is_not_missing(self):
        for raw in ("panel", "Full Court", "single judge", "DB2", "bench"):
            self.assertIsNone(v.canonical_bench(raw), raw)
            self.assertFalse(v.bench_is_missing(raw), raw)


class TreatmentTests(unittest.TestCase):
    def test_every_kind(self):
        for kind in v.TREATMENT_KINDS:
            self.assertEqual(v.canonical_treatment(kind), kind)
            self.assertEqual(v.canonical_treatment(f"  {kind.upper()} "), kind)
        self.assertEqual(v.canonical_treatment(" Overruled "), "overruled")

    def test_refused(self):
        for raw in ("per incuriam", "reversed", "OVERRULED!", "", None, 5, "over ruled"):
            self.assertIsNone(v.canonical_treatment(raw), repr(raw))


class JurisdictionTests(unittest.TestCase):
    def test_the_eight_and_their_lowercase_forms(self):
        for j in ("Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK"):
            self.assertEqual(v.canonical_jurisdiction(j), j)
            self.assertEqual(v.canonical_jurisdiction(j.lower()), j)
            self.assertEqual(v.canonical_jurisdiction(f" {j.upper()} "), j)

    def test_refused(self):
        for raw in ("PK", "Pakistan", "KPK", "Islamabad", "", "  ", None, "AJ&K", "Khyber Pakhtunkhwa"):
            self.assertIsNone(v.canonical_jurisdiction(raw), repr(raw))


class CourtTests(unittest.TestCase):
    def test_every_alias_key_maps(self):
        expected = {key: canonical for canonical, keys in COURT_KEYS.items() for key in keys}
        self.assertEqual(dict(v.COURT_ALIASES), expected)
        for key, canonical in expected.items():
            self.assertEqual(v.canonical_court(key), canonical, key)

    def test_spelled_forms(self):
        for raw in ("Karachi", "Kar.", "S.H.C.", "Sindh High Court"):
            self.assertEqual(v.canonical_court(raw), "Sindh", raw)
        for raw in ("Quetta", "Balochistan High Court", "Bal."):
            self.assertEqual(v.canonical_court(raw), "Quetta", raw)
        self.assertEqual(v.canonical_court("Supreme Court of Pakistan"), "SC")
        self.assertEqual(v.canonical_court("Azad Jammu and Kashmir"), "AJ&K")
        self.assertEqual(v.canonical_court("Gilgit-Baltistan"), "GB")

    def test_refused(self):
        for raw in ("Atlantis", "", None, "High Court", 7):
            self.assertIsNone(v.canonical_court(raw), repr(raw))


class StatuteStatusTests(unittest.TestCase):
    def test_statuses(self):
        self.assertEqual(v.canonical_statute_status(None), "in_force")
        self.assertEqual(v.canonical_statute_status("Repealed"), "repealed")
        self.assertEqual(v.canonical_statute_status(" lapsed "), "lapsed")
        self.assertEqual(v.canonical_statute_status("in_force"), "in_force")
        for raw in ("in force", "", "suspended", 1):
            self.assertIsNone(v.canonical_statute_status(raw), repr(raw))


class ReasonTests(unittest.TestCase):
    def test_reason_sets(self):
        self.assertEqual(
            v.REJECT_REASONS,
            ("provenance_incomplete", "invalid_bench", "invalid_treatment_kind", "unresolvable_judgment",
             "history_missing_effective_from", "history_overlap", "history_out_of_order", "invalid_history",
             "invalid_jurisdiction", "invalid_statute_status", "citation_conflict", "citation_missing",
             "promoted_row_protected"),
        )
        self.assertEqual(
            v.QUARANTINE_REASONS,
            ("missing_bench", "citation_not_canonical", "treatment_uncertain", "judgment_not_promoted",
             "review_source", "low_confidence", "blocked_source", "unknown_source"),
        )

    def test_reason_sets_are_disjoint(self):
        self.assertEqual(set(v.REJECT_REASONS) & set(v.QUARANTINE_REASONS), set())
        self.assertEqual(len(set(v.REJECT_REASONS)), len(v.REJECT_REASONS))
        self.assertEqual(len(set(v.QUARANTINE_REASONS)), len(v.QUARANTINE_REASONS))
        # The only F20 reason that is also a publication reason is citation_missing (a rejection).
        self.assertEqual(set(trust.QUARANTINE_REASONS) & set(v.REJECT_REASONS), {trust.REASON_CITATION_MISSING})
        self.assertNotIn(trust.REASON_CITATION_MISSING, v.QUARANTINE_REASONS)

    def test_quarantine_precedence(self):
        self.assertEqual(
            v.QUARANTINE_PRECEDENCE,
            ("review_source", "low_confidence", "blocked_source", "unknown_source",
             "citation_not_canonical", "missing_bench", "treatment_uncertain", "judgment_not_promoted"),
        )
        self.assertEqual(set(v.QUARANTINE_PRECEDENCE), set(v.QUARANTINE_REASONS))
        self.assertEqual(v.first_quarantine_reason({"missing_bench", "review_source"}), "review_source")
        self.assertEqual(v.first_quarantine_reason({"missing_bench", "citation_not_canonical"}), "citation_not_canonical")
        # Re-audit D3: an unpromoted treating or treated judgment holds a treatment, and loses to every
        # reason about the treatment itself.
        self.assertEqual(v.first_quarantine_reason({"judgment_not_promoted", "treatment_uncertain"}), "treatment_uncertain")
        self.assertEqual(v.first_quarantine_reason({"judgment_not_promoted"}), "judgment_not_promoted")
        self.assertIsNone(v.first_quarantine_reason(set()))


if __name__ == "__main__":
    unittest.main()
