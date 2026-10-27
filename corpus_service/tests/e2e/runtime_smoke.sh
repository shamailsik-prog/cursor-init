#!/usr/bin/env bash
# Audit F31 end-to-end: the corpus runtime dependency set, proven in a clean environment.
#
# Builds a fresh venv from corpus_service/requirements.txt ONLY (the set corpus_service/Dockerfile
# installs, never requirements-test.txt) and runs tests/e2e/runtime_smoke.py inside it against real
# PostgreSQL 16 with pgvector: the strict import contract, `import scraper.models`, every scraper
# module, `python -m scraper.migrate`, the API as compose starts it (uvicorn scraper.main:app)
# answering /health with db_connected, and the Celery app with its Redis broker and result backend.
# On main it fails: requirements.txt does not declare pgvector, which scraper/models.py imports.
#
# usage: CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://<superuser>:<password>@<host>:<port>/<db> \
#          bash corpus_service/tests/e2e/runtime_smoke.sh
#   PYTHON            interpreter that builds the venv (default python3.12, else python3; the image runs 3.12)
#   F31_RUNTIME_VENV  where to build it: absolute, relative to the caller's directory, or ~/...;
#                     it must not exist yet (default: a new temporary directory, removed afterwards)
# The database URL needs a role that may CREATE DATABASE and CREATE EXTENSION (each run creates and
# drops its own database). CI: .github/workflows/gate-g0.yml, job corpus-runtime.
# Spec: docs/superpowers/specs/2026-10-18-f31-corpus-runtime-dependencies-design.md (R4, R5).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROJECT=$(cd "$HERE/../.." && pwd)
: "${CORPUS_TEST_DATABASE_URL:?set CORPUS_TEST_DATABASE_URL to a superuser postgresql+asyncpg:// URL (PostgreSQL 16 + pgvector)}"
PY=${PYTHON:-$(command -v python3.12 || command -v python3)}

# Absolute form of a user-supplied path, fixed before anything is created: the script cds into
# corpus_service/ before it runs the venv's interpreter, so a relative or "~" path must already
# point where the caller meant (review round, Copilot thread 4305672181). "~" and "~/..." expand to
# $HOME; a relative path is taken from the caller's directory; "~user" is refused.
absolute_path() {
  local p=$1
  case "$p" in
    "~") p=$HOME ;;
    "~/"*) p="$HOME/${p#"~/"}" ;;
    "~"*)
      echo "FAIL  F31_RUNTIME_VENV=$p: ~user paths are not supported; give an absolute or relative path" >&2
      return 1 ;;
  esac
  case "$p" in
    /*) printf '%s\n' "$p" ;;
    *) printf '%s\n' "$PWD/$p" ;;
  esac
}

cleanup=""
if [ -n "${F31_RUNTIME_VENV:-}" ]; then
  if ! venv=$(absolute_path "$F31_RUNTIME_VENV" 2>&1); then
    echo "$venv"
    exit 2
  fi
  if [ -e "$venv" ]; then
    echo "FAIL  $venv already exists: the smoke needs a clean venv"
    exit 2
  fi
else
  cleanup=$(mktemp -d)
  venv="$cleanup/venv"
fi
trap '[ -z "$cleanup" ] || rm -rf "$cleanup"' EXIT

echo "-- F31: clean venv from corpus_service/requirements.txt only ($("$PY" --version 2>&1), $venv)"
"$PY" -m venv "$venv"
"$venv/bin/python" -m pip install --require-hashes --disable-pip-version-check --quiet -r "$PROJECT/requirements.txt"
echo "-- F31: $("$venv/bin/python" -m pip list --disable-pip-version-check --format=freeze | wc -l) distributions installed"

echo "-- F31: runtime smoke inside that venv (cwd corpus_service, as the image's WORKDIR)"
cd "$PROJECT"
"$venv/bin/python" tests/e2e/runtime_smoke.py
