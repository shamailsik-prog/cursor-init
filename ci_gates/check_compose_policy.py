#!/usr/bin/env python3
"""Compose data-store policy (audit F30).

Rejects a compose deployment whose data stores are exposed, unauthenticated, plaintext or reachable
with default/literal credentials; whose app containers reach them as the bootstrap superuser,
without verified TLS, or hold store credentials they do not use; or that contains anything the
policy cannot vet. Every finding carries a rule id (RULES); the fixtures under ci_gates/fixtures/
declare which rules they must trip (ci_gates/test_check_compose_policy.py).

Two passes over one deployment:
  raw       the YAML files as written: credentials must be required ${VAR:?} references or compose
            secret files; no include:/extends:; env_file only to committed credential-free files.
  resolved  the model `docker compose config --format json` produces for the same files plus any
            default override file next to the first one (docker-compose.override.yml, ...), with
            every profile enabled, no .env read, and every required variable set to a sentinel
            "pv-<VAR>-vp". Overrides, include, extends, anchors and interpolation are therefore
            applied exactly as compose applies them, and the sentinels show which variable each
            credential came from. Needs the docker compose CLI (no daemon); fails closed without it.

Usage:
  check_compose_policy.py FILE [FILE ...]     each FILE is one deployment (plus its override files)
  check_compose_policy.py -f FILE -f FILE     one deployment made of several files
"""
import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import yaml

RULES = {
    "store-ports": "a data store publishes host ports",
    "store-network": "a data store is not only on internal: true networks (or uses host/other network modes)",
    "pg-credentials": "Postgres lacks a required POSTGRES_USER and POSTGRES_PASSWORD (or secret file)",
    "pg-trust": "Postgres password authentication disabled (POSTGRES_HOST_AUTH_METHOD=trust)",
    "literal-credential": "a credential is a literal, a ${VAR} without :? (unset or defaulted), or a non-secret file",
    "pg-tls": "Postgres not started with ssl=on and a server certificate and key",
    "pg-password-encryption": "Postgres password_encryption is not scram-sha-256",
    "pg-hba": "pg_hba.conf missing, unverifiable, or accepting non-TLS TCP / non-SCRAM logins",
    "pg-weakening-flag": "a Postgres server option is repeated, unrecognised, or overrides a TLS/auth/listen setting",
    "app-role": "Postgres provisions no application role distinct from the bootstrap superuser",
    "redis-tls": "Redis keeps a plaintext port (needs --port 0 and --tls-port with cert and key)",
    "redis-default-user": "the Redis default user is not disabled (or requirepass gives it a login)",
    "redis-acl-user": "Redis defines no enabled application ACL user with a required-secret password",
    "redis-acl-privilege": "a Redis ACL user is not denied @admin and @dangerous commands",
    "redis-weakening-flag": "a Redis option is repeated, unverifiable (config file, include, aclfile) or weakening",
    "app-db-bootstrap-user": "an app service connects to Postgres as the bootstrap superuser",
    "app-db-tls": "an app service's DATABASE_URL does not require verified TLS (sslmode=verify-full)",
    "app-redis-tls": "an app service's REDIS_URL is not rediss:// with a named ACL user and verified TLS",
    "app-credential-scope": "an app container receives a store credential it does not use",
    "app-env-file": "an app service reads an env_file the policy cannot vet, or one holding credentials",
    "app-image-secrets": "an app image build context does not exclude .env from the image",
    "unvetted-composition": "include: or extends: pulls in configuration outside the vetted files",
    "unknown-service": "a service is neither a known data store, an app built from this repo, nor network-isolated",
    "compose-config": "docker compose cannot resolve the deployment (or is not installed)",
}

SENTINEL = "pv-{}-vp"
SENTINEL_RE = re.compile(r"pv-([A-Za-z0-9_]+)-vp")
REQUIRED_REF = re.compile(r"\$\{([A-Za-z0-9_]+):?\?[^}]*\}")
REQUIRED_VAR = re.compile(r"^\$\{([A-Za-z0-9_]+):?\?[^}]*\}$")
VAR_REF = re.compile(r"\$\{([A-Za-z0-9_]+)([^}]*)\}")
CREDENTIAL_NAME = re.compile(r"(PASSWORD|PASSWD|_PASS$|SECRET|TOKEN|_AUTH$|^REDISCLI_AUTH$|_USER$|_KEY$)")
STORE_CRED_KEY = re.compile(r"^(POSTGRES_|PGUSER$|PGPASSWORD$|PGPASSFILE$|MIGRATE_DB_|APP_DB_|REDIS_APP_|REDISCLI_)")
OPTIONAL_APP_SECRETS = {"OPENAI_API_KEY"}  # may be ${VAR:-} (empty = feature off)
PG_FAMILY = {"postgres", "pgvector", "postgis", "timescaledb", "timescaledb-ha"}
REDIS_FAMILY = {"redis", "valkey", "keydb", "redis-stack", "redis-stack-server"}
REDIS_SERVERS = {"redis-server", "valkey-server", "keydb-server"}
DEFAULT_NAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")
OVERRIDE_NAMES = ("docker-compose.override.yml", "docker-compose.override.yaml",
                  "compose.override.yml", "compose.override.yaml")
HBA_TCP = ("host", "hostssl", "hostnossl", "hostgssenc", "hostnogssenc")
PG_SENSITIVE = re.compile(r"^(ssl.*|hba_file|ident_file|password_encryption|listen_addresses|authentication.*"
                          r"|krb_.*|db_user_namespace|unix_socket.*|lo_compat_privileges|port)$")
PG_ALLOWED = {"ssl", "ssl_cert_file", "ssl_key_file", "ssl_ca_file", "ssl_min_protocol_version",
              "password_encryption", "hba_file", "ident_file"}
REDIS_ADMIN_COMMANDS = {
    "config", "flushall", "flushdb", "acl", "debug", "shutdown", "module", "monitor", "replicaof",
    "slaveof", "save", "bgsave", "bgrewriteaof", "migrate", "restore", "keys", "sync", "psync",
    "failover", "cluster", "client", "latency", "memory", "swapdb", "lastsave",
}
REDIS_UNVETTABLE = {"include", "aclfile", "loadmodule", "masterauth", "masteruser", "replicaof", "slaveof"}
REDIS_MUST_BE_NO = {"enable-debug-command", "enable-module-command", "enable-protected-configs"}
REDIS_STRICT_SSL_QUERY = {"ssl_cert_reqs": ("required", "cert_required"),
                          "ssl_check_hostname": ("true", "1", "yes", "on")}


# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------
def _env_of(svc):
    env = svc.get("environment") or {}
    if isinstance(env, list):
        env = dict(e.split("=", 1) if "=" in e else (e, "") for e in env)
    return {str(k): ("" if v is None else str(v)) for k, v in env.items()}


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    return shlex.split(str(value))


def _image_family(image):
    ref = str(image or "").split("@", 1)[0]
    return ref.rsplit("/", 1)[-1].split(":", 1)[0].lower()


def _sentinel_vars(text):
    return set(SENTINEL_RE.findall(str(text or "")))


def _is_sentinel(text):
    return bool(re.fullmatch(SENTINEL_RE.pattern, str(text or "")))


def _userinfo(url):
    """(user, password) of a URL, verbatim; a ${VAR:?msg} reference counts as one token."""
    m = re.match(r"^[a-z0-9+]+://((?:\$\{[^}]*\}|[^@/])*)@", url or "")
    if not m:
        return "", ""
    parts = re.findall(r"\$\{[^}]*\}|[^:]+", m.group(1))
    return (parts[0] if parts else ""), (parts[1] if len(parts) > 1 else "")


def _mask_refs(text):
    """${VAR:?msg} contains '?' and ':', which would confuse URL parsing; neutralise it."""
    return VAR_REF.sub("VAR", text)


def _env_file_entries(svc):
    ef = svc.get("env_file")
    if ef is None:
        return []
    items = ef if isinstance(ef, list) else [ef]
    return [str(i.get("path")) if isinstance(i, dict) else str(i) for i in items]


def _read_env_keys(path):
    keys = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        keys.append(line.split("=", 1)[0].strip().removeprefix("export ").strip())
    return keys


def _hba_problems(path):
    problems = []
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.split()
        kind = fields[0]
        if kind.startswith("include"):
            problems.append(f"line {n}: {kind} cannot be verified by policy")
            continue
        if kind == "local":
            method = fields[3] if len(fields) > 3 else ""
            if method in ("trust", "password", "md5"):
                problems.append(f"line {n}: local {method}")
            continue
        if kind not in HBA_TCP:
            problems.append(f"line {n}: unknown connection type {kind!r}")
            continue
        # TYPE DATABASE USER ADDRESS METHOD, or TYPE DATABASE USER IP-ADDRESS IP-MASK METHOD.
        if len(fields) > 5 and re.match(r"^[0-9a-fA-F.:]+$", fields[4]) and re.match(r"^[0-9a-fA-F.:]+$", fields[3]):
            method = fields[5]
        else:
            method = fields[4] if len(fields) > 4 else ""
        if kind != "hostssl" and method != "reject":
            problems.append(f"line {n}: {kind} ... {method} accepts non-TLS TCP connections")
        elif kind == "hostssl" and method not in ("scram-sha-256", "cert", "reject"):
            problems.append(f"line {n}: hostssl ... {method} (only scram-sha-256/cert/reject allowed)")
    return problems


def _acl_least_privilege(rules):
    """True if an ACL rule list cannot reach @admin/@dangerous commands. Rules apply in order and
    categories overlap (+@slow includes CONFIG), so -@admin and -@dangerous must both follow the
    LAST grant. A pure allowlist of commands passes unless it names an admin/dangerous one."""
    low = [r.lower() for r in rules]
    grants = [i for i, r in enumerate(low) if r.startswith("+") or r == "allcommands"]
    if not grants:
        return True
    category_grant = any(low[i].startswith("+@") or low[i] == "allcommands" for i in grants)
    risky = [low[i][1:].split("|")[0] for i in grants if low[i][1:].split("|")[0] in REDIS_ADMIN_COMMANDS]
    if not category_grant and not risky:
        return True
    after = low[max(grants) + 1:]
    return "-@admin" in after and "-@dangerous" in after


def _parse_pg_command(cmd):
    """Server settings from a postgres command line, last one wins, plus problems."""
    settings, problems = {}, []
    if not cmd:
        return settings, problems
    if cmd[0] != "postgres":
        problems.append(f"command must start with 'postgres', got {cmd[0]!r}")
    i = 1
    while i < len(cmd):
        arg, kv = cmd[i], None
        if arg == "-c" and i + 1 < len(cmd):
            kv, i = cmd[i + 1], i + 2
        elif arg.startswith("-c") and len(arg) > 2:
            kv, i = arg[2:], i + 1
        elif arg.startswith("--") and "=" in arg:
            kv, i = arg[2:], i + 1
        else:
            problems.append(f"unrecognised postgres argument {arg!r}")
            i += 1
            continue
        if "=" not in kv:
            problems.append(f"malformed server option {kv!r}")
            continue
        key, value = kv.split("=", 1)
        key = key.strip().lower().replace("-", "_")
        if key in settings:
            problems.append(f"{key} is set more than once (the last one wins)")
        settings[key] = value.strip().strip("'\"")
    for key in settings:
        if PG_SENSITIVE.match(key) and key not in PG_ALLOWED:
            problems.append(f"{key} may not be overridden")
    mpv = settings.get("ssl_min_protocol_version")
    if mpv is not None and mpv not in ("TLSv1.2", "TLSv1.3"):
        problems.append(f"ssl_min_protocol_version={mpv}")
    return settings, problems


def _redis_options(cmd):
    opts = []
    for tok in cmd:
        if tok.startswith("--"):
            opts.append((tok[2:].lower(), []))
        elif opts:
            opts[-1][1].append(tok)
    return opts


def _bind_source(svc, target):
    for v in svc.get("volumes") or []:
        if isinstance(v, dict) and v.get("target") == target and v.get("type") == "bind" and v.get("source"):
            return Path(v["source"])
    return None


def _inside(path, base):
    try:
        Path(path).resolve().relative_to(Path(base).resolve())
        return True
    except ValueError:
        return False


def _dockerignore_excludes_env(context, dockerfile):
    candidates = [Path(context) / f"{dockerfile}.dockerignore", Path(context) / ".dockerignore"]
    for c in candidates:
        if c.is_file():
            for line in c.read_text().splitlines():
                pat = line.strip()
                if not pat or pat.startswith("#") or pat.startswith("!"):
                    continue
                pat = pat.lstrip("/").removeprefix("**/")
                if fnmatch.fnmatch(".env", pat):
                    return True
            return False  # BuildKit uses only the first ignore file found
    return False


# --------------------------------------------------------------------------------------------
# composition: which files make up a deployment
# --------------------------------------------------------------------------------------------
def deployment_files(files):
    files = [Path(f).resolve() for f in files]
    first = files[0]
    if first.name in DEFAULT_NAMES:
        for name in OVERRIDE_NAMES:
            o = first.parent / name
            if o.is_file() and o not in files:
                files.append(o)
    return files


def _raw_closure(files):
    """All YAML documents compose would read, following include: and extends: file references."""
    seen, docs, queue = set(), [], list(files)
    while queue:
        p = Path(queue.pop(0)).resolve()
        if p in seen or not p.is_file():
            continue
        seen.add(p)
        text = p.read_text()
        doc = yaml.safe_load(text) or {}
        docs.append((p, text, doc))
        for inc in doc.get("include") or []:
            paths = inc.get("path") if isinstance(inc, dict) else inc
            for q in (paths if isinstance(paths, list) else [paths]):
                if q:
                    queue.append(p.parent / str(q))
        for svc in (doc.get("services") or {}).values():
            ext = (svc or {}).get("extends")
            if isinstance(ext, dict) and ext.get("file"):
                queue.append(p.parent / str(ext["file"]))
    return docs


def resolve(files, raw_docs):
    """`docker compose config --format json` for the deployment, or (None, error)."""
    required = set()
    for _p, text, _d in raw_docs:
        required |= set(REQUIRED_REF.findall(text))
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR") or k.startswith("DOCKER_")}
    env.update({var: SENTINEL.format(var) for var in required})
    with tempfile.TemporaryDirectory() as td:
        empty = Path(td) / "empty.env"
        empty.write_text("")
        cmd = ["docker", "compose", "--env-file", str(empty), "--profile", "*"]
        for f in files:
            cmd += ["-f", str(f)]
        cmd += ["config", "--format", "json"]
        try:
            proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.SubprocessError) as exc:
            return None, f"docker compose unavailable: {exc}"
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["failed"]
    return json.loads(proc.stdout), None


# --------------------------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------------------------
def _raw_checks(raw_docs, project_dir, bad):
    for path, _text, doc in raw_docs:
        base = path.parent
        if doc.get("include"):
            bad("unvetted-composition", "-", f"{path.name}: include: is not allowed")
        top_secrets = doc.get("secrets") or {}
        for sname, sdef in top_secrets.items():
            sdef = sdef or {}
            if "file" in sdef:
                f = str(sdef["file"])
                if not REQUIRED_VAR.match(f) and (not f.startswith("/") or _inside(f, project_dir)):
                    bad("literal-credential", "-", f"secret {sname} reads a file kept with the repo ({f}); "
                        "use environment: VAR or file: ${VAR:?}")
            elif "environment" not in sdef and not sdef.get("external"):
                bad("literal-credential", "-", f"secret {sname} has no file:/environment: source")
        for name, svc in (doc.get("services") or {}).items():
            svc = svc or {}
            if svc.get("extends"):
                bad("unvetted-composition", name, f"{path.name}: extends: is not allowed")
            env = _env_of(svc)
            svc_secrets = {s.get("source") if isinstance(s, dict) else str(s) for s in svc.get("secrets") or []}
            for key, val in env.items():
                if not CREDENTIAL_NAME.search(key.removesuffix("_FILE")):
                    continue
                if key.endswith("_FILE"):
                    m = re.fullmatch(r"/run/secrets/([A-Za-z0-9_.-]+)", val)
                    if not m or m.group(1) not in svc_secrets:
                        bad("literal-credential", name, f"{key} must point at a declared compose secret (/run/secrets/<name>)")
                    continue
                if key in OPTIONAL_APP_SECRETS and val in (f"${{{key}:-}}", f"${{{key}-}}"):
                    continue
                if not REQUIRED_VAR.match(val):
                    bad("literal-credential", name, f"{key} must be a required ${{VAR:?}} reference, got {val!r}")
            for text in list(env.values()) + _as_list(svc.get("command")):
                for var, rest in VAR_REF.findall(text):
                    if not CREDENTIAL_NAME.search(var) or rest.startswith(":?") or rest.startswith("?"):
                        continue
                    if var in OPTIONAL_APP_SECRETS and rest in (":-", "-"):
                        continue
                    bad("literal-credential", name, f"${{{var}{rest}}} is not required (:?) - unset or defaulted credential")
            if "build" in svc:
                for ef in _env_file_entries(svc):
                    p = (base / ef).resolve()
                    if Path(ef).name.startswith(".env") or not _inside(p, project_dir) or not p.is_file():
                        bad("app-env-file", name, f"env_file {ef} is not a committed, vettable file "
                            "(.env is the compose interpolation file and holds every secret)")
                        continue
                    creds = [k for k in _read_env_keys(p) if CREDENTIAL_NAME.search(k) or STORE_CRED_KEY.match(k)]
                    if creds:
                        bad("app-env-file", name, f"env_file {ef} carries credentials {creds}")
                db = env.get("DATABASE_URL")
                if db:
                    user, pw = _userinfo(db)
                    if not REQUIRED_VAR.match(user) or not REQUIRED_VAR.match(pw):
                        bad("literal-credential", name, "DATABASE_URL user and password must be required ${VAR:?} references")
                rd = env.get("REDIS_URL")
                if rd:
                    user, pw = _userinfo(rd)
                    if user and (not REQUIRED_VAR.match(user) or not REQUIRED_VAR.match(pw)):
                        bad("literal-credential", name, "REDIS_URL user and password must be required ${VAR:?} references")


def _secret_env_var(model, svc, path_value):
    """The variable behind /run/secrets/<name> for this service, if any."""
    m = re.fullmatch(r"/run/secrets/([A-Za-z0-9_.-]+)", path_value or "")
    if not m:
        return None
    sname = m.group(1)
    for s in svc.get("secrets") or []:
        if s.get("source") == sname or s.get("target") == path_value:
            sdef = (model.get("secrets") or {}).get(s.get("source")) or {}
            return sdef.get("environment") or "file:" + str(sdef.get("file"))
    return None


def _cred_vars(model, svc, key):
    """Variables that supply credential `key` of a store service (value sentinel or secret file)."""
    env = _env_of(svc)
    out = set(_sentinel_vars(env.get(key)))
    via_file = _secret_env_var(model, svc, env.get(f"{key}_FILE"))
    if via_file:
        out.add(via_file)
    return out


def _resolved_checks(model, project_dir, bad):
    services = model.get("services") or {}
    nets = model.get("networks") or {}
    kinds = {}
    for name, svc in services.items():
        fam = _image_family(svc.get("image"))
        build = svc.get("build") or {}
        if svc.get("network_mode") == "none" and not svc.get("ports"):
            kinds[name] = "isolated"
        elif fam in PG_FAMILY:
            kinds[name] = "postgres"
        elif fam in REDIS_FAMILY:
            kinds[name] = "redis"
        elif build and _inside(build.get("context", "/nonexistent"), project_dir):
            kinds[name] = "app"
        else:
            kinds[name] = "unknown"
            bad("unknown-service", name, f"image {svc.get('image')!r} is not a known data store, not built from "
                "this repo, and the service is not network_mode: none")

    bootstrap, migration, app_role, store_vars = {"POSTGRES_USER", "POSTGRES_PASSWORD"}, set(), set(), set()
    for name, svc in services.items():
        if kinds[name] in ("postgres", "redis"):
            env = _env_of(svc)
            for v in list(env.values()) + _as_list(svc.get("command")):
                store_vars |= _sentinel_vars(v)
            for s in svc.get("secrets") or []:
                sdef = (model.get("secrets") or {}).get(s.get("source")) or {}
                if sdef.get("environment"):
                    store_vars.add(sdef["environment"])
        if kinds[name] == "postgres":
            bootstrap |= _cred_vars(model, svc, "POSTGRES_USER") | _cred_vars(model, svc, "POSTGRES_PASSWORD")
            migration |= _cred_vars(model, svc, "MIGRATE_DB_USER") | _cred_vars(model, svc, "MIGRATE_DB_PASSWORD")
            app_role |= _cred_vars(model, svc, "APP_DB_USER") | _cred_vars(model, svc, "APP_DB_PASSWORD")
    migration |= {"MIGRATE_DB_USER", "MIGRATE_DB_PASSWORD"}
    for name, svc in services.items():
        if kinds[name] == "app":
            env = _env_of(svc)
            for key in ("DATABASE_URL", "REDIS_URL"):
                store_vars |= _sentinel_vars("".join(_userinfo(env.get(key, ""))))
    store_vars |= bootstrap | migration | app_role

    for name, svc in services.items():
        kind = kinds[name]
        env = _env_of(svc)
        cmd = _as_list(svc.get("command"))
        if kind in ("postgres", "redis"):
            if svc.get("ports"):
                bad("store-ports", name, f"data store publishes host ports {svc['ports']}")
            if svc.get("network_mode"):
                bad("store-network", name, f"network_mode {svc['network_mode']!r}")
            svc_nets = list((svc.get("networks") or {"default": None}).keys())
            for n in svc_nets:
                ndef = nets.get(n) or {}
                if ndef.get("internal") is not True or ndef.get("external"):
                    bad("store-network", name, f"network '{n}' is not internal: true")
        if kind == "postgres":
            if svc.get("entrypoint"):
                bad("pg-weakening-flag", name, "entrypoint override hides the server command")
            if "POSTGRES_USER" not in env or not ({"POSTGRES_PASSWORD", "POSTGRES_PASSWORD_FILE"} & set(env)):
                bad("pg-credentials", name, "POSTGRES_USER and POSTGRES_PASSWORD (or _FILE) must be set")
            if env.get("POSTGRES_HOST_AUTH_METHOD", "").strip().lower() == "trust":
                bad("pg-trust", name, "POSTGRES_HOST_AUTH_METHOD=trust disables password auth")
            settings, problems = _parse_pg_command(cmd)
            for p in problems:
                bad("pg-weakening-flag", name, p)
            if settings.get("ssl", "").lower() not in ("on", "true", "1") \
                    or not settings.get("ssl_cert_file") or not settings.get("ssl_key_file"):
                bad("pg-tls", name, "postgres must run with -c ssl=on -c ssl_cert_file=... -c ssl_key_file=...")
            if settings.get("password_encryption") != "scram-sha-256":
                bad("pg-password-encryption", name, "postgres must run with -c password_encryption=scram-sha-256")
            hba = settings.get("hba_file")
            src = _bind_source(svc, hba) if hba else None
            if not hba:
                bad("pg-hba", name, "no -c hba_file=: the image default pg_hba.conf accepts plaintext logins")
            elif not src or not src.is_file() or not _inside(src, project_dir):
                bad("pg-hba", name, f"hba_file {hba} is not a repo file bind-mounted into the container")
            else:
                for p in _hba_problems(src):
                    bad("pg-hba", name, f"{src.name} {p}")
            boot_user = _cred_vars(model, svc, "POSTGRES_USER") | {"POSTGRES_USER"}
            if not _sentinel_vars(env.get("APP_DB_USER")):
                bad("app-role", name, "APP_DB_USER must be provisioned from a required ${VAR:?} reference")
            for role in ("APP_DB_USER", "MIGRATE_DB_USER"):
                if _sentinel_vars(env.get(role)) & boot_user:
                    bad("app-role", name, f"{role} reuses the bootstrap superuser variable")
        if kind == "redis":
            if svc.get("entrypoint"):
                bad("redis-weakening-flag", name, "entrypoint override hides the server command")
            if cmd and cmd[0] not in REDIS_SERVERS:
                bad("redis-weakening-flag", name, f"command must start with redis-server, got {cmd[0]!r}")
            rest = cmd[1:] if cmd else []
            if rest and not rest[0].startswith("--"):
                bad("redis-weakening-flag", name, f"config file argument {rest[0]!r} cannot be verified")
            opts = _redis_options(rest)
            seen = set()
            for o, a in opts:
                if o != "user" and o in seen:
                    bad("redis-weakening-flag", name, f"--{o} is given more than once (the last one wins)")
                seen.add(o)
                if o in REDIS_UNVETTABLE:
                    bad("redis-weakening-flag", name, f"--{o} is not allowed")
                if o in REDIS_MUST_BE_NO and [x.lower() for x in a] != ["no"]:
                    bad("redis-weakening-flag", name, f"--{o} {' '.join(a)}")
                if o == "protected-mode" and [x.lower() for x in a] != ["yes"]:
                    bad("redis-weakening-flag", name, f"--protected-mode {' '.join(a)}")
            flat = {o: a for o, a in opts}
            if flat.get("port") != ["0"] or "tls-port" not in flat \
                    or "tls-cert-file" not in flat or "tls-key-file" not in flat:
                bad("redis-tls", name, "redis must run with --port 0 --tls-port N --tls-cert-file ... --tls-key-file ...")
            users = [(a[0], a[1:]) for o, a in opts if o == "user" and a]
            default_rules = [r.lower() for u, rules in users if u == "default" for r in rules]
            if "requirepass" in flat or "off" not in default_rules or "on" in default_rules[default_rules.index("off"):]:
                bad("redis-default-user", name, "the default user must be disabled (--user default off) and requirepass unused")
            app_users = [(u, rules) for u, rules in users if u != "default" and "on" in [r.lower() for r in rules]]
            if not [u for u, rules in app_users if any(r.startswith(">") and _is_sentinel(r[1:]) for r in rules)]:
                bad("redis-acl-user", name, "no enabled ACL user with a >${VAR:?} password")
            for u, rules in app_users:
                if not _acl_least_privilege(rules):
                    bad("redis-acl-privilege", name, f"ACL user {u} must end with -@admin -@dangerous after its last grant")
        if kind == "app":
            build = svc.get("build") or {}
            if not _dockerignore_excludes_env(build.get("context", "."), build.get("dockerfile", "Dockerfile")):
                bad("app-image-secrets", name, "the build context's .dockerignore must exclude .env")
            db, rd = env.get("DATABASE_URL", ""), env.get("REDIS_URL", "")
            if db:
                user, pw = _userinfo(db)
                uvars, pvars = _sentinel_vars(user), _sentinel_vars(pw)
                if (uvars | pvars) & bootstrap:
                    bad("app-db-bootstrap-user", name, f"DATABASE_URL uses the bootstrap superuser ({sorted((uvars | pvars) & bootstrap)})")
                if not _is_sentinel(user) or not _is_sentinel(pw):
                    bad("literal-credential", name, "DATABASE_URL user and password must come from required variables")
                query = dict(parse_qsl(urlsplit(_mask_refs(db)).query))
                if (query.get("sslmode") or query.get("ssl")) != "verify-full":
                    bad("app-db-tls", name, "DATABASE_URL must carry sslmode=verify-full (server certificate + hostname)")
                if uvars & migration:
                    one_shot = str(svc.get("restart") or "no") == "no" and "scraper.migrate" in " ".join(cmd)
                    if not one_shot or rd:
                        bad("app-credential-scope", name, "the migration (schema-owner) role may only be held by the "
                            "one-shot `python -m scraper.migrate` service, without Redis credentials")
            if rd:
                user, pw = _userinfo(rd)
                parts = urlsplit(rd)
                weak = [f"{k}={v}" for k, v in parse_qsl(parts.query, keep_blank_values=True)
                        if k.lower().startswith("ssl_")
                        and v.strip().lower() not in REDIS_STRICT_SSL_QUERY.get(k.lower(), ())]
                if parts.scheme != "rediss" or not user or user == "default" or weak:
                    bad("app-redis-tls", name, "REDIS_URL must be rediss://<acl user>:<password>@... with no ssl_* "
                        f"override weakening verification {weak}")
            for key, val in env.items():
                if key in ("DATABASE_URL", "REDIS_URL"):
                    continue
                if STORE_CRED_KEY.match(key):
                    bad("app-credential-scope", name, f"{key} is a store credential; the app gets only its own URLs")
                leaked = _sentinel_vars(val) & store_vars
                if leaked:
                    bad("app-credential-scope", name, f"{key} carries store credential(s) {sorted(leaked)}")
            for s in svc.get("secrets") or []:
                sdef = (model.get("secrets") or {}).get(s.get("source")) or {}
                if sdef.get("environment") in store_vars:
                    bad("app-credential-scope", name, f"secret {s.get('source')} is a store credential")


def check_deployment(files):
    """Return [(rule, service, message), ...] for one deployment (list of compose files)."""
    files = deployment_files(files)
    project_dir = files[0].parent
    raw_docs = _raw_closure(files)
    findings = []

    def bad(rule, service, msg):
        assert rule in RULES, rule
        if (rule, service, msg) not in findings:
            findings.append((rule, service, msg))

    _raw_checks(raw_docs, project_dir, bad)
    model, err = resolve(files, raw_docs)
    if model is None:
        bad("compose-config", "-", f"docker compose config failed: {err}")
    else:
        _resolved_checks(model, project_dir, bad)
    return findings


def check(path):
    """One deployment rooted at `path` (plus its default override files)."""
    return check_deployment([path])


def main(argv):
    groups, current = [], []
    it = iter(argv)
    for a in it:
        if a == "-f":
            current.append(next(it))
        else:
            groups.append([a])
    if current:
        groups.append(current)
    status = 0
    for files in groups:
        label = "+".join(files)
        errs = check_deployment(files)
        for rule, service, msg in errs:
            print(f"FAIL {label}: [{rule}] {service}: {msg}")
        if not errs:
            print(f"PASS {label}")
        status |= bool(errs)
    return 1 if status else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
