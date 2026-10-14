-- SIKANDER AI — Annex A authority read views (audit F05, PR 3). Additive and idempotent; 001-003 are not edited.
-- Applied by a superuser after 003. The order is always 001 -> 003 -> 004 (apply-annex-a.sh, the CI loops, the
-- test harnesses; plan D13). Every statement can be re-run.
--
-- The draft gate's corpus reader (functions/src/d4/corpusAuthorityStore.ts, a corpus_reader member) reads only
-- these four views and corpus_metadata. A row is visible (plan D1) only when:
--   * its review_status is 'promoted';
--   * its publication_id names a finished corpus_publication (finished_at IS NOT NULL). A row a superuser wrote
--     outside any publication never shows (spec ruling 2), and neither does one whose publication never finished;
--   * its source_id names a complete source_provenance row. This is corpus_provenance_complete() inlined: calling
--     that SECURITY DEFINER function from a view would need EXECUTE for corpus_reader;
--   * for a judgment, also: its classification ranks 0 in classification_rank (public only, ruling 8; ranks are
--     compared, not labels, and an unknown label fails the join, so it fails closed), and it has a bench.
-- A view shows a row only when the row and every parent it reports are visible: a citation's judgment; a
-- treatment's treating and treated judgments; a version's section and that section's statute. Parent fields
-- (a bench, a jurisdiction) come from the parent row itself.
-- v_authority_pending_adverse (plan D2) lists the treated judgment of every 'overruled' treatment that is not
-- rejected and does not show in v_authority_treatment: quarantined (ruling 3), or hidden by any rule above. A hidden
-- overruling must never pass as good law; only the treated id is exposed.
-- The views are security_barrier, carry no provenance column, and grant SELECT to corpus_reader only.
-- 004 defines no routine (plan D12). It re-defines corpus_contract_relations() with the four views (33 relations),
-- so provisioning (PR 2b) keeps them with the superuser; re-applying 003 alone after 004 would shrink the list to
-- 29, which provisioning refuses (plan D20).

-- 1. The judgments the reader may know of: promoted, published, provenance complete, public, with a bench.
CREATE OR REPLACE VIEW public.v_authority_citation WITH (security_barrier = true) AS
SELECT c.citation_text, c.judgment_id, j.bench_type
  FROM public.citation c
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

-- 2. Treatments between two visible judgments, with the bench the record states and the treating judgment's own.
CREATE OR REPLACE VIEW public.v_authority_treatment WITH (security_barrier = true) AS
SELECT t.treated_judgment_id, t.treatment, t.treating_bench_type, tj.bench_type AS treating_judgment_bench
  FROM public.treatment t
  JOIN public.judgment tj ON tj.id = t.treating_judgment_id
  JOIN public.judgment dj ON dj.id = t.treated_judgment_id
 WHERE t.review_status = 'promoted'
   AND t.treating_bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = t.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = t.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
   AND tj.review_status = 'promoted'
   AND tj.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = tj.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = tj.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = tj.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
   AND dj.review_status = 'promoted'
   AND dj.bench_type IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = dj.classification AND cr.rank = 0)
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = dj.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = dj.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''));

-- 3. An overruling the reader cannot show is pending, never absent (D2). The NOT (...) below is exactly the
--    visibility test of v_authority_treatment, NULL-safe: a NULL status or bench counts as not visible.
CREATE OR REPLACE VIEW public.v_authority_pending_adverse WITH (security_barrier = true) AS
SELECT DISTINCT t.treated_judgment_id
  FROM public.treatment t
 WHERE t.treatment = 'overruled'
   AND t.review_status IS DISTINCT FROM 'rejected'
   AND t.treated_judgment_id IS NOT NULL
   AND NOT (
     coalesce(t.review_status = 'promoted', false)
     AND t.treating_bench_type IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = t.publication_id AND pub.finished_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM public.source_provenance p
                  WHERE p.id = t.source_id
                    AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                    AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                    AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
     AND EXISTS (SELECT 1 FROM public.judgment tj
                  WHERE tj.id = t.treating_judgment_id
                    AND tj.review_status = 'promoted'
                    AND tj.bench_type IS NOT NULL
                    AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = tj.classification AND cr.rank = 0)
                    AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = tj.publication_id AND pub.finished_at IS NOT NULL)
                    AND EXISTS (SELECT 1 FROM public.source_provenance p
                                 WHERE p.id = tj.source_id
                                   AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                                   AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                                   AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> '')))
     AND EXISTS (SELECT 1 FROM public.judgment dj
                  WHERE dj.id = t.treated_judgment_id
                    AND dj.review_status = 'promoted'
                    AND dj.bench_type IS NOT NULL
                    AND EXISTS (SELECT 1 FROM public.classification_rank cr WHERE cr.label = dj.classification AND cr.rank = 0)
                    AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = dj.publication_id AND pub.finished_at IS NOT NULL)
                    AND EXISTS (SELECT 1 FROM public.source_provenance p
                                 WHERE p.id = dj.source_id
                                   AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                                   AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                                   AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> '')))
   );

-- 4. Section versions under a visible section and a visible statute, with the statute's jurisdiction. Confidence is
--    shown as stored: the reader decides what is usable (MIN_VERSION_CONFIDENCE, strictly above 0.5; ruling 4).
CREATE OR REPLACE VIEW public.v_authority_section_version WITH (security_barrier = true) AS
SELECT v.section_id, st.jurisdiction, v.version_no, v.effective_from, v.effective_to, v.text, v.version_confidence
  FROM public.statute_section_version v
  JOIN public.statute_section ss ON ss.id = v.section_id
  JOIN public.statute st ON st.id = ss.statute_id
 WHERE v.review_status = 'promoted'
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = v.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = v.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
   AND ss.review_status = 'promoted'
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = ss.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = ss.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''))
   AND st.review_status = 'promoted'
   AND EXISTS (SELECT 1 FROM public.corpus_publication pub WHERE pub.id = st.publication_id AND pub.finished_at IS NOT NULL)
   AND EXISTS (SELECT 1 FROM public.source_provenance p
                WHERE p.id = st.source_id
                  AND btrim(coalesce(p.source_name, '')) <> '' AND p.fetched_at IS NOT NULL
                  AND btrim(coalesce(p.content_hash, '')) <> '' AND p.extraction_method IS NOT NULL
                  AND (btrim(coalesce(p.source_url, '')) <> '' OR btrim(coalesce(p.raw_storage_key, '')) <> ''));

-- 5. Grants: SELECT for corpus_reader only.
REVOKE ALL ON public.v_authority_citation, public.v_authority_treatment, public.v_authority_pending_adverse,
  public.v_authority_section_version FROM PUBLIC;
REVOKE ALL ON public.v_authority_citation, public.v_authority_treatment, public.v_authority_pending_adverse,
  public.v_authority_section_version FROM corpus_writer, corpus_declassify;
GRANT SELECT ON public.v_authority_citation, public.v_authority_treatment, public.v_authority_pending_adverse,
  public.v_authority_section_version TO corpus_reader;

-- 6. The inventory of Annex A relations (003's D25), now with the four views (D13). Provisioning keeps every one of
--    them with the superuser. corpus_contract_routines() is unchanged: 004 adds no routine (D12).
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
      'v_authority_citation', 'v_authority_treatment', 'v_authority_section_version', 'v_authority_pending_adverse'
    ]) AS n
  ) s
  WHERE r IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.corpus_contract_relations() FROM PUBLIC;
