# FA-F34-R1-003 — P1 transport import gate (G-0 check [21])

Repository: `shamailsik-prog/cursor-init`  
Finding: issue #30 **FA-F34-R1-003** (spec ruling R17, `docs/superpowers/specs/2026-10-24-f34-decision-trace-reproducibility-design.md`)

## What changed

The bypassable template **call-site regex** is replaced by `ci_gates/check_p1_transport_imports.py`, wired as Gate G-0 **[21]** in `ci_gates/gate_g0.sh`.

Under `functions/src/`, `platform/`, and `services/`:

- Only `functions/src/p1/gateway.ts` and `functions/src/p1/evalSet.ts` may import the chat transport (`functions/src/p1/transport`).
- Only `functions/src/p1/embedding.ts` may import the embedding transport (`functions/src/p1/embeddingTransport`).
- `functions/src/cli/committeeEval.ts` may import `gatewayTransport` and the `P1Transport` type only (no `send`).

`functions/test/f34-template-callsites.test.ts` runs the gate on the repository instead of matching two AST shapes.

## Must-fail auditor shapes (re-audit template-experiments T4 / T4b)

| Shape | Fixture | Expected failure |
| --- | --- | --- |
| T4 | `const gw = activeTransport(); await gw?.send({ messages: [{ role: "system", … }] })` in a new `functions/src` file | Import of `activeTransport` outside grants |
| T4b (split) | Send in `platform/p1/`, transport fetched in `functions/src` | Import of `activeTransport` in `functions/src` |
| T4b (direct) | Send and import both in `platform/p1/` | Import of `activeTransport` in `platform/p1/` |

Tests: `tests/f34-p1-transport-import-gate.test.ts`, `tests/g0-gate-e2e.test.ts` (planted G-0 trees).

## RED / GREEN (ledger)

| Step | Command / evidence | Result |
| --- | --- | --- |
| RED | `docs/superpowers/plans/2026-10-24-f34-fu-r1-followups.md` — gate absent on main `0d9af65` with tests copied in | `tests/f34-p1-transport-import-gate.test.ts` 29/29 fail; G-0 e2e auditor shapes pass |
| GREEN | `python3 ci_gates/check_p1_transport_imports.py`; vitest gate suites | PASS on branch |

## Release labels (honest)

| Label | Value |
| --- | --- |
| backend_real | true |
| frontend_real | false |
| transport_stub | true |
| classification | PARTIAL (CI/gate slice; not COMPLETE while transport_stub=true) |

no COMPLETE/product-done claim

## Focused verification

```bash
python3 ci_gates/check_p1_transport_imports.py
npx vitest run tests/f34-p1-transport-import-gate.test.ts -t "auditor's T4"
npx vitest run tests/g0-gate-e2e.test.ts -t "F34 R1-003"
npx vitest run functions/test/f34-template-callsites.test.ts -t "only the granted send sites"
G0_STATIC_ONLY=1 bash ci_gates/gate_g0.sh
```
