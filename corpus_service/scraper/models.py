"""
Production SQLAlchemy ORM models for Pakistani Legal Scraper System
PostgreSQL 16 + pgvector (VECTOR(1536)) + SQLAlchemy 2.0 with Mapped/mapped_column
All PKs use gen_random_uuid() server-side.

Tables:
- scraper_sources
- courts
- case_law_master
- statutes_master
- scraper_staging
- statutes_staging
- scraper_jobs
- quarantine_queue
- quarantine_decisions (audit F23, append-only)
- embedding_queue
- embedding_attempts (audit F27, the queue's provider attempt receipts)

FINAL_2: no limitation_periods table (legal rules are not held here).

Designed for:
- FastAPI asyncpg
- Celery beat scheduling
- httpx + BeautifulSoup + Playwright harvesting
- pdfplumber + pytesseract OCR
- cryptography.Fernet for credential encryption
- OpenAI embeddings (1536 dim)
- Dual credential failover only on real failure (slot failure counters)

Author: Senior Python Engineer
Version: 1.0.0-production
"""

from __future__ import annotations

import uuid
from datetime import datetime, date
from typing import Optional, List

from sqlalchemy import (
    String,
    Text,
    Integer,
    BigInteger,
    Boolean,
    Float,
    TIMESTAMP,
    Date,
    DateTime,
    func,
    Index,
    ForeignKey,
    UniqueConstraint,
    CheckConstraint,
    text,
    JSON,
    event,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.postgresql import UUID, ARRAY, JSONB
from pgvector.sqlalchemy import Vector

# Share the single DeclarativeBase used by init_db.create_all
from scraper.database import Base
from scraper import quarantine_ledger
from scraper.trust import DEFAULT_TRUST_LEVEL, trust_check_sql


# ---------------------------------------------------------------------------
# 1. Court - Master court registry for Pakistani judiciary hierarchy
# ---------------------------------------------------------------------------
class Court(Base):
    __tablename__ = "courts"
    __table_args__ = (
        UniqueConstraint("name", name="uq_courts_name"),
        UniqueConstraint("short_code", name="uq_courts_short_code"),
        Index("ix_courts_court_level", "court_level"),
        Index("ix_courts_jurisdiction_province", "jurisdiction_province"),
        Index("ix_courts_is_active", "is_active"),
        Index("ix_courts_parent_court_id", "parent_court_id"),
        Index("ix_courts_city", "city"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    short_code: Mapped[str] = mapped_column(String(50), nullable=False)
    court_level: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        comment="supreme_court, high_court, federal_shariat_court, district_court, banking_court, labour_court, special_tribunal, etc",
    )
    jurisdiction_province: Mapped[Optional[str]] = mapped_column(
        String(100), nullable=True, comment="Punjab, Sindh, KPK, Balochistan, Islamabad, Federal, GB, AJK"
    )
    city: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    parent_court_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("courts.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"), nullable=False)
    established_year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    website_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    contact_info: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    parent_court: Mapped[Optional["Court"]] = relationship("Court", remote_side=[id], backref="child_courts")

    def __repr__(self) -> str:
        return f"<Court id={self.id} short_code={self.short_code} level={self.court_level}>"


# ---------------------------------------------------------------------------
# 2. ScraperSource - Config + dual credential failover tracking
# ---------------------------------------------------------------------------
class ScraperSource(Base):
    __tablename__ = "scraper_sources"
    __table_args__ = (
        UniqueConstraint("source_name", name="uq_scraper_sources_source_name"),
        Index("ix_scraper_sources_is_active", "is_active"),
        Index("ix_scraper_sources_next_scrape_at", "next_scrape_at"),
        Index("ix_scraper_sources_trust_level", "trust_level"),
        Index("ix_scraper_sources_source_url", "source_url"),
        CheckConstraint("active_credential_slot IN (1,2)", name="ck_active_slot_1_2"),
        # Audit F20: the vocabulary (trusted | review | blocked) comes from scraper.trust; existing
        # databases are brought to it by database.upgrade_trust_vocabulary (python -m scraper.migrate).
        CheckConstraint(trust_check_sql(), name="ck_trust_level_values"),
        CheckConstraint("scrape_frequency_hours > 0", name="ck_scrape_freq_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    source_name: Mapped[str] = mapped_column(String(100), nullable=False, comment="PakistanLawSite, SupremeCourtPK, LahoreHighCourt, PakCode, etc")
    source_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    base_search_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"), nullable=False)

    # What to scrape toggles
    scrape_case_law: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"), nullable=False)
    scrape_statutes: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    scrape_cause_lists: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    scrape_bench_info: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)

    # Auth / dual credential failover - only switch on REAL failure
    requires_login: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    credential_slot_1_username: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    credential_slot_1_password: Mapped[Optional[str]] = mapped_column(
        String(2000), nullable=True, comment="Fernet encrypted"
    )
    credential_slot_2_username: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    credential_slot_2_password: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True, comment="Fernet encrypted")
    active_credential_slot: Mapped[int] = mapped_column(Integer, default=1, server_default=text("1"), nullable=False)
    last_slot_switch_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    slot_1_last_used_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    slot_2_last_used_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    slot_1_failure_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    slot_2_failure_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    slot_1_success_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    slot_2_success_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    consecutive_failures: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    last_failure_reason: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    # Trust & scheduling
    # Fail closed (F20): a source nobody has approved is review, never trusted.
    trust_level: Mapped[str] = mapped_column(
        String(20), default=DEFAULT_TRUST_LEVEL, server_default=text(f"'{DEFAULT_TRUST_LEVEL}'"), nullable=False
    )
    scrape_frequency_hours: Mapped[int] = mapped_column(Integer, default=6, server_default=text("6"), nullable=False)
    request_delay_min_ms: Mapped[int] = mapped_column(Integer, default=1200, server_default=text("1200"), nullable=False)
    request_delay_max_ms: Mapped[int] = mapped_column(Integer, default=2500, server_default=text("2500"), nullable=False)

    # Stats
    total_pages_scraped: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"), nullable=False)
    total_records_extracted: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"), nullable=False)
    last_scraped_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    last_success_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    next_scrape_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    config_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True, server_default=text("'{}'::jsonb"))
    headers_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    jobs: Mapped[List["ScraperJob"]] = relationship("ScraperJob", back_populates="source", cascade="all, delete-orphan")

    def __repr__(self) -> str:
        return f"<ScraperSource id={self.id} name={self.source_name} active={self.is_active} slot={self.active_credential_slot}>"


# ---------------------------------------------------------------------------
# 3. CaseLawMaster - Final gold-standard case law
# ---------------------------------------------------------------------------
class CaseLawMaster(Base):
    __tablename__ = "case_law_master"
    __table_args__ = (
        UniqueConstraint("citation", name="uq_case_law_citation", deferrable=True, initially="DEFERRED"),
        Index("ix_case_law_court", "court"),
        Index("ix_case_law_court_id", "court_id"),
        Index("ix_case_law_year", "year"),
        Index("ix_case_law_reporter", "reporter"),
        Index("ix_case_law_source_site", "source_site"),
        Index("ix_case_law_is_landmark", "is_landmark"),
        Index("ix_case_law_is_promoted", "is_promoted"),
        Index("ix_case_law_scraped_at", "scraped_at"),
        Index("ix_case_law_confidence_score", "confidence_score"),
        Index("ix_case_law_case_title_trgm", "case_title", postgresql_using="gin", postgresql_ops={"case_title": "gin_trgm_ops"}),
        Index("ix_case_law_citation_trgm", "citation", postgresql_using="gin", postgresql_ops={"citation": "gin_trgm_ops"}),
        Index("ix_case_law_decision_date", "decision_date"),
        Index("ix_case_law_docket_number", "docket_number"),
        # Vector similarity index - HNSW cosine (PG16+ pgvector)
        Index(
            "ix_case_law_embedding_hnsw_cosine",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        CheckConstraint("year >= 1947 AND year <= 2100", name="ck_case_law_year_sane"),
        CheckConstraint("confidence_score >= 0 AND confidence_score <= 1", name="ck_case_law_confidence_range"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )

    # Citation canonical
    citation: Mapped[Optional[str]] = mapped_column(String(500), nullable=True, index=True, comment="e.g., 2023 SCMR 1234")
    case_title: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    case_title_urdu: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)

    court: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, comment="Denormalized court name")
    court_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("courts.id", ondelete="SET NULL"), nullable=True
    )

    judge_names: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True)
    bench_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, comment="DB, FB, Larger Bench, etc")
    case_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, comment="Civil, Criminal, Constitution, etc")

    year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    reporter: Mapped[Optional[str]] = mapped_column(String(50), nullable=True, comment="PLD, SCMR, CLC, PCrLJ, PTD, PLC, YLR, MLD, CLD, GBLR")
    volume: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    page_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    docket_number: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)

    # Parties
    petitioner: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    respondent: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    # Content
    full_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    full_text_urdu: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    headnotes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    facts: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    holding: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ratio_decidendi: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Cross references
    statutes_cited: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True)
    cases_cited: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True, comment="Alias citations_cited")
    citations_cited: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True)
    overruled_by: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_overruled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)

    # Enrichment
    embedding: Mapped[Optional[List[float]]] = mapped_column(Vector(1536), nullable=True)
    is_landmark: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    citation_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    view_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    language: Mapped[str] = mapped_column(String(20), default="en", server_default=text("'en'"), nullable=False)

    # Provenance
    source_site: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_file_path: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    scraped_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    decision_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    # Quality
    confidence_score: Mapped[float] = mapped_column(Float, default=0.5, server_default=text("0.5"), nullable=False)
    is_promoted: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    promoted_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    validation_errors: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    # Search helpers
    search_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True, comment="TSVECTOR source or plain concatenated searchable text")

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    court_obj: Mapped[Optional["Court"]] = relationship("Court", backref="case_laws")

    def __repr__(self) -> str:
        return f"<CaseLawMaster id={self.id} citation={self.citation} year={self.year}>"


# ---------------------------------------------------------------------------
# 4. StatutesMaster - Gold statutes / sections
# ---------------------------------------------------------------------------
class StatutesMaster(Base):
    __tablename__ = "statutes_master"
    __table_args__ = (
        UniqueConstraint("short_name", "section_number", name="uq_statutes_short_section"),
        Index("ix_statutes_statute_name", "statute_name"),
        Index("ix_statutes_short_name", "short_name"),
        Index("ix_statutes_section_number", "section_number"),
        Index("ix_statutes_chapter", "chapter"),
        Index("ix_statutes_year_enacted", "year_enacted"),
        Index("ix_statutes_source_site", "source_site"),
        Index("ix_statutes_is_repealed", "is_repealed"),
        Index("ix_statutes_statute_name_trgm", "statute_name", postgresql_using="gin", postgresql_ops={"statute_name": "gin_trgm_ops"}),
        Index("ix_statutes_section_title_trgm", "section_title", postgresql_using="gin", postgresql_ops={"section_title": "gin_trgm_ops"}),
        Index(
            "ix_statutes_embedding_hnsw_cosine",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    statute_name: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True, comment="Full act name e.g., Pakistan Penal Code")
    short_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, comment="PPC, CrPC, CPC, QSO")
    section_number: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, comment="302, 497, Order VII Rule 1")
    section_title: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    section_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    section_text_urdu: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    chapter: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    part: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    schedule: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    year_enacted: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    year_amended: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    effective_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    is_repealed: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    repealed_by: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    source_site: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    embedding: Mapped[Optional[List[float]]] = mapped_column(Vector(1536), nullable=True)
    confidence_score: Mapped[float] = mapped_column(Float, default=0.85, server_default=text("0.85"), nullable=False)

    # Link to parent act if section-level
    parent_act_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("statutes_master.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    parent_act: Mapped[Optional["StatutesMaster"]] = relationship("StatutesMaster", remote_side=[id], backref="sections")

    def __repr__(self) -> str:
        return f"<StatutesMaster id={self.id} {self.short_name} {self.section_number}>"


# ---------------------------------------------------------------------------
# 5. ScraperStaging - Raw harvested case law staging
# ---------------------------------------------------------------------------
class ScraperStaging(Base):
    __tablename__ = "scraper_staging"
    __table_args__ = (
        Index("ix_staging_source_site", "source_site"),
        Index("ix_staging_extracted_citation", "extracted_citation"),
        Index("ix_staging_created_at", "created_at"),
        Index("ix_staging_quarantined", "quarantined"),
        Index("ix_staging_normalised", "normalised"),
        Index("ix_staging_promoted", "promoted"),
        Index("ix_staging_confidence_score", "confidence_score"),
        Index("ix_staging_source_url_hash", "source_url_hash"),
        Index("ix_staging_content_hash", "content_hash"),
        Index("ix_staging_extracted_year", "extracted_year"),
        Index("ix_staging_job_id", "job_id"),
        CheckConstraint("confidence_score >=0 AND confidence_score <=1", name="ck_staging_confidence_range"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )

    # Provenance
    source_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_sources.id", ondelete="SET NULL"), nullable=True
    )
    source_site: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_url_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, comment="sha256 of URL for dedup")
    content_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, comment="sha256 of raw_text for dedup")
    job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_jobs.id", ondelete="SET NULL"), nullable=True
    )

    # Raw
    raw_html: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_pdf_path: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    ocr_applied: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    pdf_page_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Extracted via parsers
    extracted_citation: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    extracted_title: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    extracted_court: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    extracted_year: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    extracted_reporter: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    # Audit F19: the bench as the harvester read it (raw text). Aliases are mapped onto
    # single | division | full | larger only at publication (scraper.publication.vocabulary); a row
    # with no bench is published quarantined (missing_bench, spec ruling 9, Annex B B-10).
    extracted_bench_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    extracted_judges: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True)
    extracted_parties: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    extracted_statutes: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True)
    extracted_citations: Mapped[Optional[List[str]]] = mapped_column(ARRAY(Text), nullable=True)

    # Pipeline flags
    normalised: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    normalised_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    promoted: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    promoted_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    promoted_to_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)

    quarantined: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    quarantine_reason: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    confidence_score: Mapped[float] = mapped_column(Float, default=0.5, server_default=text("0.5"), nullable=False)
    parsing_metadata: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True, server_default=text("'{}'::jsonb"))
    validation_errors: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<ScraperStaging id={self.id} citation={self.extracted_citation} conf={self.confidence_score}>"


# ---------------------------------------------------------------------------
# 6. StatutesStaging - Raw harvested statutes staging
# ---------------------------------------------------------------------------
class StatutesStaging(Base):
    __tablename__ = "statutes_staging"
    __table_args__ = (
        Index("ix_statutes_staging_source_site", "source_site"),
        Index("ix_statutes_staging_extracted_section", "extracted_section_number"),
        Index("ix_statutes_staging_act_hash", "act_hash"),
        Index("ix_statutes_staging_quarantined", "quarantined"),
        Index("ix_statutes_staging_normalised", "normalised"),
        Index("ix_statutes_staging_promoted", "promoted"),
        Index("ix_statutes_staging_created_at", "created_at"),
        Index("ix_statutes_staging_job_id", "job_id"),
        Index("ix_statutes_staging_confidence", "confidence_score"),
        CheckConstraint("confidence_score >=0 AND confidence_score <=1", name="ck_statutes_staging_conf_range"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )

    source_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_sources.id", ondelete="SET NULL"), nullable=True
    )
    source_site: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_url_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    job_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_jobs.id", ondelete="SET NULL"), nullable=True
    )

    raw_html: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    raw_pdf_path: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    extracted_act_name: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    extracted_short_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    extracted_section_number: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    extracted_section_title: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    extracted_section_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    extracted_chapter: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    extracted_part: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    extracted_year_enacted: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    act_hash: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, comment="sha256(act_name+section_number+section_text) for dedup")

    normalised: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    normalised_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    promoted: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    promoted_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    promoted_to_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)

    quarantined: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    quarantine_reason: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    confidence_score: Mapped[float] = mapped_column(Float, default=0.5, server_default=text("0.5"), nullable=False)
    parsing_metadata: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True, server_default=text("'{}'::jsonb"))
    validation_errors: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<StatutesStaging id={self.id} act={self.extracted_short_name} sec={self.extracted_section_number}>"


# ---------------------------------------------------------------------------
# 7. ScraperJob - Job execution tracking
# ---------------------------------------------------------------------------
class ScraperJob(Base):
    __tablename__ = "scraper_jobs"
    __table_args__ = (
        Index("ix_jobs_source_id", "source_id"),
        Index("ix_jobs_status", "status"),
        Index("ix_jobs_created_at", "created_at"),
        Index("ix_jobs_source_site_job_type", "source_site", "job_type"),
        Index("ix_jobs_celery_task_id", "celery_task_id"),
        Index("ix_jobs_next_retry_at", "next_retry_at"),
        CheckConstraint("retry_count >=0", name="ck_jobs_retry_nonneg"),
        CheckConstraint("status IN ('pending','running','completed','failed','paused','cancelled')", name="ck_jobs_status_values"),
        CheckConstraint("job_type IN ('full_scrape','incremental','retry_failed','embed','cross_ref','cause_list','bench')", name="ck_jobs_type_values"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )

    source_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_sources.id", ondelete="SET NULL"), nullable=True
    )
    source_site: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    job_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True, default="incremental", server_default=text("'incremental'"))
    status: Mapped[str] = mapped_column(String(30), default="pending", server_default=text("'pending'"), nullable=False)

    celery_task_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    worker_hostname: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    worker_seat: Mapped[Optional[str]] = mapped_column(String(10), nullable=True, comment="A or B seat for PLS dual harvest")

    # Progress
    pages_scraped: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    records_extracted: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    records_promoted: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    records_quarantined: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    records_failed: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)

    # Errors & retry
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error_traceback: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    max_retries: Mapped[int] = mapped_column(Integer, default=3, server_default=text("3"), nullable=False)
    next_retry_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    # Timing
    started_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    duration_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    job_params: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True, server_default=text("'{}'::jsonb"))
    result_summary: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    source: Mapped[Optional["ScraperSource"]] = relationship("ScraperSource", back_populates="jobs")

    def __repr__(self) -> str:
        return f"<ScraperJob id={self.id} site={self.source_site} type={self.job_type} status={self.status}>"


# ---------------------------------------------------------------------------
# 8. QuarantineQueue - Low-confidence / suspicious records for human review
# ---------------------------------------------------------------------------
class QuarantineQueue(Base):
    __tablename__ = "quarantine_queue"
    __table_args__ = (
        Index("ix_quarantine_staging_id", "staging_id"),
        Index("ix_quarantine_statutes_staging_id", "statutes_staging_id"),
        Index("ix_quarantine_reviewed", "reviewed"),
        Index("ix_quarantine_reason", "reason"),
        Index("ix_quarantine_source_site", "source_site"),
        Index("ix_quarantine_created_at", "created_at"),
        Index("ix_quarantine_resolution", "resolution"),
        CheckConstraint("resolution IN ('pending','approved','rejected','needs_edit','escalated') OR resolution IS NULL", name="ck_quarantine_resolution_values"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )

    staging_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_staging.id", ondelete="CASCADE"), nullable=True
    )
    statutes_staging_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("statutes_staging.id", ondelete="CASCADE"), nullable=True
    )

    source_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("scraper_sources.id", ondelete="SET NULL"), nullable=True
    )
    source_site: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    extracted_citation: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    extracted_title: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    extracted_court: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    extracted_section: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    reason: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True, comment="validation failure, low confidence, duplicate suspected, etc")
    details: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True, server_default=text("'{}'::jsonb"), comment="structured validation output")
    confidence_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    reviewed: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    reviewed_by: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    resolution: Mapped[Optional[str]] = mapped_column(String(50), nullable=True, default="pending", server_default=text("'pending'"))
    resolution_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Optional rework output
    corrected_citation: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    corrected_title: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    case_staging: Mapped[Optional["ScraperStaging"]] = relationship("ScraperStaging", backref="quarantine_entries", foreign_keys=[staging_id])
    statute_staging: Mapped[Optional["StatutesStaging"]] = relationship("StatutesStaging", backref="quarantine_entries", foreign_keys=[statutes_staging_id])

    def __repr__(self) -> str:
        return f"<QuarantineQueue id={self.id} reason={self.reason} reviewed={self.reviewed}>"


# ---------------------------------------------------------------------------
# 8b. QuarantineDecision - append-only evidence of each reviewer decision (audit F23)
# ---------------------------------------------------------------------------
class QuarantineDecision(Base):
    """One row per resolving decision on a quarantine_queue record (promoted | rejected), written in
    the same transaction as the decision itself by scraper.routers.quarantine.

    Append-only: triggers refuse UPDATE, DELETE and TRUNCATE (scraper.quarantine_ledger: created
    with the table, repaired by migrations/002_quarantine_decisions.py). quarantine_id is unique (one resolving decision per record) and deliberately has no
    foreign key: quarantine_queue rows cascade away with their staging row, and the evidence must
    outlive its subject. The reviewer is the name a holder of the shared admin key gave
    (reviewer_auth says so) until named identities exist (audit F47).
    Spec: docs/superpowers/specs/2026-10-18-f23-auditable-quarantine-promotion-design.md.
    """

    __tablename__ = "quarantine_decisions"
    __table_args__ = (
        UniqueConstraint("quarantine_id", name="uq_quarantine_decisions_quarantine_id"),
        Index("ix_quarantine_decisions_staging_id", "staging_id"),
        Index("ix_quarantine_decisions_decided_at", "decided_at"),
        CheckConstraint("decision IN ('promoted','rejected')", name="ck_quarantine_decisions_decision"),
        CheckConstraint("btrim(reviewer) <> ''", name="ck_quarantine_decisions_reviewer"),
        CheckConstraint("btrim(reason) <> ''", name="ck_quarantine_decisions_reason"),
        CheckConstraint(
            "(decision = 'promoted' AND publication_key IS NOT NULL AND published_table IS NOT NULL "
            "AND published_id IS NOT NULL AND embedding_outbox_id IS NOT NULL) OR "
            "(decision = 'rejected' AND publication_key IS NULL AND published_table IS NULL "
            "AND published_id IS NULL AND embedding_outbox_id IS NULL)",
            name="ck_quarantine_decisions_publication",
        ),
        # F23 re-audit round 2 (spec rulings 20-21; migrations/003_quarantine_decision_fingerprint.py).
        CheckConstraint("request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'",
                        name="ck_quarantine_decisions_request_fingerprint"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    quarantine_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    staging_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    reviewer: Mapped[str] = mapped_column(String(255), nullable=False)
    reviewer_auth: Mapped[str] = mapped_column(String(50), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    prior_state: Mapped[dict] = mapped_column(JSONB, nullable=False)
    new_state: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # The source as resolved and read at decision time (scraper.tasks.promotion's rule).
    source_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    source_trust_level: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    source_resolved_by: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    # The publication (promoted only): stable key, the row it wrote, and its embedding outbox row.
    publication_key: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    published_table: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    published_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    embedding_outbox_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    request_key: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, comment="Idempotency-Key")
    # SHA-256 of the canonical decision, reviewer and reason of the request that made this decision
    # (scraper.routers.quarantine.request_fingerprint); NULL on rows written before migration 003.
    request_fingerprint: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)

    def __repr__(self) -> str:
        return f"<QuarantineDecision id={self.id} quarantine_id={self.quarantine_id} decision={self.decision}>"


# The table never exists without its append-only triggers: create_all makes them in the same
# transaction (scraper.quarantine_ledger; migration 002 repairs them on every migrate).
event.listen(QuarantineDecision.__table__, "after_create", quarantine_ledger.make_append_only)


# ---------------------------------------------------------------------------
# 9. EmbeddingQueue - Async OpenAI embedding generation queue
# ---------------------------------------------------------------------------
# Audit F27 (docs/superpowers/specs/2026-10-18-f27-leased-embedding-claims-design.md, R2, R4, R9, R14):
# the queue's lease, operation and dead-letter rules and its claim / lease / backlog indexes. The model
# and migrations/004_embedding_queue_leases.py build them from these same strings, so a migrated queue
# and a new one are identical.
EMBEDDING_QUEUE_F27_COLUMNS = {
    "lease_owner": "UUID",
    "lease_expires_at": "TIMESTAMP WITH TIME ZONE",
    "operation_id": "VARCHAR(64)",
    "stored_operation_id": "VARCHAR(64)",
}
EMBEDDING_QUEUE_F27_CHECKS = {
    # A row is `processing` exactly while a batch holds its lease (R2).
    "ck_embedding_lease_held": "(status = 'processing') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)",
    "ck_embedding_operation_ids": (
        "(operation_id IS NULL OR operation_id ~ '^[0-9a-f]{64}$') AND "
        "(stored_operation_id IS NULL OR stored_operation_id ~ '^[0-9a-f]{64}$')"
    ),
    # A dead letter always says why (R9).
    "ck_embedding_dead_letter_reason": "status <> 'dead_letter' OR error_type IS NOT NULL",
}
# name: (column list, WHERE predicate)
EMBEDDING_QUEUE_F27_INDEXES = {
    "ix_embedding_claim_order": ("priority DESC, created_at, id", "status = 'pending'"),
    "ix_embedding_lease_expiry": ("lease_expires_at", "status = 'processing'"),
    "ix_embedding_waiting_created": ("created_at", "status IN ('pending', 'processing')"),
}


class EmbeddingQueue(Base):
    __tablename__ = "embedding_queue"
    __table_args__ = (
        UniqueConstraint("table_name", "record_id", name="uq_embedding_table_record"),
        Index("ix_embedding_status", "status"),
        Index("ix_embedding_table_name", "table_name"),
        Index("ix_embedding_record_id", "record_id"),
        Index("ix_embedding_created_at", "created_at"),
        Index("ix_embedding_priority", "priority"),
        Index("ix_embedding_status_priority_created", "status", "priority", "created_at"),
        CheckConstraint("status IN ('pending','processing','completed','failed','dead_letter')", name="ck_embedding_status_values"),
        CheckConstraint("attempts >=0", name="ck_embedding_attempts_nonneg"),
        *(CheckConstraint(sql, name=name) for name, sql in EMBEDDING_QUEUE_F27_CHECKS.items()),
        *(
            Index(name, *(text(c.strip()) for c in columns.split(",")), postgresql_where=text(where))
            for name, (columns, where) in EMBEDDING_QUEUE_F27_INDEXES.items()
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )

    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    table_name: Mapped[str] = mapped_column(String(80), nullable=False, comment="case_law_master, statutes_master")

    status: Mapped[str] = mapped_column(String(30), default="pending", server_default=text("'pending'"), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5, server_default=text("5"), nullable=False)

    last_attempt_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    next_attempt_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    error_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    embedding_model: Mapped[str] = mapped_column(String(100), default="text-embedding-3-small", server_default=text("'text-embedding-3-small'"), nullable=False)
    embedding_dimensions: Mapped[int] = mapped_column(Integer, default=1536, server_default=text("1536"), nullable=False)

    priority: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False, comment="Higher = earlier")

    token_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    processing_time_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # Audit F27: the batch holding the row (a token per batch) and until when (R1, R2); the operation
    # of the current attempt and the one whose vector the record holds (R4, R6).
    lease_owner: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    lease_expires_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    operation_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    stored_operation_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<EmbeddingQueue id={self.id} table={self.table_name} record={self.record_id} status={self.status}>"


# ---------------------------------------------------------------------------
# 9b. EmbeddingAttempt - one provider attempt for an embedding operation (audit F27)
# ---------------------------------------------------------------------------
EMBEDDING_ATTEMPT_OUTCOMES = ("started", "answered", "stored", "failed", "superseded", "abandoned", "interrupted")


class EmbeddingAttempt(Base):
    """The receipt of one provider attempt (audit F27, spec R5), written by scraper.tasks.embeddings.

    `started` is committed before the request and `answered` (with the token count and the vector)
    right after it, so a worker killed in between, or before its store commits, leaves a record of the
    paid request. The vector is held only while the receipt is `answered` and is cleared when it is
    stored or superseded; a later batch stores a held vector instead of paying again (R6), at most
    STORE_RETRY_LIMIT times automatically (`store_failures`, review round 2). At most one
    unresolved (`started` or `answered`) receipt exists per operation. No input text, key or provider
    message is kept: `error_type` is the error class or code only. No foreign key to the queue row:
    the receipt outlives it.
    """

    __tablename__ = "embedding_attempts"
    __table_args__ = (
        Index(
            "ux_embedding_attempts_unresolved_operation", "operation_id", unique=True,
            postgresql_where=text("outcome IN ('started', 'answered')"),
        ),
        Index("ix_embedding_attempts_queue_id", "queue_id"),
        Index("ix_embedding_attempts_record", "table_name", "record_id"),
        Index("ix_embedding_attempts_started_open", "started_at", postgresql_where=text("outcome = 'started'")),
        CheckConstraint(
            "outcome IN (" + ", ".join(f"'{o}'" for o in EMBEDDING_ATTEMPT_OUTCOMES) + ")",
            name="ck_embedding_attempts_outcome",
        ),
        CheckConstraint("operation_id ~ '^[0-9a-f]{64}$'", name="ck_embedding_attempts_operation_id"),
        CheckConstraint("embedding IS NULL OR outcome = 'answered'", name="ck_embedding_attempts_vector_held"),
        CheckConstraint("outcome <> 'answered' OR answered_at IS NOT NULL", name="ck_embedding_attempts_answered"),
        CheckConstraint("attempt >= 1", name="ck_embedding_attempts_attempt"),
        CheckConstraint("token_count IS NULL OR token_count >= 0", name="ck_embedding_attempts_tokens"),
        CheckConstraint("store_failures >= 0", name="ck_embedding_attempts_store_failures"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    operation_id: Mapped[str] = mapped_column(String(64), nullable=False)
    queue_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    table_name: Mapped[str] = mapped_column(String(80), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    lease_owner: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    error_type: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    token_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), server_default=func.now(), nullable=False)
    answered_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    reconciled: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"), nullable=False)
    # Review round 2: failed stores of this receipt's held answer (a store the database refused, or a
    # batch lost while storing it); at scraper.tasks.embeddings.STORE_RETRY_LIMIT the row is dead-lettered
    # (`store_failed`) with the answer kept for a requeue.
    store_failures: Mapped[int] = mapped_column(Integer, default=0, server_default=text("0"), nullable=False)
    embedding: Mapped[Optional[List[float]]] = mapped_column(Vector(1536), nullable=True)

    def __repr__(self) -> str:
        return f"<EmbeddingAttempt id={self.id} operation={self.operation_id[:12]} outcome={self.outcome}>"


# ---------------------------------------------------------------------------
# FINAL_2: LimitationPeriod intentionally omitted — this service holds no
# legal rules / limitation_periods table (see FINAL_CORPUS_SERVICE_PROMPT_2).
# ---------------------------------------------------------------------------
# Helper: ensure pgvector + pg_trgm extensions via Alembic / init.sql
# Note: CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;
# Gen_random_uuid requires pgcrypto or pg 13+ builtin.
# In Postgres 16, gen_random_uuid() is available via pgcrypto extension.
# ---------------------------------------------------------------------------
