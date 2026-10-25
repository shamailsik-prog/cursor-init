-- SIKANDER AI — Annex A research term index (audit FA-D5-003-R1-001). Additive and idempotent; 001-005 are not
-- edited. Applied after 005 in the same order as the other Annex A DDL. F19 publication refreshes
-- corpus_research_term and corpus_research_term_df on every corpus_publication_finish (whole-corpus document
-- frequencies for D5 keyword search). D5 research reads them as corpus_research_reader together with 005's six
-- relations (eight SELECTable relations in total).
--
-- Spec follow-up to docs/superpowers/specs/2026-10-24-fa-d5-003-research-corpus-reader-design.md residual 2.

-- 1. Published term postings: one row per (visible judgment, distinct search term). Rebuilt wholesale on each
--    finished publication; never incrementally patched.
CREATE TABLE IF NOT EXISTS public.corpus_research_term (
  judgment_id uuid NOT NULL,
  term text NOT NULL,
  CONSTRAINT corpus_research_term_pkey PRIMARY KEY (judgment_id, term)
);
CREATE INDEX IF NOT EXISTS corpus_research_term_term_judgment_idx
  ON public.corpus_research_term (term COLLATE "C", judgment_id);

-- 2. Whole-corpus document frequencies (one row per distinct term in the index). Rebuilt with the postings table.
CREATE TABLE IF NOT EXISTS public.corpus_research_term_df (
  term text NOT NULL,
  doc_freq integer NOT NULL,
  CONSTRAINT corpus_research_term_df_pkey PRIMARY KEY (term),
  CONSTRAINT corpus_research_term_df_doc_freq_positive CHECK (doc_freq > 0)
);

-- 3. Grants: only corpus_writer may write; corpus_research_reader may read with the other research relations.
REVOKE ALL ON public.corpus_research_term, public.corpus_research_term_df FROM PUBLIC;
REVOKE ALL ON public.corpus_research_term, public.corpus_research_term_df
  FROM corpus_writer, corpus_declassify, corpus_reader, corpus_authority_reader, corpus_research_reader;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.corpus_research_term, public.corpus_research_term_df TO corpus_writer;
GRANT SELECT ON public.classification_rank TO corpus_writer;
GRANT SELECT ON public.corpus_research_term, public.corpus_research_term_df TO corpus_research_reader;

CREATE OR REPLACE FUNCTION public.corpus_research_term_clear()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  TRUNCATE public.corpus_research_term, public.corpus_research_term_df;
$$;
REVOKE ALL ON FUNCTION public.corpus_research_term_clear() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.corpus_research_term_clear() TO corpus_writer;

-- 3b. Whole index replace under corpus_writer: truncate postings/df and stamp research_judgment_count on
--     corpus_metadata (writer has no direct DML on metadata; F19 refresh runs inside SET LOCAL ROLE corpus_writer).
CREATE OR REPLACE FUNCTION public.corpus_research_term_apply(
  p_judgment_count integer,
  p_postings jsonb,
  p_df jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public.corpus_research_term_clear();
  INSERT INTO public.corpus_research_term (judgment_id, term)
  SELECT (e->>'judgment_id')::uuid, e->>'term'
    FROM jsonb_array_elements(coalesce(p_postings, '[]'::jsonb)) AS e
   WHERE e->>'judgment_id' IS NOT NULL AND btrim(e->>'term') <> '';
  INSERT INTO public.corpus_research_term_df (term, doc_freq)
  SELECT e->>'term', (e->>'doc_freq')::integer
    FROM jsonb_array_elements(coalesce(p_df, '[]'::jsonb)) AS e
   WHERE btrim(e->>'term') <> '' AND (e->>'doc_freq')::integer > 0;
  INSERT INTO public.corpus_metadata (key, value, updated_at) VALUES
    ('research_judgment_count', p_judgment_count::text, pg_catalog.now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
END;
$$;
REVOKE ALL ON FUNCTION public.corpus_research_term_apply(integer, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.corpus_research_term_apply(integer, jsonb, jsonb) TO corpus_writer;

-- 4. Inventory (37 relations; was 35 after 005).
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
      'corpus_research_term', 'corpus_research_term_df'
    ]) AS n
  ) s
  WHERE r IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.corpus_contract_relations() FROM PUBLIC;
