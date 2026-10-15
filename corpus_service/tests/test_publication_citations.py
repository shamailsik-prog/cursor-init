"""Audit F19: the Python citation key builder reproduces the TypeScript canonical keys.

tests/fixtures/corpus/citation-canonical-golden.json is generated from the real TypeScript
``normaliseCitation`` (services/d4-2/citations.ts) by ``npm run corpus:citation-golden``; Python
never writes it. These tests pin corpus_service/scraper/publication/citations.py to it:

* the builder reproduces every canonical key from structured parts;
* the parser is one-sided (plan D24): ``canonical_key(raw)`` is None or exactly the TypeScript key,
  never a different key, so a parser gap costs recall and never mis-keys an authority;
* every citation is synthetic (2099); no real authority is named (P4-13).
"""

import json
import re
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.publication import vocabulary  # noqa: E402
from scraper.publication.citations import (  # noqa: E402
    CitationError,
    CitationParts,
    build_canonical,
    canonical_key,
    is_canonical,
    parse_parts,
)

GOLDEN = Path(__file__).resolve().parents[2] / "tests/fixtures/corpus/citation-canonical-golden.json"


def golden():
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


class GoldenTests(unittest.TestCase):
    def setUp(self):
        self.doc = golden()
        self.cases = self.doc["cases"]

    def test_golden_is_synthetic_2099_only(self):
        self.assertEqual(self.doc["format"], "citation-canonical-golden/1")
        self.assertGreater(len(self.cases), 30)
        for case in self.cases:
            for field in ("raw", "canonical"):
                value = case[field] or ""
                self.assertTrue(all(y == "2099" for y in re.findall(r"(?:19|20)\d\d", value)), case["id"])
            if case["raw"]:
                self.assertIn("2099", case["raw"], case["id"])
            if case["parts"]:
                self.assertEqual(case["parts"]["year"], "2099", case["id"])

    def test_builder_reproduces_typescript(self):
        checked = 0
        for case in self.cases:
            if case["parts"] is None:
                continue
            self.assertIsNotNone(case["canonical"], case["id"])
            self.assertEqual(build_canonical(CitationParts(**case["parts"])), case["canonical"], case["id"])
            checked += 1
        self.assertGreater(checked, 25)

    def test_python_key_is_none_or_equal_to_typescript(self):
        for case in self.cases:
            key = canonical_key(case["raw"])
            self.assertIn(key, (None, case["canonical"]), f"{case['id']}: python {key!r} vs ts {case['canonical']!r}")
            if case["python"] == "match":
                self.assertEqual(key, case["canonical"], case["id"])
            else:
                self.assertEqual(case["python"], "none", case["id"])
                self.assertIsNone(key, case["id"])

    def test_parse_parts_agrees_with_the_declared_parts(self):
        for case in self.cases:
            parsed = parse_parts(case["raw"])
            if case["python"] == "none":
                self.assertIsNone(parsed, case["id"])
            else:
                self.assertIsNotNone(parsed, case["id"])
                self.assertEqual(build_canonical(parsed), case["canonical"], case["id"])

    def test_canonical_is_canonical(self):
        for case in self.cases:
            if case["canonical"] is not None:
                self.assertTrue(is_canonical(case["canonical"]), case["id"])
        self.assertFalse(is_canonical("PLD 2099 Karachi 12"))
        self.assertFalse(is_canonical(""))
        self.assertFalse(is_canonical(None))

    def test_every_court_canonical_is_covered(self):
        keys = [c["canonical"] for c in self.cases if c["canonical"]]
        for court in vocabulary.COURT_CANONICALS:
            self.assertTrue(any(f" {court} " in k or f"({court})" in k for k in keys), court)


class BuilderRefusalTests(unittest.TestCase):
    def test_builder_refuses(self):
        bad = [
            CitationParts(reporter="PLD", year="2099", page="1"),  # PLD needs a court
            CitationParts(reporter="SCMR", year="2099", page="1", court="SC"),  # no court on SCMR
            CitationParts(reporter="XYZ", year="2099", page="1"),  # unknown reporter
            CitationParts(reporter="PLD", year="2099", page="1", court="Atlantis"),  # unknown court
            CitationParts(reporter="SCMR", year="2099", page="12A"),
            CitationParts(reporter="SCMR", year="1899", page="12"),
            CitationParts(reporter="SCMR", year="2099", page=""),
            CitationParts(reporter="PLC", year="2099", page="1", series="("),
            CitationParts(reporter="PLD", year="2099", page="1", court="SupremeCourt"),  # not a TS spelling
        ]
        for parts in bad:
            with self.assertRaises(CitationError, msg=repr(parts)):
                build_canonical(parts)

    def test_error_carries_a_reason_token(self):
        with self.assertRaises(CitationError) as ctx:
            build_canonical(CitationParts(reporter="PLD", year="2099", page="1"))
        self.assertRegex(ctx.exception.reason, r"^[a-z_]+$")

    def test_parser_refuses_non_ascii_and_garbage(self):
        for raw in ("2099 SCMR 1​", "２０９９ SCMR 1", "2099 SСMR 1", None, 2099, "PLD 2099 SC 1 2",
                    "PLD 2099  SC 1", "2099 PLC (A&amp) 14", "2099 PLC (C*S) 14"):
            self.assertIsNone(canonical_key(raw), repr(raw))

    def test_court_recognition_is_the_typescript_one_and_agrees_with_the_vocabulary(self):
        from scraper.publication.citations import ts_court

        spellings = {
            "SC": "SC", "S.C.": "SC", "Supreme Court of Pakistan": "SC", "Karachi": "Sindh", "Kar.": "Sindh",
            "S.H.C.": "Sindh", "Quetta": "Quetta", "Balochistan High Court": "Quetta", "Bal.": "Quetta",
            "Azad J & K": "AJ&K", "AJK": "AJ&K", "Gilgit-Baltistan": "GB", "Crl.": "Criminal", "Lah.": "Lahore",
        }
        for raw, canonical in spellings.items():
            self.assertEqual(ts_court(raw), canonical, raw)
            self.assertEqual(vocabulary.canonical_court(raw), canonical, raw)
        # The squashed alias map is broader than TypeScript; the key builder follows TypeScript.
        for raw in ("Lahore-High-Court", "SupremeCourt", "Karachi High Court", "Atlantis"):
            self.assertIsNone(ts_court(raw), raw)


if __name__ == "__main__":
    unittest.main()
