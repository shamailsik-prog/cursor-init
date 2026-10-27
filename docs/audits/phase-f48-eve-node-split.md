# Phase audit — F48 eve / production Node toolchain split

Finding **F48** (issue #30): CI and Cloud Functions target Node 22 while the optional
`eve` agent CLI requires Node ≥24. A single `.nvmrc` and undifferentiated CI jobs implied
one toolchain for console, Functions and eve.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `5e24bd79` (main after F47 #151): `.nvmrc` 22 only; root `package.json` without `engines.node`; all `gate-g0.yml` Node jobs on 22; `npm run eve:info` on Node 22 exits with “eve requires Node.js >=24” | Agent developers following CI/local console setup hit unsupported-engine behaviour on eve; elevating CI to Node 24 would contradict `functions/package.json` `engines.node` 22 |
| GREEN (this PR) | Root `engines.node` 22; `.nvmrc.eve` and `agent/.nvmrc` 24; `EVE_NODE_VERSION` env and **`eve-toolchain`** job on Node 24 running `scripts/eve-toolchain-check.sh` (`npm ci` + `npm run eve:info`); G-0 check **[25]** `ci_gates/check_node_toolchains.py`; README documents dual activation | Mandatory path stays Node 22; eve path proven on Node 24 in CI |

### Acceptance probes (automated)

1. **Static pins** — `npm run gate:node-toolchains` / G-0 [25]: `.nvmrc` 22, `.nvmrc.eve` 24, root and `functions/` `engines.node` 22, workflow `NODE_VERSION` 22 + `EVE_NODE_VERSION` 24, eve job present.
2. **Production CI unchanged** — `functions` job and `gates` job still use `NODE_VERSION` 22 (grep `gate-g0.yml`).
3. **Eve runtime on 24** — CI job **Optional eve toolchain (Node 24, audit F48)** runs `bash scripts/eve-toolchain-check.sh` successfully.

Eve remains outside the mandatory production deploy path until its orchestration contract is implemented; this change only splits and pins toolchains.

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
