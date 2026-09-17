import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.tasks.peshawarhighcourt import _extract_listing_and_pdf_links


class PeshawarHighCourtDiscoveryTests(unittest.TestCase):
    def test_discovers_listing_pages_and_case_pdf_links(self):
        html = """
        <ul>
          <li><a href="/app/site/47/c/All_the_Referred,Reported_Judgments.html">Reported Judgments</a></li>
          <li><a href="/app/site/108/c/Case_Law.html">Case Law</a></li>
          <li><a href="https://peshawarhighcourt.gov.pk/PHCCMS/judgments/WP-475-B-2026.pdf">WP Judgment</a></li>
          <li><a href="https://example.org/external.pdf">External PDF</a></li>
          <li><a href="/notifications/260709030753pm1727.pdf">Notification</a></li>
        </ul>
        """

        listing_urls, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://peshawarhighcourt.gov.pk/app/site/"
        )

        self.assertIn(
            "https://peshawarhighcourt.gov.pk/app/site/47/c/All_the_Referred,Reported_Judgments.html",
            listing_urls,
        )
        self.assertIn(
            "https://peshawarhighcourt.gov.pk/app/site/108/c/Case_Law.html",
            listing_urls,
        )
        self.assertIn(
            "https://peshawarhighcourt.gov.pk/PHCCMS/judgments/WP-475-B-2026.pdf",
            pdf_urls,
        )
        self.assertNotIn("https://example.org/external.pdf", pdf_urls)
        self.assertNotIn(
            "https://peshawarhighcourt.gov.pk/notifications/260709030753pm1727.pdf",
            pdf_urls,
        )

    def test_discovers_inline_pdf_links_and_normalizes_www_host(self):
        html = """
        <script>
          window.latestJudgment = "https:\\/\\/www.peshawarhighcourt.gov.pk:443\\/PHCCMS\\/judgments\\/BA-394-B-2026_001.pdf";
        </script>
        """

        _, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://peshawarhighcourt.gov.pk/app/site/"
        )

        self.assertEqual(
            ["https://peshawarhighcourt.gov.pk/PHCCMS/judgments/BA-394-B-2026_001.pdf"],
            pdf_urls,
        )


if __name__ == "__main__":
    unittest.main()
