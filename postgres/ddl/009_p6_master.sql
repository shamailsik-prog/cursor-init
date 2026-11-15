-- P6 master knowledge (Layer 17 L17.5; Layer 18 §5.4 and §10 G-3).
-- Platform database, not Annex A. apply-annex-a.sh does not apply this file (same exclusion as 002).
-- Idempotent. No login password is created here. Only p6_service may write the master tables.
-- The writer trigger refuses every other current_user, including the table owner, because
-- ownership bypasses a privilege grant;
-- DELETE and TRUNCATE are refused for every role, including the table owner and p6_service,
-- while these triggers stay enabled. The table owner can still disable or drop these triggers.
-- That bypass is a residual, not a privilege.
-- master_versions is append-only: no update, no row removal, and no truncate.
-- A proposal payload is frozen from the moment it is stored. Approval is bound to payload_hash.
-- A new proposal is pending. The only way to approved is pending -> approved with a partner
-- attestation and an actor key that differs from the proposer. The edge shape is mirrored in the DDL.
-- The database trusts change_class within the p6_service boundary.
-- CAS may only apply: pending -> applied for a cosmetic system decision, and approved -> applied
-- with the decision unchanged.
-- A classification downgrade is refused
-- unless the transaction set p6.declassify to partner. Learners stay off: this file grants them nothing.

DO $$ BEGIN
  CREATE ROLE p6_service NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER ROLE p6_service NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO p6_service;

CREATE TABLE IF NOT EXISTS public.change_proposals (
  id UUID PRIMARY KEY,
  firm_id TEXT NOT NULL,
  source_module TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('public','internal','confidential','privileged','privileged-restricted')),
  change_class TEXT NOT NULL CHECK (change_class IN ('cosmetic','substantive')),
  partition TEXT NOT NULL CHECK (partition = 'mutable'),
  entry_key TEXT NOT NULL CHECK (entry_key <> '' AND entry_key NOT IN ('citation_protocol','verification_protocol')),
  payload JSONB NOT NULL,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','applied','rejected')),
  decided_by TEXT,
  decided_kind TEXT CHECK (decided_kind IS NULL OR decided_kind IN ('partner','system')),
  decided_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_class TEXT CHECK (requested_class IS NULL OR requested_class IN ('cosmetic','substantive')),
  declassify BOOLEAN NOT NULL DEFAULT false,
  payload_hash TEXT NOT NULL DEFAULT '',
  CONSTRAINT substantive_partner_approval CHECK (
    status NOT IN ('approved','applied')
    OR change_class <> 'substantive'
    OR (
      decided_kind = 'partner'
      AND decided_role = 'partner'
      AND decided_by IS NOT NULL
      AND btrim(decided_by) <> ''
    )
  )
);

CREATE TABLE IF NOT EXISTS public.master_versions (
  id UUID PRIMARY KEY,
  firm_id TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  proposal_id UUID REFERENCES public.change_proposals (id),
  parent_version_id UUID REFERENCES public.master_versions (id),
  action TEXT NOT NULL CHECK (action IN ('apply','rollback')),
  diff JSONB NOT NULL,
  snapshot JSONB NOT NULL,
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('partner','system')),
  restored_from_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, version_no)
);

ALTER TABLE public.change_proposals ADD COLUMN IF NOT EXISTS requested_class TEXT;
ALTER TABLE public.change_proposals ADD COLUMN IF NOT EXISTS declassify BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.change_proposals ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS master_versions_one_proposal
  ON public.master_versions (proposal_id)
  WHERE proposal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.master_knowledge (
  firm_id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('public','internal','confidential','privileged','privileged-restricted')),
  version_id UUID NOT NULL REFERENCES public.master_versions (id)
);

CREATE OR REPLACE FUNCTION public.p6_refuse_non_p6_writer() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF current_user IS DISTINCT FROM 'p6_service' THEN
    RAISE EXCEPTION 'non-P6 writer refused' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.p6_versions_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION 'master_versions are append-only' USING ERRCODE = '42501';
END;
$fn$;

REVOKE ALL ON FUNCTION public.p6_refuse_non_p6_writer() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p6_versions_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.p6_refuse_non_p6_writer() TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_versions_append_only() TO p6_service;

DROP TRIGGER IF EXISTS change_proposals_p6_writer ON public.change_proposals;
CREATE TRIGGER change_proposals_p6_writer
  BEFORE INSERT OR UPDATE ON public.change_proposals
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_non_p6_writer();

DROP TRIGGER IF EXISTS master_versions_p6_writer ON public.master_versions;
CREATE TRIGGER master_versions_p6_writer
  BEFORE INSERT ON public.master_versions
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_non_p6_writer();

DROP TRIGGER IF EXISTS master_knowledge_p6_writer ON public.master_knowledge;
CREATE TRIGGER master_knowledge_p6_writer
  BEFORE INSERT OR UPDATE ON public.master_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_non_p6_writer();

DROP TRIGGER IF EXISTS master_versions_append_only ON public.master_versions;
CREATE TRIGGER master_versions_append_only
  BEFORE UPDATE OR DELETE ON public.master_versions
  FOR EACH ROW EXECUTE FUNCTION public.p6_versions_append_only();

REVOKE ALL ON TABLE public.change_proposals, public.master_versions, public.master_knowledge FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON TABLE public.change_proposals, public.master_versions, public.master_knowledge FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON TABLE public.change_proposals, public.master_versions, public.master_knowledge FROM p6_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.change_proposals TO p6_service;
GRANT SELECT, INSERT ON TABLE public.master_versions TO p6_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.master_knowledge TO p6_service;

CREATE OR REPLACE FUNCTION public.p6_refuse_removal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION 'master delete or truncate refused' USING ERRCODE = '42501';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.p6_freeze_approved_payload() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
    RAISE EXCEPTION 'approved proposal payload is frozen' USING ERRCODE = '42501';
  END IF;
  IF NEW.entry_key IS DISTINCT FROM OLD.entry_key
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.change_class IS DISTINCT FROM OLD.change_class
     OR NEW.partition IS DISTINCT FROM OLD.partition
     OR NEW.firm_id IS DISTINCT FROM OLD.firm_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.source_module IS DISTINCT FROM OLD.source_module
  THEN
    IF OLD.status IN ('approved', 'applied') OR NEW.status IN ('approved', 'applied') THEN
      RAISE EXCEPTION 'approved proposal payload is frozen' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.p6_classification_rank(label text) RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  SELECT CASE label
    WHEN 'public' THEN 0
    WHEN 'internal' THEN 1
    WHEN 'confidential' THEN 2
    WHEN 'privileged' THEN 3
    WHEN 'privileged-restricted' THEN 4
    ELSE NULL
  END
$fn$;

CREATE OR REPLACE FUNCTION public.p6_refuse_class_downgrade() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF public.p6_classification_rank(NEW.classification) < public.p6_classification_rank(OLD.classification)
     AND current_setting('p6.declassify', true) IS DISTINCT FROM 'partner' THEN
    RAISE EXCEPTION 'classification downgrade requires partner declassify' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.p6_bind_payload_hash() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.payload_hash IS NULL OR NEW.payload_hash = '' THEN
    NEW.payload_hash := md5(NEW.payload::text);
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.p6_refuse_removal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p6_bind_payload_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p6_freeze_approved_payload() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p6_classification_rank(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p6_refuse_class_downgrade() FROM PUBLIC;

-- Actor key: NFKC, drop default-ignorables, ECMAScript trim, lower-case, fold ß to ss.
-- Trim is every Unicode White_Space and LineTerminator, the same set as String.prototype.trim.
-- U+0085 NEXT LINE is not in that set, so it survives trim and the charset then rejects the key.
-- U+A7F1 is mapped to U+0053 because this server's
-- normalize(NFKC) leaves it unchanged while ECMAScript NFKC maps it to S.
-- After folding, a key that is not ^[a-z0-9._@-]+$ is empty. Unicode 16 case pairs are not
-- given one-off folds: Postgres 16 lower() leaves them distinct, so both sides reject them.
-- 011_p6_actor_key.sql repeats this function for a database that already applied an older 009.
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

-- Explicit transitions:
--   INSERT -> pending, with no decision
--   pending -> approved, partner kind and role, actor key distinct from the proposer
--   pending -> applied, cosmetic, system decision p6
--   approved -> applied, decision fields unchanged
--   every other write, including a direct approved status, is refused
CREATE OR REPLACE FUNCTION public.p6_enforce_proposal_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  proposer text;
  approver text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending'
       OR NEW.decided_by IS NOT NULL
       OR NEW.decided_kind IS NOT NULL
       OR NEW.decided_role IS NOT NULL
       OR NEW.declassify IS TRUE THEN
      RAISE EXCEPTION 'new proposals are pending' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.partition IS DISTINCT FROM OLD.partition
     OR NEW.firm_id IS DISTINCT FROM OLD.firm_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
     OR NEW.source_module IS DISTINCT FROM OLD.source_module
     OR NEW.requested_class IS DISTINCT FROM OLD.requested_class
  THEN
    RAISE EXCEPTION 'approved proposal payload is frozen' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF NEW.decided_by IS NOT NULL
       OR NEW.decided_kind IS NOT NULL
       OR NEW.decided_role IS NOT NULL
       OR NEW.declassify IS TRUE
       OR NEW.change_class IS DISTINCT FROM OLD.change_class THEN
      RAISE EXCEPTION 'approval is not a direct status change' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'approval is not a direct status change' USING ERRCODE = '42501';
  END IF;
  IF NEW.decided_kind = 'partner' AND OLD.decided_kind IS DISTINCT FROM 'partner'
     AND NOT (OLD.status = 'pending' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'approval is not a direct status change' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(NEW.declassify, false) IS TRUE AND COALESCE(OLD.declassify, false) IS DISTINCT FROM TRUE
     AND NOT (OLD.status = 'pending' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'approval is not a direct status change' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF NEW.change_class IS DISTINCT FROM 'substantive'
       OR NEW.decided_kind IS DISTINCT FROM 'partner'
       OR NEW.decided_role IS DISTINCT FROM 'partner'
       OR NEW.decided_by IS NULL
       OR public.p6_actor_key(NEW.decided_by) = '' THEN
      RAISE EXCEPTION 'approval is not a direct status change' USING ERRCODE = '42501';
    END IF;
    proposer := public.p6_actor_key(NEW.proposed_by);
    approver := public.p6_actor_key(NEW.decided_by);
    IF proposer = '' OR approver = '' OR proposer = approver THEN
      RAISE EXCEPTION 'approver must differ from proposer' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'applied' THEN
    IF NEW.change_class IS DISTINCT FROM 'cosmetic'
       OR OLD.change_class IS DISTINCT FROM 'cosmetic'
       OR NEW.decided_kind IS DISTINCT FROM 'system'
       OR NEW.decided_role IS DISTINCT FROM 'system'
       OR NEW.decided_by IS DISTINCT FROM 'p6'
       OR NEW.declassify IS TRUE THEN
      RAISE EXCEPTION 'proposal status transition is refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'applied' THEN
    IF NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_kind IS DISTINCT FROM OLD.decided_kind
       OR NEW.decided_role IS DISTINCT FROM OLD.decided_role
       OR NEW.declassify IS DISTINCT FROM OLD.declassify
       OR NEW.change_class IS DISTINCT FROM OLD.change_class THEN
      RAISE EXCEPTION 'proposal status transition is refused' USING ERRCODE = '42501';
    END IF;
    IF NEW.change_class = 'substantive' AND (
         NEW.decided_kind IS DISTINCT FROM 'partner'
         OR NEW.decided_role IS DISTINCT FROM 'partner'
         OR NEW.decided_by IS NULL
         OR public.p6_actor_key(NEW.decided_by) = ''
         OR public.p6_actor_key(NEW.decided_by) = public.p6_actor_key(NEW.proposed_by)
       ) THEN
      RAISE EXCEPTION 'proposal status transition is refused' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'proposal status transition is refused' USING ERRCODE = '42501';
END;
$fn$;

REVOKE ALL ON FUNCTION public.p6_actor_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.p6_enforce_proposal_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.p6_refuse_removal() TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_bind_payload_hash() TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_freeze_approved_payload() TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_classification_rank(text) TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_refuse_class_downgrade() TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_actor_key(text) TO p6_service;
GRANT EXECUTE ON FUNCTION public.p6_enforce_proposal_transition() TO p6_service;

DROP TRIGGER IF EXISTS change_proposals_no_delete ON public.change_proposals;
CREATE TRIGGER change_proposals_no_delete
  BEFORE DELETE ON public.change_proposals
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_removal();

DROP TRIGGER IF EXISTS change_proposals_no_truncate ON public.change_proposals;
CREATE TRIGGER change_proposals_no_truncate
  BEFORE TRUNCATE ON public.change_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION public.p6_refuse_removal();

DROP TRIGGER IF EXISTS master_versions_no_delete ON public.master_versions;
CREATE TRIGGER master_versions_no_delete
  BEFORE DELETE ON public.master_versions
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_removal();

DROP TRIGGER IF EXISTS master_versions_no_truncate ON public.master_versions;
CREATE TRIGGER master_versions_no_truncate
  BEFORE TRUNCATE ON public.master_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.p6_refuse_removal();

DROP TRIGGER IF EXISTS master_knowledge_no_delete ON public.master_knowledge;
CREATE TRIGGER master_knowledge_no_delete
  BEFORE DELETE ON public.master_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_removal();

DROP TRIGGER IF EXISTS master_knowledge_no_truncate ON public.master_knowledge;
CREATE TRIGGER master_knowledge_no_truncate
  BEFORE TRUNCATE ON public.master_knowledge
  FOR EACH STATEMENT EXECUTE FUNCTION public.p6_refuse_removal();

DROP TRIGGER IF EXISTS change_proposals_bind_hash ON public.change_proposals;
CREATE TRIGGER change_proposals_bind_hash
  BEFORE INSERT ON public.change_proposals
  FOR EACH ROW EXECUTE FUNCTION public.p6_bind_payload_hash();

DROP TRIGGER IF EXISTS change_proposals_freeze_payload ON public.change_proposals;
CREATE TRIGGER change_proposals_freeze_payload
  BEFORE UPDATE ON public.change_proposals
  FOR EACH ROW EXECUTE FUNCTION public.p6_freeze_approved_payload();

-- One statement. psql autocommit must not commit a DROP of the old check and then fail the ADD.
-- A legacy substantive approval with no distinct partner fails here, before either constraint changes,
-- and this statement then rolls back, so the old check stays and the status trigger is not created.
DO $swap$
DECLARE
  bad_ids text;
  bad_count integer;
BEGIN
  -- The message lists the first 20 ids and the count. A large legacy set must not make the error unbounded.
  WITH bad AS (
    SELECT id::text AS id
      FROM public.change_proposals
     WHERE status IN ('approved', 'applied')
       AND change_class = 'substantive'
       AND (
         decided_kind IS DISTINCT FROM 'partner'
         OR decided_role IS DISTINCT FROM 'partner'
         OR public.p6_actor_key(decided_by) = ''
         OR public.p6_actor_key(decided_by) = public.p6_actor_key(proposed_by)
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
  EXECUTE $sql$ALTER TABLE public.change_proposals DROP CONSTRAINT IF EXISTS substantive_partner_approval_next$sql$;
  EXECUTE $sql$ALTER TABLE public.change_proposals ADD CONSTRAINT substantive_partner_approval_next CHECK (
    status NOT IN ('approved','applied')
    OR change_class <> 'substantive'
    OR (
      decided_kind = 'partner'
      AND decided_role = 'partner'
      AND decided_by IS NOT NULL
      AND public.p6_actor_key(decided_by) <> ''
      AND public.p6_actor_key(decided_by) IS DISTINCT FROM public.p6_actor_key(proposed_by)
    )
  ) NOT VALID$sql$;
  EXECUTE $sql$ALTER TABLE public.change_proposals VALIDATE CONSTRAINT substantive_partner_approval_next$sql$;
  EXECUTE $sql$ALTER TABLE public.change_proposals DROP CONSTRAINT IF EXISTS substantive_partner_approval$sql$;
  EXECUTE $sql$ALTER TABLE public.change_proposals RENAME CONSTRAINT substantive_partner_approval_next TO substantive_partner_approval$sql$;
  EXECUTE $sql$DROP TRIGGER IF EXISTS change_proposals_status_transition ON public.change_proposals$sql$;
  EXECUTE $sql$CREATE TRIGGER change_proposals_status_transition
    BEFORE INSERT OR UPDATE ON public.change_proposals
    FOR EACH ROW EXECUTE FUNCTION public.p6_enforce_proposal_transition();$sql$;
END
$swap$;

DROP TRIGGER IF EXISTS master_knowledge_no_downgrade ON public.master_knowledge;
CREATE TRIGGER master_knowledge_no_downgrade
  BEFORE UPDATE ON public.master_knowledge
  FOR EACH ROW EXECUTE FUNCTION public.p6_refuse_class_downgrade();

-- Named roles that already exist on a corpus database must not inherit these tables.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'corpus_reader','corpus_writer','corpus_declassify','corpus_authority_reader','corpus_research_reader'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.change_proposals, public.master_versions, public.master_knowledge FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;
