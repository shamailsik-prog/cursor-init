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

Re-checked 2026-11-15: `functions/` `source-map-js` 1.2.1 -> 1.2.2 and nested `zod` 4.6.5 -> 4.6.7 (patch). Those two dev rows are fixed, not listed. `opentelemetry-api` 1.45.2 and `soupsieve` 4.1.1 are pinned in the corpus lockfiles, so pip-audit is clean.

Re-checked 2026-11-15 (FA-Q250-ADV-002): dev `firebase-tools` 14.27.0 -> 15.36.0 (tar 7.5.23, basic-ftp gone, nested zod 4) and `vitest` 3.2.7 -> 5.1.0 at the root and in `functions/` (tinypool gone). The 15 high/critical dev rows those chains required are fixed, not listed. The allowlist table is empty. Root `@types/node` moved `^20` to `^22` because Vitest 5 declares an optional peer of `@types/node` `^22.0.0 || >=24.0.0`; the app already runs on Node 22. Production dependency ranges in the manifests are unchanged. The locked production closure did move one types package: `@types/node` 20.19.43 to 22.20.5. `protobufjs` (and `@types/express`, `@types/cors`, `@types/jsonwebtoken`) depend on `@types/node`, and npm dedupes them onto the root devDependency. That package is types only, and the production runtime is Node 22, which 22.20.5 describes. Pinning the closure back to 20.19.43 would miss the Vitest 5 peer. `npm audit --omit=dev` on the 2026-11-15 advisory database is unchanged by this upgrade: root 0 high/critical (7 moderate, 1 low) and `functions/` 0 high/critical (9 moderate, 1 low). Full-tree audits are 0 high/critical.

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

Remaining, below the gate's threshold: the production moderates in the
FA-Q250-ADV-002 re-check above. `uuid` < 11.1.1 nested under `gaxios` 6
(GHSA-w5hq-g745-h8pq, buffer-bounds check only when a caller passes `buf`) is
still among them. `npm:functions` moderates are still via `firebase-admin` 13
-> 14 (a major bump, upgrade backlog). `pip:corpus_service` has none.

| scope | advisory | package | severity | reason | owner | review by |
| --- | --- | --- | --- | --- | --- | --- |
