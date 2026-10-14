#!/usr/bin/env python3
"""Compose data-store policy (audit F30).

Rejects a compose file whose data stores are exposed, unauthenticated, plaintext or reachable with
default/literal credentials, or whose app services reach them as the bootstrap superuser or
without verified TLS. Every finding carries a rule id (see RULES); the fixtures under
ci_gates/fixtures/ declare which rules they must trip (ci_gates/test_check_compose_policy.py).

Usage: check_compose_policy.py <docker-compose.yml> [...]
"""
import re
import shlex
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import yaml

RULES = {
    "store-ports": "a data store publishes host ports",
    "store-network": "a data store sits on a network that is not internal: true (or on the host network)",
    "pg-credentials": "Postgres lacks a required POSTGRES_USER/POSTGRES_PASSWORD",
    "pg-trust": "Postgres password authentication disabled (POSTGRES_HOST_AUTH_METHOD=trust)",
    "literal-credential": "a credential is a literal, or a ${VAR} reference without :? (unset or defaulted)",
    "pg-tls": "Postgres not started with ssl=on and a server certificate and key",
    "pg-password-encryption": "Postgres password_encryption is not scram-sha-256",
    "pg-hba": "pg_hba.conf missing, unverifiable, or accepting non-TLS TCP / non-SCRAM logins",
    "app-role": "Postgres provisions no application role distinct from the bootstrap superuser",
    "redis-tls": "Redis keeps a plaintext port (needs --port 0 and --tls-port with cert and key)",
    "redis-default-user": "the Redis default user is not disabled (or requirepass gives it a login)",
    "redis-acl-user": "Redis defines no enabled application ACL user with a required-secret password",
    "redis-acl-privilege": "a Redis ACL user is not denied @admin and @dangerous commands",
    "app-env": "an app service takes DATABASE_URL/REDIS_URL from outside the compose file",
    "app-db-bootstrap-user": "an app service connects to Postgres as the bootstrap superuser",
    "app-db-tls": "an app service's DATABASE_URL does not require verified TLS (sslmode=verify-full)",
    "app-redis-tls": "an app service's REDIS_URL is not rediss:// with a named ACL user and verified TLS",
}

STORE_IMAGES = ("postgres", "pgvector", "redis", "mysql", "mariadb", "mongo", "rabbitmq")
KNOWN_DEFAULTS = {"legal", "postgres", "password", "changeme", "admin", "root", "secret", ""}
REQUIRED_VAR = re.compile(r"^\$\{([A-Za-z0-9_]+):\?[^}]*\}$")
VAR_REF = re.compile(r"\$\{([A-Za-z0-9_]+)([^}]*)\}")
CREDENTIAL_NAME = re.compile(r"(PASSWORD|PASSWD|_PASS$|SECRET|TOKEN|_AUTH$|^REDISCLI_AUTH$|_USER$)")
HBA_TCP = ("host", "hostssl", "hostnossl", "hostgssenc", "hostnogssenc")
REDIS_ADMIN_COMMANDS = {
    "config", "flushall", "flushdb", "acl", "debug", "shutdown", "module", "monitor", "replicaof",
    "slaveof", "save", "bgsave", "bgrewriteaof", "migrate", "restore", "keys", "sync", "psync",
    "failover", "cluster", "client", "latency", "memory", "swapdb", "lastsave",
}


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    return shlex.split(str(value))


def _env(svc):
    env = svc.get("environment") or {}
    if isinstance(env, list):
        env = dict(e.split("=", 1) if "=" in e else (e, "") for e in env)
    return {str(k): ("" if v is None else str(v)) for k, v in env.items()}


def _image(svc):
    return str(svc.get("image", ""))


def _is_postgres(svc):
    return any(s in _image(svc) for s in ("postgres", "pgvector"))


def _is_redis(svc):
    return "redis" in _image(svc)


def _pg_settings(cmd):
    """-c key=value / --key=value server options from a postgres command line."""
    out = {}
    for i, tok in enumerate(cmd):
        kv = None
        if tok == "-c" and i + 1 < len(cmd):
            kv = cmd[i + 1]
        elif tok.startswith("--") and "=" in tok:
            kv = tok[2:]
        if kv and "=" in kv:
            k, v = kv.split("=", 1)
            out[k.strip().replace("-", "_")] = v.strip().strip("'\"")
    return out


def _redis_options(cmd):
    """Group a redis-server command line into [(option, [args...]), ...]."""
    opts = []
    for tok in cmd:
        if tok.startswith("--"):
            opts.append((tok[2:].lower(), []))
        elif opts:
            opts[-1][1].append(tok)
    return opts


def _acl_least_privilege(rules):
    """True if an ACL rule list cannot reach @admin/@dangerous commands.

    ACL rules apply in order and categories overlap (e.g. +@slow includes CONFIG), so any
    category grant must be followed by both -@admin and -@dangerous after the LAST grant. A
    pure allowlist of individual commands passes unless it names an admin/dangerous command."""
    low = [r.lower() for r in rules]
    grants = [i for i, r in enumerate(low) if r.startswith("+") or r == "allcommands"]
    if not grants:
        return True
    category_grant = any(low[i].startswith("+@") or low[i] == "allcommands" for i in grants)
    risky = [low[i][1:].split("|")[0] for i in grants if low[i][1:].split("|")[0] in REDIS_ADMIN_COMMANDS]
    if not category_grant and not risky:
        return True
    after_last_grant = low[max(grants) + 1:]
    return "-@admin" in after_last_grant and "-@dangerous" in after_last_grant


def _bind_source(svc, target, base):
    for v in svc.get("volumes") or []:
        if isinstance(v, dict):
            src, dst, typ = v.get("source"), v.get("target"), v.get("type", "volume")
            if dst == target and typ == "bind" and src:
                return (base / src).resolve()
            continue
        parts = str(v).split(":")
        if len(parts) >= 2 and parts[1] == target and (parts[0].startswith(".") or parts[0].startswith("/")):
            return (base / parts[0]).resolve()
    return None


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


def _mask_refs(url):
    """${VAR:?msg} contains '?' and ':', which would confuse URL parsing; neutralise it."""
    return VAR_REF.sub("VAR", url)


def _url_cred_refs(url):
    """(user_ref, password_ref) as written in a URL, without decoding."""
    m = re.match(r"^[a-z0-9+]+://([^@/]*)@", url)
    if not m:
        return "", ""
    userinfo = m.group(1)
    if userinfo.startswith("${"):
        # ${A:?x}:${B:?y}
        refs = re.findall(r"\$\{[^}]*\}|[^:]+", userinfo)
        user = refs[0] if refs else ""
        pw = refs[1] if len(refs) > 1 else ""
        return user, pw
    user, _, pw = userinfo.partition(":")
    return user, pw


def check(path):
    """Return [(rule, service, message), ...] for one compose file."""
    path = Path(path)
    doc = yaml.safe_load(path.read_text()) or {}
    base = path.parent
    nets = doc.get("networks") or {}
    services = doc.get("services") or {}
    findings = []

    def bad(rule, name, msg):
        assert rule in RULES, rule
        findings.append((rule, name, msg))

    pg_bootstrap_vars = set()
    for svc in services.values():
        if _is_postgres(svc):
            m = REQUIRED_VAR.match(_env(svc).get("POSTGRES_USER", ""))
            if m:
                pg_bootstrap_vars.add(m.group(1))
            m = REQUIRED_VAR.match(_env(svc).get("POSTGRES_PASSWORD", ""))
            if m:
                pg_bootstrap_vars.add(m.group(1))
    pg_bootstrap_vars |= {"POSTGRES_USER", "POSTGRES_PASSWORD"}

    for name, svc in services.items():
        env = _env(svc)
        cmd = _as_list(svc.get("command"))

        # --- credentials anywhere: env values and command tokens -----------------------------
        for key, val in env.items():
            if CREDENTIAL_NAME.search(key) and not REQUIRED_VAR.match(val):
                bad("literal-credential", name, f"{key} must be a required ${{VAR:?}} reference, got {val!r}")
        for text in list(env.values()) + cmd:
            for var, rest in VAR_REF.findall(text):
                if CREDENTIAL_NAME.search(var) and not rest.startswith(":?"):
                    bad("literal-credential", name, f"${{{var}{rest}}} is not required (:?) - unset or defaulted credential")

        # --- data stores ------------------------------------------------------------------------
        is_store = any(s in _image(svc) for s in STORE_IMAGES)
        if is_store and svc.get("network_mode") != "none":
            if svc.get("ports"):
                bad("store-ports", name, f"data store publishes host ports {svc['ports']}")
            if svc.get("network_mode"):
                bad("store-network", name, f"network_mode {svc['network_mode']!r}")
            svc_nets = svc.get("networks") or ["default"]
            svc_nets = list(svc_nets.keys()) if isinstance(svc_nets, dict) else svc_nets
            for n in svc_nets:
                if not (nets.get(n) or {}).get("internal"):
                    bad("store-network", name, f"network '{n}' is not internal: true")

            if _is_postgres(svc):
                for req in ("POSTGRES_USER", "POSTGRES_PASSWORD"):
                    if req not in env:
                        bad("pg-credentials", name, f"{req} must be set (required ${{VAR:?}} reference)")
                if env.get("POSTGRES_HOST_AUTH_METHOD", "").strip().lower() == "trust":
                    bad("pg-trust", name, "POSTGRES_HOST_AUTH_METHOD=trust disables password auth")
                settings = _pg_settings(cmd)
                if settings.get("ssl", "").lower() not in ("on", "true", "1") \
                        or not settings.get("ssl_cert_file") or not settings.get("ssl_key_file"):
                    bad("pg-tls", name, "postgres must run with -c ssl=on -c ssl_cert_file=... -c ssl_key_file=...")
                if settings.get("password_encryption") != "scram-sha-256":
                    bad("pg-password-encryption", name, "postgres must run with -c password_encryption=scram-sha-256")
                hba = settings.get("hba_file")
                src = _bind_source(svc, hba, base) if hba else None
                if not hba:
                    bad("pg-hba", name, "no -c hba_file=: the image default pg_hba.conf accepts plaintext logins")
                elif not src or not src.is_file():
                    bad("pg-hba", name, f"hba_file {hba} is not a repo file bind-mounted into the container")
                else:
                    for p in _hba_problems(src):
                        bad("pg-hba", name, f"{src.name} {p}")
                app_user = env.get("APP_DB_USER", "")
                m = REQUIRED_VAR.match(app_user)
                if not m:
                    bad("app-role", name, "APP_DB_USER must be provisioned from a required ${VAR:?} reference")
                elif m.group(1) in pg_bootstrap_vars:
                    bad("app-role", name, f"APP_DB_USER reuses the bootstrap superuser variable {m.group(1)}")
                for other in ("MIGRATE_DB_USER",):
                    m = REQUIRED_VAR.match(env.get(other, ""))
                    if m and m.group(1) in pg_bootstrap_vars:
                        bad("app-role", name, f"{other} reuses the bootstrap superuser variable {m.group(1)}")

            if _is_redis(svc):
                opts = _redis_options(cmd)
                flat = {o: a for o, a in opts}
                if flat.get("port") != ["0"] or "tls-port" not in flat \
                        or "tls-cert-file" not in flat or "tls-key-file" not in flat:
                    bad("redis-tls", name, "redis must run with --port 0 --tls-port N --tls-cert-file ... --tls-key-file ...")
                users = [(a[0], a[1:]) for o, a in opts if o == "user" and a]
                default_rules = [r.lower() for u, rules in users if u == "default" for r in rules]
                if "requirepass" in flat or "off" not in default_rules or "on" in default_rules[default_rules.index("off"):]:
                    bad("redis-default-user", name, "the default user must be disabled (--user default off) and requirepass unused")
                app_users = [(u, rules) for u, rules in users if u != "default" and "on" in [r.lower() for r in rules]]
                good = [
                    (u, rules) for u, rules in app_users
                    if any(r.startswith(">") and REQUIRED_VAR.match(r[1:]) for r in rules)
                ]
                if not good:
                    bad("redis-acl-user", name, "no enabled ACL user with a >${VAR:?} password")
                for u, rules in app_users:
                    if not _acl_least_privilege(rules):
                        bad("redis-acl-privilege", name, f"ACL user {u} must end with -@admin -@dangerous after its last grant")

        # --- app services (built from this repo) -----------------------------------------------
        if "build" in svc:
            db_url, redis_url = env.get("DATABASE_URL"), env.get("REDIS_URL")
            if not db_url or not redis_url:
                bad("app-env", name, "DATABASE_URL and REDIS_URL must be set in compose `environment` (env_file is unverifiable and overridable)")
            if db_url:
                user, pw = _url_cred_refs(db_url)
                refs = {m.group(1) for m in (REQUIRED_VAR.match(user), REQUIRED_VAR.match(pw)) if m}
                if refs & pg_bootstrap_vars:
                    bad("app-db-bootstrap-user", name, f"DATABASE_URL uses the bootstrap superuser ({sorted(refs & pg_bootstrap_vars)})")
                if not REQUIRED_VAR.match(user) or not REQUIRED_VAR.match(pw):
                    bad("literal-credential", name, "DATABASE_URL user and password must be required ${VAR:?} references")
                query = dict(parse_qsl(urlsplit(_mask_refs(db_url)).query))
                if (query.get("sslmode") or query.get("ssl")) != "verify-full":
                    bad("app-db-tls", name, "DATABASE_URL must carry sslmode=verify-full (server certificate + hostname)")
            if redis_url:
                user, pw = _url_cred_refs(redis_url)
                parts = urlsplit(_mask_refs(redis_url))
                reqs = dict(parse_qsl(parts.query)).get("ssl_cert_reqs", "required").lower()
                if parts.scheme != "rediss" or not user or user == "default" or reqs not in ("required", "cert_required"):
                    bad("app-redis-tls", name, "REDIS_URL must be rediss://<acl user>:<password>@... with certificate verification")
                if user and (not REQUIRED_VAR.match(user) or not REQUIRED_VAR.match(pw)):
                    bad("literal-credential", name, "REDIS_URL user and password must be required ${VAR:?} references")

    # Deduplicate (a value can trip the same rule through two paths).
    seen, unique = set(), []
    for f in findings:
        if f not in seen:
            seen.add(f)
            unique.append(f)
    return unique


def main(paths):
    bad = 0
    for p in paths:
        errs = check(p)
        for rule, service, msg in errs:
            print(f"FAIL {p}: [{rule}] {service}: {msg}")
        if not errs:
            print(f"PASS {p}")
        bad += bool(errs)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
