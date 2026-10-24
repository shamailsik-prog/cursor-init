#!/usr/bin/env bash
# FA-D3C-002 end to end (spec docs/superpowers/specs/2026-10-24-d3c-corpus-runtime-boundary-design.md, R17):
# the corpus embedding batch against the real p1CorpusEmbedding function in the Functions emulator.
#
# Builds the Functions emulator source from functions/test/harness/fa-d3c-p1-emulator-entry.ts: the real export, with
# a deterministic fake embedding transport and a test OIDC key set (the production bundle keeps both seams inert). It
# generates the test identity (an RSA key pair whose public half the function trusts), writes the function's deployment
# settings (firm, audience, caller), and runs corpus_service/tests/test_fa_d3c_p1_embedding_e2e.py under
# `firebase emulators:exec --only firestore,functions` against real PostgreSQL 16 with pgvector. The test reaches the
# function through a local TLS front, because the corpus fetch boundary (F25) speaks https only.
#
# usage: CORPUS_TEST_DATABASE_URL=postgresql+asyncpg://<superuser>:<password>@<host>:<port>/<db> \
#          bash corpus_service/tests/e2e/p1_embedding_e2e.sh [extra pytest args]
#   PYTHON             interpreter with corpus_service/requirements-test.txt installed (default python3)
#   FA_D3C_PORTS       firestore,functions,hub,logging,websocket,eventarc,tasks emulator ports (the Functions emulator
#                      starts Eventarc and Cloud Tasks too; default 18097,15097,14497,14597,18098,19297,19497)
#   FA_D3C_CORPUS_DIR  the corpus tree under test (default: this repository's corpus_service; the RED run points it at
#                      a copy of origin/main's)
#   FA_D3C_OPENAI_SDK  a directory holding the openai package (pip install --target), put on PYTHONPATH so the RED run
#                      on main's code makes its direct provider call into the test's tripwire
# The database URL needs a role that may CREATE DATABASE (each test creates and drops its own).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
CORPUS=${FA_D3C_CORPUS_DIR:-$REPO/corpus_service}
: "${CORPUS_TEST_DATABASE_URL:?set CORPUS_TEST_DATABASE_URL to a superuser postgresql+asyncpg:// URL (PostgreSQL 16 + pgvector)}"
PY=${PYTHON:-python3}
IFS=, read -r P_FS P_FN P_HUB P_LOG P_WS P_EA P_TQ <<<"${FA_D3C_PORTS:-18097,15097,14497,14597,18098,19297,19497}"
PROJECT=demo-fa-d3c
FIRM=fa-d3c-e2e-firm
CALLER=corpus-embedder@fa-d3c-e2e.iam.gserviceaccount.com

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "-- FA-D3C-002 e2e: test identity (RSA key pair; the function trusts the public half)"
"$PY" - "$WORK" <<'PY'
import base64, json, sys
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

work = Path(sys.argv[1])
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
(work / "key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                 serialization.NoEncryption()))
numbers = key.public_key().public_numbers()
b64 = lambda n: base64.urlsafe_b64encode(n.to_bytes((n.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()
jwk = {"kty": "RSA", "n": b64(numbers.n), "e": b64(numbers.e), "kid": "fa-d3c-e2e-key", "alg": "RS256", "use": "sig"}
(work / "jwks.json").write_text(json.dumps({"keys": [jwk]}))
PY

FRONT_PORT=$("$PY" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
AUDIENCE="https://localhost:$FRONT_PORT/$PROJECT/asia-south1/p1CorpusEmbedding"

echo "-- FA-D3C-002 e2e: Functions source from functions/test/harness/fa-d3c-p1-emulator-entry.ts"
mkdir -p "$WORK/fn/lib"
ln -s "$REPO/functions/node_modules" "$WORK/fn/node_modules"
printf '%s\n' '{"name": "fa-d3c-p1-e2e", "private": true, "main": "lib/index.js", "engines": {"node": "22"}}' >"$WORK/fn/package.json"
"$REPO/functions/node_modules/.bin/esbuild" "$REPO/functions/test/harness/fa-d3c-p1-emulator-entry.ts" \
  --bundle --platform=node --target=node22 --format=cjs --log-level=warning \
  --external:firebase-admin --external:firebase-functions --external:pg-native \
  "--alias:@=$REPO" --outfile="$WORK/fn/lib/index.js"
cat >"$WORK/fn/.env" <<ENV
P1_CORPUS_FIRM_ID=$FIRM
P1_CORPUS_AUDIENCE=$AUDIENCE
P1_CORPUS_CALLERS=$CALLER
FA_D3C_TEST_JWKS_FILE=$WORK/jwks.json
ENV
cat >"$WORK/firebase.json" <<JSON
{
  "functions": { "source": "fn", "runtime": "nodejs22" },
  "firestore": { "rules": "$REPO/firestore.rules" },
  "emulators": {
    "firestore": { "port": $P_FS, "host": "127.0.0.1", "websocketPort": $P_WS },
    "functions": { "port": $P_FN, "host": "127.0.0.1" },
    "hub": { "port": $P_HUB, "host": "127.0.0.1" },
    "logging": { "port": $P_LOG, "host": "127.0.0.1" },
    "eventarc": { "port": $P_EA, "host": "127.0.0.1" },
    "tasks": { "port": $P_TQ, "host": "127.0.0.1" },
    "ui": { "enabled": false }
  }
}
JSON

export FA_D3C_P1_E2E=1 FA_D3C_PROJECT="$PROJECT" FA_D3C_FIRM_ID="$FIRM" FA_D3C_CALLER="$CALLER"
export FA_D3C_AUDIENCE="$AUDIENCE" FA_D3C_FRONT_PORT="$FRONT_PORT" FA_D3C_KEY_DIR="$WORK"
export FA_D3C_FUNCTION_URL="http://127.0.0.1:$P_FN/$PROJECT/asia-south1/p1CorpusEmbedding"
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"
PYPATH=${FA_D3C_OPENAI_SDK:-}
EXTRA=""
if [ "$#" -gt 0 ]; then EXTRA=$(printf '%q ' "$@"); fi

echo "-- FA-D3C-002 e2e: emulators (firestore $P_FS, functions $P_FN), corpus tree $CORPUS"
cd "$REPO"
npx firebase emulators:exec --config "$WORK/firebase.json" --only firestore,functions --project "$PROJECT" \
  "PYTHONPATH=$(printf '%q' "$PYPATH") $(printf '%q' "$PY") -m pytest $(printf '%q' "$CORPUS/tests/test_fa_d3c_p1_embedding_e2e.py") -q -p no:cacheprovider $EXTRA"
