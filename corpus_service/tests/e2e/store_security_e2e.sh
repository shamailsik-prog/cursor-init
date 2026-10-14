#!/usr/bin/env bash
# Audit F30 end-to-end proof: TLS to both stores, Redis ACLs, least-privilege database roles.
#
#   corpus_service/tests/e2e/store_security_e2e.sh [CORPUS_SERVICE_DIR]
#
# Brings up the shipped docker-compose.yml (secrets-preflight, certs, postgres, redis, then the
# app's own migrate / api / worker-embed / celery-beat / worker-a / worker-b services) with random
# secrets written to .env exactly as the README tells operators (never exported to compose), and
# asserts every clause from the outside, including which credentials each container ends up with:
# real clients (psql, redis-cli) and the app's own code path (tests/e2e/probe.py through
# scraper.config, scraper.database, scraper.tasks.celery_app). Each check prints PASS/FAIL with
# the reason it observed; the script exits 1 if any check failed. CORPUS_SERVICE_DIR defaults to
# the directory this script belongs to, so the same assertions can be run against another
# checkout (e.g. main before the fix). Needs docker (compose v2) and openssl. Cleans up after itself.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DIR=$(cd "${1:-$HERE/../..}" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
cd "$DIR"

export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-f30e2e}
COMPOSE=(docker compose -f docker-compose.yml -f "$HERE/compose.e2e.yml")
NET="${COMPOSE_PROJECT_NAME}_data"
CA_VOL="${COMPOSE_PROJECT_NAME}_tls-ca"
PG_CLIENT=postgres:16-alpine
REDIS_CLIENT=redis:7-alpine

# Secrets go into .env exactly as README/.env.example tell operators (re-audit D1); they are plain
# shell variables here, never exported, so compose can only get them from .env.
new_store_secrets
WRONG_CA=$(mktemp -d)
chmod 0755 "$WRONG_CA"
make_wrong_ca "$WRONG_CA"
NEW_DIRS=()
for d in live blackletter_state; do [ -e "$d" ] || NEW_DIRS+=("$d"); done  # api bind mounts

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  # created by the client containers when the compose under test lacks them
  docker volume rm "$CA_VOL" "${COMPOSE_PROJECT_NAME}_tls-postgres" "${COMPOSE_PROJECT_NAME}_tls-redis" >/dev/null 2>&1 || true
  rm -rf "$WRONG_CA"
  for d in "${NEW_DIRS[@]}"; do rmdir "$d" 2>/dev/null || true; done
  restore_dotenv
}
trap cleanup EXIT
write_dotenv

psql_c() { # conninfo sql [extra docker args...]: a psql client on the data network
  local conninfo=$1 sql=$2; shift 2
  docker run --rm --init --network "$NET" -v "$CA_VOL:/ca:ro" -v "$WRONG_CA:/wrongca:ro" "$@" \
    "$PG_CLIENT" timeout 60 psql "$conninfo" -v ON_ERROR_STOP=1 -tAc "$sql"
}
redis_c() { # redis-cli on the data network; args are redis-cli args
  docker run --rm --init --network "$NET" -v "$CA_VOL:/ca:ro" -v "$WRONG_CA:/wrongca:ro" \
    -e REDISCLI_AUTH "$REDIS_CLIENT" timeout 20 redis-cli -h redis -p 6379 "$@"
}
as_superuser_local() { # psql over the container's own socket (peer), the only superuser path
  "${COMPOSE[@]}" exec -T -u postgres postgres psql -U "$POSTGRES_USER" -d legal_scraper -v ON_ERROR_STOP=1 -tAc "$1"
}

echo "== F30 e2e against $DIR (project $COMPOSE_PROJECT_NAME)"
docker pull -q "$PG_CLIENT" >/dev/null && docker pull -q "$REDIS_CLIENT" >/dev/null
if ! "${COMPOSE[@]}" up -d --wait --wait-timeout 180 postgres redis; then
  "${COMPOSE[@]}" logs --no-color certs postgres redis | tail -n 80
  fail "stores start (certs -> postgres, redis healthy)"
  summary "F30 store security e2e"; exit 1
fi
pass "stores start (certs -> postgres, redis healthy)"
PG_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "${COMPOSE_PROJECT_NAME}-postgres-1")

echo "-- exposure"
if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then fail "postgres not reachable on host :5432"; else pass "postgres not reachable on host :5432"; fi
if (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null; then fail "redis not reachable on host :6379"; else pass "redis not reachable on host :6379"; fi
if "${COMPOSE[@]}" ps --format json | grep -q '"PublishedPort":[1-9]'; then fail "no published store ports"; else pass "no published store ports"; fi
if docker run --rm --init --network "$NET" "$PG_CLIENT" wget -q -T 5 -O- http://1.1.1.1 >/dev/null 2>&1; then
  fail "data network is internal (no egress)"
else
  pass "data network is internal (no egress)"
fi

echo "-- certificates (certs service)"
ossl() { docker run --rm --network none "$@"; }
CA_FP=$(ossl -v "$CA_VOL:/ca:ro" --entrypoint openssl pgvector/pgvector:pg16 x509 -in /ca/ca.crt -noout -fingerprint -sha256 2>&1)
KEYS=$(ossl -v "${COMPOSE_PROJECT_NAME}_tls-postgres:/p:ro" -v "${COMPOSE_PROJECT_NAME}_tls-redis:/r:ro" \
  --entrypoint stat pgvector/pgvector:pg16 -c '%u:%a' /p/server.key /r/server.key 2>&1 | tr '\n' ' ')
if [ "$KEYS" = "999:600 999:600 " ]; then
  pass "postgres and redis server keys are 0600 and owned by the store user (uid 999)"
else
  fail "postgres and redis server keys are 0600 and owned by the store user (uid 999)" "$KEYS"
fi
if timeout 120 "${COMPOSE[@]}" run --rm -T certs >/dev/null 2>&1 \
   && [ "$(ossl -v "$CA_VOL:/ca:ro" --entrypoint openssl pgvector/pgvector:pg16 x509 -in /ca/ca.crt -noout -fingerprint -sha256 2>&1)" = "$CA_FP" ] \
   && printf '%s' "$CA_FP" | grep -q 'Fingerprint='; then
  pass "certs service is idempotent (re-run keeps the existing CA)"
else
  fail "certs service is idempotent (re-run keeps the existing CA)" "$CA_FP"
fi
expect_refused "certs service in TLS_CERTS_MODE=external refuses missing material instead of generating" 'refusing' \
  ossl -e TLS_CERTS_MODE=external --tmpfs /tls --tmpfs /var/lib/postgresql/data \
  -v "$DIR/docker/certs/generate-certs.sh:/generate-certs.sh:ro" --entrypoint /bin/sh pgvector/pgvector:pg16 /generate-certs.sh

echo "-- (a)/(b) Postgres TLS"
APP_CONN="host=postgres port=5432 dbname=legal_scraper user=$APP_DB_USER"
expect_out "postgres: app role over TLS sslmode=verify-full against the generated CA succeeds, session encrypted" '^t$' \
  psql_c "$APP_CONN sslmode=verify-full sslrootcert=/ca/ca.crt" \
  "select ssl from pg_stat_ssl where pid = pg_backend_pid()" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_refused "postgres: plaintext TCP refused for the app role (correct password)" 'no encryption' \
  psql_c "$APP_CONN sslmode=disable" "select 1" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_refused "postgres: plaintext TCP refused for the bootstrap superuser (correct password)" 'no encryption' \
  psql_c "host=postgres dbname=legal_scraper user=$POSTGRES_USER sslmode=disable" "select 1" -e PGPASSWORD="$POSTGRES_PASSWORD"
expect_refused "postgres: bootstrap superuser cannot log in over the network even with TLS + correct password" \
  'pg_hba.conf rejects connection' \
  psql_c "host=postgres dbname=legal_scraper user=$POSTGRES_USER sslmode=verify-full sslrootcert=/ca/ca.crt" "select 1" \
  -e PGPASSWORD="$POSTGRES_PASSWORD"
expect_refused "postgres: old default legal/legal refused" 'pg_hba.conf rejects|password authentication failed|no encryption' \
  psql_c "host=postgres dbname=legal_scraper user=legal sslmode=prefer" "select 1" -e PGPASSWORD=legal
expect_refused "postgres: wrong app password refused" 'password authentication failed' \
  psql_c "$APP_CONN sslmode=verify-full sslrootcert=/ca/ca.crt" "select 1" -e PGPASSWORD=wrong-password-000000
expect_refused "postgres: verify-full against a CA that did not sign the server cert fails" 'certificate verify failed' \
  psql_c "$APP_CONN sslmode=verify-full sslrootcert=/wrongca/ca.crt" "select 1" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_refused "postgres: verify-full against a wrong hostname fails" 'does not match host name' \
  psql_c "host=wrong-name hostaddr=$PG_IP port=5432 dbname=legal_scraper user=$APP_DB_USER sslmode=verify-full sslrootcert=/ca/ca.crt" \
  "select 1" -e PGPASSWORD="$APP_DB_PASSWORD"
expect_out "postgres: server runs ssl=on, scram-sha-256, the repo pg_hba.conf" '^on\|scram-sha-256\|/etc/postgresql/corpus/pg_hba.conf$' \
  as_superuser_local "select current_setting('ssl') || '|' || current_setting('password_encryption') || '|' || current_setting('hba_file')"
expect_out "postgres: bootstrap, migration and app passwords are stored as SCRAM" '^3$' \
  as_superuser_local "select count(*) from pg_authid where rolname in ('$POSTGRES_USER','$APP_DB_USER','$MIGRATE_DB_USER') and rolpassword like 'SCRAM-SHA-256\$%'"
expect_out "postgres: app and migration roles exist, differ from the bootstrap user, and hold no superuser/createrole/createdb/replication/bypassrls" '^2$' \
  as_superuser_local "select count(*) from pg_roles where rolname in ('$APP_DB_USER','$MIGRATE_DB_USER') and rolname <> '$POSTGRES_USER' and rolcanlogin and not (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls)"

echo "-- (c) Redis TLS + ACL"
OK_RE='PONG' expect_refused "redis: plaintext on 6379 fails (even with the pre-F30 requirepass secret)" \
  'connection reset|closed|i/o error|error' redis_c --no-auth-warning -a "$REDIS_PASSWORD" PING
OK_RE='PONG' expect_refused "redis: plaintext on 6379 fails for the app ACL user" \
  'connection reset|closed|i/o error|error' redis_c --no-auth-warning --user "$REDIS_APP_USER" --pass "$REDIS_APP_PASSWORD" PING
expect_reply "redis: TLS without credentials gets NOAUTH" 'NOAUTH' \
  redis_c --tls --cacert /ca/ca.crt PING
OK_RE='PONG' expect_reply "redis: the default user cannot authenticate (disabled)" 'WRONGPASS|invalid username-password|disabled' \
  redis_c --tls --cacert /ca/ca.crt --no-auth-warning --user default --pass "$REDIS_PASSWORD" PING
SETGET=$(REDISCLI_AUTH="$REDIS_APP_PASSWORD" redis_c --tls --cacert /ca/ca.crt --user "$REDIS_APP_USER" SET f30:e2e ok-over-tls 2>&1; \
         REDISCLI_AUTH="$REDIS_APP_PASSWORD" redis_c --tls --cacert /ca/ca.crt --user "$REDIS_APP_USER" GET f30:e2e 2>&1)
if printf '%s' "$SETGET" | tr '\n' ' ' | grep -Eq '^OK ok-over-tls'; then pass "redis: app ACL user over TLS can SET/GET"; else fail "redis: app ACL user over TLS can SET/GET" "$SETGET"; fi
set -f # the commands below contain '*': word-split them, never glob them
for cmd in "CONFIG GET *" "FLUSHALL" "ACL LIST" "ACL SETUSER f30probe on >x +@all" "KEYS *" \
           "SCRIPT FLUSH" "FUNCTION FLUSH" "SELECT 1"; do
  # shellcheck disable=SC2086
  REDISCLI_AUTH="$REDIS_APP_PASSWORD" expect_reply "redis: app ACL user is refused '$cmd' (NOPERM)" 'NOPERM' \
    redis_c --tls --cacert /ca/ca.crt --user "$REDIS_APP_USER" $cmd
done
set +f
expect_refused "redis: TLS against a CA that did not sign the server cert fails" 'certificate verify failed|SSL|TLS' \
  redis_c --tls --cacert /wrongca/ca.crt --user "$REDIS_APP_USER" --pass "$REDIS_APP_PASSWORD" --no-auth-warning PING

echo "-- (d) app code path: migration role, runtime role, Celery"
if [ "${E2E_PREBUILT_IMAGE:-0}" = 1 ] && docker image inspect "${E2E_IMAGE:-corpus-f30-e2e:local}" >/dev/null 2>&1; then
  # For hosts whose build sandbox cannot reach PyPI directly; CI always builds.
  echo "NOTE  using prebuilt image ${E2E_IMAGE:-corpus-f30-e2e:local} (E2E_PREBUILT_IMAGE=1)"
elif "${COMPOSE[@]}" build -q migrate >/dev/null 2>&1 || "${COMPOSE[@]}" build migrate; then
  pass "e2e app image builds (tests/e2e/Dockerfile)"
else
  fail "e2e app image builds (tests/e2e/Dockerfile)"
fi
expect_ok "migrate service: python -m scraper.migrate (create_all + seed) succeeds as MIGRATE_DB_USER over verify-full TLS" \
  timeout 600 "${COMPOSE[@]}" run --rm -T migrate python -m scraper.migrate
expect_out "postgres: application tables are owned by the migration role, none by the app role" '^t$' \
  as_superuser_local "select count(*) filter (where tableowner = '$MIGRATE_DB_USER') >= 9 and count(*) filter (where tableowner = '$APP_DB_USER') = 0 from pg_tables where schemaname = 'public'"
run_probe "migration role (migrate service env)" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps migrate python tests/e2e/probe.py db-migrate
run_probe "runtime role (api service env)" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps -e E2E_BOOTSTRAP_USER="$POSTGRES_USER" api python tests/e2e/probe.py db-runtime
WRONG_CA_URL="postgresql+asyncpg://$APP_DB_USER:$APP_DB_PASSWORD@postgres:5432/legal_scraper?sslmode=verify-full&sslrootcert=/wrongca/ca.crt"
run_probe "app engine, wrong CA" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps -v "$WRONG_CA:/wrongca:ro" -e DATABASE_URL="$WRONG_CA_URL" \
  api python tests/e2e/probe.py db-must-fail 'certificate verify failed'
WRONG_HOST_URL="postgresql+asyncpg://$APP_DB_USER:$APP_DB_PASSWORD@$PG_IP:5432/legal_scraper?sslmode=verify-full&sslrootcert=/run/tls-ca/ca.crt"
run_probe "app engine, wrong hostname" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps -e DATABASE_URL="$WRONG_HOST_URL" \
  api python tests/e2e/probe.py db-must-fail 'mismatch|not valid for'
REDIS_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "${COMPOSE_PROJECT_NAME}-redis-1")
run_probe "app redis client, wrong CA" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps -v "$WRONG_CA:/wrongca:ro" -e REDIS_TLS_CA_FILE=/wrongca/ca.crt \
  api python tests/e2e/probe.py redis-must-fail 'certificate verify failed'
run_probe "app redis client, wrong hostname" \
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps \
  -e REDIS_URL="rediss://$REDIS_APP_USER:$REDIS_APP_PASSWORD@$REDIS_IP:6379/0" \
  api python tests/e2e/probe.py redis-must-fail 'mismatch|not valid for'
APP_SERVICES="api worker-embed celery-beat worker-a worker-b"
# shellcheck disable=SC2086
if "${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 180 $APP_SERVICES; then
  pass "app services start (after migrate completes): $APP_SERVICES"
else
  fail "app services start (after migrate completes): $APP_SERVICES" \
    "$("${COMPOSE[@]}" logs --no-color migrate $APP_SERVICES 2>&1 | grep -v -i -e password -e secret | tail -n 60)"
fi
run_probe "running api container" timeout 300 "${COMPOSE[@]}" exec -T api python tests/e2e/probe.py api-health
run_probe "celery" timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps api python tests/e2e/probe.py celery

echo "-- re-audit D1: each container holds only the credentials it uses (all secrets in .env, as documented)"
exec_env() { timeout 60 "${COMPOSE[@]}" exec -T "$1" env 2>/dev/null; }
inspect_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${COMPOSE_PROJECT_NAME}-$1-1" 2>/dev/null; }
for svc in api worker-embed celery-beat; do
  scope_check "D1: $svc env holds only its runtime URLs' credentials (no POSTGRES_*/MIGRATE_*; APP/REDIS passwords only inside DATABASE_URL/REDIS_URL)" \
    "$(exec_env "$svc")" 1 APP_DB_PASSWORD@DATABASE_URL REDIS_APP_PASSWORD@REDIS_URL
done
for svc in worker-a worker-b; do
  scope_check "D1: $svc (idle seat) env holds no store credential at all" "$(exec_env "$svc")" 1
done
scope_check "D1: migrate env holds only the migration role, inside DATABASE_URL (no Redis, app or superuser credential)" \
  "$(inspect_env migrate)" 1 MIGRATE_DB_PASSWORD@DATABASE_URL
scope_check "D5: postgres container env holds no password value (POSTGRES/APP/MIGRATE passwords arrive as /run/secrets files)" \
  "$(inspect_env postgres)" 0
scope_check "D5: redis container env holds no password value (healthcheck reads the secret file)" "$(inspect_env redis)" 0
expect_ok "D1: the app image carries no .env (/app/.env absent in the api container)" \
  timeout 60 "${COMPOSE[@]}" exec -T api test ! -e /app/.env
for svc in api worker-embed celery-beat; do
  run_probe "D1: $svc container, using only its own env" \
    timeout 300 "${COMPOSE[@]}" exec -T "$svc" python tests/e2e/probe.py env-escalation
done

echo "-- re-audit D3: secrets-preflight refuses weak or reused store passwords"
expect_refused "secrets-preflight refuses a Redis password reused from the app DB role" 'must differ' \
  env REDIS_APP_PASSWORD="$APP_DB_PASSWORD" timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight
expect_refused "secrets-preflight refuses a password shorter than 16 characters" 'at least 16' \
  env MIGRATE_DB_PASSWORD=short-pw-15char timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight
expect_refused "secrets-preflight refuses a known default password" 'known default' \
  env POSTGRES_PASSWORD=legal_scraper_pass timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight
expect_refused "secrets-preflight refuses a password that is not URL-safe" 'URL-safe' \
  env APP_DB_PASSWORD='not/url@safe:password-0123' timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight

if [ "$FAILS" -ne 0 ]; then
  "${COMPOSE[@]}" logs --no-color --tail 40 secrets-preflight migrate api worker-embed postgres redis 2>&1 \
    | grep -v -i -e password -e secret | tail -n 120
fi

summary "F30 store security e2e"
