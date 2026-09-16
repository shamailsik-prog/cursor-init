# SIKANDER AI — Phase 0 foundations

Litigation operating system for **NHS Legal, Karachi**. This tree is the Gate G-0 starting slice from the 10 September 2026 handover pack. It does **not** yet implement drafting, WhatsApp, or Court Ops.

Precedence: Erratum Set No. 1 > Layer 18 > Layer 17 > specification body. Anything outside the handover pack is history (including the withdrawn v11 prompt).

## What is here

| Path | Role |
|---|---|
| `data/courts.json` | Court prefix table (Job B). Prefixes are data. |
| `data/documentTypes.json` | 159 VERIFIED types, keyed on `id` (Job C). |
| `firestore.rules` | Every Phase 0 collection + default deny. |
| `postgres/ddl/` | Annex A corpus contract + platform flags. Embedding lock: `text-embedding-3-small`, 1536, HNSW. |
| `ci_gates/gate_g0.sh` | Static guards (fee, scraper, provider, master-write, idempotency, pagination, classification, embedding). Fail the build; no warn-only checks. |
| `platform/p1/` | Committee Brain. Masked body is the only text sent to a provider. |
| `agent/` | eve Committee Brain project. Model is a P1 LanguageModel, not a direct Gateway call. |
| `core/case-number-normaliser.ts` | Same rules as `ci_gates/case_number_normaliser.py`. |
| Foundation console (this app) | Inspect G-0 artefacts. Not the L4 Command Dashboard. |

## Run locally

```bash
npm install
npm run gate:g0
npm run dev -- --port 43127
```

Open http://127.0.0.1:43127

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

The eve agent lives at `agent/` (`sikander-ai`). It is not a second provider path. `agent/agent.ts` uses `committeeBrainLanguageModel` from `platform/p1`, which only calls `callCommitteeBrain`. Default eve tools (`web_fetch`, `web_search`, `bash`) are off.

The foundation console **Committee Brain** tab posts to `POST /api/p1/committee-brain` (Idempotency-Key required). `next.config.ts` is not wrapped with `withEve()` so `npm run dev` stays the Phase 0 inspector. The eve CLI (`npm run eve:dev`) needs Node 24; the Next.js app and CI stay on Node 20+.

Do not set provider API keys. If a Gateway key already exists as `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY`, public-rank calls may leave. Internal+ stays blocked while `data/provider_dpa.json` is empty (`TODO(firm)`).

```bash
npm run eve:info   # Node 24 — discovered agent surface
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
