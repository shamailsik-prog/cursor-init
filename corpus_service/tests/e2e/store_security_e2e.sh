#!/usr/bin/env bash
# Audit F30 end-to-end proof: TLS to both stores, Redis ACLs, least-privilege database roles. Since
# audit F19 (PR 2b) also the Annex A corpus contract that postgres init applies: owned by the bootstrap
# superuser, nothing of it held by the app or migration role, the runtime role publishing only as
# corpus_writer (publish_batch and promotion), and corpus_reader reading the result through v_*.
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
ANNEX_A_PAGE=$((RANDOM % 30000 + 10000))  # the synthetic "2099 SCMR <page>" judgments probe.py publishes
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
  "${COMPOSE[@]}" logs --no-color certs postgres redis 2>&1 | tail -n 80 | redact_stream
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

echo "-- audit F19 (PR 2b): Annex A at init (15-apply-annex-a.sh), provisioned least privilege"
annex_a_checks "Annex A at init"
expect_refused "postgres: app role over TLS cannot INSERT into an Annex A table directly" 'permission denied for table judgment' \
  psql_c "$APP_CONN sslmode=verify-full sslrootcert=/ca/ca.crt" \
  "insert into judgment (case_title) values ('F19 E2E Probe v. Test 2099')" -e PGPASSWORD="$APP_DB_PASSWORD"
for role in corpus_reader corpus_declassify; do
  expect_refused "postgres: app role over TLS cannot SET ROLE $role (not a member)" 'permission denied to set role' \
    psql_c "$APP_CONN sslmode=verify-full sslrootcert=/ca/ca.crt" "set role $role" -e PGPASSWORD="$APP_DB_PASSWORD"
done

echo "-- (c) Redis TLS + ACL"
OK_RE='PONG' expect_refused "redis: plaintext on 6379 fails (even with the pre-F30 requirepass secret)" \
  'connection reset|closed|i/o error|error' redis_c --no-auth-warning -a "$REDIS_PASSWORD" PING
OK_RE='PONG' expect_refused "redis: plaintext on 6379 fails for the app ACL user" \
  'connection reset|closed|i/o error|error' redis_c --no-auth-warning --user "$REDIS_APP_USER" --pass "$REDIS_APP_PASSWORD" PING
expect_reply "redis: TLS without credentials gets NOAUTH" 'NOAUTH' \
  redis_c --tls --cacert /ca/ca.crt PING
OK_RE='PONG' expect_reply "redis: the default user cannot authenticate (disabled)" 'WRONGPASS|invalid username-password|disabled' \
  redis_c --tls --cacert /ca/ca.crt --no-auth-warning --user default --pass "$REDIS_PASSWORD" PING
# Re-audit R2-D1: with `nopass` on the app user any password logs in.
OK_RE='PONG' expect_reply "redis: the app ACL user with a WRONG password is refused (WRONGPASS)" 'WRONGPASS' \
  redis_c --tls --cacert /ca/ca.crt --no-auth-warning --user "$REDIS_APP_USER" --pass "$(rand_secret)" PING
# The running server's own command line: exactly two ACL users (default, the app user) and no nopass.
# Prints user names and counts only (the args also hold the app password).
REDIS_ARGS=$(docker inspect -f '{{range .Args}}{{println .}}{{end}}' "${COMPOSE_PROJECT_NAME}-redis-1" 2>/dev/null)
expect_lines "redis: the running server defines exactly the ACL users default and $REDIS_APP_USER" \
  "$(printf '%s\n' default "$REDIS_APP_USER")" "$(printf '%s\n' "$REDIS_ARGS" | awk 'prev == "--user" {print} {prev = $0}')"
expect_lines "redis: no ACL rule on the running server is nopass" "" "$(printf '%s\n' "$REDIS_ARGS" | grep -ix 'nopass')"
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
  timeout 600 "${COMPOSE[@]}" run --rm -T --no-deps -e E2E_BOOTSTRAP_USER="$POSTGRES_USER" -e E2E_ANNEX_A_PAGE="$ANNEX_A_PAGE" \
  api python tests/e2e/probe.py db-runtime
annex_a_reader_checks "Annex A reader" "$ANNEX_A_PAGE"
annex_a_checks "Annex A after migrate and the probes"

echo "-- audit F19 (PR 2b): re-provisioning is idempotent, re-asserts the Annex A posture, and fails closed"
provision() { # [docker compose exec options...]: 20-provision-roles.sh on the running stack, as rotate runs it
  "${COMPOSE[@]}" exec -T -u postgres "$@" postgres /docker-entrypoint-initdb.d/20-provision-roles.sh
}
writer_membership() {
  as_superuser_local "select coalesce(string_agg('inherit=' || m.inherit_option || ':set=' || m.set_option
      || ':admin=' || m.admin_option, ','), 'none') from pg_auth_members m join pg_roles g on g.oid = m.roleid
      join pg_roles u on u.oid = m.member where g.rolname = 'corpus_writer' and u.rolname = '$APP_DB_USER'"
}
expect_ok "re-running 20-provision-roles.sh on the running stack succeeds" provision
annex_a_checks "after re-provisioning"
# Drift an operator (or an older script) could leave behind; a re-run must put it back.
as_superuser_local "grant corpus_writer to \"$APP_DB_USER\" with inherit true, admin true" >/dev/null 2>&1
as_superuser_local "grant insert, update on public.judgment, public.corpus_publication_grant to \"$APP_DB_USER\"" >/dev/null 2>&1
as_superuser_local "grant select on public.citation to \"$MIGRATE_DB_USER\"" >/dev/null 2>&1
expect_out "drift control: the runtime role's membership was widened (INHERIT TRUE, ADMIN TRUE)" '^inherit=true:set=true:admin=true$' \
  writer_membership
annex_a_grants() {
  as_superuser_local "select has_table_privilege('$APP_DB_USER', 'public.judgment', 'INSERT,UPDATE') || '|'
    || has_table_privilege('$APP_DB_USER', 'public.corpus_publication_grant', 'INSERT,UPDATE') || '|'
    || has_table_privilege('$MIGRATE_DB_USER', 'public.citation', 'SELECT')"
}
expect_out "drift control: direct grants on Annex A to the runtime and migration roles are in place" '^true\|true\|true$' \
  annex_a_grants
expect_ok "re-provisioning after drift succeeds" provision
expect_out "re-provisioning resets the runtime role's membership to INHERIT FALSE, SET TRUE, no admin" \
  '^inherit=false:set=true:admin=false$' writer_membership
expect_out "re-provisioning clears direct grants on Annex A to the runtime and migration roles" '^false\|false\|false$' \
  annex_a_grants
# Fail closed: refusals leave everything as it was (one transaction).
as_superuser_local "create database f19_no_annex_a" >/dev/null
expect_refused "provision-roles refuses a database without Annex A" 'Annex A is not applied: run 15-apply-annex-a.sh first' \
  provision -e POSTGRES_DB=f19_no_annex_a
expect_out "... and changes nothing there (the database still has its default PUBLIC CONNECT)" '^t$' \
  as_superuser_local "select has_database_privilege('public', 'f19_no_annex_a', 'CONNECT')"
as_superuser_local "drop database f19_no_annex_a" >/dev/null
as_superuser_local "alter table public.classification_rank owner to \"$MIGRATE_DB_USER\"" >/dev/null
expect_refused "provision-roles refuses when an Annex A relation has passed to the migration role" \
  'an Annex A relation is not owned by a superuser' provision
as_superuser_local "alter table public.classification_rank owner to \"$POSTGRES_USER\"" >/dev/null
as_superuser_local "alter function public.corpus_contract_relations() owner to \"$MIGRATE_DB_USER\"" >/dev/null
expect_refused "provision-roles refuses when an Annex A function has passed to the migration role" \
  'an Annex A function is not owned by a superuser' provision
as_superuser_local "alter function public.corpus_contract_relations() owner to \"$POSTGRES_USER\"" >/dev/null
expect_ok "after the operator restores ownership, provision-roles succeeds again" provision
annex_a_checks "after the fail-closed cases"
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

echo "-- re-audit R2-D2: what each app container really holds, beyond its configured environment"
# PID 1's own environment (what the main process runs with, including variables its command set
# before exec), every process's command line, the files under /run/secrets, and the mounts.
proc1_env() { timeout 60 "${COMPOSE[@]}" exec -T "$1" cat /proc/1/environ 2>/dev/null | tr '\0' '\n'; }
proc_cmdlines() {
  # shellcheck disable=SC2016
  timeout 60 "${COMPOSE[@]}" exec -T "$1" sh -c 'for f in /proc/[0-9]*/cmdline; do tr "\0" " " <"$f"; echo; done' 2>/dev/null
}
secrets_in() { # file names under /run/secrets in the service's container (running or exited)
  local c="${COMPOSE_PROJECT_NAME}-$1-1"
  docker container inspect "$c" >/dev/null 2>&1 || { echo "<no container $c>"; return; }
  docker cp "$c:/run/secrets" - 2>/dev/null | tar -t 2>/dev/null | sed -n 's|^secrets/\([^/][^/]*\)/*$|\1|p'
}
mounts_of() { # TYPE|VOLUME NAME|DESTINATION|RW, one mount per line
  local c="${COMPOSE_PROJECT_NAME}-$1-1"
  docker container inspect "$c" >/dev/null 2>&1 || { echo "<no container $c>"; return; }
  docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}|{{.RW}}{{println}}{{end}}' "$c"
}
store_mounts_of() { # the store volumes among a container's mounts, and the CA volume when writable
  mounts_of "$1" | awk -F'|' -v p="$COMPOSE_PROJECT_NAME" '/^<no container/ || $2 == p "_pgdata" ||
    $2 == p "_tls-postgres" || $2 == p "_tls-redis" || ($2 == p "_tls-ca" && $4 == "true")'
}
# Positive controls: the same readers see the stores' own secrets and data volume.
expect_lines "R2-D2 control: /run/secrets in the postgres container lists its three password files" \
  "$(printf '%s\n' app_db_password migrate_db_password postgres_password)" "$(secrets_in postgres)"
expect_lines "R2-D2 control: /run/secrets in the redis container lists its password file" "redis_app_password" "$(secrets_in redis)"
expect_out "R2-D2 control: the postgres container mounts the pgdata volume" "[|]${COMPOSE_PROJECT_NAME}_pgdata[|]" mounts_of postgres
if proc1_env api | grep -q '^DATABASE_URL=postgresql'; then
  pass "R2-D2 control: api's PID 1 environment carries its DATABASE_URL"
else # names only: the values hold the runtime credentials
  fail "R2-D2 control: api's PID 1 environment carries its DATABASE_URL" \
    "variables seen: $(proc1_env api | cut -d= -f1 | tr '\n' ' ')"
fi
for svc in api worker-embed celery-beat; do
  scope_check "R2-D2: $svc PID 1 environment holds only its runtime URLs' credentials" \
    "$(proc1_env "$svc")" 1 APP_DB_PASSWORD@DATABASE_URL REDIS_APP_PASSWORD@REDIS_URL
done
for svc in worker-a worker-b; do
  scope_check "R2-D2: $svc PID 1 environment holds no store credential" "$(proc1_env "$svc")" 1
done
for svc in api worker-embed celery-beat worker-a worker-b; do
  no_store_secret "R2-D2: no process command line in $svc carries a store password" "$(proc_cmdlines "$svc")"
done
for svc in api worker-embed celery-beat worker-a worker-b migrate; do
  expect_lines "R2-D2: $svc has no /run/secrets files (no store secret mounted)" "" "$(secrets_in "$svc")"
  expect_lines "R2-D2: $svc mounts no store volume (pgdata, tls-postgres, tls-redis) and the CA volume only read-only" \
    "" "$(store_mounts_of "$svc")"
  no_store_secret "R2-D2: $svc command, entrypoint and healthcheck carry no store password" \
    "$(docker inspect -f '{{json .Path}} {{json .Args}} {{json .Config.Cmd}} {{json .Config.Entrypoint}} {{json .Config.Healthcheck}}' \
       "${COMPOSE_PROJECT_NAME}-${svc}-1" 2>/dev/null)"
done

echo "-- review (dc265e3): no app shares storage with a one-shot that holds store credentials or files"
mount_keys_of() { # volume:NAME or bind:SOURCE, then |RW, one mount per line (a tmpfs has neither)
  local c="${COMPOSE_PROJECT_NAME}-$1-1"
  docker container inspect "$c" >/dev/null 2>&1 || { echo "<no container $c>|"; return; }
  docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}volume:{{.Name}}{{else if eq .Type "bind"}}bind:{{.Source}}{{end}}|{{.RW}}{{println}}{{end}}' "$c" \
    | grep -v '^|'
}
# secrets-preflight holds every store password; certs writes the store TLS volumes.
HELPER_MOUNTS=$(for h in secrets-preflight certs; do mount_keys_of "$h"; done | cut -d'|' -f1 | sort -u)
expect_out "review control: the one-shots' mounts are readable (certs mounts the CA volume, preflight its script)" \
  "volume:${COMPOSE_PROJECT_NAME}_tls-ca" printf '%s\n' "$HELPER_MOUNTS"
expect_out "review control: secrets-preflight's script bind is among them" "^bind:.*/check-secrets\.sh$" printf '%s\n' "$HELPER_MOUNTS"
shared_with_helpers() { # an app's mounts that a one-shot also mounts (a bind counts if either contains the other)
  local key rw h
  while IFS='|' read -r key rw; do
    [ -n "$key" ] || continue
    if [ "$key" = "volume:${COMPOSE_PROJECT_NAME}_tls-ca" ] && [ "$rw" = false ]; then continue; fi
    while IFS= read -r h; do
      if [ "$key" = "$h" ]; then printf '%s\n' "$key"; break; fi
      case "$key" in bind:*) ;; *) continue ;; esac
      case "$h" in bind:*) ;; *) continue ;; esac
      case "${h#bind:}/" in "${key#bind:}"/*) printf '%s\n' "$key"; break ;; esac
      case "${key#bind:}/" in "${h#bind:}"/*) printf '%s\n' "$key"; break ;; esac
    done <<<"$HELPER_MOUNTS"
  done < <(mount_keys_of "$1")
}
for svc in api worker-embed celery-beat worker-a worker-b migrate; do
  expect_lines "review: $svc shares no mount with secrets-preflight or certs (the CA volume read-only excepted)" \
    "" "$(shared_with_helpers "$svc")"
done
for svc in api worker-embed celery-beat; do
  run_probe "D1: $svc container, using only its own env" \
    timeout 300 "${COMPOSE[@]}" exec -T "$svc" python tests/e2e/probe.py env-escalation
done

echo "-- re-audit D3: secrets-preflight refuses weak or reused store passwords"
# Deliberately weak test values, built at runtime so no password-shaped literal sits in source:
# each one breaks exactly one preflight rule.
weak_reused=$APP_DB_PASSWORD                                  # equal to another store password
weak_short=$(head -c 15 /dev/zero | tr '\0' 'w')              # 15 characters, otherwise valid
weak_default="legal_scraper""_pass"                           # on the known-defaults list
weak_unsafe="$(rand_secret)/@:"                               # long and unique, but not URL-safe
expect_refused "secrets-preflight refuses a Redis password reused from the app DB role" 'must differ' \
  env REDIS_APP_PASSWORD="$weak_reused" timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight
expect_refused "secrets-preflight refuses a password shorter than 16 characters" 'at least 16' \
  env MIGRATE_DB_PASSWORD="$weak_short" timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight
expect_refused "secrets-preflight refuses a known default password" 'known default' \
  env POSTGRES_PASSWORD="$weak_default" timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight
expect_refused "secrets-preflight refuses a password that is not URL-safe" 'URL-safe' \
  env APP_DB_PASSWORD="$weak_unsafe" timeout 120 "${COMPOSE[@]}" run --rm -T --no-deps secrets-preflight

if [ "$FAILS" -ne 0 ]; then
  "${COMPOSE[@]}" logs --no-color --tail 40 secrets-preflight migrate api worker-embed postgres redis 2>&1 \
    | grep -v -i -e password -e secret | tail -n 120 | redact_stream
fi

summary "F30 store security e2e"
