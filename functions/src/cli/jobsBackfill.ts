import { backfillScheduledRuns, PeriodRangeError, SCHEDULED_JOBS, ScheduledRunsFailedError, UnregisteredJobTypeError, type ScheduledJobSpec } from "../p2/scheduled"

/**
 * `npm run jobs:backfill -- <jobType> <from> <to>`: enqueues the scheduled job's runs for every
 * firm over the inclusive period range (at most 366 periods). Re-running it reuses existing runs.
 * Nothing runs at import; Admin credentials are read only when a backfill actually starts.
 */

export type BackfillDeps = { schedules: readonly ScheduledJobSpec[]; now: () => number; out: (line: string) => void }

export async function runBackfill(argv: string[], deps: BackfillDeps): Promise<number> {
  if (argv.length !== 3) {
    deps.out("usage: jobs:backfill <jobType> <from> <to>")
    return 64
  }
  const [jobType, from, to] = argv
  const spec = deps.schedules.find((s) => s.jobType === jobType)
  if (!spec) {
    deps.out(`no schedule for ${jobType}`)
    return 2
  }
  try {
    const r = await backfillScheduledRuns(spec, from, to, deps.now())
    deps.out(`backfilled ${jobType} ${from}..${to}: ${r.created} created, ${r.reused} reused, ${r.firms} firms`)
    return 0
  } catch (err) {
    if (err instanceof PeriodRangeError) {
      deps.out(err.message)
      return 2
    }
    if (err instanceof UnregisteredJobTypeError) {
      deps.out(err.message)
      return 1
    }
    if (err instanceof ScheduledRunsFailedError) {
      deps.out(`backfill incomplete: ${err.failed} firm run(s) failed; re-run to retry them`)
      return 1
    }
    deps.out("backfill failed")
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await runBackfill(process.argv.slice(2), { schedules: SCHEDULED_JOBS, now: Date.now, out: (l) => console.log(l) })
}

if (require.main === module) void main()
