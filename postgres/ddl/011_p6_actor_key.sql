-- Forward migration for a database that already applied 009_p6_master.sql.
-- Installs the same p6_actor_key body as 009 only when every substantive row still
-- has a distinct partner under that body. One transaction: a refusal rolls the
-- candidate back and leaves the installed function unchanged.
-- Lists the first 20 ids and the count. Does not rewrite legacy rows.

BEGIN;
CREATE OR REPLACE FUNCTION public.p6_actor_key_next(value text) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  folded text := replace(normalize(coalesce(value, ''), NFKC), chr(42993), 'S');
  out text := '';
  i integer := 1;
  ch text;
  cp integer;
  ws text := chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760);
  n integer := 8192;
  actor_key text;
  raw text := coalesce(value, '');
  raw_i integer := 1;
  raw_cp integer;
BEGIN
  WHILE raw_i <= char_length(raw) LOOP
    raw_cp := ascii(substr(raw, raw_i, 1));
    IF raw_cp > 127 AND NOT (
      raw_cp = 223 OR raw_cp = 7838 OR raw_cp = 42993
      OR raw_cp BETWEEN 65280 AND 65519
      OR raw_cp = 160 OR raw_cp = 5760 OR raw_cp BETWEEN 8192 AND 8202
      OR raw_cp = 8232 OR raw_cp = 8233 OR raw_cp = 8239 OR raw_cp = 8287 OR raw_cp = 12288
      OR raw_cp = 173 OR raw_cp = 847 OR raw_cp = 1564
      OR raw_cp BETWEEN 4447 AND 4448
      OR raw_cp BETWEEN 6068 AND 6069
      OR raw_cp BETWEEN 6155 AND 6159
      OR raw_cp BETWEEN 8203 AND 8207
      OR raw_cp BETWEEN 8234 AND 8238
      OR raw_cp BETWEEN 8288 AND 8303
      OR raw_cp = 12644
      OR raw_cp BETWEEN 65024 AND 65039
      OR raw_cp = 65279
      OR raw_cp = 65440
      OR raw_cp BETWEEN 65520 AND 65528
      OR raw_cp BETWEEN 113824 AND 113827
      OR raw_cp BETWEEN 119155 AND 119162
      OR raw_cp BETWEEN 917504 AND 921599
    ) THEN
      RETURN '';
    END IF;
    raw_i := raw_i + 1;
  END LOOP;
  WHILE i <= char_length(folded) LOOP
    ch := substr(folded, i, 1);
    cp := ascii(ch);
    IF NOT (
      cp = 173 OR cp = 847 OR cp = 1564
      OR cp BETWEEN 4447 AND 4448
      OR cp BETWEEN 6068 AND 6069
      OR cp BETWEEN 6155 AND 6159
      OR cp BETWEEN 8203 AND 8207
      OR cp BETWEEN 8234 AND 8238
      OR cp BETWEEN 8288 AND 8303
      OR cp = 12644
      OR cp BETWEEN 65024 AND 65039
      OR cp = 65279
      OR cp = 65440
      OR cp BETWEEN 65520 AND 65528
      OR cp BETWEEN 113824 AND 113827
      OR cp BETWEEN 119155 AND 119162
      OR cp BETWEEN 917504 AND 921599
    ) THEN
      out := out || ch;
    END IF;
    i := i + 1;
  END LOOP;
  WHILE n <= 8202 LOOP
    ws := ws || chr(n);
    n := n + 1;
  END LOOP;
  ws := ws || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288);
  actor_key := replace(
    replace(regexp_replace(out, '^[' || ws || ']+|[' || ws || ']+$', '', 'g'), chr(7838), 'ss'),
    chr(223),
    'ss'
  );
  IF actor_key ~ '[^[:ascii:]]' THEN
    RETURN '';
  END IF;
  actor_key := lower(actor_key);
  IF actor_key !~ '^[a-z0-9._@-]+$' THEN
    RETURN '';
  END IF;
  RETURN actor_key;
END;
$fn$;

-- Same predicate as the constraint swap, evaluated on the candidate so a refusal
-- does not commit the narrower p6_actor_key. psql autocommit would otherwise keep it.
DO $guard$
DECLARE
  bad_ids text;
  bad_count integer;
BEGIN
  WITH bad AS (
    SELECT id::text AS id
      FROM public.change_proposals
     WHERE status IN ('approved', 'applied')
       AND change_class = 'substantive'
       AND (
         decided_kind IS DISTINCT FROM 'partner'
         OR decided_role IS DISTINCT FROM 'partner'
         OR public.p6_actor_key_next(decided_by) = ''
         OR public.p6_actor_key_next(decided_by) = public.p6_actor_key_next(proposed_by)
       )
  )
  SELECT COUNT(*)::int,
         (SELECT string_agg(listed.id, ', ' ORDER BY listed.id) FROM (SELECT id FROM bad ORDER BY id LIMIT 20) listed)
    INTO bad_count, bad_ids
    FROM bad;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'refusing to replace substantive_partner_approval: % has no distinct partner decision (% of %)',
      bad_ids, LEAST(bad_count, 20), bad_count
      USING ERRCODE = '23514';
  END IF;
END
$guard$;

DO $install$
BEGIN
  EXECUTE replace(
    pg_get_functiondef('public.p6_actor_key_next(text)'::regprocedure),
    'public.p6_actor_key_next(value text)',
    'public.p6_actor_key(value text)'
  );
END
$install$;

DROP FUNCTION public.p6_actor_key_next(text);
REVOKE ALL ON FUNCTION public.p6_actor_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.p6_actor_key(text) TO p6_service;
COMMIT;
