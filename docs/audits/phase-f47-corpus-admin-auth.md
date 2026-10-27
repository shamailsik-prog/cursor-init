# Phase audit — F47 corpus admin authentication

Finding **F47** (issue #30): corpus administrative APIs authenticated a single static
`ADMIN_API_KEY` with no named operator, scope separation, or per-credential revocation.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `require_admin_api_key` compared one shared secret (`scraper/auth.py`); trigger, export, review, and promote routes all used the same dependency; `quarantine_decisions.reviewer_auth` was fixed to `shared_admin_key` | Any copied admin key could trigger harvest, export, and publication; revoking one operator required rotating the shared secret for everyone |
| GREEN (this PR) | `CORPUS_ADMIN_CREDENTIALS` JSON registry (`scraper/admin_credentials.py`) with named `actor`, distinct `scopes` (`read`, `trigger`, `review`, `export`, `promote`), optional `not_before` / `not_after` for rotation overlap; route-specific `require_corpus_*` dependencies; append-only `corpus_admin_audit` with actor/credential on privileged mutations; quarantine decisions store `reviewer_auth = ca:<credential_id>` | `corpus_service/tests/test_f47_corpus_admin_auth.py` proves wrong scope → 403, named actor on audited trigger, revoking one credential does not disable another |

### Acceptance probes (automated)

1. **Wrong / missing scope denied** — export-only key receives 403 on `POST /api/start` (`test_wrong_scope_denied`).
2. **Named actor on privileged action** — `source.trigger` writes `corpus_admin_audit` with `actor` and `credential_id` (`test_named_actor_recorded_on_privileged_action`, needs `CORPUS_TEST_DATABASE_URL`).
3. **Per-credential revocation** — removing `bob-export` from the registry yields 401 for Bob while Alice still authenticates (`test_revoking_one_credential_leaves_others_active`).

Production/staging requires `CORPUS_ADMIN_CREDENTIALS` (see `corpus_service/.env.example`). Development synthesises a single all-scope credential from `ADMIN_API_KEY` when the JSON is unset.

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
