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
