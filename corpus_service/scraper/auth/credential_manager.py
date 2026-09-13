"""Credential manager — FINAL_2 compliant.

Retained ONLY for licensed-API token handling (Fernet at rest).
Interactive login-form discovery, credential-slot rotation, and failover
are disabled. Calling login helpers raises ConfigurationError.
"""

from __future__ import annotations

import logging
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


class ConfigurationError(RuntimeError):
    """Raised when a forbidden login-scraping path is attempted."""


class CredentialManager:
    """Stores and retrieves licensed API tokens. No form login."""

    def __init__(self, fernet_key: str) -> None:
        if not fernet_key:
            raise ValueError("ENCRYPTION_KEY / fernet key required")
        self._fernet = Fernet(fernet_key.encode() if isinstance(fernet_key, str) else fernet_key)

    def encrypt_token(self, token: str) -> str:
        return self._fernet.encrypt(token.encode()).decode()

    def decrypt_token(self, token_enc: str) -> str:
        try:
            return self._fernet.decrypt(token_enc.encode()).decode()
        except InvalidToken as e:
            raise ConfigurationError("invalid encrypted API token") from e

    def login(self, *args, **kwargs):  # noqa: ANN001
        raise ConfigurationError(
            "FINAL_2: login-form scraping is disabled. "
            "Use a licensed API key or drop exports into /imports/PakistanLawSite/"
        )

    async def async_login(self, *args, **kwargs):  # noqa: ANN001
        raise ConfigurationError(
            "FINAL_2: login-form scraping is disabled. "
            "Use a licensed API key or drop exports into /imports/PakistanLawSite/"
        )

    def get_session(self, *args, **kwargs):  # noqa: ANN001
        raise ConfigurationError(
            "FINAL_2: interactive sessions are disabled (no login scraping)"
        )


def assert_login_scraping_disabled(allow_login_scraping: bool, environment: str) -> None:
    if allow_login_scraping and str(environment).lower() == "production":
        raise ConfigurationError(
            "ALLOW_LOGIN_SCRAPING cannot be true when ENVIRONMENT=production"
        )
