-- Forward migration for a database that already applied 009_p6_master.sql.
-- Replaces p6_actor_key with the same body as 009. Idempotent.
-- After folding, a key that is not ^[a-z0-9._@-]+$ is empty. No one-off Unicode 16 folds.
-- Does not rewrite legacy rows. The approval check is not swapped again here;
-- a later update of a substantive row rechecks p6_actor_key and fails closed.

CREATE OR REPLACE FUNCTION public.p6_actor_key(value text) RETURNS text
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
BEGIN
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
    lower(replace(regexp_replace(out, '^[' || ws || ']+|[' || ws || ']+$', '', 'g'), chr(7838), chr(223))),
    chr(223),
    'ss'
  );
  IF actor_key !~ '^[a-z0-9._@-]+$' THEN
    RETURN '';
  END IF;
  RETURN actor_key;
END;
$fn$;

REVOKE ALL ON FUNCTION public.p6_actor_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.p6_actor_key(text) TO p6_service;

