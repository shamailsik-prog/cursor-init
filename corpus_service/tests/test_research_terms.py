"""FA-D5-003-R1-001: published research term tokenisation and refresh."""
from __future__ import annotations

import unittest

from scraper.publication.research_terms import research_terms_of, terms_for_judgment


class ResearchTermsTest(unittest.TestCase):
    def test_stop_words_and_ordinals_match_research_ts(self) -> None:
        self.assertEqual(research_terms_of("the bail under s. 302"), ["bail", "under", "302"])
        self.assertEqual(terms_for_judgment("Khula relief", ["PLD 2099 SC 12"]), ["khula", "relief", "pld", "2099", "sc", "12"])

    def test_arabic_indic_digits_fold_to_ascii(self) -> None:
        # Eastern Arabic-Indic digits ١٢ -> "12" after Nd folding (same as normaliseDraftText).
        self.assertEqual(research_terms_of("s. \u0663\u0660\u0662"), ["302"])


if __name__ == "__main__":
    unittest.main()
