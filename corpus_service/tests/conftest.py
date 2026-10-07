"""Test-process defaults. The service fails closed to production unless told otherwise,
so the suite opts in to development explicitly (as .env.example does for local runs)."""

import os

os.environ.setdefault("ENVIRONMENT", "development")
os.environ.setdefault("SKIP_DIR_CREATE", "1")
