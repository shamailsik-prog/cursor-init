-- SIKANDER AI — Annex A research term index (audit FA-D5-003-R1-001). Additive and idempotent; 001-005 are not edited.
-- Applied by a superuser after 005, always in the order 001 -> 003 -> 004 -> 005 -> 006 (apply-annex-a.sh in one
-- transaction, the CI loops, the test harnesses). Every statement can be re-run.
-- Spec: docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md §7 (rulings R19-R21, R24).
--
-- D5 research ranks judgments by the terms of their title and visible citations. At the architecture's corpus size
-- (195,000+ judgments, E-14) it cannot load and fold every title per request, so the corpus stores each text's terms,
-- pre-folded by the publication path (corpus_service/scraper/publication/research_terms.py, pinned to the application's
-- fold by tests/fixtures/corpus/research-terms-golden.json). The reader (platform/corpus/pgResearchCorpus.ts) then reads,
-- per query, only the judgments that can reach the top k, with whole-corpus statistics, and its answer equals a ranking
-- of the whole visible corpus.
--
-- * Terms are stored per source row: a judgment's title terms by judgment id, a citation's terms by its citation_text
--   (unique, and never rewritten by a publication). A term row is a pure function of a text; which rows a judgment's
--   document is made of (its visible citations) is decided when read, by the research views below, exactly as 004 and
--   005 decide visibility. So a later publication, a provenance edit or declassify() changes what research reads
--   without any term row going stale.
-- * Each judgment's size (its distinct-term count over its title and its promoted citations, the ranking's tie-break) is
--   stored when it is indexed, so a broad query orders thousands of tied judgments without counting their terms. It is
--   exact for a judgment whose promoted citations are all visible; v_research_term counts the visible terms itself for
--   the rare judgment with a promoted citation that is not visible (no finished publication, incomplete provenance).
-- * A row whose text was written without its terms is pending: one trigger marks every judgment INSERT or UPDATE OF
--   case_title, every citation INSERT or UPDATE OF citation_text, and the judgment (old and new) of every citation
--   INSERT, DELETE or UPDATE OF citation_text, judgment_id or review_status, whoever writes it (the publication, a
--   superuser, a bulk load). The publication indexes what it wrote and clears the marks in its own transaction; `python
--   -m scraper.publication.cli index-terms` indexes the rest. Every application of this file marks each judgment that
--   has no stored size (on the first, every judgment) and the first marks every citation, because those were written
--   before the trigger. The reader folds a pending visible judgment itself, so research is exact whatever the index
--   holds.
-- * corpus_research_reader reads two security_barrier views: v_research_term (a visible judgment's title terms and the
--   terms of its visible citations, each with the judgment's size) and v_research_pending (visible judgments whose title
--   or a visible citation is pending). It reads no index table.
--   corpus_writer maintains the index; nothing else reads or writes it.

-- 0. A judgment's citations are read by judgment (005's documents, the reader's candidate loads), and by source
--    (v_research_term finds the citations whose provenance is incomplete).
CREATE INDEX IF NOT EXISTS citation_judgment_id ON public.citation (judgment_id);
CREATE INDEX IF NOT EXISTS citation_source_id ON public.citation (source_id);

-- 1. Pre-folded terms, one table per kind of source row. A term is never empty and at most 500 characters (a query is at
--    most 500, so a longer term can never match one).
CREATE TABLE IF NOT EXISTS public.research_title_term (
  judgment_id uuid NOT NULL REFERENCES public.judgment (id) ON DELETE CASCADE,
  term text NOT NULL CHECK (term <> '' AND char_length(term) <= 500),
  PRIMARY KEY (judgment_id, term)
);
CREATE INDEX IF NOT EXISTS research_title_term_term ON public.research_title_term (term, judgment_id);

CREATE TABLE IF NOT EXISTS public.research_citation_term (
  citation_text text NOT NULL REFERENCES public.citation (citation_text) ON DELETE CASCADE ON UPDATE CASCADE,
  term text NOT NULL CHECK (term <> '' AND char_length(term) <= 500),
  PRIMARY KEY (citation_text, term)
);
CREATE INDEX IF NOT EXISTS research_citation_term_term ON public.research_citation_term (term, citation_text);

-- Each indexed judgment's distinct-term count over its title and its promoted citations (written with its terms).
CREATE TABLE IF NOT EXISTS public.research_size (
  judgment_id uuid PRIMARY KEY REFERENCES public.judgment (id) ON DELETE CASCADE,
  size integer NOT NULL CHECK (size >= 0)
);

-- 2. Rows whose terms are not (or no longer) in the index.
CREATE TABLE IF NOT EXISTS public.research_title_pending (
  judgment_id uuid PRIMARY KEY REFERENCES public.judgment (id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public.research_citation_pending (
  citation_text text PRIMARY KEY REFERENCES public.citation (citation_text) ON DELETE CASCADE ON UPDATE CASCADE
);

-- 3. The marking trigger. SECURITY DEFINER (owned by the superuser that applies this file, kept so by provisioning), so a
--    writer marks a row without any privilege on the pending tables, and no writer can skip it.
CREATE OR REPLACE FUNCTION public.research_terms_mark_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'judgment' THEN
    INSERT INTO public.research_title_pending (judgment_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME = 'citation' THEN
    -- A citation's text: its own terms. Its judgment, old and new: that judgment's size (and, with a moved or deleted
    -- citation, its terms) must be read again. A judgment deleted in the same statement is not marked.
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.citation_text IS DISTINCT FROM OLD.citation_text) THEN
      INSERT INTO public.research_citation_pending (citation_text) VALUES (NEW.citation_text) ON CONFLICT DO NOTHING;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.judgment_id IS NOT NULL THEN
      INSERT INTO public.research_title_pending (judgment_id)
      SELECT j.id FROM public.judgment j WHERE j.id = NEW.judgment_id ON CONFLICT DO NOTHING;
    END IF;
    IF TG_OP <> 'INSERT' AND OLD.judgment_id IS NOT NULL THEN
      INSERT INTO public.research_title_pending (judgment_id)
      SELECT j.id FROM public.judgment j WHERE j.id = OLD.judgment_id ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.research_terms_mark_pending() FROM PUBLIC;

-- The first application marks every citation written before the trigger existed (a re-application does not: the trigger
-- has marked every write since). Every application marks each judgment without a stored size: on the first, every
-- judgment; later, none once the index has caught up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgname = 'research_terms_pending' AND tgrelid = 'public.judgment'::regclass) THEN
    INSERT INTO public.research_citation_pending (citation_text) SELECT citation_text FROM public.citation ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.research_title_pending (judgment_id)
  SELECT j.id FROM public.judgment j
   WHERE NOT EXISTS (SELECT 1 FROM public.research_size s WHERE s.judgment_id = j.id)
  ON CONFLICT DO NOTHING;
END
$$;
DROP TRIGGER IF EXISTS research_terms_pending ON public.judgment;
CREATE TRIGGER research_terms_pending AFTER INSERT OR UPDATE OF case_title ON public.judgment
  FOR EACH ROW EXECUTE FUNCTION public.research_terms_mark_pending();
DROP TRIGGER IF EXISTS research_terms_pending ON public.citation;
CREATE TRIGGER research_terms_pending AFTER INSERT OR DELETE OR UPDATE OF citation_text, judgment_id, review_status
  ON public.citation FOR EACH ROW EXECUTE FUNCTION public.research_terms_mark_pending();

-- 4. What research reads. A visible judgment's title terms, and the terms of its visible citations, each row with the
--    judgment's size (its distinct-term count, the ranking's tie-break). The visibility rule is 004's and 005's, copied
--    verbatim (as 005 copies 004's) rather than referenced, so the planner can drive each query from the term rows it
--    matches (index lookups on the parents) instead of evaluating every visible judgment and citation first;
--    tests/fa-d5-003.corpus-grants.pg.test.ts holds the copies equal to 004's text.
--    The size is the stored one when every promoted citation of the judgment is visible (its visible document is then
--    its title and its promoted citations, which is what was counted). For the rare judgment with a promoted citation
--    that is not visible (no finished publication, a missing or incomplete provenance), it is counted here from its
--    title terms and its visible citations' terms. For a pending judgment it may be stale or null: the reader never
--    ranks a pending judgment from the index.
CREATE OR REPLACE VIEW public.v_research_term WITH (security_barrier = true) AS
SELECT t.judgment_id, t.term,
       CASE WHEN j.id IN (SELECT h.judgment_id FROM public.corpus_publication pub JOIN public.citation h ON h.publication_id = pub.id
                      WHERE pub.finished_at IS NULL AND h.review_status = 'promoted' AND h.judgment_id IS NOT NULL
                     UNION
                     SELECT h.judgment_id FROM public.citation h
                      WHERE (h.publication_id IS NULL OR h.source_id IS NULL) AND h.review_status = 'promoted'
                        AND h.judgment_id IS NOT NULL
                     UNION
                     SELECT h.judgment_id FROM public.source_provenance p JOIN public.citation h ON h.source_id = p.id
                      WHERE h.review_status = 'promoted' AND h.judgment_id IS NOT NULL
                        AND NOT (btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                                 AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                                 AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> '')))
            THEN (SELECT count(*) FROM (
                    SELECT x.term FROM public.research_title_term x WHERE x.judgment_id = j.id
                    UNION
                    SELECT y.term FROM public.citation c2 JOIN public.research_citation_term y ON y.citation_text = c2.citation_text
                     WHERE c2.judgment_id = j.id
                       AND c2.review_status = 'promoted'
                       AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = c2.publication_id AND pub.finished_at IS NOT NULL)
                       AND EXISTS (SELECT 1 FROM public.source_provenance p
                                    WHERE p.id = c2.source_id
                                      AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                                      AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                                      AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
                  ) visible_terms)::integer
            ELSE z.size END AS size
  FROM public.research_title_term t
  JOIN public.judgment j ON j.id = t.judgment_id
  LEFT JOIN public.research_size z ON z.judgment_id = j.id
 WHERE j.review_status = 'promoted'
   AND j.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = j.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
UNION ALL
SELECT c.judgment_id, t.term,
       CASE WHEN j.id IN (SELECT h.judgment_id FROM public.corpus_publication pub JOIN public.citation h ON h.publication_id = pub.id
                      WHERE pub.finished_at IS NULL AND h.review_status = 'promoted' AND h.judgment_id IS NOT NULL
                     UNION
                     SELECT h.judgment_id FROM public.citation h
                      WHERE (h.publication_id IS NULL OR h.source_id IS NULL) AND h.review_status = 'promoted'
                        AND h.judgment_id IS NOT NULL
                     UNION
                     SELECT h.judgment_id FROM public.source_provenance p JOIN public.citation h ON h.source_id = p.id
                      WHERE h.review_status = 'promoted' AND h.judgment_id IS NOT NULL
                        AND NOT (btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                                 AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                                 AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> '')))
            THEN (SELECT count(*) FROM (
                    SELECT x.term FROM public.research_title_term x WHERE x.judgment_id = j.id
                    UNION
                    SELECT y.term FROM public.citation c2 JOIN public.research_citation_term y ON y.citation_text = c2.citation_text
                     WHERE c2.judgment_id = j.id
                       AND c2.review_status = 'promoted'
                       AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = c2.publication_id AND pub.finished_at IS NOT NULL)
                       AND EXISTS (SELECT 1 FROM public.source_provenance p
                                    WHERE p.id = c2.source_id
                                      AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                                      AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                                      AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
                  ) visible_terms)::integer
            ELSE z.size END AS size
  FROM public.research_citation_term t
  JOIN public.citation c ON c.citation_text = t.citation_text
  JOIN public.judgment j ON j.id = c.judgment_id
  LEFT JOIN public.research_size z ON z.judgment_id = j.id
 WHERE c.review_status = 'promoted'
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = c.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = c.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
   AND j.review_status = 'promoted'
   AND j.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = j.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''));

-- Driven from the pending rows (usually none), with the same rule.
CREATE OR REPLACE VIEW public.v_research_pending WITH (security_barrier = true) AS
SELECT j.id AS judgment_id
  FROM public.research_title_pending pt
  JOIN public.judgment j ON j.id = pt.judgment_id
 WHERE j.review_status = 'promoted'
   AND j.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = j.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
UNION
SELECT j.id
  FROM public.research_citation_pending pc
  JOIN public.citation c ON c.citation_text = pc.citation_text
  JOIN public.judgment j ON j.id = c.judgment_id
 WHERE c.review_status = 'promoted'
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = c.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = c.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
   AND j.review_status = 'promoted'
   AND j.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = j.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''));

-- 5. Grants. The two views for corpus_research_reader only; the index for corpus_writer (who maintains it); nothing
--    else for anyone.
REVOKE ALL ON public.research_title_term, public.research_citation_term, public.research_size,
  public.research_title_pending, public.research_citation_pending,
  public.v_research_term, public.v_research_pending FROM PUBLIC;
REVOKE ALL ON public.research_title_term, public.research_citation_term, public.research_size,
  public.research_title_pending, public.research_citation_pending,
  public.v_research_term, public.v_research_pending
  FROM corpus_writer, corpus_declassify, corpus_reader, corpus_authority_reader, corpus_research_reader;
GRANT SELECT ON public.v_research_term, public.v_research_pending TO corpus_research_reader;
GRANT SELECT, INSERT, DELETE ON public.research_title_term, public.research_citation_term, public.research_size TO corpus_writer;
GRANT SELECT, DELETE ON public.research_title_pending, public.research_citation_pending TO corpus_writer;

-- 6. The inventory of Annex A relations (42) and routines (13). Provisioning keeps every one of them with the superuser
--    and refuses an Annex A view it does not list (F05 plan D20), so re-applying 005 alone after 006 (35) is refused as
--    re-applying 004 alone after 005 is.
CREATE OR REPLACE FUNCTION public.corpus_contract_relations() RETURNS SETOF regclass
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
      'corpus_publication', 'corpus_publication_item', 'corpus_publication_grant',
      'v_authority_citation', 'v_authority_treatment', 'v_authority_section_version', 'v_authority_pending_adverse',
      'v_research_judgment', 'v_research_embedding',
      'research_title_term', 'research_citation_term', 'research_size', 'research_title_pending',
      'research_citation_pending', 'v_research_term', 'v_research_pending'
    ]) AS n
  ) s
  WHERE r IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.corpus_contract_relations() FROM PUBLIC;

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
      ('research_terms_mark_pending()', false)
    ) AS v(signature, public_execute)
  ) x
  WHERE p IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.corpus_contract_routines() FROM PUBLIC;
