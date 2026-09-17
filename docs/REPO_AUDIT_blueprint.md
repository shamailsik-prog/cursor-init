# Repository audit — Gate G-0 (10 Sep 2026)

Surface: **monorepo** (Phase 0 application skeleton).
Not Firebase Cloud Functions, not FastAPI services, not the corpus harvester.

Layer 18 wants `/core`, `/platform`, `/services`, `/layers`. This tree is that monorepo at foundations only. Hard-stop (“not one of the four surfaces”) does not apply.

Classification: **real** = in use for G-0; **shell** = directory exists or is required by Layer 18 but has no owned behaviour yet; **reusable** = third-party / generated / ignore.

| Path | Class | Notes |
|---|---|---|
| `app/` | real | Phase 0 inspector (not L4 Command Dashboard). |
| `app/api/g0/` | real | `POST /api/g0/normalise` (Idempotency-Key). |
| `components/` | real | shadcn/ui primitives for the inspector. |
| `components/ui/` | reusable | shadcn generated primitives (Button, Input, Dialog-class widgets). |
| `core/` | real | Case-number normaliser (TS twin of `ci_gates/case_number_normaliser.py`). |
| `ci_gates/` | real | G-0 / G-1 scripts. Fail the build; no warn-only checks. |
| `data/` | real | `courts.json` prefix table; `documentTypes.json` 159 types; L4.9 allowlist stub. |
| `docs/` | real | Handover copies, seed xlsx, this audit. Not architecture authority. |
| `lib/` | real | Foundation seed loaders for the inspector. |
| `platform/` | real | P1 Committee Brain (Job F); P6 proposeChange stub (master writes only here). |
| `platform/p1/` | real | Outbound mask + `callCommitteeBrain`. Only place provider SDKs may be imported. Gateway transport (AI SDK `createGateway`) lives here. |
| `agent/` | real | eve Committee Brain. Instructions, P1 LanguageModel, local tools, sandbox deny-all. Not a provider path. |
| `platform/p6/` | real | Sole writer of master tables / `master_versions`. Stub `proposeChange`. |
| `platform/http/` | real | Idempotency helper for POST/PUT. |
| `postgres/ddl/` | real | Annex A corpus contract + platform flags. |
| `firestore.rules` | real | Every Phase 0 collection; default deny. |
| `tests/` | real | Job F mask test, fee-guard, Firestore rules tests. **No** `gate_g1.test.ts` (G-1 must stay red). |
| `.github/workflows/` | real | Runs `ci_gates/gate_g0.sh` on every PR. |
| `public/` | shell | Default Next.js static assets; unused by G-0 behaviour. |
| `services/` | shell | Absent. Layer 18 D1–D6 live here later. Not created as empty theatre. |
| `layers/` | shell | Absent. Amendment layers after G-1. |
| `web/` `mobile/` `src/` | shell | Absent. Guard `APP_DIRS` lists them so a future drop is scanned. |
| `node_modules/` | reusable | Generated. Not scanned by scraper-guard. |
| `.next/` | reusable | Build output. Gitignored. |
| `agent-tools/` | reusable | Cloud-agent scratch. Gitignored. |
| `_superseded/` | shell | Created only when a slice overwrite displaces a named file. |

## Provider / scraper scan of this pass

No OpenAI, Anthropic, Gemini, Groq, DeepSeek, Perplexity, Whisper, ElevenLabs, Google Vision, or translation SDK calls existed outside the P1 module added in Job F. No Playwright/Puppeteer in application source. `package-lock.json` may mention `@playwright/test` transitively under other packages; scraper-guard does not scan `node_modules` and this `package.json` does not depend on Playwright.

## Decision

Proceed with Jobs F–G on this monorepo. Corpus harvest remains a separate repository (`05_Corpus_Service`).
