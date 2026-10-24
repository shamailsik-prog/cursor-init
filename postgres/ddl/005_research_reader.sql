-- SIKANDER AI — Annex A research reader and corpus_reader narrowing (audit FA-D5-003, FA-DATA-003). Additive and
-- idempotent; 001-004 are not edited. Applied by a superuser after 004, always in the order 001 -> 003 -> 004 -> 005
-- (apply-annex-a.sh in one transaction, the CI loops, the test harnesses). Every statement can be re-run.
-- Spec: docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md (rulings R2-R5).
--
-- D5 research (WhatsApp /research, answered by the Next core after the in-process Functions authority router) reads the
-- published corpus as a login that is a member of corpus_research_reader, the NOLOGIN role this file creates, and (for
-- CONNECT only, where provisioning requires it) of corpus_clients, and of nothing else; the reader
-- (platform/corpus/pgResearchCorpus.ts) enforces that as an allowlist, as the F05 gate reader does for its own role.
-- corpus_research_reader reads six relations: 005's two views below, 004's v_authority_citation, v_authority_treatment
-- and v_authority_pending_adverse, and corpus_metadata. It is not corpus_authority_reader (the draft gate's role keeps
-- its four views, F05 plan D21) and not 001's corpus_reader.
--
-- A judgment is visible to research exactly when it is visible to the gate (004, plan D1): promoted, a bench, a
-- classification of rank 0 in classification_rank (public only; ranks, not labels; an unknown label fails the join),
-- a finished publication, and complete provenance (corpus_provenance_complete() inlined, as in 004: calling that
-- SECURITY DEFINER function from a view would need EXECUTE for the reader). An embedding is visible when it is a
-- judgment's, its own classification_rank is 0, and its judgment is visible. The views are security_barrier and carry
-- no provenance column and no text. 005 defines no routine.

-- 0. FA-DATA-003: 001 granted corpus_reader the unfiltered v_source_provenance (every source row) and the
--    corpus_embeddings base table (every vector, of every judgment and section, under any classification or review
--    state). Both are withdrawn. corpus_reader keeps the nine promoted-only v_* views and corpus_metadata, so G-0's
--    "corpus_reader can SELECT views and cannot SELECT base tables or INSERT" holds (L18 §10). Re-applying 001 grants
--    them again; 005 follows it in the same transaction and takes them back.
REVOKE ALL ON public.v_source_provenance, public.corpus_embeddings FROM corpus_reader;

-- 1. The research reader role (R2): NOLOGIN, no attribute, a member of nothing, NOINHERIT like 001's and 004's roles.
DO $$ BEGIN CREATE ROLE corpus_research_reader NOLOGIN NOINHERIT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE corpus_research_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO corpus_research_reader;

-- 2. The judgments research may rank: 004's judgment visibility rule, verbatim.
CREATE OR REPLACE VIEW public.v_research_judgment WITH (security_barrier = true) AS
SELECT j.id AS judgment_id, j.case_title, j.bench_type
  FROM public.judgment j
 WHERE j.review_status = 'promoted'
   AND j.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = j.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''));

-- 3. Their vectors: a judgment's embedding recorded at rank 0, of a visible judgment. A vector recorded under a
--    restricted rank stays hidden even after its judgment is declassified, until it is re-embedded (fail closed).
CREATE OR REPLACE VIEW public.v_research_embedding WITH (security_barrier = true) AS
SELECT e.entity_id AS judgment_id, e.model, e.embedding
  FROM public.corpus_embeddings e
  JOIN public.judgment j ON j.id = e.entity_id
 WHERE e.entity_type = 'judgment'
   AND e.classification_rank = 0
   AND j.review_status = 'promoted'
   AND j.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = j.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = j.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = j.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''));

-- 4. Grants (R2): the two views for corpus_research_reader only; SELECT on its six relations, nothing more.
REVOKE ALL ON public.v_research_judgment, public.v_research_embedding FROM PUBLIC;
REVOKE ALL ON public.v_research_judgment, public.v_research_embedding
  FROM corpus_writer, corpus_declassify, corpus_reader, corpus_authority_reader;
REVOKE ALL ON public.v_research_judgment, public.v_research_embedding, public.v_authority_citation,
  public.v_authority_treatment, public.v_authority_pending_adverse, public.corpus_metadata FROM corpus_research_reader;
GRANT SELECT ON public.v_research_judgment, public.v_research_embedding, public.v_authority_citation,
  public.v_authority_treatment, public.v_authority_pending_adverse, public.corpus_metadata TO corpus_research_reader;

-- 5. The inventory of Annex A relations, now with the two research views (35; R4). Provisioning keeps every one of them
--    with the superuser and refuses an Annex A view it does not list (F05 plan D20), so re-applying 004 alone after
--    005 (33) is refused as re-applying 003 alone after 004 is. corpus_contract_routines() is unchanged: 005 adds no
--    routine.
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
      'v_research_judgment', 'v_research_embedding'
    ]) AS n
  ) s
  WHERE r IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.corpus_contract_relations() FROM PUBLIC;
