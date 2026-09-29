# Independent phase auditor A–F audit: PR #311 GET 535–536 (+ PR309-M1)

**Auditor:** independent phase auditor (docs-only)  
**Landed squash SHA:** `8f7cffa485a9bdf9ef08e38ce0a239e32c7b7fba` (PR #311)  
**True first parent:** `4144c8527cd42451951799e2c3a974aa4359032b` (#310 docs); `4144c85^` = `792a7ed` (#309)  
**Evidence tip:** `0f68c3ed540007c8acf616f88945926c4b475b8e` (matches squash; diff empty)  
**Evidence:** `/opt/cursor/artifacts/pr311_audit.log`  
**Date:** 2026-09-29

## Executive verdict

| Scope | Verdict |
|---|---|
| **PR #311 @ `8f7cffa` (initial)** | **FAIL — PR311-MAJOR-1** |
| **PR #311 @ `8f7cffa` (re-seal @ `9e80f05`)** | **SEALED PASS [PARTIAL]** — see `docs/audits/pr313-fix-pr311-focused-bundle-audit.md` |

---

## PR311-MAJOR-1

Canonical focused ops runner **replaced** `…533-534-frontend-real.test.ts` with `…535-536-frontend-real.test.ts` in `FILES[@]` (still **34** files). The **533–534** test file remains on disk and passes in isolation but is **no longer in the unfiltered bundle** — raised-bar regression.

**Fix:** **35** files — include **both** 533–534 and 535–536 entries; update bundle doc and `FILES[@]` length guard.

---

## What passed (auditor replay)

- GET **535–536** on **533/534**; `route.ts` **46019** (+460); console **7085** (+32).
- Rules + arrays **533–536** aligned; break tests non-vacuous.
- PR309-M1: denyWrite **or** Job E missing rule fails (whitelist unchanged).
- `test:rules` **172** (56+101+1+14); isolation **33/33**; claim replay **PASS**.
- `/ops` L6640–6663 for **535/536**.

## Minors

- **PR311-M2:** Evidence ref `origin/evidence/get-535-536` fetch succeeded locally; tip **`0f68c3e`** equals squash.
