# PAKISTANI LEGAL CORPUS SERVICE — COMPLETE BUILD PROMPT
# Version: FINAL_2 — 7 September 2026
# Supersedes FINAL_SCRAPER_PROMPT_1. Amended per SIKANDER AI Layer 17,
# Annex B (items B-1 to B-10). Source policy per the ruling of
# 21 August 2026 and Layer 17 Erratum E-6.
# Usage: Copy from the line below and paste into any AI platform
# ─────────────────────────────────────────────────────────────────

You are a senior Python engineer. Build a complete, production-ready
legal corpus service for Pakistani case law and legislation. This is a
standalone cloud application, deployed in its own cloud project with its
own credentials. It is NOT part of the SIKANDER AI application and never
shares a runtime or a store with it. Its only job is to lawfully ingest
Pakistani legal material 24/7 from the sources in Section 1, extract
judgments, citations, statutory text (with version history) and treatment
of authorities, and write them into a firm-owned PostgreSQL corpus whose
schema is the Legal Corpus Interface Contract (Section 3). The SIKANDER AI
application connects to that database READ-ONLY through its Database
Connector. Nothing is ever exported from this service into the
application, and nothing from the application is ever written here.

GOVERNING SOURCE POLICY — READ FIRST
  1. Public government portals (superior courts, pakistancode.gov.pk,
     National and provincial assemblies, the Gazette) are ingested in full,
     respecting robots.txt and polite rate limits.
  2. Open non-governmental sites are ingested with full provenance and
     'review' trust until a human verifies the source.
  3. Subscription databases behind login (PakistanLawSite and the like)
     are ingested ONLY by (a) a licensed API where the publisher offers one,
     or (b) authenticated manual export files placed in the /imports
     directory by a human. This service does NOT log in to any such site.
     Login-form discovery, credential-slot rotation and failover are
     disabled by configuration (ALLOW_LOGIN_SCRAPING=false, non-overridable
     in production). The CredentialManager class is retained ONLY for
     licensed-API token handling.
  4. This service holds NO legal rules of its own — no limitation periods,
     no court-fee schedules. Those are master knowledge owned by the
     application. The courts table is reference data only.

Write every file completely. Zero placeholders. Zero TODO comments.
Zero pass stubs. Every function must have real working code.
Deliver all 33 files in order. Do not stop until all 33 are written.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — THE SOURCES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


All source configuration lives in the database table scraper_sources.
The service reads these flags at the start of every job.
Nothing is hardcoded. The admin dashboard controls everything.

Access methods (column access_method):
  public        — open HTTP/Playwright fetch, robots.txt respected
  licensed_api  — vendor API with a key held in Fernet-encrypted config
  import_folder — a human drops export files (PDF/HTML/CSV/JSON) into
                  /imports/<source_name>/ ; the service parses them
No source ever uses a login form. requires_login is ALWAYS FALSE.

SOURCE 1 — PakistanLawSite
  URL:             https://www.pakistanlawsite.com
  Access:          licensed_api if the firm holds a licence, else
                   import_folder. NEVER login scraping.
  Case law:        YES — PLD, SCMR, CLC, YLR, MLD, PCr.LJ (from exports/API)
  Statutes:        YES (from exports/API)
  Trust level:     trusted → auto-promote to contract tables
  Frequency:       every 6 hours (poll API or scan import folder)

SOURCE 2 — NasirLawSite
  URL:             https://www.nasirlawsite.com
  Access:          public
  Case law:        YES
  Statutes:        YES
  Trust level:     review → quarantine until a human verifies the source
  Frequency:       every 6 hours

SOURCE 3 — PakistanCode
  URL:             https://pakistancode.gov.pk
  Access:          public
  Case law:        NO
  Statutes:        YES — official federal statute database, WITH amendment
                   history (Section 6, B-5)
  Trust level:     trusted → auto-promote
  Frequency:       every 48 hours

SOURCE 4 — Sindh High Court
  URL:             https://www.shc.gov.pk
  Access:          public (Playwright, PDFs)
  Case law:        YES
  Statutes:        NO
  Trust level:     review → quarantine queue
  Frequency:       every 12 hours

SOURCE 5 — Supreme Court of Pakistan
  URL:             https://www.supremecourt.gov.pk
  Access:          public (Playwright, PDFs)
  Case law:        YES
  Statutes:        NO
  Trust level:     review → quarantine queue
  Frequency:       every 12 hours

SOURCE 6 — National Assembly
  URL:             https://na.gov.pk/en/legis.php
  Access:          public
  Case law:        NO
  Statutes:        YES — PDF Acts and Ordinances (amending instruments)
  Trust level:     trusted → auto-promote
  Frequency:       every 168 hours

SOURCE 7 — Lahore High Court
  URL:             https://lhc.gov.pk          Access: public (Playwright, PDFs)
  Case law: YES   Statutes: NO   Trust: review   Frequency: every 12 hours

SOURCE 8 — Peshawar High Court
  URL:             https://peshawarhighcourt.gov.pk   Access: public
  Case law: YES   Statutes: NO   Trust: review   Frequency: every 12 hours

SOURCE 9 — Balochistan High Court
  URL:             https://bhc.gov.pk          Access: public
  Case law: YES   Statutes: NO   Trust: review   Frequency: every 12 hours

SOURCE 10 — Islamabad High Court
  URL:             https://ihc.gov.pk          Access: public
  Case law: YES   Statutes: NO   Trust: review   Frequency: every 12 hours

SOURCE 11 — Federal Shariat Court
  URL:             https://federalshariatcourt.gov.pk   Access: public
  Case law: YES   Statutes: NO   Trust: review   Frequency: every 24 hours

SOURCE 12 — Provincial Assemblies (Sindh, Punjab, KP, Balochistan)
  URLs:            https://www.pas.gov.pk  https://www.pap.gov.pk
                   https://www.pakp.gov.pk  https://www.pabalochistan.gov.pk
  Access: public   Case law: NO   Statutes: YES (provincial Acts/Ordinances)
  Trust: trusted   Frequency: every 168 hours
  jurisdiction is set per assembly.

SOURCE 13 — Gazette of Pakistan (Printing Corporation)
  URL:             https://www.pcp.gov.pk (Gazette section)
  Access: public   Case law: NO   Statutes: YES — SROs, notifications, rules
  Trust: trusted   Frequency: every 24 hours

For every superior-court source the discovery, PDF download and text
extraction logic is identical to Sources 4 and 5 (Section 6). Court
homepages change; every court connector has a drift monitor: if a
listing page yields zero PDF links for two consecutive jobs, raise
a quarantine_queue row with reason 'connector_drift' and notify admin.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — WHAT TO EXTRACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


For every scraped JUDGMENT extract all of these fields:

  citations        array — every reporter citation the judgment carries,
                   e.g. ["PLD 2019 SC 456", "2019 SCMR 1100"]; a judgment
                   may have several (Section 3, table citation)
  case_title       e.g. "Muhammad Ali v. State"
  court            e.g. "Supreme Court" or "High Court Sindh" → court_id
  judge_names      array of all judges on the bench → judge_ids
  bench_size       integer — number of judges parsed after CORAM / BENCH /
                   PRESENT
  bench_type       one of: single division full larger — infer from
                   bench_size and phrases "Full Bench", "Larger Bench",
                   "Division Bench"
  decision_date    date if detectable
  year             integer
  full_text        complete judgment text stripped of all HTML
  summary          first 500 words extracted automatically
  headnotes        headnote text if present on the page
  statutes_cited   array — all Acts and Sections mentioned in text, each
                   as {statute_name, section_number}
  citations_cited  array — all case citations referenced in text
  is_landmark      boolean (derived nightly; never asserted at extraction)
  source_url       exact URL scraped (or import file path)
  confidence_score float 0.0 to 1.0
  scraped_at       timestamp

For every STATUTE SECTION extract all of these fields, ONE ROW PER VERSION:

  statute_name     e.g. "Pakistan Penal Code 1860"
  short_name       e.g. "PPC"
  section_number   e.g. "302"
  section_title    e.g. "Punishment of murder"
  section_text     complete text of this version of the section
  chapter          chapter name or number within the Act
  year_enacted     integer
  effective_from   date this text came into force
  effective_to     date it ceased (NULL = current)
  amending_instrument  the Act/Ordinance/SRO that produced this version,
                   if detectable (pakistancode footnotes, Gazette, NA PDFs)
  version_confidence  1.0 where the source states the amendment history;
                   0.5 where only current text is available (then
                   effective_from = last_amended if detectable else
                   year_enacted; effective_to = NULL)
  jurisdiction     one of: Federal Sindh Punjab KP Balochistan ICT GB AJK
  source_url       exact URL scraped

For every AMENDING / SUBORDINATE INSTRUMENT (Sources 6, 12, 13):
  type (Act | Ordinance | SRO | Notification | Rules | Order), number,
  date, title, gazette_ref, full text, affected statute/sections where
  the instrument states them.

For every TREATMENT (nightly, Section 9):
  treating_judgment, treated_citation, treatment (followed | applied |
  distinguished | doubted | overruled | per_incuriam | referred),
  passage_anchor (surrounding 400 characters), confidence.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3 — DATABASE SCHEMA (LEGAL CORPUS INTERFACE CONTRACT)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


PostgreSQL 16. Enable pgvector and pg_trgm on startup.
Use gen_random_uuid() for all primary keys.

The contract tables below are what the SIKANDER AI application reads
(read-only role: sikander_reader). This service writes to them with the
role corpus_writer. Every contract table carries these common columns:
  id UUID PK, created_at, updated_at,
  source_id UUID → source_provenance,
  confidence FLOAT DEFAULT 0.5,
  review_status VARCHAR(20) DEFAULT 'quarantined'
      -- 'promoted' | 'quarantined' | 'rejected'
Only review_status = 'promoted' rows are visible to research; the
application shows quarantined rows to reviewers only.

─── scraper_sources (control table) ────────────────────────────────
CREATE TABLE scraper_sources (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name             VARCHAR(100) UNIQUE NOT NULL,
  source_url              VARCHAR(500) NOT NULL,
  is_active               BOOLEAN DEFAULT TRUE,
  access_method           VARCHAR(20) NOT NULL DEFAULT 'public',
      -- 'public' | 'licensed_api' | 'import_folder'
  api_key_encrypted       VARCHAR(500),   -- Fernet; NEVER plaintext; NEVER returned
  import_path             VARCHAR(500),   -- for import_folder
  jurisdiction            VARCHAR(50),
  scrape_case_law         BOOLEAN DEFAULT TRUE,
  scrape_statutes         BOOLEAN DEFAULT FALSE,
  scrape_instruments      BOOLEAN DEFAULT FALSE,
  scrape_cause_lists      BOOLEAN DEFAULT FALSE,
  scrape_bench_info       BOOLEAN DEFAULT FALSE,
  requires_login          BOOLEAN NOT NULL DEFAULT FALSE
      CHECK (requires_login = FALSE),      -- enforced: no login sources
  trust_level             VARCHAR(20) DEFAULT 'review',
      -- 'trusted' | 'review' | 'blocked'
  scrape_frequency_hours  INTEGER DEFAULT 6,
  last_scraped_at         TIMESTAMPTZ,
  next_scrape_at          TIMESTAMPTZ,
  drift_zero_runs         INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

─── source_provenance ──────────────────────────────────────────────
CREATE TABLE source_provenance (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name        VARCHAR(100),
  source_url         TEXT,
  fetched_at         TIMESTAMPTZ DEFAULT NOW(),
  content_hash       VARCHAR(64),
  extraction_method  VARCHAR(20),  -- html | pdf | ocr | manual | api | export
  extractor_version  VARCHAR(50),
  raw_ref            TEXT          -- path/key of stored raw html/pdf
);
CREATE INDEX idx_prov_hash ON source_provenance(content_hash);

─── court · judge ──────────────────────────────────────────────────
CREATE TABLE court (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(255) UNIQUE, abbreviation VARCHAR(50),
  jurisdiction VARCHAR(100), city VARCHAR(100), level VARCHAR(50)
);
CREATE TABLE judge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255), name_normalised VARCHAR(255),
  court_ids UUID[], active_from DATE, active_to DATE
);
CREATE INDEX idx_judge_norm ON judge(name_normalised);

─── judgment ───────────────────────────────────────────────────────
CREATE TABLE judgment (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_title       VARCHAR(1000),
  court_id         UUID REFERENCES court(id),
  bench_size       INTEGER,
  bench_type       VARCHAR(20),  -- single | division | full | larger
  judge_ids        UUID[],
  decision_date    DATE,
  year             INTEGER,
  full_text        TEXT,
  summary          TEXT,
  headnotes        TEXT,
  statutes_cited   JSONB,        -- [{statute_name, section_number, statute_id, section_id}]
  citations_cited  TEXT[],       -- raw citation strings found in text
  cited_judgment_ids UUID[],     -- resolved where possible
  is_landmark      BOOLEAN DEFAULT FALSE,
  citation_count   INTEGER DEFAULT 0,
  classification   VARCHAR(30) DEFAULT 'public',
  embedding        VECTOR(EMBEDDING_DIM),   -- dim substituted at migration
  source_id        UUID REFERENCES source_provenance(id),
  confidence       FLOAT DEFAULT 0.5,
  review_status    VARCHAR(20) DEFAULT 'quarantined',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_j_court ON judgment(court_id);
CREATE INDEX idx_j_year  ON judgment(year);
CREATE INDEX idx_j_status ON judgment(review_status);
CREATE INDEX idx_j_title_trgm ON judgment USING gin (case_title gin_trgm_ops);

─── judgment_version (corrigenda / re-issued text) ─────────────────
CREATE TABLE judgment_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judgment_id UUID REFERENCES judgment(id),
  version_no INTEGER, full_text TEXT, note VARCHAR(500),
  source_id UUID REFERENCES source_provenance(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

─── citation ───────────────────────────────────────────────────────
CREATE TABLE citation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judgment_id      UUID REFERENCES judgment(id),
  citation_text    VARCHAR(100) UNIQUE,   -- normalised
  reporter         VARCHAR(20),
  year             INTEGER,
  volume_or_court  VARCHAR(50),
  page             INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_cit_rep_year ON citation(reporter, year);

─── treatment ──────────────────────────────────────────────────────
CREATE TABLE treatment (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treating_judgment_id  UUID REFERENCES judgment(id),
  treated_judgment_id   UUID REFERENCES judgment(id),
  treated_citation_text VARCHAR(100),   -- kept even if unresolved
  treatment             VARCHAR(20),
  passage_anchor        TEXT,
  treating_bench_type   VARCHAR(20),
  confidence            FLOAT,
  review_status         VARCHAR(20) DEFAULT 'quarantined',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tr_treated ON treatment(treated_judgment_id);

─── statute · statute_section · statute_section_version ────────────
CREATE TABLE statute (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500), short_name VARCHAR(50), year_enacted INTEGER,
  jurisdiction VARCHAR(50), status VARCHAR(20) DEFAULT 'in_force',
      -- in_force | repealed | lapsed
  source_id UUID REFERENCES source_provenance(id),
  confidence FLOAT DEFAULT 0.5, review_status VARCHAR(20) DEFAULT 'quarantined',
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, jurisdiction)
);
CREATE TABLE statute_section (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statute_id UUID REFERENCES statute(id),
  section_number VARCHAR(50), chapter VARCHAR(255), current_title VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(statute_id, section_number)
);
CREATE TABLE instrument (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20),  -- Act | Ordinance | SRO | Notification | Rules | Order
  number VARCHAR(100), date DATE, title VARCHAR(1000), gazette_ref VARCHAR(255),
  full_text TEXT, jurisdiction VARCHAR(50),
  source_id UUID REFERENCES source_provenance(id),
  confidence FLOAT DEFAULT 0.5, review_status VARCHAR(20) DEFAULT 'quarantined',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE statute_section_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id UUID REFERENCES statute_section(id),
  version_no INTEGER,
  effective_from DATE, effective_to DATE,         -- NULL = current
  title VARCHAR(500), text TEXT,
  amending_instrument_id UUID REFERENCES instrument(id),
  version_confidence FLOAT DEFAULT 0.5,
  embedding VECTOR(EMBEDDING_DIM),
  source_id UUID REFERENCES source_provenance(id),
  confidence FLOAT DEFAULT 0.5, review_status VARCHAR(20) DEFAULT 'quarantined',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(section_id, version_no)
);
CREATE INDEX idx_ssv_section_eff ON statute_section_version(section_id, effective_from);

─── corpus_metadata ────────────────────────────────────────────────
CREATE TABLE corpus_metadata (
  key VARCHAR(50) PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- keys: embedding_model, embedding_dim, schema_version, last_refresh,
--       counts_by_table (json), deploy_region

─── internal tables (not part of the contract) ─────────────────────
scraper_staging, statutes_staging, scraper_jobs, quarantine_queue,
embedding_queue — as defined below.

CREATE TABLE scraper_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site VARCHAR(100), source_url TEXT, raw_html TEXT, raw_text TEXT,
  extracted_citations TEXT[], extracted_title VARCHAR(1000),
  extracted_court VARCHAR(255), extracted_year INTEGER,
  extracted_bench_size INTEGER, extracted_bench_type VARCHAR(20),
  normalised BOOLEAN DEFAULT FALSE, normalised_at TIMESTAMPTZ,
  promoted BOOLEAN DEFAULT FALSE, promoted_at TIMESTAMPTZ,
  quarantined BOOLEAN DEFAULT FALSE, quarantine_reason VARCHAR(500),
  confidence_score FLOAT DEFAULT 0.5, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE statutes_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site VARCHAR(100), source_url TEXT, raw_html TEXT,
  statute_name VARCHAR(500), section_number VARCHAR(50), section_text TEXT,
  effective_from DATE, effective_to DATE, amending_instrument VARCHAR(500),
  version_confidence FLOAT DEFAULT 0.5,
  normalised BOOLEAN DEFAULT FALSE, promoted BOOLEAN DEFAULT FALSE,
  quarantined BOOLEAN DEFAULT FALSE, confidence_score FLOAT DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE scraper_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_site VARCHAR(100), job_type VARCHAR(50), status VARCHAR(30),
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  pages_scraped INTEGER DEFAULT 0, records_extracted INTEGER DEFAULT 0,
  records_staged INTEGER DEFAULT 0, records_promoted INTEGER DEFAULT 0,
  records_quarantined INTEGER DEFAULT 0, error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE quarantine_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_table VARCHAR(50), record_id UUID, staging_id UUID,
  source_site VARCHAR(100), source_url TEXT,
  extracted_citation VARCHAR(500), extracted_title VARCHAR(1000),
  reason VARCHAR(500),
      -- parse_failed | low_confidence | review_source | treatment_uncertain
      -- | connector_drift | version_ambiguous
  reviewed BOOLEAN DEFAULT FALSE, review_action VARCHAR(50),
  reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE embedding_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id UUID NOT NULL, table_name VARCHAR(50) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending', attempts INTEGER DEFAULT 0,
  error TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_eq_status ON embedding_queue(status);

There is NO limitation_periods table. Legal rules are not held here.

DATABASE ROLES (migration creates both):
  corpus_writer   — this service; INSERT/UPDATE on all tables
  sikander_reader — the application; SELECT only on contract tables;
                    no access to internal tables or raw_html



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4 — PER-SOURCE JOB LOGIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


At the start of EVERY job, read the source row from scraper_sources.
Never hardcode what a source ingests. Always read from database.

  source = await db.get_source(source_name)

  if not source.is_active:
      logger.info(f"{source_name} is inactive. Skipping.")
      return
  if source.trust_level == 'blocked':
      logger.info(f"{source_name} is blocked. Skipping.")
      return

  # Build the fetcher for the access method. There is no login path.
  if source.access_method == 'public':
      client = httpx.AsyncClient(headers=UA, follow_redirects=True, timeout=30.0)
      fetcher = PublicFetcher(client, robots=RobotsCache())
  elif source.access_method == 'licensed_api':
      token = CredentialManager(source, db).get_api_token()   # decrypt only
      fetcher = ApiFetcher(source.source_url, token)
  elif source.access_method == 'import_folder':
      fetcher = ImportFolderFetcher(source.import_path)
  else:
      raise ValueError(f"Unknown access_method {source.access_method}")

  if settings.ALLOW_LOGIN_SCRAPING:
      # Must never be true in production; the Settings class raises on it
      # when ENVIRONMENT == 'production'.
      logger.critical("ALLOW_LOGIN_SCRAPING is set. Refusing to run.")
      return

  if source.scrape_case_law:
      await run_case_law_pipeline(source, db, fetcher)
  if source.scrape_statutes:
      await run_statute_pipeline(source, db, fetcher)
  if source.scrape_instruments:
      await run_instrument_pipeline(source, db, fetcher)
  if source.scrape_cause_lists:
      await run_cause_list_pipeline(source, db, fetcher)
  if source.scrape_bench_info:
      await run_bench_info_pipeline(source, db, fetcher)

  await fetcher.aclose()

One fetcher is shared by all pipelines ticked for a source.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5 — CREDENTIAL MANAGER (LICENSED-API TOKENS ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


STATUS OF THIS SECTION (Layer 17, Annex B, item B-1):
The dual-credential login failover of FINAL_SCRAPER_PROMPT_1 is
WITHDRAWN. The service never presents a login form. The class below is
retained for one purpose only: to hold and decrypt a licensed vendor
API key. The rules below govern.

RULE 1 — CredentialManager exposes get_api_token() and set_api_token().
         Nothing else is public.
RULE 2 — There is NO _login(), NO handle_session_failure(), NO
         scrape_with_auth(), NO slot rotation, NO try_recover_primary().
         Do not write them. Do not port them from the earlier prompt.
RULE 3 — A licensed API returning 401/403 is a configuration failure:
         mark the job 'failed', raise an admin notification, stop that
         source. Never retry with different credentials.
RULE 4 — API keys are Fernet-encrypted at rest and NEVER returned by any
         endpoint; the API returns "CONFIGURED" or "NOT SET" only.
RULE 5 — settings.ALLOW_LOGIN_SCRAPING defaults to False; the Settings
         validator raises if it is True while ENVIRONMENT == 'production'.

class CredentialManager:
    """Holds a licensed vendor API token. No login capability."""

    def __init__(self, source, db):
        self.source = source
        self.db = db

    def get_api_token(self) -> str:
        if self.source.access_method != 'licensed_api':
            raise ValueError("Source is not a licensed API")
        token = self._decrypt(self.source.api_key_encrypted)
        if not token:
            raise ConfigurationError(
                f"No API key configured for {self.source.source_name}")
        return token

    async def set_api_token(self, plaintext: str) -> None:
        self.source.api_key_encrypted = self._encrypt(plaintext)
        await self.db.commit()

    def _encrypt(self, plaintext: str) -> str:
        from cryptography.fernet import Fernet
        from config import settings
        return Fernet(settings.ENCRYPTION_KEY.encode()
                      ).encrypt(plaintext.encode()).decode()

    def _decrypt(self, encrypted: str) -> str:
        if not encrypted:
            return ""
        from cryptography.fernet import Fernet
        from config import settings
        try:
            return Fernet(settings.ENCRYPTION_KEY.encode()
                          ).decrypt(encrypted.encode()).decode()
        except Exception:
            return ""


class ApiFetcher:
    """Fetches from a licensed vendor API with a bearer token."""
    def __init__(self, base_url: str, token: str):
        self.client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}", "User-Agent": UA["User-Agent"]},
            timeout=30.0)
    async def get(self, path: str, **params):
        r = await self.client.get(path, params=params)
        if r.status_code in (401, 403):
            raise ConfigurationError(f"Licensed API rejected key: HTTP {r.status_code}")
        r.raise_for_status()
        return r
    async def aclose(self): await self.client.aclose()


class ImportFolderFetcher:
    """Parses human-placed export files; moves each to /processed after use."""
    def __init__(self, import_path: str):
        self.path = pathlib.Path(import_path)
        self.processed = self.path / "processed"
        self.processed.mkdir(parents=True, exist_ok=True)
    def list_files(self):
        return sorted(p for p in self.path.iterdir()
                      if p.is_file() and p.suffix.lower() in
                      (".pdf", ".html", ".htm", ".csv", ".json", ".txt"))
    def read(self, p: pathlib.Path) -> bytes:
        return p.read_bytes()
    def mark_done(self, p: pathlib.Path):
        p.rename(self.processed / p.name)
    async def aclose(self): pass


class PublicFetcher:
    """Polite public fetcher: robots.txt, delay, 429 backoff, drift count."""
    def __init__(self, client, robots):
        self.client, self.robots = client, robots
    async def get(self, url: str):
        if not await self.robots.allowed(url):
            raise RobotsDisallowed(url)
        for wait in (0, 60, 120, 240):
            if wait: await asyncio.sleep(wait)
            r = await self.client.get(url)
            if r.status_code != 429:
                await asyncio.sleep(random.uniform(
                    settings.SCRAPER_DELAY_MIN, settings.SCRAPER_DELAY_MAX))
                return r
        raise RateLimited(url)
    async def aclose(self): await self.client.aclose()

Non-switching error handling (unchanged in spirit):
  HTTP 404 → skip page.  HTTP 500 → log, continue.  Parse failure →
  raw storage + quarantine, continue.  Empty page → log, continue.
  PDF extraction error → log, try OCR, continue.  Timeout → wait 10s,
  retry once, then skip.  Nothing ever causes a credential change,
  because there are no credentials to change.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 6 — REAL URLS AND PARSING STRATEGIES PER SOURCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For every source the parser must try selectors in the order given.
If selector A fails, try B. If B fails, try C.
If ALL fail, store raw HTML with confidence_score=0.1
and send to quarantine. NEVER crash. NEVER skip raw storage.

─── NasirLawSite (no login) ────────────────────────────────────────

Case law reporter index pages:
  https://www.nasirlawsite.com/case/scmr.htm
  https://www.nasirlawsite.com/case/pld.htm
  https://www.nasirlawsite.com/case/clc.htm
  https://www.nasirlawsite.com/case/ylr.htm
  https://www.nasirlawsite.com/case/mld.htm

Individual case page selectors (try in this order):
  Bench (B-10):
    A) text following "CORAM:", "BENCH:" or "PRESENT:" — count judge names
       (split on commas / "and" / line breaks; strip "J.", "C.J.", "Justice")
    B) phrases "Full Bench", "Larger Bench", "Division Bench" → bench_type
    C) if only one name → single; two → division; three or more without a
       Full/Larger phrase → full

  Citation:
    A) soup.find(class_="citation")
    B) soup.find("td", string=re.compile(r'\b(PLD|SCMR|CLC|YLR|MLD)\b'))
    C) first <b> or <strong> tag that matches any CITATION_PATTERN
    D) regex CITATION_PATTERNS applied to full page text
  Case title:
    A) soup.find(class_="title") or soup.find("h2")
    B) soup.find("td", string=re.compile(r'\bv\.\s+', re.IGNORECASE))
    C) largest <h1> or <h3> tag on the page
  Full text:
    A) soup.find(class_="judgment-text")
    B) soup.find("div", id="content")
    C) soup.find("div", id="main")
    D) largest <td> block by character count
  Judge names:
    A) text following label "BENCH:" or "CORAM:" in full text
    B) opening paragraph of full text before "JUDGMENT"

Statute pages on NasirLawSite:
  https://www.nasirlawsite.com/laws/ppc.htm
  https://www.nasirlawsite.com/laws/crpc.htm
  https://www.nasirlawsite.com/laws/cpc.htm
  https://www.nasirlawsite.com/laws/cnsa.htm
  https://www.nasirlawsite.com/laws/mflo.htm
  https://www.nasirlawsite.com/laws/laws.htm  (index of all laws)

Section extraction (try in order):
  A) soup.find_all("p", class_="section")
  B) soup.find_all("div", class_="section-body")
  C) soup.find_all("p") filtered where text starts with digit
  D) re.split(r'\n\s*(\d+[A-Z]?)\.\s', full_text)
  E) re.split(r'\nSection\s+\d+', full_text)

─── PakistanCode (no login) ────────────────────────────────────────

Main index: https://pakistancode.gov.pk/federal
Act URL pattern: https://pakistancode.gov.pk/english/statues/details/{slug}

Statute page selectors (try in order):
  Amendment history (B-5) — capture BEFORE section text:
    A) footnote / margin markers ("Subs. by Act X of YYYY, s.N", "Ins. by",
       "Omitted by", "Added by") attached to a section → one version row
       per marker, effective_from = date of the amending instrument where
       stated, else year of the instrument
    B) an "Amendments" or "History" panel on the section page
    C) none found → single version, version_confidence = 0.5,
       effective_from = last_amended if detectable else year_enacted
  Act title:
    A) soup.find("h1", class_="act-title")
    B) soup.find("h1")
    C) soup.find("h2")
  Section list:
    A) soup.find_all("div", class_="section")
    B) soup.find_all("article", class_="section-body")
    C) soup.find_all("p") where text[0].isdigit()
  Section number within each element:
    A) element.find("span", class_="section-no")
    B) element.find("strong") where text matches r'^\d+'
    C) re.match(r'^\s*(\d+[A-Z]?)[\.\)]', element.text)
  Section title:
    A) element.find(class_="section-title")
    B) first sentence of section text before full stop
  Section text:
    A) element.find(class_="section-content")
    B) all text after the section number in that block

Target statute slugs (scrape all of these):
  ppc1860             crpc1898            cpc1908
  constitution1973    limitation-act1908  specific-relief-act1877
  transfer-of-property-act1882           contract-act1872
  evidence-act1872    companies-act2017   partnership-act1932
  income-tax-ordinance2001               sales-tax-act1990
  arbitration-act1940  stamp-act1899
  muslim-family-laws-ordinance1961       family-courts-act1964
  guardians-and-wards-act1890            succession-act1925
  anti-terrorism-act1997                 cnsa1997
  peca2016            nab-ordinance1999

─── National Assembly (no login, PDF-based) ────────────────────────

Index: https://na.gov.pk/en/legis.php
Find PDF links: soup.find_all("a", href=re.compile(r'\.pdf$', re.I))
Filter: only links where link text contains "Act" OR "Ordinance" OR "Bill"
Download each PDF → pdfplumber extraction → section splitting

─── Sindh High Court (no login, Playwright, PDFs) ──────────────────

from playwright.async_api import async_playwright

async with async_playwright() as p:
    browser = await p.chromium.launch(headless=True)
    page = await browser.new_page()
    await page.goto(
        "https://www.shc.gov.pk/judgments",
        timeout=30000
    )
    await page.wait_for_load_state("networkidle", timeout=30000)
    links = await page.query_selector_all("a[href$='.pdf']")
    pdf_urls = [await link.get_attribute("href") for link in links]
    await browser.close()

For each PDF URL:
  Download using httpx
  Extract text with pdfplumber:
    with pdfplumber.open(pdf_bytes) as pdf:
        text = "\n".join(
            page.extract_text() or "" for page in pdf.pages
        )
  If text is empty (scanned PDF): pytesseract OCR on page images
  Parse extracted text using CITATION_PATTERNS and STATUTE_PATTERNS

─── Supreme Court of Pakistan (no login, Playwright, PDFs) ─────────

Same Playwright approach as SHC.
Target URL: https://www.supremecourt.gov.pk/judgements/

─── PakistanLawSite (login required, dual credentials) ─────────────


─── Superior courts other than SHC / SC (Sources 7–11) ─────────────

Same Playwright approach. Listing URLs to try in order for each court
(the first that yields PDF links wins; record which worked in
scraper_sources.source_url_resolved):
  Lahore HC:         /judgments  /reported-judgments  /judgment-search
  Peshawar HC:       /judgments  /latest-judgments
  Balochistan HC:    /judgments  /reported-judgments
  Islamabad HC:      /judgments  /reported_judgments  /caselaw
  Federal Shariat:   /judgments  /reported-judgments
Zero PDF links on two consecutive jobs → quarantine 'connector_drift'.

─── Provincial assemblies and Gazette (Sources 12–13) ──────────────

Find PDF links: soup.find_all("a", href=re.compile(r'\.pdf$', re.I))
Filter: link text contains "Act" OR "Ordinance" OR "Bill" OR "S.R.O" OR
"Notification" OR "Rules". Download → pdfplumber → instrument row →
section splitting where the instrument is a principal Act; where it is
an amending instrument, parse "In section N of the … Act … for the words
… the following shall be substituted" patterns to produce
statute_section_version rows against the principal statute.

─── PakistanLawSite (Source 1 — licensed API or import folder) ─────

NO LOGIN. Two paths:

  licensed_api:
    Use ApiFetcher with the vendor's documented endpoints. Map the
    vendor's fields to Section 2's judgment / citation / statute fields.
    Unknown vendor fields are kept in source_provenance.raw_ref (JSON).

  import_folder (/imports/PakistanLawSite/):
    A human exports search results or judgments under the firm's own
    subscription and drops the files here. For each file:
      .pdf / .html → same judgment parser as NasirLawSite (selectors
                     A–D, regex fallback), extraction_method='export'
      .csv / .json → column mapping in config (import_map.yaml);
                     mandatory columns: citation, case_title, full_text
    Every record's source_url = "import://PakistanLawSite/<filename>".
    Move the file to /processed after successful staging.

No discovery of navigation, no search-form use, no URL probing on the
live site. If access_method is 'public' for this source the job refuses
to run and raises an admin notification.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 7 — CITATION AND STATUTE REGEX PATTERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import re

CITATION_PATTERNS = [
    # PLD 2019 SC 456  or  PLD 2019 Kar. 100
    re.compile(
        r'\bPLD\s+(\d{4})\s+'
        r'([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)?)\s+(\d+)\b'
    ),
    # 2021 SCMR 1234
    re.compile(r'\b(\d{4})\s+SCMR\s+(\d+)\b'),
    # 2020 CLC 500
    re.compile(r'\b(\d{4})\s+CLC\s+(\d+)\b'),
    # 2019 YLR 2190
    re.compile(r'\b(\d{4})\s+YLR\s+(\d+)\b'),
    # 2018 MLD 450
    re.compile(r'\b(\d{4})\s+MLD\s+(\d+)\b'),
    # 2017 PCr.LJ 300
    re.compile(r'\b(\d{4})\s+PCr\.?LJ\s+(\d+)\b'),
    # 2020 PTD 1500
    re.compile(r'\b(\d{4})\s+PTD\s+(\d+)\b'),
    # 2019 PTCL 200
    re.compile(r'\b(\d{4})\s+PTCL\s+(\d+)\b'),
]

STATUTE_PATTERNS = [
    # Section 302 of the Pakistan Penal Code 1860
    re.compile(
        r'\bSection\s+([\dA-Z\-]+(?:\([a-z]+\))?)\s+'
        r'(?:of\s+(?:the\s+)?)?'
        r'([A-Z][A-Za-z\s&,]+(?:Act|Ordinance|Code|Order|Rules|Constitution)'
        r'(?:\s+\d{4})?)\b'
    ),
    # Article 199 of the Constitution
    re.compile(
        r'\bArticle\s+([\dA-Z\-]+(?:\([a-z]+\))?)'
        r'\s+of\s+(?:the\s+)?Constitution\b'
    ),
    # Order XVII Rule 1 CPC
    re.compile(
        r'\bOrder\s+([IVXLCDM\d]+)\s+Rule\s+(\d+[A-Z]?)'
        r'\s+(?:of\s+)?(?:the\s+)?CPC\b'
    ),
    # Rule 5 of the High Court Rules
    re.compile(
        r'\bRule\s+(\d+[A-Z]?)\s+of\s+(?:the\s+)?'
        r'([A-Z][A-Za-z\s]+Rules)\b'
    ),
]

CONFIDENCE SCORING — assign before every staging write:
  1.0  Citation verified by pattern, all fields extracted cleanly
  0.8  Citation found, most fields present, minor gaps
  0.6  Citation inferred from context, some fields missing
  0.4  Case title found but no structured citation extracted
  0.2  Only URL and raw text stored, no structured fields
  0.1  Parser failed entirely, raw HTML only

PROMOTION RULES:
  Trusted source + confidence >= 0.5  → auto-promote to master
  Trusted source + confidence < 0.5   → quarantine for review
  Review source (any confidence)       → always quarantine
  Blocked source                       → never scrape

DEDUPLICATION:
  Before inserting to staging, check:
    SELECT judgment_id FROM citation WHERE citation_text = %s
  for EVERY citation extracted from the page. If any matches, attach
  any NEW citations to the existing judgment row and skip the rest.
  Judgments with no reporter citation (fresh court PDFs) are deduplicated
  on (court_id, decision_date, normalised case_title, content_hash).




━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 8 — STATUTE TARGETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Scrape all of these statutes, section by section.
Primary source: pakistancode.gov.pk
Secondary source: nasirlawsite.com (used if PakistanCode fails)

PRIORITY 1 — Criminal:
  Pakistan Penal Code 1860 (PPC)
  Code of Criminal Procedure 1898 (CrPC)
  Control of Narcotic Substances Act 1997 (CNSA)
  Anti-Terrorism Act 1997 (ATA)
  National Accountability Bureau Ordinance 1999 (NAB Ordinance)
  Prevention of Electronic Crimes Act 2016 (PECA)
  Offences Against Property (Enforcement of Hudood) Ordinance 1979

PRIORITY 2 — Civil:
  Code of Civil Procedure 1908 (CPC) — all Orders and Rules
  Limitation Act 1908
  Specific Relief Act 1877
  Transfer of Property Act 1882
  Contract Act 1872
  Qanun-e-Shahadat Order 1984 (Evidence)

PRIORITY 3 — Constitutional:
  Constitution of Pakistan 1973 — all Articles
  Supreme Court Rules 1980
  Sindh High Court Rules

PRIORITY 4 — Corporate / Commercial:
  Companies Act 2017
  Partnership Act 1932
  Income Tax Ordinance 2001
  Sales Tax Act 1990
  Arbitration Act 1940
  Stamp Act 1899

PRIORITY 5 — Family:
  Muslim Family Laws Ordinance 1961
  West Pakistan Family Courts Act 1964
  Child Marriage Restraint Act 1929
  Guardians and Wards Act 1890
  Succession Act 1925


For every statute above, the target is the FULL VERSION HISTORY, not
the current text alone (Section 2, B-5). Provincial statutes for Sindh
(Sindh Court Fees Act 2024, Sindh Rented Premises Ordinance 1979, Sindh
Land Revenue Act 1967, Sindh Building Control Ordinance 1979) are added
as PRIORITY 6 from Source 12.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 9 — BACKGROUND WORKERS AND SCHEDULER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


CELERY BEAT SCHEDULE (all times PKT = UTC+5):
  scrape_pakistanlawsite        every 6 hours   (API poll / import scan)
  scrape_nasirlawsite           every 6 hours
  scrape_pakistancode           every 48 hours
  scrape_shc                    every 12 hours
  scrape_supremecourt           every 12 hours
  scrape_lhc, scrape_phc, scrape_bhc, scrape_ihc   every 12 hours
  scrape_fsc                    every 24 hours
  scrape_nationalassembly       every 168 hours
  scrape_provincial_assemblies  every 168 hours
  scrape_gazette                every 24 hours
  process_embedding_queue       every 5 minutes
  classify_treatment            daily at 02:00 PKT   (B-7)
  cross_reference_citations     daily at 03:00 PKT
  refresh_corpus_metadata       daily at 04:00 PKT
  quarantine_digest_email       daily at 09:00 PKT

EMBEDDING WORKER (B-6):
  On startup: read EMBEDDING_MODEL and EMBEDDING_DIM from settings;
  compare with corpus_metadata.embedding_model / embedding_dim. If the
  keys exist and differ → log CRITICAL and refuse to run. If absent →
  write them. Migration 001 substitutes EMBEDDING_DIM into VECTOR(n).
  SELECT * FROM embedding_queue WHERE status='pending' LIMIT 50
  For each record:
    judgment → embed_text = " ".join(citation_texts) + " " + case_title
               + " " + full_text[:2000]
    statute_section_version → embed_text = statute name + " s." +
               section_number + " " + title + " " + text[:2000]
    Call the configured provider (openai or a local model) with
    EMBEDDING_MODEL; store the vector; SET status='done'.
    Rate limit: EMBEDDING_RPM_LIMIT per minute (sleep as needed).
    Failure: attempts += 1, error stored; status='failed' after 5.

TREATMENT WORKER (B-7) — classify_treatment, nightly 02:00 PKT:
  For each judgment promoted since the last run:
    For each string in citations_cited:
      Resolve to treated_judgment_id via citation.citation_text (may be NULL).
      Take the 400 characters surrounding the citation in full_text.
      Deterministic patterns FIRST (case-insensitive):
        r"\boverrul"          → overruled
        r"per incuriam"       → per_incuriam
        r"not good law|no longer good law" → overruled
        r"\bdistinguish"      → distinguished
        r"\bdoubt"            → doubted
        r"\bfollow|\bapplied|\brelied upon|approved" → followed / applied
        r"\breferred|see also" → referred
      Deterministic hit → confidence 0.9.
      No hit → call the configured LLM (settings.TREATMENT_MODEL) with the
      passage and the closed label set; parse JSON {treatment, confidence}.
      Write a treatment row with treating_bench_type = the judgment's
      bench_type. confidence < 0.7 → review_status='quarantined' and a
      quarantine_queue row with reason 'treatment_uncertain'; otherwise
      review_status='promoted'.

CITATION CROSS-REFERENCE WORKER (nightly 03:00 PKT):
  UPDATE judgment j SET citation_count = (
      SELECT COUNT(*) FROM treatment t
      WHERE t.treated_judgment_id = j.id AND t.review_status='promoted');
  UPDATE judgment SET is_landmark = (citation_count >= 10);
  citation_count is a derived statistic only; it never substitutes for
  the treatment table when the application decides whether an authority
  is still good law.

CORPUS METADATA WORKER (nightly 04:00 PKT):
  Write counts_by_table (json), last_refresh, schema_version,
  deploy_region into corpus_metadata.

SERVICE MANDATORY RULES:
  1. NEVER crash on parse failure — wrap everything in try/except
  2. ALWAYS write raw html/pdf reference to source_provenance and staging
     BEFORE attempting any parsing
  3. ALWAYS check robots.txt before accessing any new URL path
  4. Wait random.uniform(DELAY_MIN, DELAY_MAX) between every request
  5. Max 3 concurrent connections to any single site at once
  6. HTTP 429 backoff: wait 60s, retry; 120s, retry; 240s, retry; then
     skip the page. No credential action of any kind.
  7. Deduplicate per Section 7 before every insert
  8. Log scraper_jobs.pages_scraped every 10 pages processed
  9. PDF: try pdfplumber first; if empty or fails, try pytesseract OCR
  10. One source failure must NEVER stop other sources running
  11. Every row written to a contract table carries source_id and a
      confidence; review_status is set by the promotion rules only
  12. The service never holds or seeds legal rules



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 10 — SEED DATA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


On startup, if scraper_sources is empty, insert these rows
(source_name, source_url, access_method, scrape_case_law,
 scrape_statutes, scrape_instruments, trust_level, frequency_hours,
 jurisdiction):
 ('PakistanLawSite','https://www.pakistanlawsite.com','import_folder',
   TRUE,TRUE,FALSE,'trusted',6,'Federal'),
 ('NasirLawSite','https://www.nasirlawsite.com','public',
   TRUE,TRUE,FALSE,'review',6,'Federal'),
 ('PakistanCode','https://pakistancode.gov.pk','public',
   FALSE,TRUE,TRUE,'trusted',48,'Federal'),
 ('SindhHighCourt','https://www.shc.gov.pk','public',
   TRUE,FALSE,FALSE,'review',12,'Sindh'),
 ('SupremeCourt','https://www.supremecourt.gov.pk','public',
   TRUE,FALSE,FALSE,'review',12,'Federal'),
 ('NationalAssembly','https://na.gov.pk/en/legis.php','public',
   FALSE,TRUE,TRUE,'trusted',168,'Federal'),
 ('LahoreHighCourt','https://lhc.gov.pk','public',
   TRUE,FALSE,FALSE,'review',12,'Punjab'),
 ('PeshawarHighCourt','https://peshawarhighcourt.gov.pk','public',
   TRUE,FALSE,FALSE,'review',12,'KP'),
 ('BalochistanHighCourt','https://bhc.gov.pk','public',
   TRUE,FALSE,FALSE,'review',12,'Balochistan'),
 ('IslamabadHighCourt','https://ihc.gov.pk','public',
   TRUE,FALSE,FALSE,'review',12,'ICT'),
 ('FederalShariatCourt','https://federalshariatcourt.gov.pk','public',
   TRUE,FALSE,FALSE,'review',24,'Federal'),
 ('SindhAssembly','https://www.pas.gov.pk','public',
   FALSE,TRUE,TRUE,'trusted',168,'Sindh'),
 ('PunjabAssembly','https://www.pap.gov.pk','public',
   FALSE,TRUE,TRUE,'trusted',168,'Punjab'),
 ('KPAssembly','https://www.pakp.gov.pk','public',
   FALSE,TRUE,TRUE,'trusted',168,'KP'),
 ('BalochistanAssembly','https://www.pabalochistan.gov.pk','public',
   FALSE,TRUE,TRUE,'trusted',168,'Balochistan'),
 ('Gazette','https://www.pcp.gov.pk','public',
   FALSE,FALSE,TRUE,'trusted',24,'Federal');
PakistanLawSite.import_path = '/imports/PakistanLawSite'.

Insert the court directory (table court):
  Supreme Court of Pakistan (Islamabad, apex)
  Federal Shariat Court (Islamabad, federal)
  High Court of Sindh (Karachi; benches Hyderabad, Sukkur, Larkana)
  Lahore High Court (Lahore; benches Rawalpindi, Multan, Bahawalpur)
  Peshawar High Court (Peshawar; benches Abbottabad, D.I. Khan, Mingora, Bannu)
  High Court of Balochistan (Quetta; benches Sibi, Turbat)
  Islamabad High Court (Islamabad)
  Supreme Appellate Court Gilgit-Baltistan; AJK Supreme Court; AJK High Court
  District & Sessions Courts for Karachi (East, West, South, Central,
  Malir, Korangi, Keamari), Hyderabad, Sukkur, Larkana, Lahore,
  Rawalpindi, Multan, Faisalabad, Peshawar, Quetta, Islamabad

There is NO limitation-period seed data (B-4). Limitation periods and
court-fee rules are legal knowledge owned by the SIKANDER AI
application's Limitation Engine and are never held in this corpus.

Insert corpus_metadata rows: embedding_model, embedding_dim (from
settings), schema_version='2.0', deploy_region (from settings).



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 11 — ADMIN API AND DASHBOARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


FastAPI endpoints (all /admin/* require X-API-Key):

GET  /health
     { status, db_connected, redis_connected, total_judgments,
       total_statute_versions, total_treatments, pending_embeddings,
       quarantined, active_jobs, embedding_model, deploy_region }

GET  /dashboard            — pure HTML/CSS/JS admin dashboard
GET  /admin/sources        — all sources; api_key shown as CONFIGURED / NOT SET
PATCH /admin/sources/{name}
     Body: { scrape_case_law, scrape_statutes, scrape_instruments,
             scrape_cause_lists, scrape_bench_info,
             scrape_frequency_hours, trust_level, is_active,
             access_method, import_path }
     access_method may never be set to anything other than
     'public' | 'licensed_api' | 'import_folder' (422 otherwise).
POST /admin/sources/{name}/api-key      Body: { api_key }  → "API key updated"
     Encrypts before storing. NEVER echoes the key back.
DELETE /admin/sources/{name}/api-key    → "API key removed"
GET  /admin/sources/{name}/status
     { source_name, is_active, access_method, last_scraped, next_scrape,
       records_today_judgments, records_today_statute_versions,
       import_pending_files, drift_zero_runs }
POST /admin/sources/{name}/trigger      — immediate job
GET  /admin/imports/{name}              — list files waiting in the import folder
GET  /jobs?limit=50&source=&status=
GET  /stats
GET  /quarantine?source=&reason=&limit=50&offset=0
POST /quarantine/{id}/promote
POST /quarantine/{id}/reject
GET  /search?q=&limit=10&reporter=&year=&court=
GET  /judgments/{id}                    — includes citations and treatments
GET  /statutes?statute_name=&section=&short_name=&as_at=YYYY-MM-DD
     as_at returns the version in force on that date (default: current)
GET  /statutes/{section_id}/versions
GET  /treatments?judgment_id=
GET  /export/judgments?format=csv|jsonl  (csv excludes vectors)
GET  /export/statutes?format=csv|jsonl
GET  /contract                          — returns the contract schema as JSON
                                          for the application's mapSchema

DASHBOARD HTML — each source renders as this card (B-8):

  ┌──────────────────────────────────────────────────────────┐
  │ PakistanLawSite                [Active ✓]  [Run Now]     │
  │ https://www.pakistanlawsite.com                          │
  │                                                          │
  │ ACCESS METHOD: ( ) Public  (•) Licensed API  ( ) Import  │
  │   API key: CONFIGURED  [Replace] [Remove]                │
  │   Import folder: /imports/PakistanLawSite  3 files waiting│
  │                                                          │
  │ WHAT TO INGEST:                                          │
  │   [x] Case Law   [x] Statutes   [ ] Instruments          │
  │   [ ] Cause Lists   [ ] Bench Information                │
  │                                                          │
  │ Schedule: Every [6] hours    Trust: [Trusted ▼]          │
  │ Last run: 2 hours ago        Next run: in 4 hours        │
  │ Records today: 145 judgments  23 statute versions        │
  │ Pending review: 12           Connector drift: none       │
  │                                                          │
  │ [Save Changes]                                           │
  └──────────────────────────────────────────────────────────┘

There is no credential-slot panel, no failover indicator and no
"switch" counter anywhere in the dashboard.



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 12 — ENVIRONMENT VARIABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


.env.example — all required variables:

ENVIRONMENT=production                 # development | production
DATABASE_URL=postgresql+asyncpg://corpus_writer:password@postgres:5432/legal_corpus
READER_DATABASE_ROLE=sikander_reader   # created by migration; SELECT on contract tables only
REDIS_URL=redis://redis:6379/0

# Embeddings (B-6) — ONE model for the life of the corpus
EMBEDDING_PROVIDER=openai              # openai | local
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIM=1536
OPENAI_API_KEY=sk-...
TREATMENT_MODEL=gpt-4o-mini            # any chat model; used only for residue classification

# Generate with:
# python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
ENCRYPTION_KEY=

# Protects all /admin/* endpoints
ADMIN_API_KEY=change-this-to-a-long-random-string

# Source policy (B-1) — must remain false; Settings raises in production if true
ALLOW_LOGIN_SCRAPING=false
IMPORT_ROOT=/imports

# Data residency (B-9) — fixed by the firm's recorded decision; not a developer choice
DEPLOY_REGION=
DATA_RESIDENCY_NOTE=Region fixed by NHS Legal data-residency decision (Layer 17 L17.13a)

SCRAPER_DELAY_MIN=2
SCRAPER_DELAY_MAX=5
EMBEDDING_BATCH_SIZE=50
EMBEDDING_RPM_LIMIT=100
LOG_LEVEL=INFO
TIMEZONE=Asia/Karachi



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 13 — DOCKER COMPOSE SERVICES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Services to define in docker-compose.yml:

  api             FastAPI admin (port 8000)
  worker-scraper  Celery worker — all ingestion tasks (mounts ./imports:/imports)
  worker-embed    Celery worker — embedding queue only
  celery-beat     Beat scheduler
  celery-flower   Monitoring dashboard (port 5555)
  postgres        PostgreSQL 16 with pgvector extension
  redis           Redis 7

Postgres must run this on init:
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

All services read from the same .env file.
The compose file pins no region; region is set in the cloud project per DEPLOY_REGION.
Migration 001 creates roles corpus_writer and sikander_reader.
Add healthchecks for postgres and redis.
worker-scraper depends_on postgres and redis.
api depends_on postgres and redis.




━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 14 — TESTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write tests/test_parsers.py with these test cases:

Citation pattern tests — all must match correctly:
  "PLD 2019 SC 456"           → citation="PLD 2019 SC 456"
  "2021 SCMR 1234"            → reporter="SCMR" year=2021 page=1234
  "PLD 2020 Kar. 100"         → court="Kar."
  "2019 CLC 500"              → reporter="CLC"
  "2018 YLR 2190"             → reporter="YLR"
  "2017 MLD 450"              → reporter="MLD"
  "2016 PCr.LJ 300"           → reporter="PCr.LJ"
  "PLD 1958 SC (Pak.) 1"      → year=1958
  "2020 PTD 1500"             → reporter="PTD"
  "PLD 2023 SC (AJK) 50"     → must match

Statute pattern tests:
  "Section 302 PPC"
  "Section 9 of the CNSA 1997"
  "Article 199 of the Constitution"
  "Order XVII Rule 1 CPC"
  "Section 497 CrPC"

Confidence scoring tests:
Statute version tests (B-5):
  "Subs. by Act X of 2018, s. 3"  → amending instrument parsed, year 2018
  section with two markers        → two version rows, contiguous dates
  section with no markers         → one version, version_confidence 0.5
  GET /statutes?as_at=2015-06-01  → returns the version in force then

Bench tests (B-10):
  "CORAM: A, J. and B, J."        → bench_size 2, bench_type division
  "Full Bench ... CORAM: A, B, C" → bench_type full
  single name                     → bench_type single

Treatment tests (B-7):
  "... the ratio in PLD 2010 SC 1 stands overruled ..." → overruled, 0.9
  "... distinguished the case reported as 2015 SCMR 7 ..." → distinguished
  no pattern + LLM confidence 0.55 → quarantine 'treatment_uncertain'

Confidence scoring tests:
  Full citation + all fields  → 1.0
  Citation only               → 0.8
  No citation found           → 0.4 or lower

Promotion logic tests:
  trusted source + confidence 0.6  → promoted
  trusted source + confidence 0.4  → quarantined
  review source  + confidence 1.0  → quarantined

Source-policy tests (B-1):
  Settings(ALLOW_LOGIN_SCRAPING=True, ENVIRONMENT='production') → raises
  scraper_sources.requires_login = TRUE                          → DB CHECK rejects
  PATCH access_method='login'                                    → 422
  PakistanLawSite with access_method='public'                    → job refuses, notifies admin
  Licensed API returns 401 → job failed + admin notification; no retry with other credentials
  grep of the repository for "_login(", "handle_session_failure",
  "scrape_with_auth", "try_recover_primary"                      → zero matches

Reader-role tests:
  sikander_reader SELECT judgment            → allowed
  sikander_reader SELECT scraper_staging     → denied
  sikander_reader INSERT judgment            → denied



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 15 — FILE LIST (DELIVER ALL 33 IN ORDER)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


Deliver all 33 files. Start file 1 immediately.
Do not stop until file 33 is complete.

  1.  scraper/config.py
        Settings via pydantic-settings: all Section 12 variables; validator
        raising if ALLOW_LOGIN_SCRAPING and ENVIRONMENT == 'production'.
  2.  scraper/database.py
        Async SQLAlchemy engine/session; startup creates tables, roles,
        extensions (vector, pg_trgm), seed data, corpus_metadata check.
  3.  scraper/models.py
        ORM models for every table in Section 3 (contract + internal).
        mapped_column / Mapped throughout. VECTOR dimension from settings.
  4.  scraper/auth/credential_manager.py
        CredentialManager (API token only) — exactly as Section 5.
  5.  scraper/fetchers.py
        PublicFetcher, ApiFetcher, ImportFolderFetcher, RobotsCache,
        errors (RobotsDisallowed, RateLimited, ConfigurationError).
  6.  scraper/parsers/citation_extractor.py
        CITATION_PATTERNS, STATUTE_PATTERNS, extract_citations,
        extract_statutes, score_confidence, normalise_citation.
  7.  scraper/parsers/text_cleaner.py
        clean_html, extract_summary, extract_judge_names,
        extract_bench(text) → (bench_size, bench_type).
  8.  scraper/parsers/statute_parser.py
        split_into_sections (5 strategies), detect_statute_name,
        extract_amendment_markers(section_html) → version rows,
        parse_amending_instrument(text) → affected sections.
  9.  scraper/parsers/pdf_extractor.py
        extract_pdf_text (pdfplumber → pytesseract), download_pdf (stream).
  10. scraper/parsers/treatment_classifier.py
        Deterministic patterns + LLM residue → (treatment, confidence).
  11. scraper/tasks/celery_app.py
        Celery app, Redis broker, full beat schedule (Section 9), PKT.
  12. scraper/tasks/dispatcher.py
        run_source_job — Section 4 exactly; one fetcher per job.
  13. scraper/tasks/pakistanlawsite.py      (API poll / import folder only)
  14. scraper/tasks/nasirlawsite.py
  15. scraper/tasks/pakistancode.py          (with amendment history)
  16. scraper/tasks/superior_courts.py
        Generic Playwright court task parametrised by source; used for
        SHC, SC, LHC, PHC, BHC, IHC, FSC; drift monitor.
  17. scraper/tasks/legislatures.py
        National Assembly, provincial assemblies, Gazette; instruments;
        amending-instrument → version rows.
  18. scraper/tasks/embeddings.py           (model lock; B-6)
  19. scraper/tasks/treatment.py            (classify_treatment; B-7)
  20. scraper/tasks/promotion.py
        Staging → contract tables; trust + confidence rules; sets
        review_status; enqueues embeddings; writes quarantine rows.
  21. scraper/tasks/cross_reference.py      (citation_count, is_landmark, corpus_metadata)
  22. scraper/routers/sources.py            (incl. api-key endpoints; no credential slots)
  23. scraper/routers/jobs.py
  24. scraper/routers/quarantine.py
  25. scraper/routers/search.py             (judgments, statutes with as_at, versions, treatments)
  26. scraper/routers/export.py
  27. scraper/routers/contract.py           (GET /contract)
  28. scraper/templates/dashboard.html      (Section 11 card; no credential panel)
  29. scraper/main.py                       (FastAPI app, routers, API-key middleware, startup)
  30. migrations/001_initial.py
        All Section 3 tables + indexes; roles corpus_writer / sikander_reader
        with grants; EMBEDDING_DIM substitution; seed sources; court
        directory; corpus_metadata. NO limitation_periods.
  31. docker-compose.yml
  32. Dockerfile                            (python 3.12-slim; playwright install chromium --with-deps)
  33. requirements.txt
        fastapi uvicorn sqlalchemy[asyncio] asyncpg alembic celery[redis]
        redis httpx beautifulsoup4 lxml playwright pdfplumber pytesseract
        pillow cryptography openai pydantic-settings python-multipart
        aiofiles pyyaml pytest pytest-asyncio

README.md (delivered with file 33) must state:
  Setup:   cp .env.example .env (fill all values, including DEPLOY_REGION
           from the firm's data-residency decision); docker-compose up -d;
           docker-compose exec api alembic upgrade head
  Access:  Dashboard http://localhost:8000/dashboard · API docs /docs ·
           Flower :5555
  First run: open the dashboard; for PakistanLawSite choose Licensed API
           (enter key) or Import folder (drop export files into
           /imports/PakistanLawSite); tick what each source ingests;
           click Run Now; review the quarantine queue daily for the first
           two weeks of every new source, weekly thereafter.
  Connecting SIKANDER AI: the application connects to this database
           READ-ONLY as sikander_reader through its Database Connector
           (Module 10), mapping to the contract returned by GET /contract.
           Nothing is exported from this service into the application
           and nothing is restored. The earlier pg_dump / pg_restore
           instruction is withdrawn.
  Source policy: reproduce the GOVERNING SOURCE POLICY block verbatim.
