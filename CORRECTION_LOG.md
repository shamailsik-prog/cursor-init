# Correction log — Phase 0 tree in this repository

## 10 Sep 2026 pack (copied from Google Drive `ss ai` / SIKANDER_AI_HANDOVER_10Sep2026-2.zip)

See the pack’s original `04_Phase0_Repo_Slice/CORRECTION_LOG.md` (Jobs A–G). Those files were copied in unchanged:

- `data/courts.json`
- `data/documentTypes.json`
- `firestore.rules`
- `postgres/ddl/001_corpus_contract.sql`
- `postgres/ddl/002_platform.sql`
- `ci_gates/gate_g0.sh`, `gate_g1.py`, `case_number_normaliser.py`, `validate_case_numbers.py`, `check_159_types.py`, `check_duplicate_routes.py`
- `docs/SIKANDER_AI_DocumentTypes_Seed_159_v1.1_10Sep2026.xlsx`
- `CURSOR_START_PROMPT.md`
- `docs/HANDOVER_MANIFEST.md`

## This repository (9 Sep 2026 session)

- Copied the Phase 0 slice to the application root as instructed by `CURSOR_START_PROMPT.md`.
- Ran `bash ci_gates/gate_g0.sh` — static half PASSED.
- Added a Next.js Phase 0 inspector only (not L4 Command Dashboard, not Layers 3–16):
  - `app/page.tsx`, `app/layout.tsx`, `app/foundation-console.tsx`, `app/globals.css`
  - `app/api/g0/normalise/route.ts` — POST `/api/g0/normalise` (Idempotency-Key required)
  - `core/case-number-normaliser.ts` — TypeScript twin of the Python normaliser for the inspector
  - `lib/foundation-data.ts`
- `package.json` — `gate:g0` script; renamed package to `sikander-ai`.
- `README.md` — how to run G-0 and the inspector.
- Did **not** invent values for O-2, O-8, O-9, O-10, O-11, O-12.
- Did **not** add court-fee functions, scrapers, or provider SDKs.
- Stopped after G-0 green, per the start prompt. G-1 is still red until the ten forensic tests exist.
