import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.tasks.shc import _extract_listing_and_pdf_links


class SindhHighCourtDiscoveryTests(unittest.TestCase):
    def test_discovers_listing_pages_and_case_pdf_links(self):
        html = """
        <ul>
          <li><a href="/Imp_Judgement_Orders.php">Important Judgement Orders</a></li>
          <li><a href="https://sindhhighcourt.gov.pk/archive.php">Judgment Archive</a></li>
          <li><a href="https://example.org/external.pdf">External document</a></li>
          <li>
            <a href="/news_notifications/source_files/Spl.Cr.A.T.A.No.348_of_2019.pdf">
              Judgement Dated 08th April,2020 in Special Criminal Anti-Terrorism Appeal
            </a>
          </li>
          <li>
            <a href="/news_notifications/source_files/Circular_SOP_VideoLink.pdf">
              SOPs of Video Link- HC
            </a>
          </li>
        </ul>
        """

        listing_urls, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://sindhhighcourt.gov.pk/"
        )

        self.assertIn("https://sindhhighcourt.gov.pk/Imp_Judgement_Orders.php", listing_urls)
        self.assertIn("https://sindhhighcourt.gov.pk/archive.php", listing_urls)
        self.assertIn(
            "https://sindhhighcourt.gov.pk/news_notifications/source_files/Spl.Cr.A.T.A.No.348_of_2019.pdf",
            pdf_urls,
        )
        self.assertNotIn("https://example.org/external.pdf", pdf_urls)
        self.assertNotIn(
            "https://sindhhighcourt.gov.pk/news_notifications/source_files/Circular_SOP_VideoLink.pdf",
            pdf_urls,
        )

    def test_discovers_inline_pdf_links(self):
        html = """
        <script>
          const judgmentPdf = "https:\\/\\/sindhhighcourt.gov.pk\\/news_notifications\\/source_files\\/S.M.C._3_2018.pdf";
        </script>
        """
        _, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://sindhhighcourt.gov.pk/Imp_Judgement_Orders.php"
        )

        self.assertEqual(
            ["https://sindhhighcourt.gov.pk/news_notifications/source_files/S.M.C._3_2018.pdf"],
            pdf_urls,
        )


if __name__ == "__main__":
    unittest.main()
