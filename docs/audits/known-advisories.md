# Known dependency advisories (allowlist)

`npm audit --omit=dev --audit-level=high` (root and `functions/`) and `pip-audit`
(`corpus_service/requirements.txt`) run report-only in
`.github/workflows/security.yml`. The gate is `ci_gates/check_known_advisories.mjs`:
it fails when a **high or critical** npm advisory, or **any** pip-audit
vulnerability (pip-audit reports no severity), is not in the table below for
its scope. Rows that no longer match anything are printed as stale: delete them.

Rules for this file:

- One row per advisory id (GHSA for npm; the pip-audit id, or one of its
  aliases, for Python) and scope (`npm:root`, `npm:functions`,
  `pip:corpus_service`).
- `reason` and `owner` are required (the gate rejects a row without them).
  `review by` is the date the row must be re-checked; an overdue row is a
  review item, not an automatic failure.
- Fix rather than list when a non-breaking fix exists. Rows marked
  **fix available** below have one and are listed only so this tooling lands
  without bundling dependency upgrades; they are the first upgrades to make.
- Dev-only advisories (`firebase-tools` 14 -> 15, `vitest` 3 -> 5 and their
  transitive packages) are out of scope: `--omit=dev` excludes them because
  they never ship. Track them in the upgrade backlog, not here.

Baseline taken 2026-10-06 (`npm audit` against the lockfiles at `feat/forensic`).
`npm:functions` has no high or critical advisory (8 moderate, all via
`firebase-admin` 13 -> 14, a major bump). `pip:corpus_service` has none:
note that `requirements.txt` is unpinned, so pip-audit audits whatever the
latest resolvable versions are on the day it runs, not a fixed set.

Re-checked 2026-10-07 against the lockfiles after `feat/forensic` was merged
into the Phase 1 branch (with the final-audit fixes):
- `npm:root`: 16 advisories (2 critical, 11 high, 3 moderate). The high and
  critical ones are the same 9 advisory ids as the rows below. 13 package
  entries map to them, some only through a dependency.
- `npm:functions`: 8 moderate, no high or critical.
- `pip:corpus_service`: none.

The gate passes, with no unlisted advisory and no stale row. The reasons below
were re-verified: no `next/og` or `next/image` import in app/, components/,
lib/ or platform/, and no `dangerouslyAllowSVG` in `next.config.ts`.

| scope | advisory | package | severity | reason | owner | review by |
| --- | --- | --- | --- | --- | --- | --- |
| npm:root | GHSA-vcvr-r3jv-pc5j | next | critical | **fix available**: next 16.4.0 (minor; eslint-config-next must move with it). RCE is in `next/og` `ImageResponse`, which the app does not import (no `next/og` use in app/, components/, lib/, platform/). Upgrade next + eslint-config-next together and re-run the full suite. | Shamail Sikander | 2026-10-20 |
| npm:root | GHSA-jqcg-44mw-7w3h | proxy-addr | critical | **fix available** (`npm audit fix`, no major). Reaches the tree only through the `shadcn` CLI (shadcn -> @modelcontextprotocol/sdk -> express -> proxy-addr); no server in this app uses express or proxy-addr. Also move `shadcn` to devDependencies: the app only imports its CSS. | Shamail Sikander | 2026-10-20 |
| npm:root | GHSA-6qxp-vccf-f47h | @modelcontextprotocol/sdk | high | **fix available** (`npm audit fix`). Via the `shadcn` CLI only (its MCP server); never loaded by the app. | Shamail Sikander | 2026-10-20 |
| npm:root | GHSA-m9gg-hp2v-232j | @grpc/grpc-js | high | **fix available** (grpc-js 1.14.5, via firebase-admin -> @google-cloud/firestore -> google-gax; `npm audit fix`). Affects `getAuthContext` on gRPC *servers*; the app is a gRPC client of Firestore. | Shamail Sikander | 2026-10-20 |
| npm:root | GHSA-wq5f-xc86-pv6w | sharp | high | **fix available** (sharp 0.35.5 via next). librsvg in sharp, used by next/image optimisation; the app does not import `next/image` and `next.config.ts` does not enable `dangerouslyAllowSVG`. | Shamail Sikander | 2026-10-20 |
| npm:root | GHSA-68fv-2mgg-jv7q | source-map-js | high | **fix available** (`npm audit fix`). Build-time only (postcss under next and shadcn); no untrusted source maps are parsed at runtime. | Shamail Sikander | 2026-10-20 |
| npm:root | GHSA-vfj7-8cjw-p6xm | braces | high | Needs a breaking change: npm's only fix is downgrading `shadcn` to 1.0.0. Via shadcn -> ts-morph -> fast-glob -> micromatch -> braces, CLI-time only. Resolved by moving `shadcn` to devDependencies (then `--omit=dev` drops it). | Shamail Sikander | 2026-11-06 |
| npm:root | GHSA-rfgv-xxqx-mfg5 | undici | high | Needs a major bump of `eve` (undici 8 is pinned by eve 0.56; npm proposes eve 0.5.4, a breaking change). WebSocket subprotocol DoS. App code does not import undici; exposure is through eve's own HTTP/WebSocket use (agent/), not verified here. | Shamail Sikander | 2026-11-06 |
| npm:root | GHSA-w293-vg96-wgc3 | undici | high | Needs a major bump of `eve` (as above). TLS validation bypass only with `BalancedPool` plus custom connect options; app code uses neither (eve internals not verified here). | Shamail Sikander | 2026-11-06 |
