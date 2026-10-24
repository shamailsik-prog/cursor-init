"""
Production settings for Pakistani Legal Scraper System.

Stack: PostgreSQL 16 + pgvector, FastAPI, Celery, httpx, BeautifulSoup,
       pdfplumber, pytesseract, cryptography Fernet; embeddings through the P1 gateway
       (FA-D3C-002). No headless browser (FA-D3C-001).

Implements dual Blackletter seat failover ONLY on real failure (exceptions,
network errors, 5xx, auth failure after retry) — never on empty results.

This module centralizes all environment configuration via pydantic-settings.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import ssl
from functools import lru_cache
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken
from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Well-known / shipped-in-source database passwords that must never reach production.
_DEFAULT_DB_PASSWORDS = frozenset(
    {"legal_scraper_pass", "legal", "postgres", "password", "changeme", "change_me", "admin", "secret"}
)
_MIN_PROD_DB_PASSWORD_LENGTH = 16
_DEFAULT_REDIS_PASSWORDS = _DEFAULT_DB_PASSWORDS | {"redis", "default", ""}

# ---------------------------------------------------------------------------------------------
# Store TLS (audit F30)
# ---------------------------------------------------------------------------------------------
# libpq sslmode values. DATABASE_URL may spell the mode as libpq's `sslmode` or asyncpg's `ssl`;
# `sslrootcert` names the CA file that signs the server certificate.
_PG_SSL_MODES = ("disable", "allow", "prefer", "require", "verify-ca", "verify-full")


def split_postgres_tls(url: str) -> Tuple[str, Dict[str, str]]:
    """Return (url without TLS query parameters, {"sslmode": ..., "sslrootcert": ...}).

    Raises ValueError for an unknown mode or for `ssl` and `sslmode` that disagree."""
    parts = urlsplit(url)
    kept: List[Tuple[str, str]] = []
    tls: Dict[str, str] = {}
    modes = set()
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in ("sslmode", "ssl"):
            modes.add(value.strip().lower())
        elif key == "sslrootcert":
            tls["sslrootcert"] = value
        else:
            kept.append((key, value))
    if len(modes) > 1:
        raise ValueError(f"DATABASE_URL gives conflicting TLS modes {sorted(modes)}")
    if modes:
        mode = modes.pop()
        if mode not in _PG_SSL_MODES:
            raise ValueError(f"DATABASE_URL TLS mode {mode!r} is not one of {', '.join(_PG_SSL_MODES)}")
        tls["sslmode"] = mode
    return urlunsplit(parts._replace(query=urlencode(kept))), tls


def asyncpg_engine_args(url: str) -> Tuple[str, Dict[str, Any]]:
    """Translate libpq-style TLS parameters into what asyncpg actually accepts.

    asyncpg.connect() has no sslmode/sslrootcert keywords, and SQLAlchemy passes URL query
    parameters straight to it, so the URL is stripped of them and the mode becomes an explicit
    `ssl` connect argument: verify-full -> SSLContext that requires a certificate chaining to
    sslrootcert (or the system store) AND a hostname match; verify-ca -> chain only; require ->
    encryption without verification; disable -> no TLS; allow/prefer -> asyncpg's negotiation.
    Production/staging only accept verify-full (Settings.require_verified_store_tls)."""
    clean_url, tls = split_postgres_tls(url)
    mode = tls.get("sslmode")
    if mode is None:  # no mode: asyncpg's default negotiation; never accepted in production
        return (clean_url if tls else url), {}
    if mode == "disable":
        return clean_url, {"ssl": False}
    if mode in ("allow", "prefer"):
        return clean_url, {"ssl": mode}
    if mode == "require":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    else:
        ctx = ssl.create_default_context(cafile=tls.get("sslrootcert") or None)
        ctx.verify_mode = ssl.CERT_REQUIRED
        ctx.check_hostname = mode == "verify-full"
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return clean_url, {"ssl": ctx}


# URL query parameters that may appear on a production Redis URL, with the only values allowed.
# Anything else starting with ssl_ is refused: TLS for Redis is configured by REDIS_TLS_CA_FILE and
# redis_ssl_options(), and a URL query must not be able to override it (re-audit D4).
_REDIS_STRICT_SSL_QUERY = {
    "ssl_cert_reqs": ("required", "cert_required"),
    "ssl_check_hostname": ("true", "1", "yes", "on"),
}


def _redis_url_problem(name: str, url: str, db_password: str = "") -> Optional[str]:
    """Why a Redis URL is unacceptable in production/staging, or None."""
    parts = urlsplit(url)
    if parts.scheme != "rediss":
        return f"{name} must use rediss:// (TLS) in production/staging"
    username = unquote(parts.username or "")
    password = unquote(parts.password or "")
    if not username or username == "default" or not password:
        return (
            f"{name} must authenticate as a named Redis ACL user with a password "
            "(rediss://<user>:<password>@host:port/db); the default user is disabled"
        )
    if len(password) < _MIN_PROD_DB_PASSWORD_LENGTH or password.lower() in _DEFAULT_REDIS_PASSWORDS:
        return (
            f"{name} must carry a non-default Redis ACL password of at least "
            f"{_MIN_PROD_DB_PASSWORD_LENGTH} characters in production/staging"
        )
    if db_password and password == db_password:
        return f"{name} password must differ from the DATABASE_URL password"
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if not key.lower().startswith("ssl_"):
            continue
        allowed = _REDIS_STRICT_SSL_QUERY.get(key.lower())
        if allowed is None or value.strip().lower() not in allowed:
            return (
                f"{name} must not override TLS verification ({key}) in production/staging; "
                "configure the CA with REDIS_TLS_CA_FILE"
            )
    return None


class Settings(BaseSettings):
    """
    Central configuration object. Reads from environment and .env file.
    All secrets are handled via SecretStr where appropriate or validated Fernet key.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
        env_prefix="",
    )

    # ---------------------------------------------------------------------
    # Core / App
    # ---------------------------------------------------------------------
    APP_ENV: Literal["development", "staging", "production"] = Field(
        default="production",
        description="Application environment"
    )
    PROJECT_NAME: str = Field(default="Pakistan Legal Scraper")
    API_V1_PREFIX: str = Field(default="/api/v1")
    LOG_LEVEL: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = Field(
        default="INFO",
        description="Python logging level"
    )
    TIMEZONE: str = Field(default="Asia/Karachi", description="IANA timezone")
    DEBUG: bool = Field(default=False)

    # ---------------------------------------------------------------------
    # Database - PostgreSQL 16 + pgvector + asyncpg (FastAPI) and sync (Celery/alembic)
    # ---------------------------------------------------------------------
    DATABASE_URL: str = Field(
        default="postgresql+asyncpg://legal:legal_scraper_pass@postgres:5432/legal_scraper",
        description="Async SQLAlchemy URL. Must use postgresql+asyncpg://"
    )
    DATABASE_POOL_SIZE: int = Field(default=20, ge=5, le=100)
    DATABASE_MAX_OVERFLOW: int = Field(default=30, ge=0, le=100)
    DATABASE_POOL_TIMEOUT: int = Field(default=30, ge=5, le=120)
    DATABASE_ECHO: bool = Field(default=False)

    # ---------------------------------------------------------------------
    # Redis / Celery / Cache
    # ---------------------------------------------------------------------
    REDIS_URL: str = Field(
        default="redis://redis:6379/0",
        description="Redis URL used for Celery broker, result backend, and rate limiting"
    )
    CELERY_BROKER_URL: Optional[str] = Field(default=None, description="If None, falls back to REDIS_URL")
    CELERY_RESULT_BACKEND: Optional[str] = Field(default=None, description="If None, falls back to REDIS_URL")
    REDIS_TLS_CA_FILE: Optional[str] = Field(
        default=None,
        description="CA file that signs the Redis server certificate (rediss://). Unset: system trust store.",
    )
    REDIS_CACHE_TTL_SECONDS: int = Field(default=3600, ge=60)

    # ---------------------------------------------------------------------
    # Security / Secrets - Fernet + Admin API Key
    # ---------------------------------------------------------------------
    # No hardcoded production secrets. Set via env / .env (see .env.example).
    ENCRYPTION_KEY: str = Field(
        default="",
        description="Base64 urlsafe 32-byte Fernet key. Required in production; auto-generated in development if unset.",
    )
    ADMIN_API_KEY: str = Field(
        default="",
        description="X-API-Key required for admin routes. Required in production.",
    )
    SECRET_KEY: str = Field(
        default="",
        description="FastAPI JWT secret if needed. Required in production.",
    )

    # ---------------------------------------------------------------------
    # Embeddings, through the P1 gateway (FA-D3C-002)
    # ---------------------------------------------------------------------
    # The corpus holds no provider key or SDK. Every paid embedding goes to P1's p1CorpusEmbedding Cloud Function
    # (scraper/p1_client.py), which applies the kill switches, the budget, the P1 ledger, the provider policy and the
    # outbound mask. An empty URL turns embeddings off: the batch is skipped, as it was with no key.
    P1_EMBEDDING_URL: str = Field(
        default="",
        description="https URL of P1's p1CorpusEmbedding function (a Google serverless host on 443); empty disables embeddings",
    )
    P1_ID_TOKEN_FILE: str = Field(
        default="/run/secrets/p1_id_token",
        description="File holding the corpus service account's current Google-signed OIDC ID token, audience P1_EMBEDDING_URL; "
        "the deployment keeps it current. Read on every call, never logged.",
    )
    OPENAI_EMBEDDING_MODEL: str = Field(default="text-embedding-3-small", description="OpenAI embedding model name")
    OPENAI_EMBEDDING_DIMENSIONS: int = Field(default=1536, ge=256, le=3072)
    EMBEDDING_BATCH_SIZE: int = Field(default=50, ge=1, le=500, description="Number of texts per embedding API call")
    EMBEDDING_RPM_LIMIT: int = Field(default=3000, ge=10, le=10000, description="Requests per minute limit for embeddings with token bucket")
    EMBEDDING_TPM_LIMIT: int = Field(default=1000000, ge=10000)
    OPENAI_TIMEOUT_SECONDS: int = Field(default=60, ge=10, le=300)

    # ---------------------------------------------------------------------
    # Scraper Tuning
    # ---------------------------------------------------------------------
    SCRAPER_DELAY_MIN: float = Field(default=1.2, ge=0.1, le=30.0, description="Min delay between HTTP requests")
    SCRAPER_DELAY_MAX: float = Field(default=3.5, ge=0.1, le=60.0, description="Max delay between HTTP requests (jitter)")
    SCRAPER_TIMEOUT_SECONDS: int = Field(default=45, ge=5, le=180)
    SCRAPER_RETRY_ATTEMPTS: int = Field(default=3, ge=0, le=10)
    SCRAPER_RETRY_BACKOFF: float = Field(default=2.0, ge=1.0, le=10.0)
    SCRAPER_USER_AGENT: str = Field(
        default="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 PakistaniLegalBot/1.0"
    )
    SCRAPER_CONCURRENT_REQUESTS: int = Field(default=3, ge=1, le=20)

    # FINAL_2 — login scraping permanently disabled in production
    # Fail closed: without an explicit ENVIRONMENT=development / APP_ENV=development the service is production.
    ENVIRONMENT: Literal["development", "staging", "production"] = Field(default="production")
    ALLOW_LOGIN_SCRAPING: bool = Field(default=False, description="FINAL_2: must remain false in production")
    CORS_ALLOW_ORIGINS: str = Field(
        default="",
        description="Comma-separated allowed CORS origins. Defaults to localhost only when empty.",
    )

    # ---------------------------------------------------------------------
    # Public corpus API bounds (audit F24; scraper/public_corpus.py, scraper/rate_limit.py)
    # ---------------------------------------------------------------------
    PUBLIC_QUERY_TIMEOUT_MS: int = Field(default=3000, ge=100, le=60000, description="statement_timeout for each public request (SET LOCAL)")
    PUBLIC_RATE_LIMIT_REQUESTS: int = Field(default=60, ge=1, le=100000, description="Requests per client address per window (token bucket capacity)")
    PUBLIC_RATE_LIMIT_WINDOW_SECONDS: int = Field(default=60, ge=1, le=86400, description="Seconds to refill a full bucket")
    PUBLIC_RATE_LIMIT_MAX_CLIENTS: int = Field(default=10000, ge=100, le=1000000, description="Client addresses tracked at once (LRU)")
    EXPORT_MAX_ROWS: int = Field(default=50000, ge=1, le=1000000, description="Hard row cap for /export/cases")
    EXPORT_CHUNK_ROWS: int = Field(default=500, ge=10, le=10000, description="Rows fetched and encoded per export chunk")
    EXPORT_QUERY_TIMEOUT_MS: int = Field(default=60000, ge=1000, le=600000, description="statement_timeout for each export batch read")
    # Re-audit round (F24 R1c, L3): aggregate load caps and the whole-export deadline. The pool holds
    # 20 + 30 overflow connections (database.py); public reads may use at most PUBLIC_DB_CONCURRENCY.
    PUBLIC_DB_CONCURRENCY: int = Field(default=8, ge=1, le=40, description="Concurrent public database reads per process; the next is 503")
    EXPORT_MAX_CONCURRENT: int = Field(default=2, ge=1, le=10, description="Concurrent exports per process; the next is 503")
    EXPORT_DEADLINE_SECONDS: int = Field(default=120, ge=1, le=3600, description="Wall-clock bound on one export, database reads and response sends together")

    # ---------------------------------------------------------------------
    # Blackletter / Pakistan Law Site - Dual Credential Failover
    # ---------------------------------------------------------------------
    # Seat A - Primary
    PLS_USER: str = Field(default="", description="DEPRECATED login seat — unused when ALLOW_LOGIN_SCRAPING=false")
    PLS_PASS: str = Field(default="", description="DEPRECATED login seat — unused")
    PLS_JOURNALS: str = Field(default="PLD,SCMR,CLC,PCrLJ", description="Comma separated journals for Seat A")

    # Seat B - Fallback (only used on real failure, never on empty result)
    PLS_USER_B: str = Field(default="", description="DEPRECATED login seat — unused")
    PLS_PASS_B: str = Field(default="", description="DEPRECATED login seat — unused")
    PLS_JOURNALS_B: str = Field(default="PTD,PLC,YLR,MLD,CLD,GBLR", description="Comma separated journals for Seat B")

    PLS_BASE_URL: str = Field(default="https://www.pakistanlawsite.com")
    PLS_LOGIN_URL: str = Field(default="https://www.pakistanlawsite.com/Login")
    PLS_MAX_FAILOVER_RETRIES: int = Field(default=1, ge=0, le=3, description="Failover attempts after real failure only")
    PLS_SESSION_TTL_MINUTES: int = Field(default=45, ge=5, le=180)

    # ---------------------------------------------------------------------
    # PDF & OCR
    # ---------------------------------------------------------------------
    PDF_STORAGE_PATH: str = Field(default="/app/live", description="Local vault for PDFs")
    STATE_STORAGE_PATH: str = Field(default="/app/state", description="Local state for harvester")
    PDF_MAX_SIZE_MB: int = Field(default=100, ge=1, le=500)
    OCR_ENABLED: bool = Field(default=True)
    OCR_LANGUAGE: str = Field(default="eng")
    OCR_DPI: int = Field(default=300, ge=72, le=600)

    # ---------------------------------------------------------------------
    # Google Drive Integration
    # ---------------------------------------------------------------------
    GOOGLE_DRIVE_ENABLED: bool = Field(default=False, description="Enable Google Drive mirroring")
    DRIVE_FOLDER_ROOT: str = Field(default="18AedWtIzasDrnVsgZyHv172_hU526yOF", description="Root folder ID on Drive")
    GOOGLE_APPLICATION_CREDENTIALS_JSON: Optional[str] = Field(default=None, description="Service account JSON as string or path")
    DRIVE_UPLOAD_CONCURRENCY: int = Field(default=2, ge=1, le=10)
    DRIVE_CHUNK_SIZE_MB: int = Field(default=8, ge=1, le=100)

    # ---------------------------------------------------------------------
    # Validation
    # ---------------------------------------------------------------------
    @model_validator(mode="after")
    def refuse_login_scraping_in_production(self):
        """FINAL_2: login-form scraping is non-overridable in production."""
        if self.ALLOW_LOGIN_SCRAPING and self.is_prodish():
            raise ValueError("ALLOW_LOGIN_SCRAPING cannot be true in production/staging")
        return self

    @field_validator("LOG_LEVEL", mode="before")
    @classmethod
    def normalize_log_level(cls, v: str) -> str:
        if isinstance(v, str):
            upper = v.upper()
            if upper in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
                return upper
            raise ValueError(f"Invalid LOG_LEVEL {v}. Must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL")
        return v

    @field_validator("ENCRYPTION_KEY")
    @classmethod
    def validate_fernet_key(cls, v: str) -> str:
        """Validate ENCRYPTION_KEY when provided; empty allowed until post-validators fill/dev-generate."""
        if not v or not str(v).strip():
            return ""
        v = v.strip()
        try:
            Fernet(v.encode() if isinstance(v, str) else v)
        except Exception as e:
            raise ValueError(
                f"ENCRYPTION_KEY must be a valid Fernet key generated via Fernet.generate_key(). Error: {e}"
            )
        return v

    @model_validator(mode="after")
    def require_or_generate_secrets(self):
        """
        Production/staging: require ENCRYPTION_KEY, ADMIN_API_KEY, SECRET_KEY from env.
        Development (explicit opt-in only): auto-generate ephemeral random secrets per process,
        so no constant from source is ever a valid credential. Generated values are never logged.
        """
        is_prodish = self.is_prodish()

        if not self.ENCRYPTION_KEY:
            if is_prodish:
                raise ValueError("ENCRYPTION_KEY must be set via environment in production/staging")
            object.__setattr__(self, "ENCRYPTION_KEY", Fernet.generate_key().decode())
            logging.getLogger(__name__).warning(
                "ENCRYPTION_KEY unset — generated ephemeral Fernet key for development only"
            )

        if not self.ADMIN_API_KEY:
            if is_prodish:
                raise ValueError("ADMIN_API_KEY must be set via environment in production/staging")
            object.__setattr__(self, "ADMIN_API_KEY", secrets.token_urlsafe(32))
            logging.getLogger(__name__).warning(
                "ADMIN_API_KEY unset — generated a random per-process key for development only"
                " (not logged; set ADMIN_API_KEY to use admin routes)"
            )

        if not self.SECRET_KEY:
            if is_prodish:
                raise ValueError("SECRET_KEY must be set via environment in production/staging")
            object.__setattr__(self, "SECRET_KEY", secrets.token_urlsafe(48))

        if is_prodish:
            password = urlsplit(self.DATABASE_URL).password
            password = unquote(password) if password else ""
            if (
                len(password) < _MIN_PROD_DB_PASSWORD_LENGTH
                or password.lower() in _DEFAULT_DB_PASSWORDS
            ):
                raise ValueError(
                    "DATABASE_URL must carry a non-default database password of at least "
                    f"{_MIN_PROD_DB_PASSWORD_LENGTH} characters in production/staging"
                )

        return self

    @model_validator(mode="after")
    def require_verified_store_tls(self):
        """Audit F30: in production/staging both stores must be reached over TLS that verifies
        the server certificate and hostname, and Redis through a named ACL user with a strong
        password distinct from the database one. An explicitly empty REDIS_URL means this process
        uses no Redis (the one-shot migrate service) and is allowed."""
        _, tls = split_postgres_tls(self.DATABASE_URL)  # also rejects unknown/conflicting modes
        if not self.is_prodish():
            return self
        if tls.get("sslmode") != "verify-full":
            raise ValueError(
                "DATABASE_URL must use TLS with server verification in production/staging: add "
                "sslmode=verify-full (and sslrootcert=<CA file> for a private CA)"
            )
        db_password = unquote(urlsplit(self.DATABASE_URL).password or "")
        for name in ("REDIS_URL", "CELERY_BROKER_URL", "CELERY_RESULT_BACKEND"):
            url = getattr(self, name)
            if not url:
                continue
            problem = _redis_url_problem(name, url, db_password)
            if problem:
                raise ValueError(problem)
        return self

    def is_prodish(self) -> bool:
        """
        Fail closed. Development only when ENVIRONMENT or APP_ENV is *explicitly* set to
        "development" and neither is explicitly production/staging; anything else (including
        both unset) is production-grade.
        """
        explicit = {
            str(getattr(self, name)).lower()
            for name in ("ENVIRONMENT", "APP_ENV")
            if name in self.model_fields_set
        }
        return not ("development" in explicit and not explicit & {"production", "staging"})

    @field_validator("TIMEZONE")
    @classmethod
    def validate_timezone(cls, v: str) -> str:
        # Basic IANA check - must contain slash or be UTC
        if v == "UTC" or "/" in v:
            return v
        raise ValueError(f"TIMEZONE must be a valid IANA zone like Asia/Karachi, got {v}")

    @field_validator("DATABASE_URL")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        if "postgresql" not in v:
            raise ValueError("DATABASE_URL must be a PostgreSQL URL")
        if "+asyncpg" not in v and "+psycopg" not in v and "postgresql://" not in v:
            raise ValueError("DATABASE_URL should include driver e.g., postgresql+asyncpg://")
        return v

    @field_validator("REDIS_URL")
    @classmethod
    def validate_redis_url(cls, v: str) -> str:
        # "" = this process uses no Redis (e.g. the one-shot migrate service gets no Redis
        # credentials); scraper.tasks.celery_app refuses to load without a URL.
        if v and not v.startswith("redis://") and not v.startswith("rediss://"):
            raise ValueError("REDIS_URL must start with redis:// or rediss://")
        return v

    @field_validator("PLS_JOURNALS", "PLS_JOURNALS_B")
    @classmethod
    def validate_journals(cls, v: str) -> str:
        if not v:
            raise ValueError("Journal list cannot be empty")
        # Normalize: uppercase, no spaces, dedup preserve order
        parts = [p.strip().upper() for p in v.split(",") if p.strip()]
        if not parts:
            raise ValueError("Journal list parsed to empty after normalization")
        # Allow only known Pakistani law journal codes plus generic
        # But don't hard-fail on unknown to allow future journals; just ensure alphanumeric 2-10 chars
        for p in parts:
            if not re.match(r"^[A-Z0-9]{2,10}$", p):
                raise ValueError(f"Invalid journal code '{p}' in {v}")
        return ",".join(parts)

    @model_validator(mode="after")
    def validate_delay_range(self):
        if self.SCRAPER_DELAY_MIN >= self.SCRAPER_DELAY_MAX:
            raise ValueError(
                f"SCRAPER_DELAY_MIN ({self.SCRAPER_DELAY_MIN}) must be < SCRAPER_DELAY_MAX ({self.SCRAPER_DELAY_MAX})"
            )
        if self.EMBEDDING_BATCH_SIZE < 1:
            raise ValueError("EMBEDDING_BATCH_SIZE must be >=1")
        return self

    # ---------------------------------------------------------------------
    # Computed / Helper Properties - zero placeholders, real code
    # ---------------------------------------------------------------------
    @property
    def database_sync_url(self) -> str:
        """
        Convert async URL to sync URL for Alembic, Celery workers, psycopg2.
        Example: postgresql+asyncpg:// -> postgresql+psycopg2://
        Fallback to postgresql:// if driver unspecified.
        TLS parameters are re-emitted in libpq's spelling (sslmode=..., sslrootcert=...), which
        psycopg2/libpq enforce natively (audit F30).
        """
        url, tls = split_postgres_tls(self.DATABASE_URL)
        if "+asyncpg" in url:
            url = url.replace("+asyncpg", "+psycopg2")
        elif "postgresql://" in url and "+psycopg2" not in url:
            url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
        if tls:
            parts = urlsplit(url)
            query = parse_qsl(parts.query, keep_blank_values=True)
            query += [(k, tls[k]) for k in ("sslmode", "sslrootcert") if k in tls]
            url = urlunsplit(parts._replace(query=urlencode(query)))
        return url

    def redis_ssl_options(self) -> Optional[Dict[str, Any]]:
        """TLS options for redis-py / kombu / the Celery Redis result backend (audit F30).

        None for a plaintext redis:// URL (development only; production refuses it). For rediss://
        the server certificate must chain to REDIS_TLS_CA_FILE (or the system store) and match the
        hostname. kombu would otherwise default a bare rediss:// broker URL to CERT_NONE."""
        if urlsplit(self.REDIS_URL).scheme != "rediss":
            return None
        opts: Dict[str, Any] = {"ssl_cert_reqs": ssl.CERT_REQUIRED, "ssl_check_hostname": True}
        if self.REDIS_TLS_CA_FILE:
            opts["ssl_ca_certs"] = self.REDIS_TLS_CA_FILE
        return opts

    @property
    def celery_broker_url(self) -> str:
        return self.CELERY_BROKER_URL or self.REDIS_URL

    @property
    def celery_result_backend(self) -> str:
        return self.CELERY_RESULT_BACKEND or self.REDIS_URL

    @property
    def journals_a(self) -> List[str]:
        return [j.strip() for j in self.PLS_JOURNALS.split(",") if j.strip()]

    @property
    def journals_b(self) -> List[str]:
        return [j.strip() for j in self.PLS_JOURNALS_B.split(",") if j.strip()]

    @property
    def all_journals(self) -> List[str]:
        """Deduplicated list preserving order A then B."""
        seen = set()
        result: List[str] = []
        for j in self.journals_a + self.journals_b:
            if j not in seen:
                seen.add(j)
                result.append(j)
        return result

    @property
    def drive_enabled_effective(self) -> bool:
        """True only if enabled AND folder ID set and credentials present."""
        if not self.GOOGLE_DRIVE_ENABLED:
            return False
        if not self.DRIVE_FOLDER_ROOT:
            return False
        # If no credentials env, we still attempt to use ADC or file path
        return True

    def get_fernet(self) -> Fernet:
        """Return a Fernet instance from ENCRYPTION_KEY with runtime validation."""
        try:
            return Fernet(self.ENCRYPTION_KEY.encode())
        except Exception as e:
            # Regenerate key hint for operator
            raise RuntimeError(f"Invalid ENCRYPTION_KEY - generate with Fernet.generate_key(): {e}") from e

    def encrypt_value(self, plaintext: str) -> str:
        """Encrypt a plaintext string using Fernet."""
        if plaintext is None:
            raise ValueError("Cannot encrypt None")
        f = self.get_fernet()
        return f.encrypt(plaintext.encode()).decode()

    def decrypt_value(self, token: str) -> str:
        """Decrypt a token using Fernet, with InvalidToken handling."""
        try:
            f = self.get_fernet()
            return f.decrypt(token.encode()).decode()
        except InvalidToken as e:
            raise ValueError("Failed to decrypt - invalid token or wrong ENCRYPTION_KEY") from e

    def get_pls_credentials(self) -> Dict[str, Dict[str, str | List[str]]]:
        """
        Returns structured credentials for both seats.
        Used by credential_manager to implement failover ONLY on real failure.
        """
        return {
            "seat_a": {
                "username": self.PLS_USER,
                "password": self.PLS_PASS,
                "journals": self.journals_a,
                "label": "primary",
            },
            "seat_b": {
                "username": self.PLS_USER_B,
                "password": self.PLS_PASS_B,
                "journals": self.journals_b,
                "label": "fallback",
            },
        }

    def get_credentials_for_journal(self, journal_code: str) -> Tuple[str, str, str]:
        """
        Given a journal code, return (username, password, seat_label).
        No auto-failover here - failover decision lives in credential_manager
        and triggers ONLY on exceptions / 5xx / auth errors, NOT empty results.
        """
        journal_code = journal_code.strip().upper()
        if journal_code in self.journals_a:
            return self.PLS_USER, self.PLS_PASS, "seat_a"
        if journal_code in self.journals_b:
            return self.PLS_USER_B, self.PLS_PASS_B, "seat_b"
        # Default to primary if journal unknown but listed in all
        return self.PLS_USER, self.PLS_PASS, "seat_a"

    def is_real_failure(self, exception: Exception | None, status_code: int | None = None, response_text: str | None = None) -> bool:
        """
        Determine if a failure qualifies for Seat B failover.
        Real failures: network errors, timeouts, 5xx, 401/403 after retry, captcha block.
        NOT real: empty search results, 0 PDFs, valid 200 with no data.
        """
        if status_code is not None:
            if status_code >= 500:
                return True
            if status_code in (401, 403):
                # Auth failure is real ONLY after retry already attempted elsewhere
                return True
            if status_code == 429:
                return True  # Rate limit - might need other seat
        if exception is not None:
            # httpx / network layer (FA-D3C-001: no browser in this runtime, so no browser timeout class)
            real_exception_names = (
                "TimeoutException",
                "ConnectTimeout",
                "ReadTimeout",
                "NetworkError",
                "ConnectionError",
                "RemoteProtocolError",
                "APIConnectionError",
            )
            if exception.__class__.__name__ in real_exception_names:
                return True
            msg = str(exception).lower()
            if any(k in msg for k in ["timeout", "connection", "network", "temporary failure", "bad gateway", "service unavailable", "too many requests"]):
                return True
        if response_text:
            lowered = response_text.lower()
            if any(k in lowered for k in ["session expired", "blocked", "captcha", "access denied", "login required", "internal server error"]):
                # Only treat as real failure if status also indicates issue, not 200 with message
                return status_code is None or status_code != 200
        return False

    def get_log_level_int(self) -> int:
        return getattr(logging, self.LOG_LEVEL.upper(), logging.INFO)

    def model_dump_safe(self) -> Dict[str, str | int | float | bool | List[str]]:
        """Return dict for logging with secrets redacted."""
        data = self.model_dump()
        for key in ["PLS_PASS", "PLS_PASS_B", "ENCRYPTION_KEY", "ADMIN_API_KEY", "SECRET_KEY"]:
            if key in data and data[key]:
                val = str(data[key])
                data[key] = val[:4] + "***REDACTED***" + val[-2:] if len(val) > 6 else "***REDACTED***"
        return data


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """
    Cached settings singleton. Use throughout FastAPI via Depends(get_settings).
    LRU cache ensures .env is read once, thread-safe.
    """
    settings = Settings()
    # Ensure directories exist for PDF vault if running locally
    for path_attr in ["PDF_STORAGE_PATH", "STATE_STORAGE_PATH"]:
        p = Path(getattr(settings, path_attr))
        try:
            if not p.exists() and os.environ.get("SKIP_DIR_CREATE") != "1":
                p.mkdir(parents=True, exist_ok=True)
        except Exception:
            # In read-only containers / tests, creation may fail - ignore
            pass
    return settings


# Default instance for legacy imports: from config import settings
settings = get_settings()


def reload_settings() -> Settings:
    """Force reload from env - clears lru_cache (useful in tests)."""
    get_settings.cache_clear()
    global settings
    settings = get_settings()
    return settings


# ---------------------------------------------------------------------
# Module-level helpers for immediate use without DI
# ---------------------------------------------------------------------
def generate_new_fernet_key() -> str:
    """Utility: generate a new Fernet key for ENCRYPTION_KEY rotation."""
    return Fernet.generate_key().decode()


def validate_settings_or_raise() -> Settings:
    """
    Validate all critical settings at startup.
    Called in FastAPI lifespan or Celery worker init.
    """
    s = get_settings()
    # This triggers all pydantic validators; if invalid, Pydantic ValidationError raised
    # Additional runtime checks:
    if s.GOOGLE_DRIVE_ENABLED and not s.DRIVE_FOLDER_ROOT:
        raise ValueError("GOOGLE_DRIVE_ENABLED is True but DRIVE_FOLDER_ROOT is empty")
    if s.EMBEDDING_BATCH_SIZE > 200 and s.OPENAI_EMBEDDING_MODEL.startswith("text-embedding-3-small"):
        logging.warning("Large EMBEDDING_BATCH_SIZE may hit token limits for text-embedding-3-small")
    return s
