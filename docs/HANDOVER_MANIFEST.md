# SIKANDER AI — Handover Manifest (10 September 2026)

Everything needed to start the build is in this folder. Nothing outside it is authoritative.

## 01_Governing_Architecture
- SIKANDER_AI_MASTER_COMPLETE_v10_1_1_10Sep2026.pdf — the bound record: v9 set (Docs 1–24) + Layer 17 (Doc 25) + Layer 18 (Doc 26) + Erratum Set No. 1 (Doc 27). Reference, not a build instruction.
- SIKANDER_AI_Layer17_Amendment_No1_7Sep2026.pdf / .docx — governing architecture: rulings, errata E-1–E-14, components L17.1–L17.14, Annex A corpus contract, Annex B corpus-service corrections. (E-3 is reversed by Layer 18 E-15.)
- SIKANDER_AI_Layer18_Implementation_Consolidation_10Sep2026.pdf / .docx — how it is built: 23 services with one owner per function, engineering standards, Phase 0 DDL, courts, entity resolution, WhatsApp grammar, layer protocol, gates, test matrix, completeness map, Annex C (159 types).
- SIKANDER_AI_Layer18_Erratum_Set_No1_10Sep2026.pdf / .docx — the latest corrections (W-15–W-22): normaliser as prefix table, SC "C.P." ambiguity rule, seed contracts by posture, ownership patches, Firestore rules for all collections, gates that fail. Governs over Layer 18 where they differ.

## 02_Developer_Guides
- SIKANDER_AI_Developer_Reading_Order_and_Build_Brief_7Sep2026.pdf / .docx — read first.
- SIKANDER_AI_COMPLETE_DEVELOPER_SPECIFICATION_v10_1_1_10Sep2026.pdf / .docx — one file, every module and layer component, with all corrections applied in the text; Part II-A carries Layer 18.
- SIKANDER_AI_Developer_Build_Guide_Complete_7Sep2026.pdf / .docx — implementation view per module (superseded on any conflict by the documents above).

## 03_Data_Seeds
- SIKANDER_AI_DocumentTypes_Seed_159_v1_1_10Sep2026.xlsx — 159 approved document types with posture, firstGroundRule, requiredFields, annexureRule, checklist; REMOVED sheet holds the excluded fee sheet. Partner-editable.
- documentTypes.json — the same, as arrays, keyed on id.
- courts.json — court prefix table, synonyms, bench letters, fixtures.

## 04_Phase0_Repo_Slice
- Copy into the application repository root. Contains data/, firestore.rules, postgres/ddl/001_corpus_contract.sql and 002_platform.sql, ci_gates/ (gate_g0.sh with ten static guards, gate_g1.py that fails until tests exist, case_number_normaliser.py, validate_case_numbers.py, check_159_types.py, check_duplicate_routes.py), CORRECTION_LOG.md.

## 05_Corpus_Service
- FINAL_CORPUS_SERVICE_PROMPT_2.md — build prompt for the separate corpus service (Playwright allowed here only; no login scraping; writes to the Annex A contract).

## 06_Firm_Open_Items
- SIKANDER_AI_Firm_Decisions_Register_7Sep2026.pdf / .docx — decisions only the firm can make (data residency, insurer, DPAs, gateway, OCR vendor, CFMS forms, Firebase disposition, in-region routing, Drive segregation).
- Open items: O-2 R2 signer live test · O-8 retention period · O-9 confirm court prefixes against the firm's filings · O-10 200/200 entity-resolution pairs · O-11 PBC rule numbers · O-12 metered cost model at G-1.

## Withdrawn (do not use)
rev-17; v11 Master Prompt; v11.1 Corrected Spec; v10.1.1 "FINAL CLEAN" (10 Sep, tool-generated); the tool-generated courts.json / documentTypes.json / gate_g1.py of 10 Sep; FINAL_SCRAPER_PROMPT_1; the Cruel Critic Audit and Claude Code Correction Pack (absorbed into Layer 18 and Erratum Set No. 1).
