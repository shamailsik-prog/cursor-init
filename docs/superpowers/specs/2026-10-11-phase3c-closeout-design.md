# Phase 3c close-out: scheduled-tick retry (O-43) and the 3c gate in CI

Date: 2026-10-11. Status: rulings made under the owner's standing autonomy instruction (7 October 2026); pending the partner's signature with Erratum Set No. 2.

## Why this slice exists

Phase 3c (PR #17, `9b78e2f`) shipped the first scheduled job type, `d1AutoConfirmTick`. O-43 was recorded as "before the first scheduled job type" and is still open: `onSchedule` has no retry count, so a failed tick loses that day's run for the failing firm until a backfill (the next day's tick would still pick the pair up, since eligibility is age-based, so the cost is one day). PR #17 also left `gate:g4:phase3c` out of `.github/workflows/gate-g0.yml`. Why this slice and not another: Phase 3 is split 3a, 3b, 3c and all three are on `main`; Phase 4 work (WhatsApp, email, web) needs provider and channel decisions (O-21 and the channel set-up) that the docs leave to the partner; O-47 and O-48 wait on O-26 and O-30.

## Rulings

| Id | Ruling | Basis | Cost if wrong |
| --- | --- | --- | --- |
| P3-51 | **O-43: scheduled ticks retry.** `scheduledJobFunction` passes `SCHEDULE_RETRY = { retryCount: 3, minBackoffSeconds: 60, maxBackoffSeconds: 600 }` to `onSchedule`. The sweeper is unchanged (its next minute is its retry). | O-43 states `retryCount: 3` with a backoff is safe because runs are idempotent per run key (E-42(h), P3-16). The tick throws `ScheduledRunsFailedError` only after trying every firm, so a retry re-reads the firms and reuses every job already created. | A persistent failure runs the tick four times in about 11 minutes, each logging per failing firm; no data effect. |
| P3-52 | **CI.** `gate-g0.yml` should run `npm run gate:g4:phase3c` after the Phase 3b step (`- name: Gate G-4 Phase 3c`, `if: ${{ !cancelled() }}`, `run: npm run gate:g4:phase3c`); the edit is NOT in this PR because the autopilot token lacks `workflows` permission, so it is a follow-up for a maintainer. #20 (`5d888ce`) made that edit. The boot test in that gate (`p2.boot.test.ts`) pins the retry config, so the gate covers P3-51 and no new gate script is added. | Same pattern as the earlier gates (P3-41). | None. |

## Testing

`p2.boot.test.ts` asserts the deployed `d1AutoConfirmTick` carries the retry config and the sweeper none. Written first, it failed before the change (no `retryConfig`).

## Out of scope

O-47, O-48, O-30, O-29, probabilistic `resolveEntity`, Phase 4 channels.
