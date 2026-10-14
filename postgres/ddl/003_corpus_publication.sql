-- SIKANDER AI — Annex A corpus publication (audit F19). Additive and idempotent; 001 and 002 are not edited.
-- Applied by a superuser after 001 (it needs the Annex A roles and tables). Every statement can be re-run.
--
-- A contract row becomes 'promoted' (or a promoted row changes) only inside an audited corpus publication:
--   corpus_publication_begin()  -> advisory lock, audit row, transaction-scoped grant row
--   INSERT/UPDATE contract rows carrying publication_id, guarded by enforce_promoted_via_publication()
--   INSERT corpus_publication_item rows (one per entity decision)
--   corpus_publication_finish() -> counts recomputed and checked, grant removed, corpus_metadata refreshed
-- Error codes are SQLSTATE class SK (SKP01-SKP11); each message is a stable token, and DETAIL never
-- carries row values. Superuser sessions are exempt from the guard (spec ruling 2) but cannot publish (D2).

-- 1. Fail-closed default: a contract row nobody published is quarantined.
ALTER TABLE court ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE judge ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE instrument ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE statute ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE statute_section ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE statute_section_version ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE judgment ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE citation ALTER COLUMN review_status SET DEFAULT 'quarantined';
ALTER TABLE treatment ALTER COLUMN review_status SET DEFAULT 'quarantined';

-- 2. Append-only publication audit.
CREATE TABLE IF NOT EXISTS corpus_publication (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key TEXT NOT NULL UNIQUE CHECK (batch_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  input_sha256 TEXT NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('staging','curated')),
  actor_id TEXT NOT NULL CHECK (btrim(actor_id) <> '' AND length(actor_id) <= 200),
  publisher_session_user TEXT NOT NULL,
  item_count INT, promoted_count INT, quarantined_count INT, updated_count INT, unchanged_count INT, rejected_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT corpus_publication_counts_on_finish CHECK ((finished_at IS NULL) = (item_count IS NULL))
);
COMMENT ON COLUMN corpus_publication.actor_id IS
  'Application-asserted actor identifier; not verified by the database.';
CREATE TABLE IF NOT EXISTS corpus_publication_item (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES corpus_publication(id),
  item_key TEXT NOT NULL CHECK (item_key ~ '^[A-Za-z0-9._:-]{1,100}$'),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('judgment','citation','treatment','statute','statute_section','statute_section_version')),
  entity_id UUID,
  decision TEXT NOT NULL CHECK (decision IN ('promoted','quarantined','updated','unchanged','rejected')),
  reason TEXT,
  content_sha256 TEXT CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  prev_sha256 TEXT CHECK (prev_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT corpus_publication_item_entity_unless_rejected CHECK (decision = 'rejected' OR entity_id IS NOT NULL),
  CONSTRAINT corpus_publication_item_reason_when_held CHECK (decision NOT IN ('quarantined','rejected') OR reason IS NOT NULL),
  CONSTRAINT corpus_publication_item_hash_unless_rejected CHECK (decision = 'rejected' OR content_sha256 IS NOT NULL),
  CONSTRAINT corpus_publication_item_unchanged_same_hash CHECK (decision <> 'unchanged' OR prev_sha256 = content_sha256)
);
CREATE INDEX IF NOT EXISTS corpus_publication_item_publication ON corpus_publication_item (publication_id);
CREATE INDEX IF NOT EXISTS corpus_publication_item_entity ON corpus_publication_item (entity_type, entity_id, id DESC);

-- Transaction-local publication grant (the judgment_declassify_grant pattern): no application role may write it.
CREATE TABLE IF NOT EXISTS corpus_publication_grant (
  xid BIGINT PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES corpus_publication(id)
);
REVOKE ALL ON corpus_publication_grant FROM PUBLIC;

-- 3. Every contract row (and its provenance) records the publication that last wrote it.
ALTER TABLE court ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE judge ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE instrument ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE statute ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE statute_section ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE statute_section_version ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE judgment ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE citation ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE treatment ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);
ALTER TABLE source_provenance ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES corpus_publication(id);

-- 4. Closed sets and the treatment natural key. Added NOT VALID only when missing, then VALIDATEd
--    (VALIDATE of an already valid constraint is a no-op).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conname = 'treatment_treating_bench_type_check' AND conrelid = 'public.treatment'::regclass) THEN
    ALTER TABLE public.treatment ADD CONSTRAINT treatment_treating_bench_type_check
      CHECK (treating_bench_type IN ('single','division','full','larger')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conname = 'statute_jurisdiction_annex_a_check' AND conrelid = 'public.statute'::regclass) THEN
    ALTER TABLE public.statute ADD CONSTRAINT statute_jurisdiction_annex_a_check
      CHECK (jurisdiction IS NOT NULL AND jurisdiction IN ('Federal','Sindh','Punjab','KP','Balochistan','ICT','GB','AJK')) NOT VALID;
  END IF;
END $$;
ALTER TABLE treatment VALIDATE CONSTRAINT treatment_treating_bench_type_check;
ALTER TABLE statute VALIDATE CONSTRAINT statute_jurisdiction_annex_a_check;
CREATE UNIQUE INDEX IF NOT EXISTS treatment_natural_key
  ON treatment (treating_judgment_id, treated_judgment_id, treatment, (coalesce(passage_anchor, '')));

-- 5. Helpers.
CREATE OR REPLACE FUNCTION corpus_session_is_superuser() RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- session_user, not current_user: inside a SECURITY DEFINER function current_user is the owner (D1).
  SELECT coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = session_user), false)
$$;

CREATE OR REPLACE FUNCTION corpus_provenance_complete(p_source_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.source_provenance p
    WHERE p.id = p_source_id
      AND btrim(coalesce(p.source_name, '')) <> ''
      AND p.fetched_at IS NOT NULL
      AND btrim(coalesce(p.content_hash, '')) <> ''
      AND p.extraction_method IS NOT NULL
      AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> '')
  )
$$;

-- The inventory of Annex A relations (D25). Provisioning (PR 2b) keeps every one of them away from the
-- runtime role's blanket grants and the migration role's ownership; PR 3's 004 must extend it.
CREATE OR REPLACE FUNCTION corpus_contract_relations() RETURNS SETOF regclass
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r FROM (
    SELECT pg_catalog.to_regclass('public.' || n) AS r
    FROM unnest(ARRAY[
      'classification_rank', 'source_provenance', 'court', 'judge', 'instrument', 'statute', 'statute_section',
      'statute_section_version', 'judgment', 'judgment_version', 'citation', 'treatment', 'corpus_metadata',
      'corpus_embeddings', 'judgment_classification_declassify_audit', 'judgment_declassify_grant',
      'v_judgment', 'v_citation', 'v_treatment', 'v_statute', 'v_statute_section', 'v_statute_section_version',
      'v_instrument', 'v_court', 'v_judge', 'v_source_provenance',
      'corpus_publication', 'corpus_publication_item', 'corpus_publication_grant'
    ]) AS n
  ) s
  WHERE r IS NOT NULL
$$;

-- 6. The publication guard, BEFORE INSERT OR UPDATE on every contract table.
--    Fires when a row becomes promoted, or when a promoted row changes anything but classification
--    and updated_at (D4: declassify() and classification raises are unaffected; columns added later
--    are covered, which fails closed). A demotion of a promoted row also needs a publication (D5).
CREATE OR REPLACE FUNCTION enforce_promoted_via_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_ignored CONSTANT text[] := ARRAY['classification', 'updated_at'];
  v_fires boolean;
  v_new jsonb;
  v_confidence double precision;
  v_from date;
  v_to date;
BEGIN
  IF public.corpus_session_is_superuser() THEN
    RETURN NEW; -- spec ruling 2: a superuser can drop the trigger anyway; the reader views close the gap
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_fires := NEW.review_status = 'promoted';
  ELSE
    v_fires := (NEW.review_status = 'promoted' AND OLD.review_status IS DISTINCT FROM 'promoted')
      OR (OLD.review_status = 'promoted'
          AND (pg_catalog.to_jsonb(NEW) - c_ignored) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - c_ignored));
  END IF;
  IF NOT coalesce(v_fires, false) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.corpus_publication_grant g
                 WHERE g.xid = pg_catalog.txid_current() AND g.publication_id = NEW.publication_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP02', MESSAGE = 'publication_required',
      DETAIL = pg_catalog.format('table %s', TG_TABLE_NAME);
  END IF;
  IF NEW.review_status IS DISTINCT FROM 'promoted' THEN
    RETURN NEW; -- a demotion inside a publication: no content checks
  END IF;

  IF NOT public.corpus_provenance_complete(NEW.source_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP03', MESSAGE = 'provenance_incomplete',
      DETAIL = pg_catalog.format('table %s', TG_TABLE_NAME);
  END IF;

  v_new := pg_catalog.to_jsonb(NEW);
  IF TG_TABLE_NAME = 'judgment' THEN
    IF pg_catalog.btrim(coalesce(v_new ->> 'bench_type', '')) = '' THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP04', MESSAGE = 'bench_required', DETAIL = 'table judgment';
    END IF;
  ELSIF TG_TABLE_NAME = 'treatment' THEN
    v_confidence := (v_new ->> 'confidence')::double precision;
    IF v_confidence IS NULL OR v_confidence < 0.7 THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP05', MESSAGE = 'treatment_confidence', DETAIL = 'table treatment';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.judgment j WHERE j.id = (v_new ->> 'treating_judgment_id')::uuid)
       OR NOT EXISTS (SELECT 1 FROM public.judgment j WHERE j.id = (v_new ->> 'treated_judgment_id')::uuid) THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP05', MESSAGE = 'treatment_judgment_missing', DETAIL = 'table treatment';
    END IF;
  ELSIF TG_TABLE_NAME = 'statute_section_version' THEN
    v_from := (v_new ->> 'effective_from')::date;
    v_to := (v_new ->> 'effective_to')::date;
    IF v_from IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP06', MESSAGE = 'version_effective_from_required',
        DETAIL = 'table statute_section_version';
    END IF;
    IF v_to IS NOT NULL AND v_to <= v_from THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP06', MESSAGE = 'version_range_invalid',
        DETAIL = 'table statute_section_version';
    END IF;
    -- Procedural overlap check, serialised by the publication advisory lock. A promoted version with a
    -- NULL effective_from overlaps everything (fails closed).
    IF EXISTS (
      SELECT 1 FROM public.statute_section_version v
      WHERE v.section_id = (v_new ->> 'section_id')::uuid
        AND v.id <> (v_new ->> 'id')::uuid
        AND v.review_status = 'promoted'
        AND pg_catalog.daterange(v.effective_from, v.effective_to, '[)')
            OPERATOR(pg_catalog.&&) pg_catalog.daterange(v_from, v_to, '[)')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP06', MESSAGE = 'version_overlap', DETAIL = 'table statute_section_version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER court_publication_guard BEFORE INSERT OR UPDATE ON court
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER judge_publication_guard BEFORE INSERT OR UPDATE ON judge
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER instrument_publication_guard BEFORE INSERT OR UPDATE ON instrument
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER statute_publication_guard BEFORE INSERT OR UPDATE ON statute
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER statute_section_publication_guard BEFORE INSERT OR UPDATE ON statute_section
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER statute_section_version_publication_guard BEFORE INSERT OR UPDATE ON statute_section_version
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
-- On judgment, BEFORE triggers fire in name order: judgment_monotonic (FA-DATA-001) runs first.
CREATE OR REPLACE TRIGGER judgment_publication_guard BEFORE INSERT OR UPDATE ON judgment
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER citation_publication_guard BEFORE INSERT OR UPDATE ON citation
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();
CREATE OR REPLACE TRIGGER treatment_publication_guard BEFORE INSERT OR UPDATE ON treatment
  FOR EACH ROW EXECUTE FUNCTION enforce_promoted_via_publication();

-- 7. Audit enforcement. Append-only for every role, a superuser included (D6). The single permitted
--    change is finish() stamping the counts and finished_at once, while the publication's grant is open.
CREATE OR REPLACE FUNCTION corpus_publication_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  c_finish CONSTANT text[] := ARRAY['item_count', 'promoted_count', 'quarantined_count', 'updated_count',
                                    'unchanged_count', 'rejected_count', 'finished_at'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'corpus_publication' THEN
      IF OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL THEN
        IF (pg_catalog.to_jsonb(NEW) - c_finish) = (pg_catalog.to_jsonb(OLD) - c_finish) THEN
          IF EXISTS (SELECT 1 FROM public.corpus_publication_grant g
                     WHERE g.publication_id = OLD.id AND g.xid = pg_catalog.txid_current()) THEN
            RETURN NEW;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'SKP11', MESSAGE = 'corpus_audit_append_only',
    DETAIL = pg_catalog.format('table %s', TG_TABLE_NAME);
END;
$$;

CREATE OR REPLACE TRIGGER corpus_publication_append_only BEFORE UPDATE OR DELETE ON corpus_publication
  FOR EACH ROW EXECUTE FUNCTION corpus_publication_append_only();
CREATE OR REPLACE TRIGGER corpus_publication_no_truncate BEFORE TRUNCATE ON corpus_publication
  FOR EACH STATEMENT EXECUTE FUNCTION corpus_publication_append_only();
CREATE OR REPLACE TRIGGER corpus_publication_item_append_only BEFORE UPDATE OR DELETE ON corpus_publication_item
  FOR EACH ROW EXECUTE FUNCTION corpus_publication_append_only();
CREATE OR REPLACE TRIGGER corpus_publication_item_no_truncate BEFORE TRUNCATE ON corpus_publication_item
  FOR EACH STATEMENT EXECUTE FUNCTION corpus_publication_append_only();

CREATE OR REPLACE FUNCTION corpus_publication_item_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF public.corpus_session_is_superuser() THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.corpus_publication_grant g
                 WHERE g.xid = pg_catalog.txid_current() AND g.publication_id = NEW.publication_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP02', MESSAGE = 'publication_required', DETAIL = 'table corpus_publication_item';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER corpus_publication_item_guard BEFORE INSERT ON corpus_publication_item
  FOR EACH ROW EXECUTE FUNCTION corpus_publication_item_guard();

-- 8. begin / finish.
CREATE OR REPLACE FUNCTION corpus_publication_begin(p_batch_key text, p_input_sha256 text, p_source_kind text, p_actor_id text)
RETURNS TABLE (publication_id uuid, already boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_xid bigint;
  v_id uuid;
  v_existing_id uuid;
  v_existing_sha text;
  v_existing_finished timestamptz;
BEGIN
  IF public.corpus_session_is_superuser() THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP07', MESSAGE = 'publication_superuser_refused';
  END IF;
  IF p_batch_key IS NULL OR p_batch_key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR p_input_sha256 IS NULL OR p_input_sha256 !~ '^[0-9a-f]{64}$'
     OR p_source_kind IS NULL OR p_source_kind NOT IN ('staging', 'curated')
     OR p_actor_id IS NULL OR pg_catalog.btrim(p_actor_id) = '' OR pg_catalog.length(p_actor_id) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP09', MESSAGE = 'publication_invalid_argument';
  END IF;
  -- One publication at a time: serialises the procedural overlap check and the seq/commit order.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sikander.corpus_publication', 0));
  v_xid := pg_catalog.txid_current();
  IF EXISTS (SELECT 1 FROM public.corpus_publication_grant g WHERE g.xid = v_xid) THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP08', MESSAGE = 'publication_already_open';
  END IF;
  SELECT c.id, c.input_sha256, c.finished_at INTO v_existing_id, v_existing_sha, v_existing_finished
    FROM public.corpus_publication c WHERE c.batch_key = p_batch_key;
  IF FOUND THEN
    IF v_existing_sha <> p_input_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP01', MESSAGE = 'batch_key_reused',
        DETAIL = 'this batch_key was published with different content';
    END IF;
    IF v_existing_finished IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'SKP08', MESSAGE = 'publication_unfinished';
    END IF;
    RETURN QUERY SELECT v_existing_id, true; -- idempotent re-run: nothing is written
    RETURN;
  END IF;
  INSERT INTO public.corpus_publication (batch_key, input_sha256, source_kind, actor_id, publisher_session_user)
    VALUES (p_batch_key, p_input_sha256, p_source_kind, pg_catalog.btrim(p_actor_id), session_user)
    RETURNING id INTO v_id;
  INSERT INTO public.corpus_publication_grant (xid, publication_id) VALUES (v_xid, v_id);
  RETURN QUERY SELECT v_id, false;
END;
$$;

CREATE OR REPLACE FUNCTION corpus_publication_finish(p_publication_id uuid, p_counts jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_xid bigint;
  v_counts jsonb;
  v_seq bigint;
BEGIN
  IF public.corpus_session_is_superuser() THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP07', MESSAGE = 'publication_superuser_refused';
  END IF;
  v_xid := pg_catalog.txid_current();
  IF NOT EXISTS (SELECT 1 FROM public.corpus_publication_grant g
                 WHERE g.xid = v_xid AND g.publication_id = p_publication_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP08', MESSAGE = 'publication_not_open';
  END IF;
  -- The audit and the summary cannot disagree (D22).
  SELECT pg_catalog.jsonb_build_object(
      'items', count(DISTINCT i.item_key),
      'promoted', count(*) FILTER (WHERE i.decision = 'promoted'),
      'quarantined', count(*) FILTER (WHERE i.decision = 'quarantined'),
      'updated', count(*) FILTER (WHERE i.decision = 'updated'),
      'unchanged', count(*) FILTER (WHERE i.decision = 'unchanged'),
      'rejected', count(*) FILTER (WHERE i.decision = 'rejected'))
    INTO v_counts
    FROM public.corpus_publication_item i WHERE i.publication_id = p_publication_id;
  IF v_counts IS DISTINCT FROM p_counts THEN
    RAISE EXCEPTION USING ERRCODE = 'SKP10', MESSAGE = 'publication_counts_mismatch';
  END IF;
  UPDATE public.corpus_publication c
     SET item_count = (v_counts ->> 'items')::int,
         promoted_count = (v_counts ->> 'promoted')::int,
         quarantined_count = (v_counts ->> 'quarantined')::int,
         updated_count = (v_counts ->> 'updated')::int,
         unchanged_count = (v_counts ->> 'unchanged')::int,
         rejected_count = (v_counts ->> 'rejected')::int,
         finished_at = pg_catalog.clock_timestamp()
   WHERE c.id = p_publication_id
   RETURNING c.seq INTO v_seq;
  DELETE FROM public.corpus_publication_grant g WHERE g.xid = v_xid AND g.publication_id = p_publication_id;
  -- D30: last_refresh is the transaction start in UTC (errs toward stale, which fails closed for the reader).
  INSERT INTO public.corpus_metadata (key, value, updated_at) VALUES
      ('last_refresh', pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), pg_catalog.now()),
      ('publication_seq', v_seq::text, pg_catalog.now()),
      ('publication_contract', '1', pg_catalog.now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
  RETURN v_seq;
END;
$$;

-- 9. Grants. corpus_writer: DML on the contract tables (no DELETE, no TRUNCATE), the audit by INSERT
--    and SELECT only, and the two publication functions. Nothing else may execute them.
REVOKE ALL ON corpus_publication, corpus_publication_item FROM PUBLIC;
REVOKE ALL ON corpus_publication_grant FROM corpus_reader, corpus_writer, corpus_declassify;
REVOKE ALL ON corpus_publication, corpus_publication_item FROM corpus_reader, corpus_declassify;
GRANT SELECT ON corpus_publication TO corpus_writer;
GRANT SELECT, INSERT ON corpus_publication_item TO corpus_writer;
REVOKE UPDATE, DELETE, TRUNCATE ON corpus_publication, corpus_publication_item FROM corpus_writer;
GRANT SELECT, INSERT, UPDATE ON court, judge, instrument, statute, statute_section, statute_section_version,
  judgment, citation, treatment TO corpus_writer;
GRANT SELECT, INSERT ON source_provenance TO corpus_writer;
REVOKE ALL ON FUNCTION corpus_publication_begin(text, text, text, text), corpus_publication_finish(uuid, jsonb),
  enforce_promoted_via_publication(), corpus_publication_append_only(), corpus_publication_item_guard(),
  corpus_provenance_complete(uuid), corpus_session_is_superuser(), corpus_contract_relations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION corpus_publication_begin(text, text, text, text), corpus_publication_finish(uuid, jsonb)
  TO corpus_writer;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_writer') THEN
    REVOKE ALL ON public.corpus_publication, public.corpus_publication_item, public.corpus_publication_grant FROM app_writer;
    REVOKE ALL ON FUNCTION public.corpus_publication_begin(text, text, text, text),
      public.corpus_publication_finish(uuid, jsonb) FROM app_writer;
  END IF;
END $$;
