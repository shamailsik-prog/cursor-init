# SIKANDER AI — Phase 0 foundations

Litigation operating system for **NHS Legal, Karachi**. This tree is the Gate G-0 starting slice from the 10 September 2026 handover pack. It does **not** yet implement drafting, WhatsApp, or Court Ops.

Precedence: Erratum Set No. 1 > Layer 18 > Layer 17 > specification body. Anything outside the handover pack is history (including the withdrawn v11 prompt).

## What is here

| Path | Role |
|---|---|
| `data/courts.json` | Court prefix table (Job B). Prefixes are data. |
| `data/documentTypes.json` | 159 VERIFIED types, keyed on `id` (Job C). |
| `firestore.rules` | Every Phase 0 collection + default deny. Matter-bound `documents`, `document_versions` and non-engine `jobs` reads also check the matter's current label (audit F14): two access calls per distinct matter on top of two identity calls, so a client transaction or batch over rows of about nine or more matters can be denied (limit 20); split such work by matter. |
| `postgres/ddl/` | Annex A corpus contract + platform flags. Embedding lock: `text-embedding-3-small`, 1536, HNSW. |
| `ci_gates/gate_g0.sh` | Static guards (fee, scraper, provider, master-write, idempotency, pagination, classification, embedding). Fail the build; no warn-only checks. |
| `platform/p1/` | Committee Brain. Masked body is the only text sent to a provider. |
| `agent/` | eve Committee Brain project. Model is a P1 LanguageModel, not a direct Gateway call. |
| `core/case-number-normaliser.ts` | Same rules as `ci_gates/case_number_normaliser.py`. |
| Foundation console (this app) | Inspect G-0 artefacts. Monitor tab is the live status board (Update button). Not the L4 Command Dashboard. |

## Run locally

```bash
npm ci                     # frozen install: exactly what package-lock.json pins, never rewritten
npm ci --prefix functions
npm run gate:g0
npm run dev -- --port 43127
```

Open http://127.0.0.1:43127

Toolchain (audit F39, F48): **Node 22** for the foundation console, Cloud Functions and every mandatory CI job (`.nvmrc`, root `engines.node`, `functions/package.json` `engines.node`). **Node 24** is only for the optional eve agent CLI (`eve` declares `engines.node >=24`); it is not the Functions deploy target. Use `.nvmrc.eve` when activating eve locally (`fnm use` / `nvm install` per that file, in a separate shell from Node 22 work). Production setup stays on Node 22:

```bash
npm ci && npm ci --prefix functions   # Node 22
npm run gate:node-toolchains          # static F48 guard
```

Optional eve (Node 24 only):

```bash
npm run eve:toolchain-check   # same script as CI job eve-toolchain
npm run eve:dev
```

npm is pinned at 10.9 in both manifests (`packageManager` `npm@10.9.9`; `devEngines.packageManager` `~10.9.0`, `onFail: warn`). Node 24 ships npm 11, which warns but still installs the same lockfile. CI enforces the pin on Node 22 jobs: `npm run gate:lockfiles`. Change dependencies with the pinned npm on Node 22 (`corepack npm …` or `npm install -g npm@10.9.9`), then commit `package.json` and `package-lock.json` together.

## Gate G-0

```bash
bash ci_gates/gate_g0.sh
```

Must pass before any Layer 3–16 work.

```bash
npm test                 # P1 mask + G-1 forensic
npm run test:rules       # Firestore emulator rules
python3 ci_gates/gate_g1.py
```

Live Firestore/Postgres checks: `SIKANDER_LIVE=1 bash ci_gates/gate_g0.sh` (needs `ci_gates/gate_g0_live.sh`, not in this slice).

## Committee Brain (eve)

The eve agent lives at `agent/` (`sikander-ai`). It is not a second provider path. `agent/agent.ts` uses `committeeBrainLanguageModel` from `platform/p1`, which only calls `callCommitteeBrain` (no provider transport, audit F18); eve has no signed-in caller or matter, so its calls are blocked until it reaches the Cloud Functions route with a caller's identity. Default eve tools (`web_fetch`, `web_search`, `bash`) are off.

The foundation console **Committee Brain** tab posts to `POST /api/p1/committee-brain` (Idempotency-Key required). `next.config.ts` is not wrapped with `withEve()` so `npm run dev` stays the Phase 0 inspector on Node 22. The eve CLI (`npm run eve:dev`, `npm run eve:info`) runs only after switching to Node 24 (`.nvmrc.eve`); CI proves that path in the separate **eve-toolchain** job while Functions tests and deploy stay on Node 22 (audit F48).

Paid AI calls run only in Cloud Functions P1 (`/api/platform/brain/committeeBrain`), where the kill switches, the monthly budget and the cost log apply (audit F18, spec `docs/superpowers/specs/2026-10-18-f18-legacy-ai-path-closed-design.md`). The Next.js and eve runtime has no provider transport: `callCommitteeBrain` masks and applies policy, then is blocked (`PHASE0_NO_CREDENTIALS`) unless a test injects a transport. In a Firebase session `POST /api/p1/committee-brain` forwards the request to the Functions route with the caller's own ID token, firm and Idempotency-Key (base URL `SIKANDER_FUNCTIONS_API_BASE_URL`); with no Functions URL configured it records a blocked row as before, and when Functions does not answer it fails closed (503 `p1_functions_unavailable`, 504 `p1_functions_timeout`, 502 `p1_functions_bad_answer`) with an alert line.

Never set a provider API key (`AI_GATEWAY_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY` or any other in `platform/p1/providerKeyGuard.ts`) in the Next.js or eve environment: the key belongs to the Functions `api` function only. Under `NODE_ENV=production` a key there refuses every AI call with an alert line (`p1.provider_key_in_next_runtime`) and eve refuses to start; G-0 check [19] (`ci_gates/check_next_ai_egress.py`) fails any AI SDK, provider SDK, key or provider host in the Next/eve code and any deploy surface that hands it a key. Through the Functions path, per L18 §4.6, public and internal calls may leave; confidential and above stay blocked while `data/provider_dpa.json` is empty (`TODO(firm)`).

```bash
# After `nvm use 24` / `.nvmrc.eve`:
npm run eve:info   # discovered agent surface
```

## Non-negotiables

- Court fee and stamp duty are MANUAL checklist items only. L17.9 REMOVED by E-15 (8 Sep 2026). The four banned identifiers fail CI.
- No Playwright / Puppeteer in this repository. Corpus harvest is a separate repo (`05_Corpus_Service` in the handover pack).
- Provider SDKs only under `platform/committeeBrain` or `platform/p1`.
- Tenant and matter scoping at the data layer. No role exempt.
- Classification ranks 0–4, monotonic. Downgrade only via partner `declassify()`.
- Master knowledge written by P6 only.
- Do not invent document types, court prefixes, PBC rule numbers, or fee schedules.

## Open items (firm only)

O-2, O-8, O-9, O-10, O-11, O-12 — marked `TODO(firm)`. See `docs/HANDOVER_MANIFEST.md` and Erratum Set No. 1 §ES1-4.

## Secrets

None required for Phase 0. Firebase, R2, and Postgres are not connected. The console reads the seed JSON and DDL in-repo. When those services exist, set them in `.env.local` — do not invent residency, DPA, or bucket values (O-2 / O-8).
