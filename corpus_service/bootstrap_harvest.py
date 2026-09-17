#!/usr/bin/env python3
"""Bootstrap public-source harvest for corpus_service (FINAL_2).

No Docker/Postgres required. Writes JSONL + PDFs under ./live/.
  - public government / open sites only
  - PakistanLawSite is NOT fetched here (licensed_api / import_folder only)
  - login scraping is never used
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
LIVE = ROOT / "live"
UA = "SikanderCorpusBot/0.1 (+corpus-service; public-harvest)"
RATE_SECONDS = 1.25
MAX_PC_STATUTES = 40
MAX_NLS_PAGES = 30
MAX_NA_PDFS = 20


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ensure_dirs() -> None:
    for p in (
        LIVE,
        LIVE / "PakistanCode" / "pdfs",
        LIVE / "PakistanCode" / "pages",
        LIVE / "NasirLawSite" / "pages",
        LIVE / "NationalAssembly" / "pdfs",
        LIVE / "provenance",
    ):
        p.mkdir(parents=True, exist_ok=True)


class RobotsGate:
    def __init__(self, client: httpx.Client) -> None:
        self.client = client
        self._parsers: dict[str, RobotFileParser | None] = {}

    def allowed(self, url: str) -> bool:
        parsed = urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self._parsers:
            rp = RobotFileParser()
            robots_url = urljoin(origin + "/", "robots.txt")
            try:
                r = self.client.get(robots_url, timeout=20)
                if r.status_code >= 400:
                    self._parsers[origin] = None
                else:
                    rp.parse(r.text.splitlines())
                    self._parsers[origin] = rp
            except Exception:
                self._parsers[origin] = None
        rp = self._parsers[origin]
        if rp is None:
            return True
        return bool(rp.can_fetch(UA, url))


class Harvester:
    def __init__(self) -> None:
        ensure_dirs()
        self.client = httpx.Client(
            headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*"},
            follow_redirects=True,
            timeout=60.0,
        )
        self.robots = RobotsGate(self.client)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.prov_path = LIVE / "provenance" / f"harvest_{stamp}.jsonl"
        self.counts = {
            "fetched": 0,
            "skipped_robots": 0,
            "errors": 0,
            "pdfs": 0,
            "pages": 0,
        }

    def close(self) -> None:
        self.client.close()

    def record(self, row: dict) -> None:
        with self.prov_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def get(self, url: str) -> httpx.Response | None:
        if not self.robots.allowed(url):
            self.counts["skipped_robots"] += 1
            self.record({"event": "robots_skip", "url": url, "fetched_at": now_iso()})
            return None
        try:
            time.sleep(RATE_SECONDS)
            r = self.client.get(url)
            self.counts["fetched"] += 1
            return r
        except Exception as e:
            self.counts["errors"] += 1
            self.record(
                {"event": "error", "url": url, "error": str(e), "fetched_at": now_iso()}
            )
            return None

    def harvest_pakistancode(self) -> None:
        index = (
            "https://pakistancode.gov.pk/english/LGu0xAD.php?alp=A&page=1&action=active"
        )
        r = self.get(index)
        if r is None or r.status_code != 200:
            self.counts["errors"] += 1
            self.record(
                {
                    "event": "error",
                    "source": "PakistanCode",
                    "url": index,
                    "status": getattr(r, "status_code", None),
                }
            )
            return

        soup = BeautifulSoup(r.text, "lxml")
        acts: list[tuple[str, str]] = []
        for a in soup.find_all("a", href=True):
            title = a.get_text(" ", strip=True)
            href = a["href"].strip()
            if not title or len(title) < 8:
                continue
            if not href.startswith("UY"):
                continue
            acts.append((title, urljoin(index, href)))

        catalog_path = LIVE / "PakistanCode" / "catalog_A.json"
        catalog_path.write_text(
            json.dumps([{"title": t, "url": u} for t, u in acts], indent=2),
            encoding="utf-8",
        )
        self.record(
            {
                "event": "catalog",
                "source": "PakistanCode",
                "url": index,
                "count": len(acts),
                "path": str(catalog_path.relative_to(ROOT)),
                "fetched_at": now_iso(),
                "content_hash": sha256_bytes(r.content),
            }
        )

        for title, detail_url in acts[:MAX_PC_STATUTES]:
            dr = self.get(detail_url)
            if dr is None or dr.status_code != 200:
                continue
            dsoup = BeautifulSoup(dr.text, "lxml")
            pdf = None
            for link in dsoup.find_all("a", href=True):
                if ".pdf" in link["href"].lower():
                    pdf = urljoin(detail_url, link["href"])
                    break
            if pdf is None:
                iframe = dsoup.find("iframe", src=True)
                if iframe and "pdf" in iframe["src"].lower():
                    m = re.search(
                        r"(https?://[^#]+\.pdf|/?pdffiles/[^\s\"'#]+\.pdf)",
                        iframe["src"],
                        re.I,
                    )
                    if m:
                        pdf = urljoin("https://pakistancode.gov.pk/", m.group(1))

            safe = re.sub(r"[^a-zA-Z0-9._-]+", "_", title)[:80]
            html_path = LIVE / "PakistanCode" / "pages" / f"{safe}.html"
            html_path.write_bytes(dr.content)
            self.counts["pages"] += 1
            row = {
                "event": "statute_page",
                "source": "PakistanCode",
                "title": title,
                "url": detail_url,
                "pdf_url": pdf,
                "fetched_at": now_iso(),
                "content_hash": sha256_bytes(dr.content),
                "extraction_method": "html",
                "raw_storage_key": str(html_path.relative_to(ROOT)),
                "trust_level": "trusted",
            }
            if pdf:
                pr = self.get(pdf)
                if pr is not None and pr.status_code == 200 and pr.content[:4] == b"%PDF":
                    pdf_path = LIVE / "PakistanCode" / "pdfs" / f"{safe}.pdf"
                    pdf_path.write_bytes(pr.content)
                    row["pdf_path"] = str(pdf_path.relative_to(ROOT))
                    row["pdf_hash"] = sha256_bytes(pr.content)
                    row["extraction_method"] = "pdf"
                    self.counts["pdfs"] += 1
            self.record(row)
            print(f"[PakistanCode] {title[:70]}", flush=True)

    def harvest_nasirlawsite(self) -> None:
        seeds = [
            "https://www.nasirlawsite.com/laws.htm",
            "https://www.nasirlawsite.com/historic.htm",
            "https://www.nasirlawsite.com/research.htm",
        ]
        seen: set[str] = set()
        queue = list(seeds)
        while queue and len(seen) < MAX_NLS_PAGES:
            url = queue.pop(0)
            if url in seen:
                continue
            seen.add(url)
            r = self.get(url)
            if r is None or r.status_code != 200:
                continue
            soup = BeautifulSoup(r.text, "lxml")
            title = soup.title.get_text(strip=True) if soup.title else url
            text = soup.get_text("\n", strip=True)
            safe = re.sub(
                r"[^a-zA-Z0-9._-]+",
                "_",
                urlparse(url).path.strip("/") or "index",
            )[:80]
            path = LIVE / "NasirLawSite" / "pages" / f"{safe}.html"
            path.write_bytes(r.content)
            self.counts["pages"] += 1
            self.record(
                {
                    "event": "page",
                    "source": "NasirLawSite",
                    "title": title,
                    "url": url,
                    "fetched_at": now_iso(),
                    "content_hash": sha256_bytes(r.content),
                    "extraction_method": "html",
                    "raw_storage_key": str(path.relative_to(ROOT)),
                    "text_chars": len(text),
                    "trust_level": "review",
                }
            )
            print(f"[NasirLawSite] {title[:70]}", flush=True)
            for a in soup.find_all("a", href=True):
                full = urljoin(url, a["href"].strip())
                host = urlparse(full).netloc.lower()
                if host not in {"www.nasirlawsite.com", "nasirlawsite.com"}:
                    continue
                if full.endswith((".htm", ".html")) and full not in seen and len(queue) < 80:
                    queue.append(full)

    def harvest_national_assembly(self) -> None:
        index = "https://na.gov.pk/en/acts-tenure.php"
        r = self.get(index)
        if r is None or r.status_code != 200:
            self.counts["errors"] += 1
            self.record(
                {
                    "event": "error",
                    "source": "NationalAssembly",
                    "url": index,
                    "status": getattr(r, "status_code", None),
                }
            )
            return

        soup = BeautifulSoup(r.text, "lxml")
        pdfs: list[tuple[str, str]] = []
        for a in soup.find_all("a", href=True):
            href = a["href"]
            label = a.get_text(" ", strip=True) or "NA document"
            if ".pdf" not in href.lower():
                continue
            pdfs.append((label, urljoin(index, href)))

        catalog = LIVE / "NationalAssembly" / "catalog.json"
        catalog.write_text(
            json.dumps([{"title": t, "url": u} for t, u in pdfs], indent=2),
            encoding="utf-8",
        )
        self.record(
            {
                "event": "catalog",
                "source": "NationalAssembly",
                "url": index,
                "count": len(pdfs),
                "path": str(catalog.relative_to(ROOT)),
                "fetched_at": now_iso(),
                "content_hash": sha256_bytes(r.content),
            }
        )

        for title, pdf_url in pdfs[:MAX_NA_PDFS]:
            pr = self.get(pdf_url)
            if pr is None or pr.status_code != 200:
                continue
            if pr.content[:4] != b"%PDF":
                self.record(
                    {
                        "event": "skip_non_pdf",
                        "source": "NationalAssembly",
                        "url": pdf_url,
                    }
                )
                continue
            safe = (
                re.sub(r"[^a-zA-Z0-9._-]+", "_", title)[:80]
                or sha256_bytes(pdf_url.encode())[:16]
            )
            path = LIVE / "NationalAssembly" / "pdfs" / f"{safe}.pdf"
            path.write_bytes(pr.content)
            self.counts["pdfs"] += 1
            self.record(
                {
                    "event": "instrument_pdf",
                    "source": "NationalAssembly",
                    "title": title,
                    "url": pdf_url,
                    "fetched_at": now_iso(),
                    "content_hash": sha256_bytes(pr.content),
                    "extraction_method": "pdf",
                    "raw_storage_key": str(path.relative_to(ROOT)),
                    "trust_level": "trusted",
                }
            )
            print(f"[NationalAssembly] {title[:70]}", flush=True)

    def run(self) -> int:
        print("Starting bootstrap harvest (public sources only)...", flush=True)
        self.harvest_pakistancode()
        self.harvest_nasirlawsite()
        self.harvest_national_assembly()
        summary = {
            "event": "summary",
            "fetched_at": now_iso(),
            "counts": self.counts,
            "provenance": str(self.prov_path.relative_to(ROOT)),
        }
        self.record(summary)
        print(json.dumps(summary, indent=2), flush=True)
        ok = self.counts["errors"] < 20 and self.counts["fetched"] > 0
        return 0 if ok else 1


def main() -> int:
    h = Harvester()
    try:
        return h.run()
    finally:
        h.close()


if __name__ == "__main__":
    sys.exit(main())
