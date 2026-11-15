-- P6 master knowledge (Layer 17 L17.5; Layer 18 §5.4 and §10 G-3).
-- Platform database, not Annex A. apply-annex-a.sh does not apply this file (same exclusion as 002).
-- Idempotent. No login password is created here. Only p6_service may write the master tables.
-- The writer trigger refuses every other current_user, including the table owner, because
-- ownership bypasses GRANT. Learners stay off: this file does not grant them anything.

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
  CONSTRAINT substantive_partner_approval CHECK (
    (status NOT IN ('approved','applied') OR change_class <> 'substantive')
    OR (decided_kind = 'partner' AND decided_role = 'partner')
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
GRANT SELECT, INSERT, UPDATE ON TABLE public.change_proposals TO p6_service;
GRANT SELECT, INSERT ON TABLE public.master_versions TO p6_service;
GRANT SELECT, INSERT, UPDATE ON TABLE public.master_knowledge TO p6_service;

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
