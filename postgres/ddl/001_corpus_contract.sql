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

-- monotonic classification (rank-based, Layer 18 W-2)
CREATE OR REPLACE FUNCTION enforce_monotonic_classification() RETURNS TRIGGER AS $$
DECLARE old_rank SMALLINT; new_rank SMALLINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.classification IS DISTINCT FROM OLD.classification THEN
    SELECT rank INTO old_rank FROM classification_rank WHERE label = OLD.classification;
    SELECT rank INTO new_rank FROM classification_rank WHERE label = NEW.classification;
    IF new_rank IS NULL THEN RAISE EXCEPTION 'Unknown classification %', NEW.classification; END IF;
    IF new_rank < old_rank AND current_setting('app.declassify_reason', true) IS NULL THEN
      RAISE EXCEPTION 'Classification downgrade rejected: use declassify() with a partner reason';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS judgment_monotonic ON judgment; CREATE TRIGGER judgment_monotonic BEFORE UPDATE ON judgment FOR EACH ROW EXECUTE FUNCTION enforce_monotonic_classification();

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
