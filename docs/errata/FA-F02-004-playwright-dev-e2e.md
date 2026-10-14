# Erratum FA-F02-004 — root `@playwright/test` (dev e2e)

**Status:** allowlisted in G-0 (`package.json:playwright` under `fa_d3c_001_scraper`).

**Scope:** `@playwright/test` is declared only in root `devDependencies` for Gate G-0 jobs `F02 console auth (Playwright)` and `test:e2e:console-auth`. It is not used for corpus harvest or production runtime.

**Owner ruling:** pending final confirmation whether console e2e remains in-repo or moves to a dedicated tooling package.

**Until then:** do not add Playwright to `dependencies`, Dockerfiles, or `corpus_service` without updating the allowlist and this erratum.
