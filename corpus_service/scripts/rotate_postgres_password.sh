#!/usr/bin/env bash
# Rotate the Postgres role password on an EXISTING pgdata volume (audit F30 upgrade path).
# The postgres image only applies POSTGRES_USER/POSTGRES_PASSWORD when the volume is empty, so an
# install created with the old legal/legal defaults must rotate in place:
#   POSTGRES_USER=legal POSTGRES_PASSWORD=<new unique secret> REDIS_PASSWORD=<secret> \
#     ./scripts/rotate_postgres_password.sh
# then put the same values in .env (DATABASE_URL uses them) and `docker compose up -d`.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${POSTGRES_USER:?POSTGRES_USER required (existing role, e.g. legal)}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required (new secret)}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD required}"
if [ "${#POSTGRES_PASSWORD}" -lt 16 ] || [ "$POSTGRES_PASSWORD" = "legal" ]; then
  echo "refusing: new password must be >=16 chars and not a default" >&2; exit 1
fi
docker compose up -d --wait postgres
# Local-socket connection inside the container; the new password is passed via stdin variable, not argv.
printf '%s' "$POSTGRES_PASSWORD" | docker compose exec -T postgres sh -c \
  'read -r NEWPW; psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d legal_scraper -v newpw="$NEWPW" -v role="$POSTGRES_USER" <<SQL
ALTER ROLE :"role" WITH PASSWORD :'"'"'newpw'"'"';
SQL'
docker compose down
echo "Rotated password for role $POSTGRES_USER."
