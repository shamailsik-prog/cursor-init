#!/usr/bin/env bash
# Audit F30 upgrade e2e: a data volume created by the PRE-F30 stack (pgvector:pg16 with the shipped
# legal/legal defaults, plaintext, application tables owned by the superuser) is brought forward by
# scripts/rotate_postgres_password.sh and then served by the shipped compose with TLS, rotated
# credentials and the least-privilege roles -- without losing data.
#
#   corpus_service/tests/e2e/upgrade_e2e.sh [CORPUS_SERVICE_DIR]
#
# Prints PASS/FAIL per check, exits 1 if any failed. Needs docker (compose v2) and openssl.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIR=$(cd "${1:-$HERE/../..}" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
cd "$DIR"

export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-f30upgrade}
NET="${COMPOSE_PROJECT_NAME}_data"
CA_VOL="${COMPOSE_PROJECT_NAME}_tls-ca"
LEGACY="${COMPOSE_PROJECT_NAME}-legacy-postgres"
PG_CLIENT=postgres:16-alpine

# New credentials. The bootstrap role keeps its pre-F30 name, as on a real upgrade.
export POSTGRES_USER=legal POSTGRES_PASSWORD="$(rand_secret)"
export APP_DB_USER=corpus_app APP_DB_PASSWORD="$(rand_secret)"
export MIGRATE_DB_USER=corpus_migrate MIGRATE_DB_PASSWORD="$(rand_secret)"
export REDIS_APP_USER=corpus_redis REDIS_APP_PASSWORD="$(rand_secret)"
export REDIS_PASSWORD="$(rand_secret)"   # only read by the pre-F30 compose
export E2E_ENCRYPTION_KEY="$(fernet_key)" E2E_ADMIN_API_KEY="$(rand_secret)" E2E_SECRET_KEY="$(rand_secret)"
COMPOSE=(docker compose -f docker-compose.yml -f "$HERE/compose.e2e.yml")

CREATED_ENV=0
[ -e .env ] || { : >.env; CREATED_ENV=1; }
NEW_DIRS=()
for d in live blackletter_state; do [ -e "$d" ] || NEW_DIRS+=("$d"); done  # api bind mounts
cleanup() {
  docker rm -f "$LEGACY" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$CA_VOL" >/dev/null 2>&1 || true   # created by the clients if compose lacks it
  docker volume rm "${COMPOSE_PROJECT_NAME}_pgdata" >/dev/null 2>&1 || true
  for d in "${NEW_DIRS[@]}"; do rmdir "$d" 2>/dev/null || true; done
  if [ "$CREATED_ENV" -eq 1 ]; then rm -f .env; fi
}
trap cleanup EXIT

psql_c() { # conninfo sql [extra docker args...]
  local conninfo=$1 sql=$2; shift 2
  docker run --rm --init --network "$NET" -v "$CA_VOL:/ca:ro" "$@" "$PG_CLIENT" timeout 60 psql "$conninfo" -v ON_ERROR_STOP=1 -tAc "$sql"
}
as_superuser_local() {
  "${COMPOSE[@]}" exec -T -u postgres postgres psql -U "$POSTGRES_USER" -d legal_scraper -v ON_ERROR_STOP=1 -tAc "$1"
}

echo "== F30 upgrade e2e against $DIR (project $COMPOSE_PROJECT_NAME)"
docker pull -q "$PG_CLIENT" >/dev/null

# 1. Pre-F30 state, exactly as the old manifest produced it.
docker volume create --label com.docker.compose.project="$COMPOSE_PROJECT_NAME" \
  --label com.docker.compose.volume=pgdata "${COMPOSE_PROJECT_NAME}_pgdata" >/dev/null
docker run -d --name "$LEGACY" -e POSTGRES_USER=legal -e POSTGRES_PASSWORD=legal -e POSTGRES_DB=legal_scraper \
  -v "${COMPOSE_PROJECT_NAME}_pgdata:/var/lib/postgresql/data" -v "$DIR/init.sql:/docker-entrypoint-initdb.d/init.sql:ro" \
  pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 60); do
  # TCP readiness only after the image's init (its temporary server is socket-only).
  docker exec "$LEGACY" pg_isready -h 127.0.0.1 -U legal -d legal_scraper >/dev/null 2>&1 && break
  sleep 1
done
expect_ok "pre-F30 volume: legal/legal superuser creates application tables and data" \
  docker exec "$LEGACY" psql -v ON_ERROR_STOP=1 -U legal -d legal_scraper -c \
  "create table keep(v int); insert into keep values (42);
   create table legacy_items(id serial primary key, v text); insert into legacy_items(v) values ('pre-f30');"
expect_out "pre-F30 volume: plaintext legal/legal login over TCP works (the state F30 removes)" '^1$' \
  docker exec -e PGPASSWORD=legal "$LEGACY" psql "host=127.0.0.1 user=legal dbname=legal_scraper sslmode=disable" -tAc "select 1"
docker stop "$LEGACY" >/dev/null && docker rm "$LEGACY" >/dev/null

# 2. Upgrade in place.
expect_ok "rotate_postgres_password.sh upgrades the existing volume" bash ./scripts/rotate_postgres_password.sh

# 3. Serve it with the shipped compose.
if "${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres; then pass "upgraded volume starts under the shipped compose"; else fail "upgraded volume starts under the shipped compose"; fi
expect_refused "old legal/legal no longer works (plaintext)" 'no encryption' \
  psql_c "host=postgres dbname=legal_scraper user=legal sslmode=disable" "select 1" -e PGPASSWORD=legal
expect_refused "old legal/legal no longer works (TLS): superuser has no network login" 'pg_hba.conf rejects connection' \
  psql_c "host=postgres dbname=legal_scraper user=legal sslmode=verify-full sslrootcert=/ca/ca.crt" "select 1" -e PGPASSWORD=legal
expect_refused "rotated superuser password does not open a network login either" 'pg_hba.conf rejects connection' \
  psql_c "host=postgres dbname=legal_scraper user=legal sslmode=verify-full sslrootcert=/ca/ca.crt" "select 1" -e PGPASSWORD="$POSTGRES_PASSWORD"
expect_out "upgraded server runs ssl=on with the repo pg_hba.conf" '^on\|/etc/postgresql/corpus/pg_hba.conf$' \
  as_superuser_local "select current_setting('ssl') || '|' || current_setting('hba_file')"
expect_out "superuser password re-hashed as SCRAM" '^t$' \
  as_superuser_local "select rolpassword like 'SCRAM-SHA-256\$%' from pg_authid where rolname = 'legal'"
expect_out "data kept: app role reads the pre-F30 table over verify-full TLS" '^42$' \
  psql_c "host=postgres dbname=legal_scraper user=$APP_DB_USER sslmode=verify-full sslrootcert=/ca/ca.crt" \
  "select v from keep" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_out "app role can INSERT into a pre-F30 serial table (sequence grant)" '^post-f30\|true$' \
  psql_c "host=postgres dbname=legal_scraper user=$APP_DB_USER sslmode=verify-full sslrootcert=/ca/ca.crt" \
  "insert into legacy_items(v) values ('post-f30') returning v || '|' || (id > 1)::text" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_refused "app role cannot DROP a pre-F30 table" 'must be owner' \
  psql_c "host=postgres dbname=legal_scraper user=$APP_DB_USER sslmode=verify-full sslrootcert=/ca/ca.crt" \
  "drop table keep" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_out "pre-F30 tables and their sequence now belong to the migration role" '^3$' \
  as_superuser_local "select count(*) from pg_class c where c.relname in ('keep','legacy_items','legacy_items_id_seq') and pg_get_userbyid(c.relowner) = '$MIGRATE_DB_USER'"
expect_ok "re-running the upgrade is idempotent" bash ./scripts/rotate_postgres_password.sh

# 4. The app's own migration and runtime paths on the upgraded volume.
if [ "${E2E_PREBUILT_IMAGE:-0}" = 1 ] && docker image inspect "${E2E_IMAGE:-corpus-f30-e2e:local}" >/dev/null 2>&1; then
  echo "NOTE  using prebuilt image ${E2E_IMAGE:-corpus-f30-e2e:local} (E2E_PREBUILT_IMAGE=1)"
else
  "${COMPOSE[@]}" build -q migrate >/dev/null 2>&1 || "${COMPOSE[@]}" build migrate
fi
expect_ok "migrate service creates the current schema on the upgraded volume" \
  timeout 600 "${COMPOSE[@]}" run --rm -T migrate python -m scraper.migrate
run_probe "runtime role on the upgraded volume" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps api python tests/e2e/probe.py db-runtime

summary "F30 upgrade e2e"
