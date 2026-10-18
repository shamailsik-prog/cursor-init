"""PakistanLawSite connector — FINAL_2 compliant.

Login-form scraping is permanently disabled. This module only:
  1) polls a licensed API when PLS_API_KEY is configured, or
  2) ingests human-dropped export files from /imports/PakistanLawSite/.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from scraper.tasks import outcomes

logger = logging.getLogger(__name__)

IMPORT_DIR = Path(
    os.getenv(
        "PLS_IMPORT_DIR",
        str(Path(__file__).resolve().parents[2] / "imports" / "PakistanLawSite"),
    )
)


async def scrape_pakistanlawsite(source, db):
    """Entry point used by the dispatcher. Never performs interactive login."""
    from scraper.config import settings

    if getattr(settings, "ALLOW_LOGIN_SCRAPING", False):
        # Production validator should already reject this; belt-and-braces.
        raise RuntimeError(
            "ALLOW_LOGIN_SCRAPING is true — refusing to run PakistanLawSite connector"
        )

    api_key = os.getenv("PLS_API_KEY") or getattr(settings, "PLS_API_KEY", None)
    if api_key:
        logger.info("PakistanLawSite: licensed API path selected")
        return await _poll_licensed_api(api_key=api_key, source=source, db=db)

    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        p
        for p in IMPORT_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in {".pdf", ".html", ".htm", ".json", ".csv", ".txt"}
    )
    if not files:
        logger.warning(
            "PakistanLawSite: no PLS_API_KEY and no files in %s — idle (FINAL_2)",
            IMPORT_DIR,
        )
        # Audit F28: idle is a run that worked and found nothing (outcome "empty"), not a failure.
        return outcomes.run_tally().finish(note="idle: no_api_key_or_import_files")

    logger.info("PakistanLawSite: importing %d file(s) from %s", len(files), IMPORT_DIR)
    return await _ingest_import_folder(files=files, source=source, db=db)


async def _poll_licensed_api(*, api_key: str, source, db):
    """Placeholder for vendor API polling once the firm supplies an endpoint."""
    logger.warning(
        "PakistanLawSite licensed API key present but endpoint not configured — "
        "drop exports in %s meanwhile",
        IMPORT_DIR,
    )
    return outcomes.run_tally().finish(note="idle: api_endpoint_not_configured")


async def _ingest_import_folder(*, files, source, db):
    """Copy import files into live/ with provenance; promotion happens downstream."""
    import hashlib
    import json
    from datetime import datetime, timezone

    live = Path(__file__).resolve().parents[2] / "live" / "PakistanLawSite" / "imports"
    live.mkdir(parents=True, exist_ok=True)
    provenance = Path(__file__).resolve().parents[2] / "live" / "provenance"
    provenance.mkdir(parents=True, exist_ok=True)
    out = provenance / "pls_imports.jsonl"
    tally = outcomes.run_tally()
    for path in files:
        data = path.read_bytes()
        dest = live / path.name
        dest.write_bytes(data)
        row = {
            "event": "import_file",
            "source": "PakistanLawSite",
            "title": path.name,
            "url": f"import://PakistanLawSite/{path.name}",
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "content_hash": hashlib.sha256(data).hexdigest(),
            "extraction_method": "import_folder",
            "raw_storage_key": str(dest),
            "trust_level": "trusted",
        }
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        tally.item_ok(1)
    return tally.finish()
