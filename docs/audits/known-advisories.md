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
- Fix rather than list when a non-breaking fix exists.
- Dev-only advisories (`firebase-tools` 14 -> 15, `vitest` 3 -> 5 and their
  transitive packages) are out of scope: `--omit=dev` excludes them because
  they never ship. Track them in the upgrade backlog, not here.

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
  eve's copy to `undici` 8.11.2, the same major (fixes GHSA-rfgv-xxqx-mfg5,
  GHSA-w293-vg96-wgc3 and eight lower-severity undici advisories). Remove the
  override once an eve release pins undici >= 8.10.2. The override is keyed on
  the version it replaces, `"eve": { "undici@8.9.0": "8.11.2" }` (audit F39):
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
