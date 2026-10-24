/** SQL helpers for multiset digests (R8) and manifest session settings. */
export const MANIFEST_SESSION_SETTINGS = `
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET IntervalStyle = 'iso_8601';
SET extra_float_digits = 3;
SET bytea_output = 'hex';
`

const INT8BE = (start: number) =>
  `((get_byte(h,${start})::bigint << 56) | (get_byte(h,${start + 1})::bigint << 48) | (get_byte(h,${start + 2})::bigint << 40) | (get_byte(h,${start + 3})::bigint << 32) | (get_byte(h,${start + 4})::bigint << 24) | (get_byte(h,${start + 5})::bigint << 16) | (get_byte(h,${start + 6})::bigint << 8) | get_byte(h,${start + 7})::bigint) - CASE WHEN get_byte(h,${start}) >= 128 THEN (1::bigint << 64) ELSE 0 END`

export function tableDigestSql(qualified: string, pkExpr: string | null): string {
  const rowHash = pkExpr
    ? `digest(convert_to((${pkExpr})::text || chr(30) || (to_jsonb(t.*))::text, 'UTF8'), 'sha256')`
    : `digest(convert_to((to_jsonb(t.*))::text, 'UTF8'), 'sha256')`
  return `WITH rows AS (SELECT ${rowHash} AS h FROM ${qualified} t) SELECT count(*)::bigint || '|' || coalesce(sum(${INT8BE(0)}),0)::text || '|' || coalesce(sum(${INT8BE(8)}),0)::text || '|' || coalesce(sum(${INT8BE(16)}),0)::text || '|' || coalesce(sum(${INT8BE(24)}),0)::text FROM rows`
}
