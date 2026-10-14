-- SIKANDER AI — Legal Corpus Interface Contract (Layer 17 Annex A) + Layer 18 §5.1 corrections. Phase 0.
CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS classification_rank (label TEXT PRIMARY KEY, rank SMALLINT NOT NULL UNIQUE);
INSERT INTO classification_rank VALUES ('public',0),('internal',1),('confidential',2),('privileged',3),('privileged-restricted',4) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS source_provenance (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_name TEXT NOT NULL, source_url TEXT, fetched_at TIMESTAMPTZ,
  content_hash TEXT, extraction_method TEXT CHECK (extraction_method IN ('html','pdf','ocr','manual','api','export')), extractor_version TEXT, raw_storage_key TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS court (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), full_name TEXT UNIQUE NOT NULL, abbreviation TEXT, jurisdiction TEXT, city TEXT, level TEXT,
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 1.0, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS judge (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, court_ids UUID[], active_from DATE, active_to DATE,
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 1.0, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS instrument (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), type TEXT CHECK (type IN ('Act','Ordinance','SRO','Notification','Rules','Order')), number TEXT, date DATE, title TEXT, gazette_ref TEXT, text TEXT, jurisdiction TEXT,
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS statute (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, short_name TEXT, year_enacted INT, jurisdiction TEXT, status TEXT DEFAULT 'in_force',
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(name, jurisdiction));
CREATE TABLE IF NOT EXISTS statute_section (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), statute_id UUID REFERENCES statute(id), section_number TEXT NOT NULL, chapter TEXT, current_title TEXT,
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(statute_id, section_number));
CREATE TABLE IF NOT EXISTS statute_section_version (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), section_id UUID REFERENCES statute_section(id), version_no INT NOT NULL, effective_from DATE, effective_to DATE, title TEXT, text TEXT,
  amending_instrument_id UUID REFERENCES instrument(id), version_confidence FLOAT DEFAULT 0.5, source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(section_id, version_no));
CREATE INDEX IF NOT EXISTS ssv_asat ON statute_section_version (section_id, effective_from, effective_to);
CREATE TABLE IF NOT EXISTS judgment (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), case_title TEXT, court_id UUID REFERENCES court(id), bench_size INT, bench_type TEXT CHECK (bench_type IN ('single','division','full','larger')), judge_ids UUID[], decision_date DATE,
  full_text TEXT, headnotes TEXT, summary TEXT, statutes_cited JSONB, citations_cited UUID[], is_landmark BOOLEAN DEFAULT FALSE, citation_count INT DEFAULT 0, classification TEXT DEFAULT 'public',
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS judgment_text_trgm ON judgment USING gin (full_text gin_trgm_ops);
CREATE TABLE IF NOT EXISTS judgment_version (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), judgment_id UUID REFERENCES judgment(id), version INT NOT NULL, text TEXT NOT NULL, is_corrigendum BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(judgment_id, version));
CREATE TABLE IF NOT EXISTS citation (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), judgment_id UUID REFERENCES judgment(id), citation_text TEXT UNIQUE NOT NULL, reporter TEXT, year INT, volume_or_court TEXT, page INT,
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS treatment (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), treating_judgment_id UUID REFERENCES judgment(id), treated_judgment_id UUID REFERENCES judgment(id),
  treatment TEXT CHECK (treatment IN ('followed','applied','distinguished','doubted','overruled','per_incuriam','referred')), passage_anchor TEXT, treating_bench_type TEXT,
  source_id UUID REFERENCES source_provenance(id), confidence FLOAT DEFAULT 0.5, review_status TEXT DEFAULT 'promoted' CHECK (review_status IN ('promoted','quarantined','rejected')), created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS treatment_treated ON treatment (treated_judgment_id);

CREATE TABLE IF NOT EXISTS corpus_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
INSERT INTO corpus_metadata VALUES ('embedding_model','text-embedding-3-small', now()), ('embedding_dim','1536', now()), ('schema_version','L17-AnnexA-1.0', now()) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS corpus_embeddings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), entity_type TEXT NOT NULL CHECK (entity_type IN ('judgment','statute_section_version')), entity_id UUID NOT NULL,
  model TEXT NOT NULL, classification_rank SMALLINT NOT NULL DEFAULT 0, embedding vector(1536) NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (entity_type, entity_id, model));
CREATE INDEX IF NOT EXISTS corpus_embeddings_hnsw ON corpus_embeddings USING hnsw (embedding vector_cosine_ops);

-- Partner declassify audit (FA-DATA-001); downgrades only via declassify().
CREATE TABLE IF NOT EXISTS judgment_classification_declassify_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judgment_id UUID NOT NULL REFERENCES judgment(id),
  from_classification TEXT NOT NULL,
  to_classification TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  declassify_session_user TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT judgment_declassify_reason_nonempty CHECK (btrim(reason) <> '')
);
CREATE INDEX IF NOT EXISTS judgment_declassify_audit_judgment ON judgment_classification_declassify_audit (judgment_id);
COMMENT ON COLUMN judgment_classification_declassify_audit.actor_id IS
  'Application-asserted partner or user identifier; not verified by the database.';

-- Transaction-local downgrade grant (no privileges granted to application roles).
CREATE TABLE IF NOT EXISTS judgment_declassify_grant (
  judgment_id UUID NOT NULL REFERENCES judgment(id) ON DELETE CASCADE,
  xid BIGINT NOT NULL,
  to_classification TEXT NOT NULL,
  PRIMARY KEY (judgment_id, xid)
);
REVOKE ALL ON judgment_declassify_grant FROM PUBLIC;

-- monotonic classification (rank-based, Layer 18 W-2); downgrades only with matching tx grant (FA-DATA-001).
CREATE OR REPLACE FUNCTION enforce_monotonic_classification() RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE old_rank SMALLINT; new_rank SMALLINT;
  grant_ok BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.classification IS DISTINCT FROM OLD.classification THEN
    SELECT rank INTO old_rank FROM public.classification_rank WHERE label = OLD.classification;
    SELECT rank INTO new_rank FROM public.classification_rank WHERE label = NEW.classification;
    IF new_rank IS NULL THEN RAISE EXCEPTION 'Unknown classification %', NEW.classification; END IF;
    IF new_rank < old_rank THEN
      SELECT EXISTS (
        SELECT 1 FROM public.judgment_declassify_grant g
        WHERE g.judgment_id = NEW.id
          AND g.xid = pg_catalog.txid_current()
          AND g.to_classification = NEW.classification
      ) INTO grant_ok;
      IF NOT grant_ok THEN
        RAISE EXCEPTION 'Classification downgrade rejected: call declassify() with a partner reason';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS judgment_monotonic ON judgment; CREATE TRIGGER judgment_monotonic BEFORE UPDATE ON judgment FOR EACH ROW EXECUTE FUNCTION enforce_monotonic_classification();

CREATE OR REPLACE FUNCTION declassify(
  p_judgment_id UUID,
  p_new_classification TEXT,
  p_actor_id TEXT,
  p_reason TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_old TEXT;
  v_old_rank SMALLINT;
  v_new_rank SMALLINT;
  v_audit_id UUID;
  v_xid BIGINT;
  v_session_user TEXT;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'declassify requires a recorded reason';
  END IF;
  IF p_actor_id IS NULL OR btrim(p_actor_id) = '' THEN
    RAISE EXCEPTION 'declassify requires actor_id';
  END IF;
  v_xid := pg_catalog.txid_current();
  SELECT classification INTO v_old FROM public.judgment WHERE id = p_judgment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'judgment not found: %', p_judgment_id;
  END IF;
  SELECT rank INTO v_old_rank FROM public.classification_rank WHERE label = v_old;
  SELECT rank INTO v_new_rank FROM public.classification_rank WHERE label = p_new_classification;
  IF v_new_rank IS NULL THEN
    RAISE EXCEPTION 'Unknown classification %', p_new_classification;
  END IF;
  IF v_new_rank >= v_old_rank THEN
    RAISE EXCEPTION 'declassify applies only to downgrades';
  END IF;
  v_audit_id := pg_catalog.gen_random_uuid();
  SELECT session_user INTO STRICT v_session_user;
  INSERT INTO public.judgment_classification_declassify_audit (
    id, judgment_id, from_classification, to_classification, actor_id, declassify_session_user, reason
  ) VALUES (
    v_audit_id, p_judgment_id, v_old, p_new_classification, btrim(p_actor_id), v_session_user, btrim(p_reason)
  );
  INSERT INTO public.judgment_declassify_grant (judgment_id, xid, to_classification)
  VALUES (p_judgment_id, v_xid, p_new_classification);
  UPDATE public.judgment
    SET classification = p_new_classification, updated_at = pg_catalog.now()
    WHERE id = p_judgment_id;
  DELETE FROM public.judgment_declassify_grant
    WHERE judgment_id = p_judgment_id AND xid = v_xid;
  RETURN v_audit_id;
END;
$$;

REVOKE ALL ON FUNCTION declassify(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
DO $$ BEGIN CREATE ROLE corpus_declassify NOINHERIT LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT EXECUTE ON FUNCTION declassify(UUID, TEXT, TEXT, TEXT) TO corpus_declassify;
GRANT SELECT ON judgment_classification_declassify_audit TO corpus_declassify;
REVOKE INSERT, UPDATE, DELETE ON judgment_classification_declassify_audit FROM corpus_declassify;

-- promoted-only views for the application role
CREATE OR REPLACE VIEW v_judgment AS SELECT * FROM judgment WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_citation AS SELECT * FROM citation WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_treatment AS SELECT * FROM treatment WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_statute AS SELECT * FROM statute WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_statute_section AS SELECT * FROM statute_section WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_statute_section_version AS SELECT * FROM statute_section_version WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_instrument AS SELECT * FROM instrument WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_court AS SELECT * FROM court WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_judge AS SELECT * FROM judge WHERE review_status='promoted';
CREATE OR REPLACE VIEW v_source_provenance AS SELECT * FROM source_provenance;
DO $$ BEGIN CREATE ROLE corpus_reader NOINHERIT LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE corpus_writer NOINHERIT LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON v_judgment, v_citation, v_treatment, v_statute, v_statute_section, v_statute_section_version, v_instrument, v_court, v_judge, v_source_provenance, corpus_metadata, corpus_embeddings TO corpus_reader;
REVOKE ALL ON judgment_classification_declassify_audit FROM corpus_reader;
REVOKE ALL ON judgment_declassify_grant FROM corpus_reader, corpus_declassify;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_writer') THEN
    REVOKE ALL ON public.judgment_declassify_grant FROM app_writer;
    REVOKE ALL ON FUNCTION public.declassify(UUID, TEXT, TEXT, TEXT) FROM app_writer;
  END IF;
END $$;
