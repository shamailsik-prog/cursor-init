# Known dependency advisories (allowlist)

`npm audit --omit=dev --audit-level=high` (root and `functions/`), full-tree
`npm audit --audit-level=high` (scopes `npm:root:dev`, `npm:functions:dev`), and
`pip-audit` (`corpus_service/requirements.txt`) run report-only in
`.github/workflows/security.yml`. The gate is `ci_gates/check_known_advisories.mjs`:
it fails when a **high or critical** npm advisory, or **any** pip-audit
vulnerability (pip-audit reports no severity), is not in the table below for
its scope. Rows that no longer match anything are printed as stale: delete them.

Rules for this file:

- One row per advisory id (GHSA for npm; the pip-audit id, or one of its
  aliases, for Python) and scope (`npm:root`, `npm:root:dev`, `npm:functions`,
  `npm:functions:dev`, `pip:corpus_service`).
- `reason` and `owner` are required (the gate rejects a row without them).
  `review by` is the date the row must be re-checked; an overdue row is a
  review item, not an automatic failure.
- Fix rather than list when a non-breaking fix exists.
- Production scopes (`npm:root`, `npm:functions`) gate what ships. Dev scopes
  gate CI/build/emulator/test tooling (`firebase-tools`, `vitest`, and their
  transitive trees) that still runs with repository credentials.

Re-checked 2026-10-26 (F40): full-tree npm audit is gated; overrides bump
`vite` to 7.3.7 and `@grpc/grpc-js` to 1.14.6 on root and `functions/`.
Remaining dev rows below are triaged, not ignored.

Re-checked 2026-10-22: `next` and `eslint-config-next` 16.4.0 -> 16.4.2 fix
GHSA-2464-fhr4-w9xw (critical, Image Optimization RCE with SVG) and
GHSA-p3m5-59mp-jv5r (high, App Router Server Actions DoS). Fixed, not listed.

Re-checked 2026-10-07 after the dependency-upgrade change. All nine rows of
the 2026-10-06 baseline were fixed, not listed, and the table is empty:

- `next` and `eslint-config-next` 16.3.4 -> 16.4.0 (GHSA-vcvr-r3jv-pc5j);
  this also brings `sharp` 0.35.5 (GHSA-wq5f-xc86-pv6w).
- `npm audit fix` (no major bump): `proxy-addr`, `@modelcontextprotocol/sdk`,
  `@grpc/grpc-js` 1.14.5, `source-map-js`.
- `shadcn` moved to devDependencies. The app uses only its stylesheet
  (`app/globals.css` imports `shadcn/tailwind.css`, resolved at build time),
  so `--omit=dev` drops its CLI tree, including `braces` (GHSA-vfj7-8cjw-p6xm).
- `undici` under `eve`: eve 0.56 pins `undici` 8.9.0 exactly, and npm's own
  fix is a breaking downgrade of eve. A package.json `overrides` entry moves
  eve's copy to `undici` 8.12.3, the same major (fixes the eve-pinned undici
  advisories covered by audit FA-DEP-002, including GHSA-rfgv-xxqx-mfg5 and
  GHSA-w293-vg96-wgc3). Remove the
  override once an eve release pins undici >= 8.12.3. The override is keyed on
  the version it replaces, `"eve": { "undici@8.9.0": "8.12.3" }` (audit F39):
  the unkeyed form `"eve": { "undici": "8.11.2" }` is carried by npm >= 11.2
  across eve's peer dependency on `ai` into `@ai-sdk/provider-utils` (which
  declares undici ^7.29.0), so npm 10 and npm 11 resolved different trees and
  no lockfile satisfied both. The keyed form resolves one tree on both.

Remaining, below the gate's threshold: `npm:root` has 2 moderate (`uuid` < 11.1.1
nested under `gaxios` 6, GHSA-w5hq-g745-h8pq, buffer-bounds check only when a
caller passes `buf`; and `gaxios` through it). `npm:functions` has 8 moderate,
all via `firebase-admin` 13 -> 14 (a major bump, upgrade backlog).
`pip:corpus_service` has none.

| scope | advisory | package | severity | reason | owner | review by |
| --- | --- | --- | --- | --- | --- | --- |
| npm:root:dev | GHSA-c475-qrg2-pj4r | basic-ftp | high | Transitive under dev `firebase-tools@14` (emulator FTP client); not in production tree; upgrade backlog firebase-tools 15 | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-23hp-3jrh-7fpw | tar | critical | `firebase-tools@14` pins tar@6.x for CLI packaging; CI/emulator only; tar 7.x via firebase-tools 15 | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-34x7-hfp2-rc4v | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-83g3-92jg-28cx | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-8qq5-rm4j-mr97 | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-8x88-c5mf-7j5w | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-9ppj-qmqm-q256 | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-qffp-2rhf-9h96 | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-r292-9mhp-454m | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-r6q2-hw4h-h46w | tar | high | Same tar@6.x chain as GHSA-23hp-3jrh-7fpw | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-5gmw-xhrv-c9v3 | tinypool | critical | `vitest@3` pins tinypool 1.x for test workers; dev/CI only; vitest 5 + tinypool 2 upgrade backlog | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-85c8-ppgw-ccpr | tinypool | critical | Same tinypool 1.x chain as GHSA-5gmw-xhrv-c9v3 | Shamail | 2026-11-15 |
| npm:root:dev | GHSA-mrhx-c7xc-m3w5 | zod | high | Nested zod under dev `firebase-tools@14`; app depends on zod 4.6.7 | Shamail | 2026-11-15 |
| npm:functions:dev | GHSA-68fv-2mgg-jv7q | source-map-js | high | Transitive under `functions/` vitest/esbuild dev tree; not in deployed bundle | Shamail | 2026-11-15 |
| npm:functions:dev | GHSA-5gmw-xhrv-c9v3 | tinypool | critical | `vitest@3` in functions devDependencies; vitest 5 upgrade backlog | Shamail | 2026-11-15 |
| npm:functions:dev | GHSA-85c8-ppgw-ccpr | tinypool | critical | Same tinypool 1.x chain as GHSA-5gmw-xhrv-c9v3 | Shamail | 2026-11-15 |
| npm:functions:dev | GHSA-mrhx-c7xc-m3w5 | zod | high | Nested zod under `firebase` dev tooling in functions tests; not production zod | Shamail | 2026-11-15 |
