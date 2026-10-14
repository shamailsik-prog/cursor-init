#!/usr/bin/env bash
# Store-credential preflight (audit F30). Run by the one-shot `secrets-preflight` compose service,
# which has no network and receives the four store passwords as files under /run/secrets. Postgres
# and Redis start only if this exits 0.
#
# Enforces what compose's ${VAR:?} cannot: every password is at least 16 characters, URL-safe
# (they are embedded in DATABASE_URL / REDIS_URL and in the Redis ACL rule), not a known default,
# and all four differ; the usernames are valid, the three database roles differ, and the Redis
# user is not `default`. Never prints a secret.
set -euo pipefail

fail=0
bad() { echo "secrets-preflight: $*" >&2; fail=1; }

name_re='^[a-z_][a-z0-9_]{0,62}$'
for v in POSTGRES_USER APP_DB_USER MIGRATE_DB_USER REDIS_APP_USER; do
  n=${!v:-}
  if [[ -z $n ]]; then bad "$v is not set"; continue; fi
  [[ $n =~ $name_re ]] || bad "$v must match $name_re"
done
[[ ${APP_DB_USER:-} != "${POSTGRES_USER:-}" ]] || bad "APP_DB_USER must differ from POSTGRES_USER"
[[ ${MIGRATE_DB_USER:-} != "${POSTGRES_USER:-}" ]] || bad "MIGRATE_DB_USER must differ from POSTGRES_USER"
[[ ${APP_DB_USER:-} != "${MIGRATE_DB_USER:-}" ]] || bad "APP_DB_USER and MIGRATE_DB_USER must differ"
[[ ${REDIS_APP_USER:-} != default ]] || bad "REDIS_APP_USER may not be the disabled 'default' user"

declare -A pw=()
for s in postgres_password app_db_password migrate_db_password redis_app_password; do
  f=/run/secrets/$s
  if [[ ! -r $f ]]; then bad "secret $s is missing"; continue; fi
  p=$(<"$f")
  pw[$s]=$p
  (( ${#p} >= 16 )) || bad "$s must be at least 16 characters"
  [[ $p =~ ^[A-Za-z0-9._~-]+$ ]] || bad "$s must be URL-safe ([A-Za-z0-9._~-]; e.g. openssl rand -hex 24)"
  case "${p,,}" in
    legal|legal_scraper_pass|postgres|password|changeme|change_me|admin|secret|redis) bad "$s is a known default" ;;
  esac
done
names=("${!pw[@]}")
for ((i = 0; i < ${#names[@]}; i++)); do
  for ((j = i + 1; j < ${#names[@]}; j++)); do
    a=${names[i]} b=${names[j]}
    [[ ${pw[$a]} != "${pw[$b]}" ]] || bad "$a and $b must differ"
  done
done

if (( fail )); then
  echo "secrets-preflight: refusing to start the data stores" >&2
  exit 1
fi
echo "secrets-preflight: store credentials ok (4 distinct passwords, 4 valid users)"
