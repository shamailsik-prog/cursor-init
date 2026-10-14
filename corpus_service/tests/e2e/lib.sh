# Shared helpers for the audit F30 end-to-end scripts (sourced, not executed).
# shellcheck shell=bash

FAILS=0
CHECKS=0

pass() { CHECKS=$((CHECKS + 1)); printf 'PASS  %s\n' "$1"; }
fail() {
  CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1))
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '%s\n' "$2" | head -c 1500 | sed 's/^/      | /'; printf '\n'; fi
}

# expect_ok LABEL CMD...            CMD must exit 0.
expect_ok() {
  local label=$1 out; shift
  if out=$("$@" 2>&1); then pass "$label"; else fail "$label" "$out"; fi
}

# expect_out LABEL REGEX CMD...     CMD must exit 0 and its output must match REGEX.
expect_out() {
  local label=$1 re=$2 out; shift 2
  if out=$("$@" 2>&1) && printf '%s' "$out" | grep -Eq -- "$re"; then pass "$label"; else fail "$label" "$out"; fi
}

# expect_reply LABEL REGEX CMD...   CMD's output must match REGEX, whatever its exit code (redis-cli
# prints server error replies such as NOAUTH/NOPERM; its exit status for them varies by version).
expect_reply() {
  local label=$1 re=$2 out; shift 2
  out=$("$@" 2>&1)
  if printf '%s' "$out" | grep -Eq -- "$re" \
     && { [ -z "${OK_RE:-}" ] || ! printf '%s' "$out" | grep -Eq -- "$OK_RE"; }; then
    pass "$label"
  else
    fail "$label" "expected /$re/${OK_RE:+ and no /$OK_RE/}; got: $out"
  fi
}

# expect_refused LABEL REGEX CMD... CMD must FAIL, for the stated reason: its output must match REGEX
# (so an unrelated error such as a missing network cannot count as a pass). If OK_RE is set, the
# output must also not match it (e.g. a PONG that a client printed before exiting non-zero).
expect_refused() {
  local label=$1 re=$2 out rc; shift 2
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -Eqi -- "$re" \
     && { [ -z "${OK_RE:-}" ] || ! printf '%s' "$out" | grep -Eq -- "$OK_RE"; }; then
    pass "$label"
  else
    fail "$label" "exit=$rc; expected failure matching /$re/; got: $out"
  fi
}

# run_probe LABEL CMD...            CMD runs tests/e2e/probe.py; its PASS/FAIL lines are counted
# individually and the command itself must exit 0.
run_probe() {
  local label=$1 out rc line; shift
  out=$("$@" 2>&1); rc=$?
  local seen=0
  while IFS= read -r line; do
    case "$line" in
      "PASS  "*) seen=1; pass "${label}: ${line#PASS  }" ;;
      "FAIL  "*) seen=1; fail "${label}: ${line#FAIL  }" ;;
    esac
  done <<<"$out"
  if [ "$rc" -ne 0 ] || [ "$seen" -eq 0 ]; then
    fail "${label}: probe exited $rc" "$(printf '%s' "$out" | grep -v '^PASS  ' | tail -n 40)"
  fi
}

summary() {
  printf '\n%s: %d checks, %d failed\n' "$1" "$CHECKS" "$FAILS"
  [ "$FAILS" -eq 0 ]
}

rand_secret() { openssl rand -hex 24; }
fernet_key() { openssl rand 32 | base64 | tr '+/' '-_'; }

# A CA that did not sign the store certificates, for the wrong-CA checks.
make_wrong_ca() {
  local dir=$1
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
    -subj "/CN=f30-e2e-wrong-ca" -keyout "$dir/ca.key" -out "$dir/ca.crt" >/dev/null 2>&1
  chmod 0644 "$dir/ca.crt"
}

# --- re-audit D1: secrets live in .env exactly as the README says, never in the shell ----------
STORE_SECRET_VARS="POSTGRES_PASSWORD MIGRATE_DB_PASSWORD APP_DB_PASSWORD REDIS_APP_PASSWORD"
STORE_CRED_KEYS="POSTGRES_USER POSTGRES_PASSWORD MIGRATE_DB_USER MIGRATE_DB_PASSWORD APP_DB_USER APP_DB_PASSWORD REDIS_APP_USER REDIS_APP_PASSWORD REDISCLI_AUTH PGPASSWORD"

# new_store_secrets: random credentials as plain (non-exported) shell variables.
new_store_secrets() {
  POSTGRES_USER="boot_$(openssl rand -hex 3)" POSTGRES_PASSWORD="$(rand_secret)"
  APP_DB_USER=corpus_app APP_DB_PASSWORD="$(rand_secret)"
  MIGRATE_DB_USER=corpus_migrate MIGRATE_DB_PASSWORD="$(rand_secret)"
  REDIS_APP_USER=corpus_redis REDIS_APP_PASSWORD="$(rand_secret)"
  REDIS_PASSWORD="$(rand_secret)"   # read only by the pre-F30 compose (requirepass)
  ENCRYPTION_KEY="$(fernet_key)" ADMIN_API_KEY="$(rand_secret)" SECRET_KEY="$(rand_secret)"
  # If the caller exported any of these, un-export them: compose must get them from .env only.
  export -n POSTGRES_USER POSTGRES_PASSWORD APP_DB_USER APP_DB_PASSWORD MIGRATE_DB_USER MIGRATE_DB_PASSWORD \
    REDIS_APP_USER REDIS_APP_PASSWORD REDIS_PASSWORD ENCRYPTION_KEY ADMIN_API_KEY SECRET_KEY 2>/dev/null || true
}

# write_dotenv: the operator's .env as README/.env.example describe it (mode 0600). An existing
# .env is set aside and put back by restore_dotenv.
ENV_BACKUP=""
write_dotenv() {
  if [ -e .env ] && [ -z "$ENV_BACKUP" ]; then ENV_BACKUP=$(mktemp); cp -p .env "$ENV_BACKUP"; fi
  ( umask 077
    printf '%s\n' \
      "POSTGRES_USER=$POSTGRES_USER" "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
      "APP_DB_USER=$APP_DB_USER" "APP_DB_PASSWORD=$APP_DB_PASSWORD" \
      "MIGRATE_DB_USER=$MIGRATE_DB_USER" "MIGRATE_DB_PASSWORD=$MIGRATE_DB_PASSWORD" \
      "REDIS_APP_USER=$REDIS_APP_USER" "REDIS_APP_PASSWORD=$REDIS_APP_PASSWORD" \
      "ENCRYPTION_KEY=$ENCRYPTION_KEY" "ADMIN_API_KEY=$ADMIN_API_KEY" "SECRET_KEY=$SECRET_KEY" \
      "OPENAI_API_KEY=" "TLS_CERTS_MODE=auto" \
      "REDIS_PASSWORD=$REDIS_PASSWORD" >.env )
}
restore_dotenv() {
  if [ -n "$ENV_BACKUP" ]; then mv -f "$ENV_BACKUP" .env; else rm -f .env; fi
}

# scope_check LABEL ENV_TEXT KEYS_TOO [SECRET@KEY ...]
# ENV_TEXT is a container's environment (KEY=VALUE lines). Each store password may appear only
# inside the value of the key named for it (e.g. APP_DB_PASSWORD@DATABASE_URL) and nowhere else;
# with KEYS_TOO=1 no store credential variable may be present at all. Reports key names only,
# never values.
scope_check() {
  local label=$1 envtext=$2 keys_too=$3; shift 3
  local problems="" name value allowed spec line k
  if [ -z "$envtext" ]; then fail "$label" "could not read the container environment"; return; fi
  if [ "$keys_too" = 1 ]; then
    for k in $STORE_CRED_KEYS; do
      if printf '%s\n' "$envtext" | grep -q "^$k="; then problems+="has $k; "; fi
    done
  fi
  for name in $STORE_SECRET_VARS; do
    value=${!name}
    allowed=""
    for spec in "$@"; do
      if [ "${spec%@*}" = "$name" ]; then allowed=${spec#*@}; fi
    done
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      if [ -z "$allowed" ] || [ "${line%%=*}" != "$allowed" ]; then problems+="${line%%=*} carries $name; "; fi
    done < <(printf '%s\n' "$envtext" | grep -F -- "$value")
  done
  if [ -z "$problems" ]; then pass "$label"; else fail "$label" "$problems"; fi
}
