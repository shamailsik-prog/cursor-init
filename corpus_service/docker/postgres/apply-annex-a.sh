#!/usr/bin/env bash
# Annex A corpus contract (audit F19) for the corpus service's own database. Idempotent.
#
# Applies postgres/ddl/001_corpus_contract.sql, 003_corpus_publication.sql, 004_authority_read_views.sql
# (audit F05: the reader's promoted-only authority views) and 005_research_reader.sql (audit FA-D5-003 and
# FA-DATA-003: the research reader role and views, and corpus_reader's narrowed grants), in that order and in
# one transaction, as the bootstrap superuser over the container's local socket (peer, map
# container_admin). The superuser therefore owns every Annex A relation and function; neither
# application role can redefine, disable or bypass them (docker/postgres/provision-roles.sh keeps it
# that way). The migration role cannot apply 001 itself: it creates roles (corpus_reader,
# corpus_writer, corpus_declassify) and extensions, and that role is NOCREATEROLE.
#
# Runs in two places, always as the container OS user "postgres":
#   1. fresh volume: the image entrypoint runs it from /docker-entrypoint-initdb.d/ after 10-init.sql
#      and before 20-provision-roles.sh (which refuses to run without it);
#   2. existing volume: scripts/rotate_postgres_password.sh runs it via
#      `docker compose exec -u postgres postgres /docker-entrypoint-initdb.d/15-apply-annex-a.sh`,
#      which brings a volume created before F19 onto Annex A and re-applies the DDL after an upgrade.
# The file list is explicit: 002 is the platform application's database, not the corpus. The order is
# load-bearing (F05 plan D13): 004 re-defines 003's corpus_contract_relations() with its four views and 005
# re-defines it again with its two, so 003 is never applied without 004 and 005 after it (provision-roles.sh
# refuses that state, D20). One transaction also keeps 001's grants to corpus_reader and 005's revoke of two of
# them atomic: no session ever sees the unfiltered grants again.
apply_annex_a() (
  set -euo pipefail
  : "${POSTGRES_USER:?POSTGRES_USER required}"
  ddl=/etc/postgresql/corpus/ddl
  for f in 001_corpus_contract.sql 003_corpus_publication.sql 004_authority_read_views.sql 005_research_reader.sql; do
    [[ -r $ddl/$f ]] || { echo "apply-annex-a: $ddl/$f is not readable (is ../postgres/ddl mounted?)" >&2; exit 1; }
  done
  # A re-run's "already exists, skipping" NOTICEs are expected; warnings and errors still print.
  psql -v ON_ERROR_STOP=1 --no-psqlrc --no-password --quiet --single-transaction \
    --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-legal_scraper}" \
    -c "SET client_min_messages = warning" \
    -f "$ddl/001_corpus_contract.sql" -f "$ddl/003_corpus_publication.sql" -f "$ddl/004_authority_read_views.sql" \
    -f "$ddl/005_research_reader.sql"
  echo "apply-annex-a: Annex A (001, 003, 004, 005) applied to ${POSTGRES_DB:-legal_scraper}"
)

apply_annex_a
