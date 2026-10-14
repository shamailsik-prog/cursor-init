#!/usr/bin/env bash
# Least-privilege Postgres roles for the corpus service (audit F30). Idempotent.
#
# Runs in two places, always as the container OS user "postgres" over the local socket:
#   1. fresh volume: the image entrypoint runs it from /docker-entrypoint-initdb.d/ after
#      10-init.sql has created the extensions;
#   2. existing volume: scripts/rotate_postgres_password.sh runs it via
#      `docker compose exec -u postgres postgres /docker-entrypoint-initdb.d/20-provision-roles.sh`.
#
# Roles (all NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS):
#   corpus_clients   NOLOGIN group; pg_hba.conf only lets its members in over TCP (TLS + SCRAM).
#   MIGRATE_DB_USER  schema owner: CONNECT, USAGE + CREATE on schema public. Used only by the
#                    one-shot `migrate` compose service (Base.metadata.create_all + seed).
#   APP_DB_USER      runtime role for api/workers/beat: CONNECT, USAGE on public, and
#                    SELECT/INSERT/UPDATE/DELETE on tables (USAGE/SELECT/UPDATE on sequences).
#                    No DDL, no TRUNCATE, no CREATE on the database or schema.
# The bootstrap superuser (POSTGRES_USER) keeps only extensions and catalog ownership; existing
# application tables it owns (pre-F30 installs created them as the superuser) move to
# MIGRATE_DB_USER.
#
# Annex A corpus contract (audit F19, PR 2b). 15-apply-annex-a.sh applies postgres/ddl 001 + 003 as
# the bootstrap superuser before this script runs, which refuses to run without it. Its relations
# (public.corpus_contract_relations()) and routines (public.corpus_contract_routines()) stay owned by
# the superuser: the relations are left out of the ownership move and of the runtime role's DML grants.
# On every run this script resets, on every Annex A relation and the sequences they own, any grant to
# APP_DB_USER, MIGRATE_DB_USER, corpus_clients or PUBLIC (001/003 grant PUBLIC nothing there), and on
# every Annex A routine any grant to those three roles, and to PUBLIC wherever the DDL itself keeps
# EXECUTE from PUBLIC (all but 001's trigger function enforce_monotonic_classification(), which keeps
# PostgreSQL's default and cannot be called directly). The grants the DDL makes to corpus_reader,
# corpus_writer and corpus_declassify are left alone. APP_DB_USER is a member of corpus_writer WITH
# INHERIT FALSE, SET TRUE (D14): it holds none of corpus_writer's rights until scraper.publication
# switches to it (SET LOCAL ROLE) for one audited publication. MIGRATE_DB_USER gets no corpus_* role.
# corpus_writer and corpus_reader get USAGE on schema public (revoked from PUBLIC below), which their
# own grants need; neither can log in. PostgreSQL 16 or later is required
# (pg_auth_members.inherit_option / set_option).
#
# It then checks the result in the same transaction and rolls everything back on any surprise:
# memberships of the two application roles other than corpus_clients and the app's single
# corpus_writer membership (INHERIT FALSE, SET TRUE, no admin); an Annex A relation or routine not
# owned by a superuser; any table or column privilege on an Annex A relation, or any privilege on a
# sequence one owns, that either application role holds directly, through corpus_clients or PUBLIC, or
# through a role it inherits; EXECUTE on an Annex A routine the DDL keeps from PUBLIC, for either
# application role (directly, or through corpus_clients, PUBLIC or an inherited role), corpus_clients
# or PUBLIC. A membership a role can only SET and does not inherit (the app's corpus_writer) grants
# nothing here, so corpus_writer's own EXECUTE on corpus_publication_begin/finish does not trip it.
#
# Passwords come from files (compose secrets: APP_DB_PASSWORD_FILE, MIGRATE_DB_PASSWORD_FILE,
# POSTGRES_PASSWORD_FILE) or, failing that, the variable itself. They reach psql through its
# environment (\getenv), never argv.
provision_corpus_roles() (
  set -euo pipefail
  for v in APP_DB_PASSWORD MIGRATE_DB_PASSWORD POSTGRES_PASSWORD; do
    f="${v}_FILE"
    if [[ -z ${!v:-} && -n ${!f:-} ]]; then
      [[ -r ${!f} ]] || { echo "provision-roles: $f=${!f} is not readable" >&2; exit 1; }
      export "$v=$(<"${!f}")"
    fi
  done
  : "${POSTGRES_USER:?POSTGRES_USER required}"
  : "${APP_DB_USER:?APP_DB_USER required}"
  : "${APP_DB_PASSWORD:?APP_DB_PASSWORD required}"
  : "${MIGRATE_DB_USER:?MIGRATE_DB_USER required}"
  : "${MIGRATE_DB_PASSWORD:?MIGRATE_DB_PASSWORD required}"
  export POSTGRES_DB="${POSTGRES_DB:-legal_scraper}"

  fail() { echo "provision-roles: $*" >&2; exit 1; }
  name_re='^[a-z_][a-z0-9_]{0,62}$'
  for v in APP_DB_USER MIGRATE_DB_USER; do
    n=${!v}
    if ! [[ $n =~ $name_re ]]; then fail "$v must match $name_re"; fi
    if [[ $n == pg_* || $n == postgres || $n == corpus_clients ]]; then fail "$v may not be '$n'"; fi
  done
  if [[ $APP_DB_USER == "$POSTGRES_USER" ]]; then fail "APP_DB_USER must differ from the bootstrap POSTGRES_USER"; fi
  if [[ $MIGRATE_DB_USER == "$POSTGRES_USER" ]]; then fail "MIGRATE_DB_USER must differ from the bootstrap POSTGRES_USER"; fi
  if [[ $APP_DB_USER == "$MIGRATE_DB_USER" ]]; then fail "APP_DB_USER and MIGRATE_DB_USER must differ"; fi
  for v in APP_DB_PASSWORD MIGRATE_DB_PASSWORD; do
    p=${!v}
    if (( ${#p} < 16 )); then fail "$v must be at least 16 characters"; fi
    case "${p,,}" in
      legal|legal_scraper_pass|postgres|password|changeme|change_me|admin|secret) fail "$v is a known default" ;;
    esac
  done
  if [[ $APP_DB_PASSWORD == "$MIGRATE_DB_PASSWORD" ]]; then fail "APP_DB_PASSWORD and MIGRATE_DB_PASSWORD must differ"; fi
  if [[ -n ${POSTGRES_PASSWORD:-} ]] \
     && [[ $APP_DB_PASSWORD == "$POSTGRES_PASSWORD" || $MIGRATE_DB_PASSWORD == "$POSTGRES_PASSWORD" ]]; then
    fail "application role passwords must differ from POSTGRES_PASSWORD"
  fi

  psql -v ON_ERROR_STOP=1 --no-psqlrc --no-password --quiet \
    --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_user APP_DB_USER
\getenv app_pw APP_DB_PASSWORD
\getenv mig_user MIGRATE_DB_USER
\getenv mig_pw MIGRATE_DB_PASSWORD
\getenv db POSTGRES_DB
SET password_encryption = 'scram-sha-256';
SET client_min_messages = warning;
BEGIN;

-- Fail closed before changing anything: PostgreSQL 16 role-membership options, and Annex A applied.
DO $$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::int < 160000
     OR (SELECT count(*) FROM pg_catalog.pg_attribute
          WHERE attrelid = 'pg_catalog.pg_auth_members'::regclass
            AND attname IN ('inherit_option', 'set_option') AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION 'PostgreSQL 16 or later is required (GRANT ... WITH INHERIT FALSE, SET TRUE); this server is %',
      pg_catalog.current_setting('server_version');
  END IF;
  IF pg_catalog.to_regprocedure('public.corpus_contract_relations()') IS NULL
     OR pg_catalog.to_regprocedure('public.corpus_contract_routines()') IS NULL THEN
    RAISE EXCEPTION 'Annex A is not applied: run 15-apply-annex-a.sh first';
  END IF;
END
$$;

SELECT 'CREATE ROLE corpus_clients NOLOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'corpus_clients') \gexec
SELECT format('CREATE ROLE %I', :'mig_user')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'mig_user') \gexec
SELECT format('CREATE ROLE %I', :'app_user')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec

ALTER ROLE corpus_clients WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE :"mig_user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  INHERIT PASSWORD :'mig_pw';
ALTER ROLE :"app_user" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  INHERIT PASSWORD :'app_pw';

-- An existing role may carry other memberships (pg_read_server_files, pg_write_all_data, ...).
-- The runtime role's corpus_writer membership is kept (a re-run must not revoke it) and its options
-- are set again just below.
SELECT format('REVOKE %I FROM %I', g.rolname, u.rolname)
  FROM pg_auth_members m
  JOIN pg_roles g ON g.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
 WHERE u.rolname IN (:'app_user', :'mig_user') AND g.rolname <> 'corpus_clients'
   AND NOT (g.rolname = 'corpus_writer' AND u.rolname = :'app_user') \gexec
GRANT corpus_clients TO :"mig_user", :"app_user";
-- Annex A publishing (D14): SET ROLE corpus_writer only, never its rights by inheritance.
GRANT corpus_writer TO :"app_user" WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

-- Database: only corpus_clients may connect; nobody but the superuser may CREATE (schemas,
-- trusted extensions) or use TEMP.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
REVOKE ALL ON DATABASE :"db" FROM :"app_user", :"mig_user";
GRANT CONNECT ON DATABASE :"db" TO corpus_clients;

-- Schema public: usage for clients, CREATE for the migration role only.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM :"app_user", :"mig_user";
GRANT USAGE ON SCHEMA public TO corpus_clients;
GRANT CREATE ON SCHEMA public TO :"mig_user";
-- The Annex A roles' own grants (003: corpus_writer's DML and publication functions, 001: the
-- reader's v_* views) need the schema too, now that PUBLIC no longer has it.
GRANT USAGE ON SCHEMA public TO corpus_writer, corpus_reader;

-- Application objects belong to the migration role (pre-F30 installs created them as the
-- superuser). Extension members, sequences owned by a table column, and the Annex A relations (owned
-- by the superuser, which applied them) are left alone; ALTER TABLE ... OWNER moves a table's
-- indexes and owned sequences with it.
SELECT set_config('corpus.mig_user', :'mig_user', false) AS mig_user_setting \gset
DO $$
DECLARE
  r record;
  mig text := current_setting('corpus.mig_user');
  mig_oid oid := (SELECT oid FROM pg_roles WHERE rolname = current_setting('corpus.mig_user'));
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND c.relowner <> mig_oid
       AND c.oid NOT IN (SELECT a::oid FROM public.corpus_contract_relations() a)
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       AND NOT (c.relkind = 'S' AND EXISTS (
                SELECT FROM pg_depend d
                 WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                   AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                     WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.rel, mig);
  END LOOP;
  FOR r IN
    SELECT t.oid::regtype AS typ, t.typtype
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND t.typowner <> mig_oid
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.typ, mig);
  END LOOP;
END
$$;

-- Runtime role: DML only, on existing and future objects of the migration role. The REVOKEs also
-- clear any direct grant on an Annex A relation; the GRANT loops cover what GRANT ... ON ALL TABLES /
-- ALL SEQUENCES IN SCHEMA public did, except the Annex A relations and the sequences they own (the
-- runtime role reaches Annex A only as corpus_writer, through a publication). Then every Annex A
-- relation, sequence and routine is reset for the application roles, corpus_clients and PUBLIC.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"app_user";
SELECT set_config('corpus.app_user', :'app_user', false) AS app_user_setting \gset
DO $$
DECLARE
  r record;
  app text := current_setting('corpus.app_user');
  mig text := current_setting('corpus.mig_user');
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND c.oid NOT IN (SELECT a::oid FROM public.corpus_contract_relations() a)
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO %I', r.rel, app);
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
       AND NOT EXISTS (SELECT FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                          AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                          AND d.refobjid IN (SELECT a::oid FROM public.corpus_contract_relations() a))
  LOOP
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE %s TO %I', r.rel, app);
  END LOOP;
  -- Nothing of Annex A is ever granted to the application roles, their group or PUBLIC (re-audit D2:
  -- a grant through corpus_clients or PUBLIC is reset here, not just refused by the check below).
  FOR r IN SELECT a AS rel FROM public.corpus_contract_relations() a LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I, %I, corpus_clients, PUBLIC', r.rel, app, mig);
  END LOOP;
  FOR r IN
    SELECT s.oid::regclass AS seq
      FROM pg_class s
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
                      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
     WHERE s.relkind = 'S' AND d.refobjid IN (SELECT a::oid FROM public.corpus_contract_relations() a)
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I, %I, corpus_clients, PUBLIC', r.seq, app, mig);
  END LOOP;
  -- Re-audit D1: EXECUTE on the Annex A routines. PUBLIC only where the DDL itself keeps it from PUBLIC
  -- (public_execute false); corpus_writer's and corpus_declassify's grants are the DDL's and stay.
  FOR r IN SELECT f.routine, f.public_execute FROM public.corpus_contract_routines() f LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I, %I, corpus_clients', r.routine, app, mig);
    IF NOT r.public_execute THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.routine);
    END IF;
  END LOOP;
END
$$;
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig_user" IN SCHEMA public REVOKE ALL ON TABLES FROM :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig_user" IN SCHEMA public REVOKE ALL ON SEQUENCES FROM :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig_user" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig_user" IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_user";

-- Large objects live outside the tables' grants; the app never uses them, so only the superuser
-- may create them (re-audit D8).
REVOKE EXECUTE ON FUNCTION lo_creat(integer), lo_create(oid), lo_from_bytea(oid, bytea),
  lo_import(text), lo_import(text, oid) FROM PUBLIC;

-- Fail closed (D14, D25, re-audit D1): the result, not just the statements above. Exactly what it
-- covers is listed in the header; any surprise (a membership granted by another grantor, an Annex A
-- relation or routine that changed hands, a privilege reaching an application role some other way)
-- rolls the whole run back. has_*_privilege counts direct grants, PUBLIC and roles a role inherits
-- from; a membership with INHERIT FALSE does not count.
DO $$
DECLARE
  app text := current_setting('corpus.app_user');
  mig text := current_setting('corpus.mig_user');
  problem text;
BEGIN
  SELECT string_agg(format('%s in %s (inherit=%s set=%s admin=%s)', u.rolname, g.rolname,
                           m.inherit_option, m.set_option, m.admin_option), '; ')
    INTO problem
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname IN (app, mig)
     AND NOT (g.rolname = 'corpus_clients' AND NOT m.admin_option)
     AND NOT (g.rolname = 'corpus_writer' AND u.rolname = app
              AND NOT m.inherit_option AND m.set_option AND NOT m.admin_option);
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected role membership: %', problem;
  END IF;
  IF (SELECT count(*) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
       WHERE g.rolname = 'corpus_writer' AND u.rolname = app) <> 1 THEN
    RAISE EXCEPTION 'the runtime role must hold exactly one corpus_writer membership';
  END IF;
  SELECT string_agg(format('%s owned by %s', c.oid::regclass, o.rolname), '; ')
    INTO problem
    FROM public.corpus_contract_relations() a
    JOIN pg_class c ON c.oid = a
    JOIN pg_roles o ON o.oid = c.relowner
   WHERE NOT o.rolsuper;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'an Annex A relation is not owned by a superuser: %', problem;
  END IF;
  -- Owners first: a role that owned an Annex A routine (corpus_contract_relations() or
  -- corpus_contract_routines() included) could redefine it.
  SELECT string_agg(format('%s owned by %s', f.routine, o.rolname), '; ')
    INTO problem
    FROM public.corpus_contract_routines() f
    JOIN pg_proc p ON p.oid = f.routine
    JOIN pg_roles o ON o.oid = p.proowner
   WHERE NOT o.rolsuper;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'an Annex A function is not owned by a superuser: %', problem;
  END IF;
  SELECT string_agg(DISTINCT format('%s on %s', u.n, r.rel), '; ')
    INTO problem
    FROM (SELECT a AS rel FROM public.corpus_contract_relations() a) r
   CROSS JOIN (VALUES (app), (mig), ('corpus_clients'), ('public')) u(n)
   WHERE has_table_privilege(u.n, r.rel, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(u.n, r.rel, 'SELECT,INSERT,UPDATE,REFERENCES');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'an application role, corpus_clients or PUBLIC holds a privilege on an Annex A relation: %', problem;
  END IF;
  SELECT string_agg(DISTINCT format('%s on %s', u.n, s.oid::regclass), '; ')
    INTO problem
    FROM pg_class s
    JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
                    AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
   CROSS JOIN (VALUES (app), (mig), ('corpus_clients'), ('public')) u(n)
   WHERE s.relkind = 'S' AND d.refobjid IN (SELECT a::oid FROM public.corpus_contract_relations() a)
     AND (pg_catalog.pg_get_userbyid(s.relowner) = u.n OR has_sequence_privilege(u.n, s.oid, 'USAGE,SELECT,UPDATE'));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'an application role owns or holds a privilege on an Annex A sequence: %', problem;
  END IF;
  -- Re-audit D1: EXECUTE on an Annex A routine the DDL keeps from PUBLIC. The one routine PUBLIC may
  -- execute by design (001's trigger function) is left out: every role holds it through PUBLIC.
  SELECT string_agg(format('%s may execute %s', u.n, f.routine), '; ')
    INTO problem
    FROM public.corpus_contract_routines() f
   CROSS JOIN (VALUES (app), (mig), ('corpus_clients'), ('public')) u(n)
   WHERE NOT f.public_execute AND has_function_privilege(u.n, f.routine, 'EXECUTE');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'an application role, corpus_clients or PUBLIC may execute an Annex A routine: %', problem;
  END IF;
END
$$;

COMMIT;
SQL
  echo "provision-roles: roles ${MIGRATE_DB_USER} (schema owner) and ${APP_DB_USER} (runtime DML) ready in ${POSTGRES_DB}"
)

provision_corpus_roles
