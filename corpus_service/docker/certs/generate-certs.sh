#!/bin/sh
# One-shot TLS bootstrap for the corpus data stores (audit F30). Run by the `certs` compose service
# before Postgres and Redis start.
#
# Layout (one named volume per consumer, so no container sees a key it does not need):
#   $TLS_CA_DIR/ca.crt                         private CA certificate (public; mounted read-only by every client)
#   $TLS_POSTGRES_DIR/server.{crt,key}         Postgres server cert (SAN DNS:postgres), key 0600 uid 999
#   $TLS_REDIS_DIR/server.{crt,key}            Redis server cert (SAN DNS:redis), key 0600 uid 999
#
# Idempotent: existing material is kept when it chains to ca.crt, names the right host, matches its
# key and is valid for at least TLS_RENEW_BEFORE_SECONDS more. Otherwise (TLS_CERTS_MODE=auto) a new
# CA and both server certs are issued together. The CA private key is never written to a volume:
# it exists only in a temporary directory inside this one-shot container while signing and is then
# deleted, so nobody can mint further certificates for this CA.
#
# Operator-supplied certificates: put your files at the same paths (e.g. bind the three volumes to
# host directories, see corpus_service/README.md) and set TLS_CERTS_MODE=external. The service then
# only validates them and fixes key ownership/permissions; it never generates or overwrites anything
# and fails if the material is invalid.
set -eu
umask 077

CA_DIR=${TLS_CA_DIR:-/tls/ca}
PG_DIR=${TLS_POSTGRES_DIR:-/tls/postgres}
REDIS_DIR=${TLS_REDIS_DIR:-/tls/redis}
MODE=${TLS_CERTS_MODE:-auto}
RENEW_BEFORE=${TLS_RENEW_BEFORE_SECONDS:-2592000}   # 30 days
CA_DAYS=${TLS_CA_DAYS:-3650}
LEAF_DAYS=${TLS_LEAF_DAYS:-825}
# Runtime users of the pinned store images: pgvector/pgvector:pg16 postgres=999:999,
# redis:7-alpine redis=999:1000. Postgres refuses a key that is not 0600 and owned by its user.
PG_OWNER=${TLS_POSTGRES_KEY_OWNER:-999:999}
REDIS_OWNER=${TLS_REDIS_KEY_OWNER:-999:1000}

log() { printf 'certs: %s\n' "$*"; }

pub_fingerprint() { openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 -r | cut -d' ' -f1; }

leaf_ok() { # dir hostname
  dir=$1 host=$2
  [ -s "$CA_DIR/ca.crt" ] && [ -s "$dir/server.crt" ] && [ -s "$dir/server.key" ] || return 1
  openssl verify -x509_strict -CAfile "$CA_DIR/ca.crt" "$dir/server.crt" >/dev/null 2>&1 || return 1
  openssl x509 -in "$CA_DIR/ca.crt" -noout -checkend "$RENEW_BEFORE" >/dev/null 2>&1 || return 1
  openssl x509 -in "$dir/server.crt" -noout -checkend "$RENEW_BEFORE" >/dev/null 2>&1 || return 1
  openssl x509 -in "$dir/server.crt" -noout -checkhost "$host" 2>/dev/null | grep -q 'does match' || return 1
  tmp=$(mktemp)
  openssl x509 -in "$dir/server.crt" -noout -pubkey >"$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  cert_fp=$(pub_fingerprint "$tmp")
  openssl pkey -in "$dir/server.key" -pubout -out "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  key_fp=$(pub_fingerprint "$tmp")
  rm -f "$tmp"
  [ -n "$cert_fp" ] && [ "$cert_fp" = "$key_fp" ]
}

fix_perms() {
  chmod 0755 "$CA_DIR" && chmod 0644 "$CA_DIR/ca.crt" && chown 0:0 "$CA_DIR/ca.crt"
  chown "$PG_OWNER" "$PG_DIR" "$PG_DIR/server.crt" "$PG_DIR/server.key"
  chmod 0700 "$PG_DIR" && chmod 0644 "$PG_DIR/server.crt" && chmod 0600 "$PG_DIR/server.key"
  chown "$REDIS_OWNER" "$REDIS_DIR" "$REDIS_DIR/server.crt" "$REDIS_DIR/server.key"
  chmod 0700 "$REDIS_DIR" && chmod 0644 "$REDIS_DIR/server.crt" && chmod 0600 "$REDIS_DIR/server.key"
}

mkdir -p "$CA_DIR" "$PG_DIR" "$REDIS_DIR"

if leaf_ok "$PG_DIR" postgres && leaf_ok "$REDIS_DIR" redis; then
  fix_perms
  log "existing certificates are valid; kept ($(openssl x509 -in "$CA_DIR/ca.crt" -noout -subject))"
  exit 0
fi

if [ "$MODE" = "external" ]; then
  log "TLS_CERTS_MODE=external but the supplied certificates are missing, expired, do not chain to ca.crt," >&2
  log "do not name postgres/redis, or do not match their keys; refusing to start the data stores" >&2
  exit 1
fi
[ "$MODE" = "auto" ] || { log "unknown TLS_CERTS_MODE=$MODE (auto|external)" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log "issuing a new private CA and server certificates for postgres and redis"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/ca.key" 2>/dev/null
openssl req -x509 -new -key "$work/ca.key" -sha256 -days "$CA_DAYS" \
  -subj "/CN=corpus-data-stores-ca-$(openssl rand -hex 4)" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "subjectKeyIdentifier=hash" \
  -out "$work/ca.crt"

issue() { # name
  name=$1
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$work/$name.key" 2>/dev/null
  openssl req -new -key "$work/$name.key" -subj "/CN=$name" -out "$work/$name.csr"
  printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:$name" \
    "subjectKeyIdentifier=hash" \
    "authorityKeyIdentifier=keyid:always" >"$work/$name.ext"
  openssl x509 -req -in "$work/$name.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days "$LEAF_DAYS" -sha256 \
    -extfile "$work/$name.ext" -out "$work/$name.crt" 2>/dev/null
  openssl verify -x509_strict -CAfile "$work/ca.crt" "$work/$name.crt" >/dev/null
}
issue postgres
issue redis

# Install: write next to the target, then rename, so a reader never sees a half-written file.
install_file() { # src dest mode
  cp "$1" "$2.new" && chmod "$3" "$2.new" && mv -f "$2.new" "$2"
}
install_file "$work/postgres.key" "$PG_DIR/server.key" 0600
install_file "$work/postgres.crt" "$PG_DIR/server.crt" 0644
install_file "$work/redis.key" "$REDIS_DIR/server.key" 0600
install_file "$work/redis.crt" "$REDIS_DIR/server.crt" 0644
install_file "$work/ca.crt" "$CA_DIR/ca.crt" 0644
fix_perms

leaf_ok "$PG_DIR" postgres && leaf_ok "$REDIS_DIR" redis || { log "self-check of issued certificates failed" >&2; exit 1; }
log "issued; CA private key discarded"
