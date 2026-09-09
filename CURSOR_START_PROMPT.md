# Paste this as the first message in Cursor / Claude Code

You are building SIKANDER AI for NHS Legal, Karachi. Read, in this order, before writing any code:

1. 02_Developer_Guides/SIKANDER_AI_Developer_Reading_Order_and_Build_Brief_7Sep2026.pdf  (reading order, precedence, non-negotiables, gates, phased build order)
2. 01_Governing_Architecture/SIKANDER_AI_Layer18_Erratum_Set_No1_10Sep2026.pdf          (latest corrections — governs over Layer 18 where they differ)
3. 01_Governing_Architecture/SIKANDER_AI_Layer18_Implementation_Consolidation_10Sep2026.pdf (23 services, one owner per function, standards, DDL, gates, Annex C)
4. 01_Governing_Architecture/SIKANDER_AI_Layer17_Amendment_No1_7Sep2026.pdf              (what the system is; Annex A corpus contract; E-3 is reversed by E-15)
5. 02_Developer_Guides/SIKANDER_AI_COMPLETE_DEVELOPER_SPECIFICATION_v10_1_1_10Sep2026.pdf (every module and layer component, corrections applied in text)

Precedence: Erratum Set No. 1 > Layer 18 > Layer 17 > the specification body > everything else. Any document not in this folder is history.

Start at Gate G-0. The Phase 0 slice in 04_Phase0_Repo_Slice/ (courts prefix table, document-type seed, firestore.rules, DDL, ci_gates/) is the starting tree: copy it in, run `bash ci_gates/gate_g0.sh`, and do not proceed while it fails. Do not build any Layer 3–16 feature before Gate G-1 passes.

Non-negotiables you must never break (CI enforces them):
- No court-fee calculation anywhere (calculateCourtFee, getFeeRule, insertFeeMemo, courtFeeBasis fail the build). Court fee and stamp duty are MANUAL checklist items only.
- Every AI / OCR / STT / TTS / translation call goes through P1 Committee Brain with a classification; no provider SDK outside P1; the masked prompt is what is sent.
- No scraper, Playwright or Puppeteer in this repository; the corpus service is a separate repository (05_Corpus_Service).
- Tenant and matter scoping at the data layer; no role exempt; no channel broader than the web app.
- Classification compares ranks 0–4, inherits monotonically, downgrade only by partner declassify().
- Master knowledge is written by P6 only; everyone else calls proposeChange.
- Embedding lock: text-embedding-3-small, 1536 dims, HNSW; search refuses on mismatch.
- Citation gate + human approval before any court-facing document leaves.
- Loose vault never deletes; escalate at 30 days.
- Key document types on `id`, never on row number. Do not invent types, court prefixes, PBC rule numbers or fee schedules.

Open items that only the firm can close (do not fill with invented values): O-2, O-8, O-9, O-10, O-11, O-12 — see 06_Firm_Open_Items and Erratum Set No. 1 §ES1-4. Mark them TODO(firm).

Write CORRECTION_LOG.md listing every file you touch. Stop after G-0 is green and report.
