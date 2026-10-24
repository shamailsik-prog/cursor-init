/** psql session defaults so manifest digests match across host timezones (F33-A). */
export const PG_MANIFEST_PGOPTIONS =
  "-c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=iso_8601 -c extra_float_digits=3 -c bytea_output=hex"

export function withManifestPsqlEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = env.PGOPTIONS?.trim()
  const pgoptions = base ? `${base} ${PG_MANIFEST_PGOPTIONS}` : PG_MANIFEST_PGOPTIONS
  return { ...env, PGOPTIONS: pgoptions }
}
