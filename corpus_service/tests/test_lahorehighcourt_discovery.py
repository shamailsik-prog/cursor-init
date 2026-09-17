import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scraper.tasks.lahorehighcourt import _extract_listing_and_pdf_links


class LahoreHighCourtDiscoveryTests(unittest.TestCase):
    def test_discovers_current_listing_links(self):
        html = """
        <ul>
          <li>
            <a href="http://data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting">
              Judgments Approved for Reporting by Sitting Judges
            </a>
          </li>
          <li>
            <a href="https://data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting_by_former_judges">
              Judgments Approved for Reporting by Former Judges
            </a>
          </li>
          <li><a href="/green_bench_notifications">Green Bench Notifications</a></li>
          <li><a href="https://example.org/not-allowed.pdf">Ignore non-LHC domain</a></li>
        </ul>
        """
        listing_urls, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://lhc.gov.pk/reported_judgments"
        )

        self.assertIn(
            "http://data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting",
            listing_urls,
        )
        self.assertIn(
            "https://data.lhc.gov.pk/reported_judgments/judgments_approved_for_reporting_by_former_judges",
            listing_urls,
        )
        self.assertIn("https://lhc.gov.pk/green_bench_notifications", listing_urls)
        self.assertEqual([], pdf_urls)

    def test_discovers_pdf_links_from_listing_markup(self):
        html = """
        <div class="field-item even">
          <a href="/system/files/notification-1.pdf">Notification 1</a>
          <a href="/system/files/notification-2.pdf">Notification 2</a>
          <script>
            const backup = "https:\\/\\/lhc.gov.pk\\/system\\/files\\/notification-3.pdf";
          </script>
        </div>
        """
        _, pdf_urls = _extract_listing_and_pdf_links(
            html, "https://lhc.gov.pk/green_bench_notifications"
        )
        self.assertIn("https://lhc.gov.pk/system/files/notification-1.pdf", pdf_urls)
        self.assertIn("https://lhc.gov.pk/system/files/notification-2.pdf", pdf_urls)
        self.assertIn("https://lhc.gov.pk/system/files/notification-3.pdf", pdf_urls)


if __name__ == "__main__":
    unittest.main()
