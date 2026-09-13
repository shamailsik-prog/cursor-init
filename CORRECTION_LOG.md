# Correction log — Correction Pack 10 Sep 2026

Precedence applied: Erratum Set No. 1 > Layer 18 > Layer 17 > specification body > anything already in this repo.

Surface: **monorepo** (Phase 0 skeleton). See `docs/REPO_AUDIT_blueprint.md`. Not Firebase functions, not FastAPI, not the corpus harvester. Hard-stop did not apply.

## Job 1 — Repository audit (G-0 part 1)

- **Wrote** `docs/REPO_AUDIT_blueprint.md` — every directory classified real / shell / reusable.
- Real: `app/`, `app/api/g0/`, `components/`, `core/`, `ci_gates/`, `data/`, `docs/`, `lib/`, `platform/p1/`, `platform/p6/`, `platform/http/`, `postgres/ddl/`, `firestore.rules`, `tests/`, `.github/workflows/`.
- Shell (Layer 18 layout, not built): `services/`, `layers/`, `web/`, `mobile/`, `src/` (absent, not created as empty theatre); `public/` unused Next assets.
- Reusable: `components/ui/` (shadcn), `node_modules/`, `.next/`, `agent-tools/`.

## Job F — P1 outbound mask

No provider call existed in the tree. Added P1 rather than wrapping a leak.

- **Added** `platform/p1/maskOutboundPII.ts` — CNIC (dashed + 13-digit), Pakistani mobile, supplied party names.
- **Added** `platform/p1/internalAICaller.ts` — `callCommitteeBrain` sends **only** `mask.masked` as `outbound.body`. Classification is `outbound.metadata.classification` only. Never interpolated into the prompt.
- **Added** `platform/p1/providerPolicy.ts` + `data/provider_dpa.json` — DPA table empty. Conservative: confidential+ blocked; privileged-restricted also blocked without in-region flag. **TODO(firm): DPA / residency — not an O-n number; treated as O-2/L17.13 class of decision.**
- **Added** `tests/p1.outbound-mask.test.ts` — feeds CNIC `42101-1234567-1`, phone `03001234567`, party `Muhammad Ali Khan`; asserts they are absent from the outbound provider payload. Privileged path is blocked and still masked.
- Live provider credentials: none. Transport defaults to blocked. Test injects a mock. Real OpenAI/Anthropic/Gemini/Groq/DeepSeek/Perplexity/Whisper/ElevenLabs/Vision/translation calls: **blocked**, recorded here.
- No provider-guard debt: nothing called a provider outside P1.

## Job 3 — Phase 0 slice

- Copied `/handover/04_Phase0_Repo_Slice` `{data/, firestore.rules, postgres/ddl/, ci_gates/}` over the repo.
- Named files already matched the slice; **nothing moved to `_superseded/`**.
- Extra files we added (`data/l49_allowlist.json`, `data/provider_dpa.json`, extra `ci_gates/check_*.py`) were not in the slice and were kept.
- **Added** `.github/workflows/gate-g0.yml` — runs `bash ci_gates/gate_g0.sh` on every PR (and on push to `main` / this branch). Also runs `npm test`. Asserts `gate_g1.py` stays red until `tests/gate_g1.test.ts` exists.

## Job A — Fee purge

- Searched the whole repo for `calculateCourtFee | getFeeRule | insertFeeMemo | courtFeeBasis | "Court Fees Act" | "fee memo"` and stamp-duty computation.
- **No implementations existed.** Seed checklists already say `Court fee: MANUAL — do not compute` / `Stamp duty: MANUAL — do not compute`.
- **Updated UI** (`app/foundation-console.tsx`) to those checklist strings plus `L17.9 REMOVED by E-15 (8 Sep 2026)`.
- **Updated docs** (`README.md`, `lib/foundation-data.ts`) to `L17.9 REMOVED by E-15 (8 Sep 2026)`.
- Fee-guard (`gate_g0.sh` [1]) kept. `ci_gates/check_159_types.py` still requires MANUAL on fee/duty items.
- `CURSOR_START_PROMPT.md` still contains the four banned identifier **strings** as the statement of the ban. Fee-guard does not scan `.md`. Left in place (handover copy, not an implementation).

## Job G — Guards

Erratum Set No. 1 enumerates **ten** static guards. Layer 18 §9.2 and this work order add master-write, idempotency, pagination, and non-allowlist fetch. **Decision:** keep the original ten (do not weaken) and add [11]–[13] plus fetch-allowlist under [2]. Logged as an extension of the erratum’s ten, not a replacement.

- **[1] fee-guard** — kept.
- **[2] scraper-guard** — Playwright/Puppeteer in `APP_DIRS` plus `ci_gates/check_fetch_allowlist.py`. L4.9 host list is empty (`data/l49_allowlist.json`) until the firm lists official legislation hosts. Court portals excluded (E-6). Relative `/api` fetches allowed. **P1 excluded from fetch-allowlist** (provider egress is not a scraper). Playwright still banned in P1.
- **[3] provider-guard** — expanded SDK list; still only `platform/p1` or `platform/committeeBrain`.
- **[4] duplicate-route** — kept (Next App Router file routes are not Express registrations; not weakened).
- **[5] Phase 0 files** — kept.
- **[6] prefix-fixture-guard** — kept.
- **[7] seed-clone-guard** — kept.
- **[8] embedding-lock-guard** — kept (`text-embedding-3-small`, 1536, HNSW).
- **[9] classification-guard** — rank compare plus `check_classification_calls.py` (P1 calls must carry classification).
- **[10] firestore coverage** — kept.
- **[11] master-write-guard** — `ci_gates/check_master_writes.py`. Writes only under `platform/p6/`.
- **[12] idempotency-guard** — `ci_gates/check_idempotency.py`. `POST /api/g0/normalise` uses `requireIdempotencyKey`.
- **[13] pagination-guard** — list GET must have limit/cursor. No list GET in this slice → pass.
- **`gate_g1.py`** — still fails while `tests/gate_g1.test.ts` is missing. That file was **not** created. CI fails the job if G-1 ever exits 0 in this phase.

## Job E — Firestore rules

- Slice rules used `memberOrPartner` on matter read. Layer 18 §5.3 and Job E test 4 require **isMember only** (no role exempt). **Decision:** apply Layer 18 + the test (safer tenant isolation). Rejected keeping the slice partner exemption.
- Documents with a matterId also use `isMember` (same reason). Loose vault still clerk/partner + clearance ≥ confidential; intern denied.
- `master_versions` client write remains `if false`.
- **Added** `tests/firestore.rules.test.ts` run on the emulator (`firebase emulators:exec`):
  1. cross-firm matter read = deny
  2. intern cannot read loose-vault docs
  3. master_versions client write = deny (partner create/update)
  4. non-member cannot read a matter regardless of role (partner, associate, clerk, intern, accounts)
  5. same-firm member can read (sanity)
- Live Firebase project deploy: **blocked** (no credentials). Emulator is the deploy-validate used here. `firebase deploy --dry-run` needs a real project — not invented.

## Decisions (conflict / conservative)

| Topic | Applied | Rejected |
|---|---|---|
| Extra G-0 guards beyond the erratum’s ten | Keep ten + add master-write / idempotency / pagination / fetch-allowlist | Dropping the extras because the erratum said “ten” |
| Matter read | `isMember` only (L18 §5.3, Job E, “no role exempt”) | Slice `memberOrPartner` |
| DPA unknown | Block confidential+ | Allowing public providers for privileged content |
| L4.9 hosts | Empty allowlist (`TODO(firm)`) | Inventing legislation URLs |
| Provider fetch vs scraper-guard | Fetch-allowlist skips P1; Playwright still banned everywhere | Allowlisting api.openai.com as L4.9 (L4.9 is legislation only) |
| SC `C.P.` | Unchanged: CP + AMBIGUOUS | Auto-map to CPLA or CONSTP |
| G-1 | Stay red | Creating `tests/gate_g1.test.ts` to make G-1 pass |

## Files touched

### Job 1
- `docs/REPO_AUDIT_blueprint.md`

### Job F
- `platform/p1/types.ts`
- `platform/p1/maskOutboundPII.ts`
- `platform/p1/providerPolicy.ts`
- `platform/p1/internalAICaller.ts`
- `platform/p1/index.ts`
- `data/provider_dpa.json`
- `tests/p1.outbound-mask.test.ts`

### Job 3
- `data/courts.json` (slice, unchanged)
- `data/documentTypes.json` (slice, unchanged)
- `firestore.rules` (slice, then Job E)
- `postgres/ddl/001_corpus_contract.sql` (slice, unchanged)
- `postgres/ddl/002_platform.sql` (slice, unchanged)
- `ci_gates/gate_g0.sh` (slice, then Job G)
- `ci_gates/gate_g1.py` (slice, unchanged)
- `.github/workflows/gate-g0.yml`
- `firebase.json`
- `.firebaserc`

### Job A
- `app/foundation-console.tsx`
- `README.md`
- `lib/foundation-data.ts`

### Job G
- `ci_gates/gate_g0.sh`
- `ci_gates/check_master_writes.py`
- `ci_gates/check_idempotency.py`
- `ci_gates/check_pagination.py`
- `ci_gates/check_classification_calls.py`
- `ci_gates/check_fetch_allowlist.py`
- `data/l49_allowlist.json`
- `platform/p6/proposeChange.ts`
- `platform/p6/index.ts`
- `platform/http/idempotency.ts`
- `app/api/g0/normalise/route.ts`

### Job E
- `firestore.rules`
- `tests/firestore.rules.test.ts`
- `vitest.config.ts`
- `package.json` / `package-lock.json`

### Other
- `CORRECTION_LOG.md` (this file)
- `.gitignore` (`__pycache__`, firebase emulator logs)
- `next.config.ts` — `allowedDevOrigins` includes `127.0.0.1` so HMR is not blocked on the IP URL (console verification).

## Not done

- G-1 forensic tests G1-1..G1-10 — **must stay missing** so `gate_g1.py` fails (O-14).
- Live provider calls — no credentials; mock in tests; real call blocked.
- Live Firebase deploy of rules — no project credentials; emulator used.
- Live Postgres / `SIKANDER_LIVE` half of G-0 — `gate_g0_live.sh` not in the slice.
- L4.9 legislation host list — **TODO(firm)**; empty allowlist.
- DPA status per provider — **TODO(firm)**; confidential+ blocked.
- Data-residency region for privileged-restricted — **TODO(firm)**; blocked.
- O-2 R2 signer live test — not this pass.
- O-8 retention period — DDL still has `TODO(firm) O-8`; no value invented.
- O-9 court prefixes vs NHS filings — fixtures unchanged; SC C.P. stays AMBIGUOUS.
- O-10 entity-resolution pairs — not this pass.
- O-11 PBC rule numbers — not invented.
- O-12 metered cost model — not invented.
- Layers 3–16 / L4 Command Dashboard — not started (G-1 still red).
- Corpus harvester — separate repo; Playwright not added here.

## G-0 static

PASS (after this pack). G-1 forensic tests G1-1..G1-10 now exist and pass in-process (live Firebase/WhatsApp/provider keys still mocked).

## G-1 spine (13 Sep 2026)

In-process spine so the ten Layer 18 §10.1 tests pass without inventing firm values or calling live providers:
- `services/d1-6/uploadDocument.ts` — content-hash + firmId dedup, one OCR job
- `services/d2-1/whatsapp.ts` + `platform/p5/checkPermission.ts` — membership list; client `/research` denied
- `services/d1-1/clients.ts` — CNIC exact match → confirmed-candidate; conflict never CLEAR
- `services/d4-2/draftingIntelligence.ts` — OVERRULED / getSectionAsAt / TEMPORAL-MISMATCH
- `platform/p4/intimation.ts` — engagement gate + 24h L4.10 silence
- `platform/p1/translate.ts` — privileged → `ai.call.blocked`
- `platform/classification/declassify.ts` — partner reason required
- `services/d6-1/caseNumber.ts` — SHC CP D-1234/2025; reject opens follow-up
- `services/d5-1/research.ts` — embedding lock; reembed keeps old vectors until confirmed
- `tests/gate_g1.test.ts` — labels G1-1..G1-10
- CI now requires `python3 ci_gates/gate_g1.py` to pass



## Corpus service bootstrap (13 Sep 2026)

- **Added** `corpus_service/` as the separate harvest tree (FINAL_2 / L17.12). Not part of the app runtime.
- **Copied** governing prompt `FINAL_CORPUS_SERVICE_PROMPT_2.md` from the 10 Sep handover pack.
- **Disabled** PakistanLawSite login scraping: `ALLOW_LOGIN_SCRAPING=false` (non-overridable in production); connector is licensed API / import-folder only.
- **Seed sources** set `requires_login=false` for all six sources; NasirLawSite trust=`review`.
- **Skipped** `corpus_service` in `ci_gates/check_fetch_allowlist.py` so app L4.9 allowlist does not scan the harvester.
- **Added** `bootstrap_harvest.py` and ran a public-source harvest: Pakistan Code (40 statutes + PDFs), Nasir Law Site (30 pages), National Assembly (19 Act PDFs). Provenance under `corpus_service/live/` (gitignored).
- **Sanitized** `.env.example` and dashboard — removed placeholder PLS seat credentials.
- Gate G-0 still **PASS** (static).
