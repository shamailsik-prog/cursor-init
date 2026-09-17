import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.tasks.supremecourt import _extract_listing_and_pdf_links


class SupremeCourtDiscoveryTests(unittest.TestCase):
    def test_discovers_listing_pages_and_case_pdfs(self):
        html = """
        <ul>
          <li><a href="/latest-judgements/">Latest Judgements</a></li>
          <li><a href="/online-case-status/">Judgement Search</a></li>
          <li><a href="/downloads_judgements/c.p._12_2024.pdf">Download Judgement</a></li>
          <li><a href="https://example.org/external.pdf">External PDF</a></li>
          <li><a href="/wp-content/uploads/public-notice.pdf">Public Notice</a></li>
        </ul>
        """

        listing_urls, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://www.supremecourt.gov.pk/"
        )

        self.assertIn("https://www.supremecourt.gov.pk/latest-judgements/", listing_urls)
        self.assertIn("https://www.supremecourt.gov.pk/online-case-status/", listing_urls)
        self.assertIn(
            "https://www.supremecourt.gov.pk/downloads_judgements/c.p._12_2024.pdf",
            pdf_urls,
        )
        self.assertNotIn("https://example.org/external.pdf", pdf_urls)
        self.assertNotIn(
            "https://www.supremecourt.gov.pk/wp-content/uploads/public-notice.pdf",
            pdf_urls,
        )

    def test_discovers_inline_script_pdf_links(self):
        html = """
        <script>
          window.latestJudgement = "https:\\/\\/www.supremecourt.gov.pk\\/downloads_judgements\\/const.p._6_2023_ans_07052024.pdf";
        </script>
        """

        _, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://www.supremecourt.gov.pk/latest-judgements/"
        )

        self.assertEqual(
            [
                "https://www.supremecourt.gov.pk/downloads_judgements/const.p._6_2023_ans_07052024.pdf"
            ],
            pdf_urls,
        )

    def test_discovers_listing_links_from_sitemap_xml_text(self):
        xml = """
        <urlset>
          <url><loc>https://www.supremecourt.gov.pk/latest-judgements/</loc></url>
          <url><loc>https://www.supremecourt.gov.pk/judgement-search/</loc></url>
          <url><loc>https://www.supremecourt.gov.pk/downloads_judgements/crl.p._619_l_2024.pdf</loc></url>
          <url><loc>https://example.org/not-allowed.pdf</loc></url>
        </urlset>
        """
        listing_urls, pdf_urls = _extract_listing_and_pdf_links(
            xml, "https://www.supremecourt.gov.pk/sitemap.xml"
        )

        self.assertIn("https://www.supremecourt.gov.pk/latest-judgements/", listing_urls)
        self.assertIn("https://www.supremecourt.gov.pk/judgement-search/", listing_urls)
        self.assertIn(
            "https://www.supremecourt.gov.pk/downloads_judgements/crl.p._619_l_2024.pdf",
            pdf_urls,
        )
        self.assertNotIn("https://example.org/not-allowed.pdf", pdf_urls)


if __name__ == "__main__":
    unittest.main()
