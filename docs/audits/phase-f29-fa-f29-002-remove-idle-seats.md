# FA-F29-002 — Remove idle harvester seat services from compose

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **F29** / **FA-F29-002** (idle `worker-a` / `worker-b` seats undermine stop/start; remove or disable while login scraping stays off)

## Mechanism (this branch)

- **Shipped compose:** `corpus_service/docker-compose.yml` no longer defines `worker-a` or `worker-b`. Scheduled harvest work remains on `worker-embed` and `celery-beat`; operator pause/resume is unchanged (FA-F29-001 DB flag).
- **E2E overlay:** `corpus_service/tests/e2e/compose.e2e.yml` and `store_security_e2e.sh` no longer start or assert idle-seat containers.
- **Policy fixtures:** `ci_gates/fixtures/shipped_attacks.py` attack anchors that targeted idle seats now target `worker-embed` or `celery-beat` (same rules under test).

## RED / GREEN (ledger)

| Step | Evidence | Result |
| --- | --- | --- |
| RED | `2775cda` (main after PR #142): compose still runs `worker-a` / `worker-b` with `restart: unless-stopped` and `python -m scraper.workers.harvester` | Idle seats remain after stop; fails F29 compose acceptance |
| GREEN | This branch: services removed; `docker compose config` lists no `worker-a`/`worker-b`; `ci_gates/test_check_compose_policy.py` shipped tree + attacks PASS | Idle seats absent from default deployment |

## Focused verification

```bash
# Compose diff vs main (expect worker-a/worker-b blocks gone)
git diff 2775cdaaf5ba27ea0e4f446fd516d55c1dcf14b0 -- corpus_service/docker-compose.yml

# Policy + attack fixtures (from repo root)
python -m unittest ci_gates.test_check_compose_policy.ShippedComposeAttacks -v
python ci_gates/check_compose_policy.py corpus_service/docker-compose.yml
```

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| OR-1..OR-4 | unchanged |

F29 parent issue remains open for any sibling findings (e.g. FA-F29-003+); this slice closes **FA-F29-002** only.
