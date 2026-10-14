#!/usr/bin/env bash
# Upgrade an EXISTING pgdata volume to the audit F30 posture, and rotate its credentials.
#
# The postgres image applies POSTGRES_USER/POSTGRES_PASSWORD and runs /docker-entrypoint-initdb.d
# only when the volume is empty, so an install created before F30 (legal/legal defaults, plaintext,
# tables owned by the superuser, app connecting as the superuser) must be brought forward in place:
#
#   1. Stop the old stack. Put the new values in corpus_service/.env (see .env.example):
#        POSTGRES_USER=<existing bootstrap role, e.g. legal>  POSTGRES_PASSWORD=<new unique secret>
#        APP_DB_USER / APP_DB_PASSWORD          runtime role (DML only)
#        MIGRATE_DB_USER / MIGRATE_DB_PASSWORD  schema-owner role (migrate service)
#        REDIS_APP_USER / REDIS_APP_PASSWORD    Redis ACL user
#        ENCRYPTION_KEY / ADMIN_API_KEY / SECRET_KEY
#      Use URL-safe secrets (e.g. `openssl rand -hex 24`): they are embedded in DATABASE_URL/REDIS_URL.
#      Values already exported in the shell take precedence over .env, as with compose.
#   2. ./scripts/rotate_postgres_password.sh
#   3. docker compose up -d
#
# What it does: starts postgres through compose, so `secrets-preflight` checks the passwords, the
# `certs` service issues the TLS material, and the server comes up with ssl=on, the repo
# pg_hba.conf (TLS + SCRAM only, no network login for the superuser) and
# password_encryption=scram-sha-256 -- on the old volume too, because all of that is passed as
# server options rather than stored in PGDATA. Then, over the container's local socket as OS user
# postgres (peer auth; no old password needed, nothing on argv):
#   - re-hashes the bootstrap superuser's password as SCRAM from the postgres_password secret file;
#   - runs docker/postgres/provision-roles.sh: creates or updates the app and migration roles,
#     moves existing application tables to the migration role and grants the app role DML only.
set -euo pipefail
cd "$(dirname "$0")/.."

# Read KEY=VALUE lines from .env without evaluating them; the shell environment wins.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*} value=${line#*=}
    case "$key" in
      POSTGRES_USER|POSTGRES_PASSWORD|APP_DB_USER|APP_DB_PASSWORD|MIGRATE_DB_USER|MIGRATE_DB_PASSWORD|REDIS_APP_USER|REDIS_APP_PASSWORD)
        if [ -z "${!key:-}" ]; then export "$key=$value"; fi ;;
    esac
  done < .env
fi
: "${POSTGRES_USER:?POSTGRES_USER required (existing bootstrap role, e.g. legal)}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required (new secret)}"
: "${APP_DB_USER:?APP_DB_USER required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD required}"
: "${MIGRATE_DB_USER:?MIGRATE_DB_USER required}"
: "${MIGRATE_DB_PASSWORD:?MIGRATE_DB_PASSWORD required}"
: "${REDIS_APP_USER:?REDIS_APP_USER required}"
: "${REDIS_APP_PASSWORD:?REDIS_APP_PASSWORD required}"
if [ "${#POSTGRES_PASSWORD}" -lt 16 ] || [ "$POSTGRES_PASSWORD" = "legal" ]; then
  echo "refusing: new password must be >=16 chars and not a default" >&2; exit 1
fi

docker compose up -d --wait postgres
# The new password comes from the container's postgres_password secret file, via psql's backquote.
docker compose exec -T -u postgres postgres \
  psql -v ON_ERROR_STOP=1 --no-psqlrc --quiet -U "$POSTGRES_USER" -d legal_scraper <<'SQL'
\getenv role POSTGRES_USER
\set newpw `cat "$POSTGRES_PASSWORD_FILE"`
SET password_encryption = 'scram-sha-256';
ALTER ROLE :"role" WITH PASSWORD :'newpw';
SQL
docker compose exec -T -u postgres postgres /docker-entrypoint-initdb.d/20-provision-roles.sh
docker compose down
echo "Rotated password for role $POSTGRES_USER; provisioned $MIGRATE_DB_USER and $APP_DB_USER; TLS on."
