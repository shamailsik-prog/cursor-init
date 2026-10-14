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
SELECT format('REVOKE %I FROM %I', g.rolname, u.rolname)
  FROM pg_auth_members m
  JOIN pg_roles g ON g.oid = m.roleid
  JOIN pg_roles u ON u.oid = m.member
 WHERE u.rolname IN (:'app_user', :'mig_user') AND g.rolname <> 'corpus_clients' \gexec
GRANT corpus_clients TO :"mig_user", :"app_user";

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

-- Application objects belong to the migration role (pre-F30 installs created them as the
-- superuser). Extension members, and sequences owned by a table column, are left alone; ALTER
-- TABLE ... OWNER moves a table's indexes and owned sequences with it.
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

-- Runtime role: DML only, on existing and future objects of the migration role.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"app_user";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM :"app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
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

COMMIT;
SQL
  echo "provision-roles: roles ${MIGRATE_DB_USER} (schema owner) and ${APP_DB_USER} (runtime DML) ready in ${POSTGRES_DB}"
)

provision_corpus_roles
