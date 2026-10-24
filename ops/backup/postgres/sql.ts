/** SQL helpers for multiset digests (R8) and manifest session settings. */
export const MANIFEST_SESSION_SETTINGS = `
SET TimeZone = 'UTC';
SET DateStyle = 'ISO, YMD';
SET IntervalStyle = 'iso_8601';
SET extra_float_digits = 3;
SET bytea_output = 'hex';
`

/** Signed int64 from 8 big-endian bytes (matches MultisetDigest in lib/digest.ts). */
export const SQL_INT8BE = `
CREATE OR REPLACE FUNCTION pg_temp.skb_int8be(b bytea) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    (get_byte(b,0)::bigint << 56) | (get_byte(b,1)::bigint << 48) | (get_byte(b,2)::bigint << 40) |
    (get_byte(b,3)::bigint << 32) | (get_byte(b,4)::bigint << 24) | (get_byte(b,5)::bigint << 16) |
    (get_byte(b,6)::bigint << 8) | get_byte(b,7)::bigint
  ) - CASE WHEN get_byte(b,0) >= 128 THEN (1::bigint << 64) ELSE 0 END;
$$;
`

export function tableDigestSql(qualified: string, pkExpr: string): string {
  const rowHash = pkExpr
    ? `digest(convert_to(${pkExpr} || chr(30) || (to_jsonb(t.*))::text, 'UTF8'), 'sha256')`
    : `digest(convert_to((to_jsonb(t.*))::text, 'UTF8'), 'sha256')`
  return `
WITH rows AS (SELECT ${rowHash} AS h FROM ${qualified} t)
SELECT count(*)::bigint AS cnt,
  coalesce(sum(pg_temp.skb_int8be(substring(h,1,8))),0)::text AS s0,
  coalesce(sum(pg_temp.skb_int8be(substring(h,9,8))),0)::text AS s1,
  coalesce(sum(pg_temp.skb_int8be(substring(h,17,8))),0)::text AS s2,
  coalesce(sum(pg_temp.skb_int8be(substring(h,25,8))),0)::text AS s3
FROM rows;
`
}
