-- FA-DATA-002: classification coverage for corpus_embeddings.
-- Additive and idempotent. Does not replace declassify(), judgment_monotonic, or 001-006.
-- A declassified judgment's embeddings stay at the higher rank (fail closed). There is no wrapper.
-- A lowering of classification_rank is allowed only for entity_type = 'judgment' when the
-- existing transaction-local judgment_declassify_grant matches that entity and the new rank,
-- and the new rank is still at least the source judgment's current rank. No new grant table.

CREATE OR REPLACE FUNCTION public.enforce_embedding_classification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  known BOOLEAN;
  grant_ok BOOLEAN;
  source_rank SMALLINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.classification_rank cr WHERE cr.rank = NEW.classification_rank
  ) INTO known;
  IF NOT known THEN
    RAISE EXCEPTION 'Unknown classification rank %', NEW.classification_rank;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.classification_rank IS DISTINCT FROM OLD.classification_rank
     AND NEW.classification_rank < OLD.classification_rank THEN
    grant_ok := false;
    IF NEW.entity_type = 'judgment' THEN
      BEGIN
        SELECT EXISTS (
          SELECT 1
            FROM public.judgment_declassify_grant g
            JOIN public.classification_rank cr ON cr.label = g.to_classification
           WHERE g.judgment_id = NEW.entity_id
             AND g.xid = pg_catalog.txid_current()
             AND cr.rank = NEW.classification_rank
        ) INTO grant_ok;
      EXCEPTION
        WHEN insufficient_privilege THEN
          grant_ok := false;
      END;
    END IF;
    IF NOT grant_ok THEN
      RAISE EXCEPTION 'Classification downgrade rejected: call declassify() with a partner reason';
    END IF;
  END IF;

  IF NEW.entity_type = 'judgment' THEN
    SELECT cr.rank INTO source_rank
      FROM public.judgment j
      JOIN public.classification_rank cr ON cr.label = j.classification
     WHERE j.id = NEW.entity_id;
    IF NOT FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.judgment j WHERE j.id = NEW.entity_id) THEN
        RAISE EXCEPTION 'source judgment missing: %', NEW.entity_id;
      END IF;
      RAISE EXCEPTION 'Unknown classification on source judgment %', NEW.entity_id;
    END IF;
    IF NEW.classification_rank < source_rank THEN
      RAISE EXCEPTION 'Classification downgrade rejected: call declassify() with a partner reason';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_embedding_classification() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_embedding_classification() FROM
  corpus_reader, corpus_writer, corpus_declassify, corpus_authority_reader, corpus_research_reader;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_writer') THEN
    REVOKE ALL ON FUNCTION public.enforce_embedding_classification() FROM app_writer;
  END IF;
END $$;

DROP TRIGGER IF EXISTS corpus_embeddings_monotonic ON public.corpus_embeddings;
CREATE TRIGGER corpus_embeddings_monotonic
  BEFORE INSERT OR UPDATE ON public.corpus_embeddings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_embedding_classification();
