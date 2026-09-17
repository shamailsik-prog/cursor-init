import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.tasks.islamabadhighcourt import (
    _extract_feed_urls,
    _extract_listing_and_pdf_links,
    _extract_pdf_urls_from_feed_payload,
)


class IslamabadHighCourtDiscoveryTests(unittest.TestCase):
    def test_discovers_listing_pages_markup_pdfs_and_feed_urls(self):
        html = """
        <ul>
          <li><a href="/frmJgmnt.aspx?jgs=1">Latest Judgments</a></li>
          <li>
            <a href="https://mis.ihc.gov.pk/attachments/judgements/123/1/WP-1-2026.pdf">
              Writ Petition 1/2026
            </a>
          </li>
          <li><a data-src="/attachments/judgements/124/1/Crl_Apl-2-2026.pdf">View Judgment</a></li>
          <li><a href="https://example.org/attachments/judgements/9/1/ext.pdf">External PDF</a></li>
        </ul>
        <script>
          window.inlineJudgment = "https:\\/\\/www.mis.ihc.gov.pk:443\\/attachments\\/judgements\\/125\\/1\\/Case-3-2026.pdf";
          const feed = "ihc.asmx/GetLatestJgmntsNew";
          const rejectedFeed = "/ihc.asmx/srchDecision";
        </script>
        """

        listing_urls, pdf_urls = _extract_listing_and_pdf_links(html, "https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1")
        feed_urls = _extract_feed_urls(html, "https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1")

        self.assertIn("https://mis.ihc.gov.pk/frmJgmnt.aspx?jgs=1", listing_urls)
        self.assertIn(
            "https://mis.ihc.gov.pk/attachments/judgements/123/1/WP-1-2026.pdf",
            pdf_urls,
        )
        self.assertIn(
            "https://mis.ihc.gov.pk/attachments/judgements/124/1/Crl_Apl-2-2026.pdf",
            pdf_urls,
        )
        self.assertIn(
            "https://mis.ihc.gov.pk/attachments/judgements/125/1/Case-3-2026.pdf",
            pdf_urls,
        )
        self.assertNotIn("https://example.org/attachments/judgements/9/1/ext.pdf", pdf_urls)
        self.assertEqual(
            ["https://mis.ihc.gov.pk/ihc.asmx/GetLatestJgmntsNew"],
            feed_urls,
        )

    def test_extracts_case_pdf_urls_from_ajax_payload(self):
        payload = (
            '{"d":"['
            '{\\"ATTACHMENTS\\":\\"/attachments/judgements/206312/1/5459-2025_639081358973138924.pdf\\",'
            '\\"CASENO\\":\\"Writ Petition-5459-2025\\"},'
            '{\\"ATTACHMENTS\\":\\"https://mis.ihc.gov.pk/attachments/judgements/199260/1/W.P._NO._2494_OF_2025.pdf\\",'
            '\\"CASENO\\":\\"W.P. 2494/2025\\"},'
            '{\\"ATTACHMENTS\\":\\"/attachments/downloads/NJPMC_Ordinance.pdf\\",'
            '\\"CASENO\\":\\"Policy Document\\"},'
            '{\\"ATTACHMENTS\\":\\"https://example.org/attachments/judgements/1/test.pdf\\",'
            '\\"CASENO\\":\\"Writ Petition-100/2025\\"}'
            ']"}'
        )

        pdf_urls = _extract_pdf_urls_from_feed_payload(
            payload, "https://mis.ihc.gov.pk/ihc.asmx/GetLatestJgmntsNew"
        )

        self.assertEqual(
            [
                "https://mis.ihc.gov.pk/attachments/judgements/206312/1/5459-2025_639081358973138924.pdf",
                "https://mis.ihc.gov.pk/attachments/judgements/199260/1/W.P._NO._2494_OF_2025.pdf",
            ],
            pdf_urls,
        )


if __name__ == "__main__":
    unittest.main()
