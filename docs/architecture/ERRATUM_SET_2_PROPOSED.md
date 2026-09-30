# SIKANDER AI — Layer 18 · Erratum Set No. 2 (PROPOSED)

Stack, chain freeze, corpus service boundary, authentication · errata E-23 to E-26
Prepared for Advocate Shamail Sikander · NHS Legal, Karachi · 30 September 2026

**Status: PROPOSED. Pending the partner's signature. Not governing until signed.**
On signature this set is bound behind Erratum Set No. 1 under the Layer 17 §1.4 protocol. Until then it is a
recommendation, and the text of the v19 set is unchanged. Precedence once signed: Layer 18 Erratum Set No. 2 >
Layer 18 Erratum Set No. 1 > Layer 18 > Layer 17 > earlier text (see `README.md`). This ordering is inferred from Set No. 1's
status line (p. 336); it is not stated in the set. The partner is asked to confirm it at signature.

Citations are to `SIKANDER_AI_Architecture_Set_v19.txt` in this directory, by the "=== PAGE n ===" marker of the
extract and the line number in that file.

---

## ES2-0. Decisions recorded

The following decisions were taken on 30 September 2026 by the partner's delegate. They are recorded here so that
the set shows what was decided and what was changed (Layer 17 §1.4, rule 2, p. 245, line 6695). They take effect as
governing text only on the partner's signature below.

1. The specified stack is reaffirmed. The Next.js application in this repository is transitional and is retired
   service by service (strangler pattern).
2. The governance, attestation, adjudication, seal-verification and lattice chains, and the filing-transport
   pipeline, are frozen behind the feature flag `LEGACY_GOVERNANCE_CHAINS` (default off). Data is retained.
   Nothing is deleted.
3. `corpus_service/` moves to its own repository.
4. Authentication under Layer 18 §4.1 and §4.5 is a Phase 1 blocker.

## ES2-1. Register of Errata (E-23 to E-29)

The last erratum number used in Layer 18 §13.1 is E-22 (p. 319, line 8710). This set continues from E-23.

| No. | Where | Change | Authority |
|-----|-------|--------|-----------|
| E-23 | v6 §3 Technology Stack (p. 29, lines 907–922); L9.5 Cross-Platform Delivery (line 4376)| Stack reaffirmed as specified: Flutter frontend; Firebase Cloud Functions (Node.js / TypeScript), region asia-south1; Cloud Firestore; Firebase Storage + Cloudflare R2. The Next.js application in this repository is TRANSITIONAL, not a target architecture. It is retired service by service: each of the 23 services is rebuilt on the specified stack and its Next.js routes removed only after the replacement passes its gate. | v6 §3 (locked text, never edited: Layer 17 §1.4 rule 2); L9.5 "One Flutter codebase → iOS, Android, macOS, Windows, Web"; partner's delegate, 30 Sep 2026. |
| E-24 | Layer 17 exclusion register, "Electronic filing / transmission to court" (p. 275, line 7505); Layer 17 R-4 (p. 246, line 6720); Layer 18 §9.1 rule 4 (p. 307, line 8455) | The governance / attestation / adjudication / seal-verification / lattice chains (ops-reporting), and the filing-transport pipeline (filings), are OUT OF SCOPE: they have no basis in the specification. They are frozen behind `LEGACY_GOVERNANCE_CHAINS`, default off. Frozen means: the routes are disabled while the flag is off and no new feature is added to them. Data written by them is retained; no table, collection or record is dropped or migrated. Electronic filing stays excluded; the system prepares to filing readiness only. | Exclusion register: "Excluded. No Pakistani forum accepts it; the system prepares to filing readiness only." R-4: "Deliverables are real, runnable logic; a count-matching shell is a non-delivery." §9.1: features sit behind flags; disable() "leaves data intact". |
| E-25 | Layer 17 L17.12 (p. 267, line 7309); Layer 18 W-6 (p. 290, lines 7922–7932); Layer 17 Annex B, B-3 (p. 282, line 7664); Layer 17 L17.10 and Annex A | `corpus_service/` (the Python external corpus service) moves out of this application repository into its own repository, its own cloud project and its own credentials. The application holds only a read-only connection to the corpus through Module 10. The service writes to the Annex A contract tables (judgment, judgment_version, citation, treatment, statute, statute_section, statute_section_version, instrument, court, judge, source_provenance, corpus_metadata; L17.10 step 57, line 7245); the `pg_dump` / `pg_restore` path is not used. The Layer 18 CI rule banning Playwright applies to the application repository only; once `corpus_service/` has moved, it applies with no exemption (a consequence of W-6, not stated in it). | L17.12 step 65: "separate repository, separate cloud project, separate credentials"; W-6: "The corpus service is a separate repository (Layer 17 L17.12); the CI rule applies to the app repository."; B-3: "The app reads a contract (Annex A) through Module 10 and never receives a restore." |
| E-26 | Layer 18 §4.1 Call types (p. 296, line 8140); §4.5 Permission check (p. 297, line 8162); Layer 17 R-1, R-2 (p. 245, lines 6702, 6708) | Authentication per §4.1 and §4.5 is a Phase 1 BLOCKER. Every GET / POST / PUT route must take identity from the `Authorization` (Bearer) header and the firm from `X-Firm-Id`, and must call `checkPermission(userId, action, matterId?)` before any data is read. Identity supplied in a request body or query string is not accepted. No real matter is opened until this is met. | §4.1: "headers Authorization (Bearer), X-Firm-Id". §4.5: checkPermission "is the single authority for web, mobile and WhatsApp (R-1)". R-2: "No matter access without membership, and no role is exempt". |
| E-27 | Layer 18 §4.5 Permission check (p. 297, line 8162) | `checkPermission` and every caller built by P5 take role, clearance and active status from the `users/{uid}` record, which is authoritative. Token custom claims may only restrict (lower clearance; a role mismatch is denied); they never grant. Identity fields on `users/{uid}` and all `firms/{firmId}` fields are writable only by Cloud Functions (Admin SDK); the client SDK may change `displayName` only. Stricter than the text, which reads claims: a demotion or deactivation takes effect on the next call instead of when the token expires (up to 1 hour). Direct client access through Firestore rules still authorises from token claims until a later phase. | §4.5: checkPermission "reads the user's claims (firmId, role, clearanceLevel)"; R-2 "no role is exempt". Engineering review findings, 30 Sep 2026. |
| E-28 | Layer 18 §4.2 Idempotency (line 8150); storage table "Feature flags, decisions register, idempotency keys — Postgres, Firestore mirror for the client" (p. 302, line 8331); §4.4 Rate limits (line 8157) | Until the P6 Postgres store exists, idempotency keys (`idempotency_keys/{firmId}_{key}`, 24-hour expiry by TTL policy) and rate-limit counters (`rate_limits/{uid}_{kind}_{minute}`) are held in Firestore, server-only. Both move to Postgres with the P6 cutover. Replays of `generateRecoveryCodes` return a redacted body, so recovery codes are never at rest in plaintext; only final results (2xx, 400, 404, 422 and business-conflict 409) are replayed, and transient refusals release the key for retry. | §4.2: "stores key → response for 24 hours per firm; a repeat returns the stored response with reused: true". Storage table as cited. |
| E-29 | Module 40 / P5 MFA recovery, E-19 (line 8703); users schema `recoveryCodesEncrypted` (line 8274) | Recovery codes are stored as salted HMAC-SHA-256 hashes in the server-only `mfa_recovery/{uid}`, never encrypted and never recoverable, and are bound to the second factors enrolled when they were generated. `disableMfa` takes an `approvalId` issued by `approveMfaDisable` (a different partner, cleared at or above the subject, single use, one-hour expiry, voided after five wrong codes) instead of an approving partner's uid. Codes can be generated only in a second-factor session. Break-glass and lockout remain open (O-20). | E-19: "disableMfa with partner approval and recovery code; enforceMfaForRole; break-glass". Engineering review findings, 30 Sep 2026. |

## ES2-2. Why (facts about the repository as at 30 September 2026)

These are the review's findings about the repository, subject to verification before signature. The line counts and the
existence of `corpus_service/` were checked directly; the absence of authentication and the extent of the chains are
reported, not independently audited.

1. **The stack.** The repository is a Next.js application. The specification names Flutter and Firebase Cloud
   Functions in asia-south1 (v6 §3). Nothing in the set authorises a Next.js product tier. Rewriting everything at
   once would stop delivery; the strangler approach in E-23 keeps the working services running while they are replaced.
2. **The chains.** `app/api/d2/ops-reporting/route.ts` is 47,912 lines. Most of
   `app/api/d4/filings/route.ts` (19,337 lines in total) is reported to be of the same kind. Together they implement chains of
   "workflow ops alert … governance / attestation / adjudication / seal verification / lattice view". None of these
   appears anywhere in the v19 set. By R-4 volume of source is not delivery: acceptance is runtime conformance to the
   specification, and there is no specification here to conform to. The filing-transport code also runs against the
   excluded item "Electronic filing / transmission to court". Freezing rather than deleting preserves the data and
   keeps the change reversible.
3. **The corpus service.** `corpus_service/` (a Python scraper) sits inside the application repository. L17.12 requires
   a separate repository, and W-6 records that a shared repository forces a choice between banning Playwright for
   the corpus service and permitting it in the application. v6 §3 states of external data "No scraper in the app" (p. 29, line 920), and Layer 17 E-6 limits the app's own fetching to official legislation (line 6782).
4. **Authentication.** API routes take the caller's identity from the request body or query string with no
   authentication. If confirmed, any caller could act as any user in any firm. This contradicts §4.1 and §4.5, and R-1 and
   R-2, and it is the reason E-26 is a blocker and not a later task.

## ES2-3. Consequences and conditions

1. `LEGACY_GOVERNANCE_CHAINS` is to be registered in the `feature_flags` table (Erratum Set No. 1, ES1-3,
   `postgres/ddl/002_platform.sql`) with default off, in the same way as `WA_31_CUT` (Erratum Set No. 1, W-21).
2. Freezing is not deletion. Any later proposal to delete the chains or their data needs a further erratum and an
   express partner decision.
3. Nothing in this set reopens an excluded item (Layer 17 §1.4, rule 5, p. 245, line 6699). Electronic filing remains excluded.
4. E-23 to E-26 do not alter locked v6 text; they override it by erratum (Layer 17 §1.4, rule 2).

## ES2-4. Open items

| Ref | Item | Needs |
|-----|------|-------|
| O-15 | Date by which each of the 23 services is retired from the Next.js application (E-23) | Partner and engineering, Phase 1 planning |
| O-16 | Name and hosting of the new corpus service repository and cloud project (E-25) | Partner; repository access |
| O-17 | Definition of "disabled response" for frozen routes, and confirmation that no client currently relies on them (E-24) | Engineering, Phase 1 |
| O-18 | Interim access control for the existing routes until E-26 is met | Engineering; partner approval |
| O-19 | Confirmation of the precedence ordering of Set No. 2 over Set No. 1 (inferred, not stated in the set) | Partner, at signature |
| O-20 | MFA break-glass procedure and account lockout after repeated failures (E-29; Module 40 security depth) | Partner and engineering, Phase 1 |
| O-21 | Which AI providers have an executed DPA and which are in-region (`data/provider_dpa.json`); until recorded, confidential and above are blocked from every external provider (L18 §4.6) | Partner |

O-15 to O-21 are new. Items O-2 and O-8 to O-14 remain open as recorded in ES1-4 (Erratum Set No. 1).

## ES2-5. Signature

This erratum set is PROPOSED. It becomes governing, bound behind Erratum Set No. 1, on the partner's signature.

| | |
|---|---|
| Decisions taken by | Partner's delegate, 30 September 2026 |
| Approved by | Advocate Shamail Sikander, Partner, NHS Legal, Karachi |
| Signature | ______________________________ |
| Date | ______________________________ |
| Decision | Adopted / Adopted with amendments / Not adopted (delete as applicable) |

End of Erratum Set No. 2 (PROPOSED).
