import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.tasks.balochistanhighcourt import _extract_listing_and_pdf_links


class BalochistanHighCourtDiscoveryTests(unittest.TestCase):
    def test_discovers_listing_pages_and_data_src_case_pdfs(self):
        html = """
        <ul>
          <li><a href="/resources/judgments">Significant Judgments</a></li>
          <li>
            <a href="/resources/judgments/justice-qazi-faez-isa/reported-judgments">
              Reported Judgments
            </a>
          </li>
          <li>
            <a href="/resources/judgments/justice-qazi-faez-isa/reported-judgments/2013">2013</a>
          </li>
          <li><a href="https://portal.bhc.gov.pk/judgments">Portal Judgments</a></li>
          <li><a class="popup" data-src="https://bhc.gov.pk/media/judgments/417.pdf">View Judgment</a></li>
          <li><a class="popup" data-src="https://example.org/media/judgments/100.pdf">External Judgment</a></li>
          <li><a href="https://bhc.gov.pk/media/downloads/95.pdf">Service Rules</a></li>
        </ul>
        """

        listing_urls, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://bhc.gov.pk/resources/judgments"
        )

        self.assertIn("https://bhc.gov.pk/resources/judgments", listing_urls)
        self.assertIn(
            "https://bhc.gov.pk/resources/judgments/justice-qazi-faez-isa/reported-judgments",
            listing_urls,
        )
        self.assertIn(
            "https://bhc.gov.pk/resources/judgments/justice-qazi-faez-isa/reported-judgments/2013",
            listing_urls,
        )
        self.assertIn("https://portal.bhc.gov.pk/judgments", listing_urls)
        self.assertIn("https://bhc.gov.pk/media/judgments/417.pdf", pdf_urls)
        self.assertNotIn("https://example.org/media/judgments/100.pdf", pdf_urls)
        self.assertNotIn("https://bhc.gov.pk/media/downloads/95.pdf", pdf_urls)

    def test_discovers_inline_script_pdf_links_and_normalizes_www_host(self):
        html = """
        <script>
          const judgmentPdf = "https:\\/\\/www.bhc.gov.pk:443\\/media\\/judgments\\/420.pdf";
        </script>
        """

        _, pdf_urls = _extract_listing_and_pdf_links(html, "https://bhc.gov.pk/resources/judgments")

        self.assertEqual(["https://bhc.gov.pk/media/judgments/420.pdf"], pdf_urls)


if __name__ == "__main__":
    unittest.main()
