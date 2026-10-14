# Shared helpers for the audit F30 end-to-end scripts (sourced, not executed).
# shellcheck shell=bash

FAILS=0
CHECKS=0

# Every secret value the scripts hold; nothing they print may contain one.
SECRET_VALUE_VARS="POSTGRES_PASSWORD MIGRATE_DB_PASSWORD APP_DB_PASSWORD REDIS_APP_PASSWORD REDIS_PASSWORD ENCRYPTION_KEY ADMIN_API_KEY SECRET_KEY F05_READER_PASSWORD"

# redact TEXT: TEXT with every secret value replaced by <redacted>.
redact() {
  local text=$1 name value
  for name in $SECRET_VALUE_VARS; do
    value=${!name:-}
    if [ -n "$value" ]; then text=${text//"$value"/<redacted>}; fi
  done
  printf '%s' "$text"
}
# redact_stream: the same for a pipe (container logs).
redact_stream() { local line; while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$(redact "$line")"; done; }

# pass/fail print through redact: no label or failure detail can echo a secret.
pass() { CHECKS=$((CHECKS + 1)); printf 'PASS  %s\n' "$(redact "$1")"; }
fail() {
  CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1))
  printf 'FAIL  %s\n' "$(redact "$1")"
  if [ -n "${2:-}" ]; then redact "$2" | head -c 1500 | sed 's/^/      | /'; printf '\n'; fi
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

# no_store_secret LABEL TEXT
# TEXT is anything read from a container (process command lines, a healthcheck, ...); it must not
# contain any store password value. Reports variable names only, never values.
no_store_secret() {
  local label=$1 text=$2 name problems=""
  if [ -z "$text" ]; then fail "$label" "nothing to scan (could not read it)"; return; fi
  for name in $STORE_SECRET_VARS; do
    if printf '%s' "$text" | grep -qF -- "${!name}"; then problems+="carries $name; "; fi
  done
  if [ -z "$problems" ]; then pass "$label"; else fail "$label" "$problems"; fi
}

# --- audit F19 (PR 2b): the Annex A corpus contract on the compose postgres -----------------------
# Both need the calling script's COMPOSE array and as_superuser_local (the bootstrap superuser over the
# container's own socket, the only superuser path).

# as_role_local ROLE SQL: SQL as ROLE (SET ROLE from the local superuser session).
as_role_local() {
  "${COMPOSE[@]}" exec -T -u postgres postgres \
    psql -U "$POSTGRES_USER" -d legal_scraper -v ON_ERROR_STOP=1 -qtA -c "SET ROLE $1" -c "$2"
}

# annex_a_checks PREFIX: Annex A is applied (001 + 003 by 15-apply-annex-a.sh) and owned by the
# bootstrap superuser; neither application role owns or holds anything of it (relations, their
# sequences, and EXECUTE on the routines the DDL keeps from PUBLIC), nor does corpus_clients or PUBLIC;
# the runtime role's only corpus_* membership is corpus_writer WITH INHERIT FALSE, SET TRUE (D14, D25;
# PR 2b fix round 1).
annex_a_checks() {
  local p=$1 roles="(values ('$APP_DB_USER'), ('$MIGRATE_DB_USER')) u(n)"
  expect_out "$p: server is PostgreSQL 16 (pgvector/pgvector:pg16)" '^16$' \
    as_superuser_local "select current_setting('server_version_num')::int / 10000"
  expect_out "$p: Annex A is applied (corpus_contract_relations() lists all 33 relations, 004's four views included)" '^33$' \
    as_superuser_local "select count(*) from public.corpus_contract_relations()"
  # Audit F05 (004), independent of the inventory function: the authority views exist, belong to the bootstrap
  # superuser, and neither application role, corpus_clients nor PUBLIC holds any privilege on them.
  expect_out "$p: the four v_authority_* views are the bootstrap superuser's and nobody else holds a privilege on them" '^4:0$' \
    as_superuser_local "select count(*) || ':' || count(*) filter (where pg_get_userbyid(c.relowner) <> '$POSTGRES_USER'
        or exists (select 1 from (values ('$APP_DB_USER'), ('$MIGRATE_DB_USER'), ('corpus_clients'), ('public')) u(n)
                    where has_table_privilege(u.n, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                       or has_any_column_privilege(u.n, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'v\\_authority\\_%'"
  expect_out "$p: corpus_metadata.schema_version is L17-AnnexA-1.0" '^L17-AnnexA-1\.0$' \
    as_superuser_local "select value from public.corpus_metadata where key = 'schema_version'"
  expect_out "$p: the 9 *_publication_guard triggers exist and are enabled (tgenabled O)" '^9/9$' \
    as_superuser_local "select count(*) filter (where t.tgenabled = 'O') || '/' || count(*) from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and t.tgname = c.relname || '_publication_guard' and c.relnamespace = 'public'::regnamespace"
  expect_out "$p: corpus_contract_routines() lists the 12 Annex A routines" '^12$' \
    as_superuser_local "select count(*) from public.corpus_contract_routines()"
  expect_out "$p: every Annex A relation and routine is owned by the bootstrap superuser" '^0$' \
    as_superuser_local "select (select count(*) from public.corpus_contract_relations() r join pg_class c on c.oid = r
        where pg_get_userbyid(c.relowner) <> '$POSTGRES_USER')
      + (select count(*) from public.corpus_contract_routines() f join pg_proc p on p.oid = f.routine
        where pg_get_userbyid(p.proowner) <> '$POSTGRES_USER')"
  expect_out "$p: neither $APP_DB_USER, $MIGRATE_DB_USER, corpus_clients nor PUBLIC may EXECUTE an Annex A routine the DDL keeps from PUBLIC" '^0$' \
    as_superuser_local "select count(*) from public.corpus_contract_routines() f
      cross join (values ('$APP_DB_USER'), ('$MIGRATE_DB_USER'), ('corpus_clients'), ('public')) u(n)
      where not f.public_execute and has_function_privilege(u.n, f.routine, 'EXECUTE')"
  expect_out "$p: neither corpus_clients nor PUBLIC holds any privilege on an Annex A relation" '^0$' \
    as_superuser_local "select count(*) from public.corpus_contract_relations() r
      cross join (values ('corpus_clients'), ('public')) u(n)
      where has_table_privilege(u.n, r, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(u.n, r, 'SELECT,INSERT,UPDATE,REFERENCES')"
  expect_out "$p: neither $APP_DB_USER nor $MIGRATE_DB_USER owns or holds any privilege on an Annex A relation or sequence" '^0$' \
    as_superuser_local "select (select count(*) from public.corpus_contract_relations() r cross join $roles
        where has_table_privilege(u.n, r, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           or has_any_column_privilege(u.n, r, 'SELECT,INSERT,UPDATE,REFERENCES')
           or (select pg_get_userbyid(relowner) from pg_class where oid = r) = u.n)
      + (select count(*) from pg_class s join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = s.oid
           and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') cross join $roles
        where s.relkind = 'S' and d.refobjid in (select r::oid from public.corpus_contract_relations() r)
          and (has_sequence_privilege(u.n, s.oid, 'USAGE,SELECT,UPDATE') or pg_get_userbyid(s.relowner) = u.n))"
  expect_out "$p: the only corpus role membership of $APP_DB_USER and $MIGRATE_DB_USER: $APP_DB_USER in corpus_writer WITH INHERIT FALSE, SET TRUE, no admin" \
    "^corpus_writer:$APP_DB_USER:inherit=false:set=true:admin=false\$" \
    as_superuser_local "select coalesce(string_agg(g.rolname || ':' || u.rolname || ':inherit=' || m.inherit_option
        || ':set=' || m.set_option || ':admin=' || m.admin_option, ',' order by g.rolname, u.rolname), 'none')
      from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
      where u.rolname in ('$APP_DB_USER', '$MIGRATE_DB_USER') and g.rolname <> 'corpus_clients'"
}

# annex_a_reader_checks PREFIX PAGE: after probe.py db-runtime published "2099 SCMR PAGE" (publish_batch)
# and "2099 SCMR PAGE+1" (promotion), corpus_reader sees both through 001's promoted-only views, and only
# through them. The draft gate's reader role, 004's corpus_authority_reader (audit F05, #51 R1 D-3, plan D21),
# sees both through v_authority_citation and reads nothing of 001's views or tables; corpus_reader holds
# nothing on 004's views.
annex_a_reader_checks() {
  local p=$1 page=$2
  expect_out "$p: corpus_reader reads both published judgments (publish_batch, promotion) through v_judgment and v_citation" '^2$' \
    as_role_local corpus_reader "select count(*) from public.v_citation c join public.v_judgment j on j.id = c.judgment_id
      where c.citation_text in ('2099 SCMR $page', '2099 SCMR $((page + 1))')"
  expect_refused "$p: corpus_reader cannot read the judgment table itself, only the views" 'permission denied for table judgment' \
    as_role_local corpus_reader "select count(*) from public.judgment"
  expect_out "$p: corpus_authority_reader reads both published judgments through 004's v_authority_citation (audit F05)" '^2$' \
    as_role_local corpus_authority_reader "select count(*) from public.v_authority_citation
      where citation_text in ('2099 SCMR $page', '2099 SCMR $((page + 1))')"
  expect_refused "$p: corpus_authority_reader cannot read 001's v_judgment" 'permission denied for view v_judgment' \
    as_role_local corpus_authority_reader "select count(*) from public.v_judgment"
  expect_refused "$p: corpus_authority_reader cannot read the judgment table" 'permission denied for table judgment' \
    as_role_local corpus_authority_reader "select count(*) from public.judgment"
  expect_refused "$p: corpus_reader cannot read 004's v_authority_citation" 'permission denied for view v_authority_citation' \
    as_role_local corpus_reader "select count(*) from public.v_authority_citation"
  expect_out "$p: corpus_reader holds no privilege at all on 004's four authority views" '^0$' \
    as_superuser_local "select count(*) from pg_class c cross join lateral aclexplode(c.relacl) e
      where c.relnamespace = 'public'::regnamespace and c.relname like 'v\_authority\_%'
        and e.grantee = 'corpus_reader'::regrole"
  expect_out "$p: corpus_authority_reader is NOLOGIN, holds no attribute or membership, and reads exactly the four views and corpus_metadata" \
    '^false\|0\|corpus_metadata,v_authority_citation,v_authority_pending_adverse,v_authority_section_version,v_authority_treatment$' \
    as_superuser_local "select (r.rolcanlogin or r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication
        or r.rolbypassrls)::text || '|' || (select count(*) from pg_auth_members m where m.member = r.oid) || '|'
        || (select string_agg(c.relname, ',' order by c.relname collate \"C\") from pg_class c
             where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
               and has_any_column_privilege(r.oid, c.oid, 'SELECT'))
      from pg_roles r where r.rolname = 'corpus_authority_reader'"
}

# annex_a_d7_reader_checks PREFIX PAGE: the draft gate's reader login made as an operator would on this stack (audit
# F05, #51 fix round 2, plan D21): a member of corpus_authority_reader and, for CONNECT through pg_hba, corpus_clients,
# and of nothing else. Over TLS it passes the adapter's own session check (ROLE_SQL, read from
# functions/src/d4/corpusAuthorityStore.ts by d7_role_sql.py: reader t, elevated f, other_role f, writes f,
# reads_more f, read-only on) and reads both published judgments. One more membership (pg_read_server_files) fails
# the same check. The login is dropped at the end. Needs psql_c and as_superuser_local from the calling script.
annex_a_d7_reader_checks() {
  local p=$1 page=$2 user=f05_d7_reader sql conn
  if ! sql=$(python3 "$(dirname "${BASH_SOURCE[0]}")/d7_role_sql.py" 2>&1); then
    fail "$p: the adapter's ROLE_SQL is readable from corpusAuthorityStore.ts" "$sql"
    return
  fi
  F05_READER_PASSWORD=$(rand_secret)
  conn="host=postgres port=5432 dbname=legal_scraper user=$user sslmode=verify-full sslrootcert=/ca/ca.crt"
  if printf '%s\n' '\getenv pw F05_D7_PW' "drop role if exists $user;" "create role $user login password :'pw';" \
       "grant corpus_authority_reader, corpus_clients to $user;" \
     | "${COMPOSE[@]}" exec -T -e F05_D7_PW="$F05_READER_PASSWORD" -u postgres postgres \
         psql -U "$POSTGRES_USER" -d legal_scraper -v ON_ERROR_STOP=1 -qtA >/dev/null 2>&1; then
    pass "$p: a reader login is created as an operator would (corpus_authority_reader, corpus_clients)"
  else
    fail "$p: a reader login is created as an operator would (corpus_authority_reader, corpus_clients)"
    return
  fi
  expect_out "$p: the reader login passes the adapter's session check over TLS (reader, not elevated, no other role, no write, nothing else readable, read-only)" \
    '^t\|f\|f\|f\|f\|on$' \
    psql_c "$conn" "$sql" -e PGPASSWORD="$F05_READER_PASSWORD" -e "PGOPTIONS=-c default_transaction_read_only=on"
  expect_out "$p: the reader login reads both published judgments through v_authority_citation over TLS" '^2$' \
    psql_c "$conn" "select count(*) from public.v_authority_citation where citation_text in ('2099 SCMR $page', '2099 SCMR $((page + 1))')" \
    -e PGPASSWORD="$F05_READER_PASSWORD"
  as_superuser_local "grant pg_read_server_files to $user" >/dev/null 2>&1 || fail "$p: grant pg_read_server_files to the reader"
  expect_out "$p: one more membership (pg_read_server_files) fails the same check (other_role)" \
    '^t\|f\|t\|f\|f\|on$' \
    psql_c "$conn" "$sql" -e PGPASSWORD="$F05_READER_PASSWORD" -e "PGOPTIONS=-c default_transaction_read_only=on"
  as_superuser_local "drop role $user" >/dev/null 2>&1 || fail "$p: drop the reader login"
}

# expect_lines LABEL EXPECTED ACTUAL: two newline-separated lists must hold the same lines (sorted).
expect_lines() {
  local label=$1 want got
  want=$(printf '%s\n' "$2" | sed '/^$/d' | sort | tr '\n' ' ')
  got=$(printf '%s\n' "$3" | sed '/^$/d' | sort | tr '\n' ' ')
  if [ "$want" = "$got" ]; then pass "$label"; else fail "$label" "expected [${want% }], got [${got% }]"; fi
}
