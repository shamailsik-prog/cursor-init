-- SIKANDER AI — Annex A classification inventory (audit FA-DATA-002-DEPLOY-001). Additive and idempotent;
-- 001-007 are not edited. Applied after 007, in the same order as the other Annex A DDL:
-- 001, 003, 004, 005, 006, 007, 008. 008 must follow 007. It re-defines corpus_contract_routines()
-- (15 routines; was 14 after 006) so provisioning's owner check and EXECUTE-drift reset cover
-- enforce_embedding_classification(), re-asserts 007's EXECUTE revokes, and refuses to run when 007
-- or trigger corpus_embeddings_monotonic is missing or disabled. corpus_contract_relations() stays 37.

-- Fail closed before replacing the inventory: a database that never ran 007, or whose trigger was
-- disabled afterwards, must not pick up a 15-routine list that points at nothing.
DO $$
DECLARE
  trig "char";
BEGIN
  IF pg_catalog.to_regprocedure('public.enforce_embedding_classification()') IS NULL THEN
    RAISE EXCEPTION '007 is not applied: public.enforce_embedding_classification() is missing';
  END IF;
  SELECT t.tgenabled INTO trig
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'corpus_embeddings'
     AND t.tgname = 'corpus_embeddings_monotonic'
     AND NOT t.tgisinternal;
  IF trig IS NULL OR trig <> 'O' THEN
    RAISE EXCEPTION '007 is not applied: trigger corpus_embeddings_monotonic is missing or disabled';
  END IF;
END
$$;

-- Routine inventory (15 routines; was 14 after 006). Provisioning resets EXECUTE drift on these.
CREATE OR REPLACE FUNCTION public.corpus_contract_routines() RETURNS TABLE (routine regprocedure, public_execute boolean)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p, x.public_execute FROM (
    SELECT pg_catalog.to_regprocedure('public.' || v.signature) AS p, v.public_execute
    FROM (VALUES
      ('enforce_monotonic_classification()', true),
      ('declassify(uuid, text, text, text)', false),
      ('corpus_session_is_superuser()', false),
      ('corpus_provenance_complete(uuid)', false),
      ('corpus_contract_relations()', false),
      ('corpus_contract_routines()', false),
      ('enforce_promoted_via_publication()', false),
      ('corpus_publication_commit_check()', false),
      ('corpus_publication_append_only()', false),
      ('corpus_publication_item_guard()', false),
      ('corpus_publication_begin(text, text, text, text)', false),
      ('corpus_publication_finish(uuid, jsonb)', false),
      ('corpus_research_term_clear()', false),
      ('corpus_research_term_apply(integer, jsonb, jsonb)', false),
      ('enforce_embedding_classification()', false)
    ) AS v(signature, public_execute)
  ) x
  WHERE p IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.corpus_contract_routines() FROM PUBLIC;

-- Re-assert 007: no app role and not PUBLIC may execute the embedding guard. The trigger still fires.
REVOKE ALL ON FUNCTION public.enforce_embedding_classification() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_embedding_classification() FROM
  corpus_reader, corpus_writer, corpus_declassify, corpus_authority_reader, corpus_research_reader;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_writer') THEN
    REVOKE ALL ON FUNCTION public.enforce_embedding_classification() FROM app_writer;
  END IF;
END $$;
