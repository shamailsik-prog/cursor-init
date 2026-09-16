"""Stdlib-only regressions for corpus_service Bugbot / FINAL_2 holes.

Does not import the FastAPI app (startup would require Postgres).
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def _citation_to_str(citation):
    """Mirror of scraper.tasks.nasirlawsite._citation_to_str (pure)."""
    if citation is None:
        return None
    if isinstance(citation, str):
        return citation[:500]
    if isinstance(citation, dict):
        text = citation.get("normalized") or citation.get("raw") or ""
        return text[:500] if text else None
    return str(citation)[:500]


class CorpusBugbotFixes(unittest.TestCase):
    def test_no_shipped_fernet_or_admin_secret(self):
        config = _read("scraper/config.py")
        self.assertNotIn("GCgd5SyyArrS3Uy40yMYuAUN5OkZ11rbQwIu-2Ulf-U=", config)
        self.assertNotIn("prod-admin-2024-secure-key-32bytes-minimum!", config)
        self.assertIn("ENCRYPTION_KEY must be set via environment", config)

    def test_shared_orm_base(self):
        models = _read("scraper/models.py")
        self.assertIn("from scraper.database import Base", models)
        self.assertNotIn("class Base(DeclarativeBase)", models)

    def test_no_limitation_period_table(self):
        models = _read("scraper/models.py")
        self.assertNotIn("class LimitationPeriod", models)
        self.assertNotIn('__tablename__ = "limitation_periods"', models)

    def test_trust_level_is_final_2(self):
        models = _read("scraper/models.py")
        self.assertIn("trust_level IN ('trusted','review','blocked')", models)
        db = _read("scraper/database.py")
        self.assertIn('trust_level="review"', db)
        self.assertNotIn("semi_trusted", db)
        promotion = _read("scraper/tasks/promotion.py")
        self.assertIn('if trust=="review"', promotion)

    def test_embedding_status_completed(self):
        embeddings = _read("scraper/tasks/embeddings.py")
        self.assertIn('item.status = "completed"', embeddings)
        self.assertNotIn('item.status="done"', embeddings)
        self.assertNotIn('item.status = "done"', embeddings)

    def test_celery_registers_beat_tasks(self):
        celery = _read("scraper/tasks/celery_app.py")
        self.assertIn("import scraper.tasks.dispatcher", celery)
        self.assertIn("import scraper.tasks.embeddings", celery)
        self.assertIn("celery,embeddings", _read("docker-compose.yml"))

    def test_harvester_idles_instead_of_exiting(self):
        harvester = _read("scraper/workers/harvester.py")
        self.assertIn("while not _stop", harvester)
        self.assertNotIn("auto generated placeholder", harvester)

    def test_quarantine_and_export_require_admin_key(self):
        quarantine = _read("scraper/routers/quarantine.py")
        export = _read("scraper/routers/export.py")
        main = _read("scraper/main.py")
        self.assertIn("require_admin_api_key", quarantine)
        self.assertIn("require_admin_api_key", export)
        self.assertIn("require_admin_api_key", main)
        self.assertIn("allow_origins=_cors_origins", main)
        self.assertNotIn('allow_origins=["*"]', main)

    def test_nasir_citation_stringify(self):
        nasir = _read("scraper/tasks/nasirlawsite.py")
        self.assertIn("def _citation_to_str", nasir)
        self.assertIn("extracted_citation=citation", nasir)
        self.assertEqual(
            _citation_to_str({"normalized": "PLD 2023 SC 1", "raw": "PLD 2023 SC 1"}),
            "PLD 2023 SC 1",
        )
        self.assertEqual(_citation_to_str("PLD 2023 SC 1"), "PLD 2023 SC 1")
        self.assertIsNone(_citation_to_str({"normalized": "", "raw": ""}))

    def test_admin_gate_parses(self):
        tree = ast.parse(_read("scraper/auth.py"))
        names = [n.name for n in tree.body if isinstance(n, ast.FunctionDef)]
        self.assertIn("require_admin_api_key", names)


if __name__ == "__main__":
    unittest.main()
