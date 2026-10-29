import { backfillLegacyPartnerIndependence } from "../retention/legacyPartnerIndependenceBackfill"

/**
 * `npm run partner-independence:backfill`: one resume pass over legacy partner docs missing
 * `independentPartner` (FA-F42-R1-006-003-001-002). Re-run until the cursor marks complete.
 */
async function main(): Promise<void> {
  const result = await backfillLegacyPartnerIndependence()
  const line = `partner-independence backfill: scanned=${result.scanned} applied=${result.applied} skipped=${result.skipped} failed=${result.failed} complete=${result.complete ?? false}`
  process.stdout.write(`${line}\n`)
  if (result.failed > 0) process.exitCode = 1
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
