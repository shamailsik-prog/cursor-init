"""Audit FA-D5-003 R1 (spec R22): the Python research-terms fold equals the application's.

tests/fixtures/corpus/research-terms-golden.json is generated from the real TypeScript ``researchTermsOf``
(services/d5-1/researchTerms.ts) by ``npm run corpus:research-terms-golden``; Python never writes it. These tests pin
corpus_service/scraper/publication/research_terms.py to it:

* the golden's domain is the module's DOMAIN, and its contexts are the five the sweep uses;
* every explicit case: the same terms, in the same order (``python: match``), or None (``python: none``: a code point
  outside the DOMAIN, so the row stays pending and the application folds it itself);
* the exhaustive sweep: every DOMAIN code point in every context gives the TypeScript output, block by block.
"""

import hashlib
import json
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.publication import research_terms as rt  # noqa: E402

GOLDEN = Path(__file__).resolve().parents[2] / "tests/fixtures/corpus/research-terms-golden.json"


def golden():
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def _js(terms):
    """JSON.stringify of a string array."""
    return json.dumps(terms, ensure_ascii=False, separators=(",", ":"))


class GoldenShapeTests(unittest.TestCase):
    def test_format_domain_and_contexts(self):
        doc = golden()
        self.assertEqual(doc["format"], rt.GOLDEN_FORMAT)
        self.assertEqual([tuple(r) for r in doc["domain"]], list(rt.DOMAIN))
        self.assertEqual(doc["contexts"], ["a{}b", "{}", "9{}9 {}{}", "aΣ{}", "a{}Σ"])
        self.assertGreater(len(doc["cases"]), 40)
        self.assertTrue(doc["blocks"], "the golden has no sweep digests: run npm run corpus:research-terms-golden")
        for case in doc["cases"]:
            self.assertIsInstance(case["terms"], list, case["id"])

    def test_domain_is_ordered_and_assigned(self):
        last = -1
        for a, b in rt.DOMAIN:
            self.assertLessEqual(a, b)
            self.assertGreater(a, last)
            last = b
            for cp in range(a, b + 1):
                self.assertNotEqual(rt.unicodedata.category(chr(cp)), "Cn", hex(cp))
                self.assertFalse(0xD800 <= cp <= 0xDFFF, hex(cp))


class GoldenCaseTests(unittest.TestCase):
    def test_every_case(self):
        mismatches = []
        for case in golden()["cases"]:
            got = rt.research_terms_of(case["text"])
            want = case["terms"] if case["python"] == "match" else None
            if got != want:
                mismatches.append((case["id"], got, want))
        self.assertEqual(mismatches, [])

    def test_a_declined_text_is_one_typescript_still_folds(self):
        # The cases Python declines are folded by the application at query time: TypeScript gives terms for each.
        for case in golden()["cases"]:
            if case["python"] == "none":
                self.assertTrue(case["terms"], case["id"])

    def test_term_set_and_null_title(self):
        self.assertEqual(rt.research_term_set("Bail bail BAIL arrest"), frozenset({"bail", "arrest"}))
        self.assertEqual(rt.research_terms_of(None), [])
        self.assertIsNone(rt.research_term_set("Bail 保释"))


class GoldenSweepTests(unittest.TestCase):
    def test_every_domain_code_point_in_every_context(self):
        doc = golden()
        contexts = doc["contexts"]
        lines = {}
        for a, b in rt.DOMAIN:
            for cp in range(a, b + 1):
                ch = chr(cp)
                outs = []
                for context in contexts:
                    terms = rt.research_terms_of(context.replace("{}", ch))
                    self.assertIsNotNone(terms, hex(cp))
                    outs.append(_js(terms))
                block = format(cp >> 8, "04x")
                lines.setdefault(block, []).append(f"{cp:x}\t" + "\t".join(outs) + "\n")
        digests = {block: hashlib.sha256("".join(rows).encode("utf-8")).hexdigest() for block, rows in sorted(lines.items())}
        differing = sorted(block for block in set(digests) | set(doc["blocks"]) if digests.get(block) != doc["blocks"].get(block))
        self.assertEqual(differing, [])


if __name__ == "__main__":
    unittest.main()
