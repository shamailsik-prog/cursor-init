#!/usr/bin/env python3
"""Compose data-store policy (audit F30).

Rejects a compose deployment whose data stores are exposed, unauthenticated, plaintext, reachable
with default/literal credentials, or configured outside an allowlist (Postgres server options,
pg_hba.conf users, Redis ACL users and passwords); whose app containers reach them as the
bootstrap superuser, without verified TLS, or can read store credentials, secrets or volumes they
do not use, or get host-level access; or that contains anything the policy cannot vet (unknown
images, repo-built stores). Every finding carries a rule id (RULES); the fixtures under
ci_gates/fixtures/ declare which rules they must trip (ci_gates/test_check_compose_policy.py),
including the re-audit's own attack mutations of the shipped tree (fixtures/shipped_attacks.py).

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
import string
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import yaml

RULES = {
    "store-ports": "a data store publishes host ports",
    "store-network": "a data store is not only on internal: true networks (or uses host/other network modes)",
    "store-image": "a data store is built from a repository Dockerfile (its entrypoint cannot be vetted) "
                   "instead of running a known upstream store image",
    "pg-credentials": "Postgres lacks a required POSTGRES_USER and POSTGRES_PASSWORD (or secret file)",
    "pg-trust": "Postgres password authentication disabled (POSTGRES_HOST_AUTH_METHOD=trust)",
    "literal-credential": "a credential is a literal, a ${VAR} without :? (unset or defaulted), or a non-secret file",
    "pg-tls": "Postgres not started with ssl=on and a server certificate and key",
    "pg-password-encryption": "Postgres password_encryption is not scram-sha-256",
    "pg-hba": "pg_hba.conf missing, unverifiable, or accepting non-TLS TCP, non-SCRAM, or TCP logins for any "
              "user outside the application group (HBA_CLIENT_GROUP)",
    "pg-weakening-flag": "a Postgres server option is repeated, unrecognised, outside the allowlist (PG_ALLOWED), "
                         "or passed through the environment (PGOPTIONS, POSTGRES_INITDB_ARGS)",
    "app-role": "Postgres provisions no application role distinct from the bootstrap superuser",
    "redis-tls": "Redis keeps a plaintext port (needs --port 0 and --tls-port with cert and key)",
    "redis-default-user": "the Redis default user is not disabled (or requirepass gives it a login)",
    "redis-acl-user": "Redis has no enabled application ACL user, or an enabled user without exactly one required-"
                      "secret password (nopass, a second password, or one removed again), or one no app connects as",
    "redis-acl-privilege": "a Redis ACL user is not denied @admin and @dangerous commands",
    "redis-weakening-flag": "a Redis option is repeated, unverifiable (config file, include, aclfile) or weakening",
    "app-db-bootstrap-user": "an app service connects to Postgres as the bootstrap superuser",
    "app-db-tls": "an app service's DATABASE_URL does not require verified TLS (sslmode=verify-full)",
    "app-redis-tls": "an app service's REDIS_URL is not rediss:// with a named ACL user and verified TLS",
    "app-credential-scope": "an app container can read a store credential it does not use (anywhere in the service "
                            "outside its own two URLs: environment, command, healthcheck, build args, a store's "
                            "secret or config), or holds the migration role outside the one-shot migrate service",
    "app-store-volume": "an app service mounts a data store's volume (only the CA volume, read-only, is shared)",
    "app-host-access": "an app service publishes a host port (other than the api's loopback bind) or gets host "
                       "access: privileged, cap_add, devices, a host or another container's namespace, a bind "
                       "mount from outside the repository, or a volume the policy cannot see into",
    "app-env-file": "an app service reads an env_file the policy cannot vet, or one holding credentials",
    "app-image-secrets": "an app image build context does not exclude .env from the image",
    "unvetted-composition": "include: or extends: pulls in configuration outside the vetted files",
    "unknown-service": "a service is neither a known data store, an app built from this repo, nor network-isolated",
    "compose-config": "docker compose cannot resolve the deployment (or is not installed)",
}

SENTINEL = "pv-{}-vp"
SENTINEL_RE = re.compile(r"pv-([A-Za-z0-9_]+)-vp")
REQUIRED_VAR = re.compile(r"^\$\{([A-Za-z0-9_]+):?\?[^}]*\}$")  # anchored: one start, linear
SCHEME_RE = re.compile(r"[a-z0-9+]+://")
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
# The only USER an accepting TCP line of pg_hba.conf may name: the NOLOGIN group that
# docker/postgres/provision-roles.sh creates and puts the application roles in. A constant, not read
# from the hba file under check (that would let the file vouch for itself); the tests pin it to the
# shipped corpus_service/docker/postgres/pg_hba.conf and provision-roles.sh.
HBA_CLIENT_GROUP = "+corpus_clients"
# Allowlist: exactly the server options the shipped compose sets (pinned by the tests). Anything
# else (log_statement, scram_iterations, config_file, include, listen_addresses, ...) is refused.
PG_ALLOWED = {"ssl", "ssl_cert_file", "ssl_key_file", "ssl_ca_file", "ssl_min_protocol_version",
              "password_encryption", "hba_file", "ident_file"}
# Environment variables that hand Postgres options outside the command line: PGOPTIONS reaches
# every libpq session in the container (the init scripts' superuser psql included), and
# POSTGRES_INITDB_ARGS goes to initdb.
PG_OPTION_ENV = {"PGOPTIONS", "POSTGRES_INITDB_ARGS"}
STORE_SERVICE_NAMES = {"postgres": "postgres", "redis": "redis"}
# The one host port an app may publish: the api on loopback (README: put a TLS proxy in front).
APP_ALLOWED_PORTS = {"api": [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 8000,
                              "published": "8000", "protocol": "tcp"}]}
# The one store volume an app may mount, read-only: the CA certificate (no key: README).
APP_SHARED_STORE_VOLUMES = {"tls-ca"}
HOST_NAMESPACE_KEYS = ("network_mode", "pid", "ipc", "userns_mode", "uts", "cgroup")
REDIS_ADMIN_COMMANDS = {
    "config", "flushall", "flushdb", "acl", "debug", "shutdown", "module", "monitor", "replicaof",
    "slaveof", "save", "bgsave", "bgrewriteaof", "migrate", "restore", "keys", "sync", "psync",
    "failover", "cluster", "client", "latency", "memory", "swapdb", "lastsave",
}
REDIS_UNVETTABLE = {"include", "aclfile", "loadmodule", "masterauth", "masteruser", "replicaof", "slaveof"}
REDIS_MUST_BE_NO = {"enable-debug-command", "enable-module-command", "enable-protected-configs"}
REDIS_STRICT_SSL_QUERY = {"ssl_cert_reqs": ("required", "cert_required"),
                          "ssl_check_hostname": ("true", "1", "yes", "on")}
_NAME_CHARS = frozenset(string.ascii_letters + string.digits + "_")


class _RefScanner:
    """${NAME...} references in compose text, found by one left-to-right scan (linear time).

    Same matches as the regexes it replaces, which were quadratic on crafted input such as
    "${a?" * k (every "${" rescanned the rest of the text looking for '}'; re-audit R2-D5):
      VAR_REF       \\$\\{([A-Za-z0-9_]+)((?:[^A-Za-z0-9_}][^}]*)?)\\}   findall -> [(name, rest)]
      REQUIRED_REF  \\$\\{([A-Za-z0-9_]+):?\\?[^}]*\\}                      findall -> [name]
    A start that fails because no '}' follows means no later start can match either, so the scan
    stops; a start that matches resumes after its '}'; any other start costs only its name.
    """

    def __init__(self, required_only):
        self.required_only = required_only

    def _matches(self, text):
        text = str(text)
        n, i = len(text), text.find("${")
        while i >= 0:
            j = i + 2
            while j < n and text[j] in _NAME_CHARS:
                j += 1
            if j > i + 2 and (not self.required_only or text.startswith(("?", ":?"), j)):
                k = text.find("}", j)
                if k < 0:
                    return
                yield i, k + 1, text[i + 2:j], text[j:k]
                i = text.find("${", k + 1)
            else:
                i = text.find("${", i + 1)

    def findall(self, text):
        if self.required_only:
            return [name for _s, _e, name, _rest in self._matches(text)]
        return [(name, rest) for _s, _e, name, rest in self._matches(text)]

    def sub(self, replacement, text):
        text, out, pos = str(text), [], 0
        for start, end, _name, _rest in self._matches(text):
            out += [text[pos:start], replacement]
            pos = end
        return "".join(out) + text[pos:]


VAR_REF = _RefScanner(required_only=False)
REQUIRED_REF = _RefScanner(required_only=True)


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
    """(user, password) of a URL, verbatim; a ${VAR:?msg} reference counts as one token (it may
    contain ':', '/' or '@'). A linear scan, not a regex: the URLs come from compose files, and a
    regex with overlapping alternatives under a repetition backtracks catastrophically on
    crafted input (CodeQL py/redos)."""
    url = url or ""
    m = SCHEME_RE.match(url)
    if not m:
        return "", ""
    parts, current, i, n = [], [], m.end(), len(url)
    while i < n:
        if url.startswith("${", i):
            end = url.find("}", i + 2)
            if end < 0:  # unterminated reference: no userinfo can be read
                return "", ""
            current.append(url[i:end + 1])
            i = end + 1
            continue
        c = url[i]
        if c == "/":  # the path began before any '@': there is no userinfo
            return "", ""
        if c == "@":
            parts.append("".join(current))
            return parts[0], (parts[1] if len(parts) > 1 else "")
        if c == ":":
            parts.append("".join(current))
            current = []
        else:
            current.append(c)
        i += 1
    return "", ""  # no '@'


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
        user = fields[2] if len(fields) > 2 else ""
        if method != "reject" and user != HBA_CLIENT_GROUP:
            problems.append(f"line {n}: a TCP login for USER {user!r}; only {HBA_CLIENT_GROUP} (the application "
                            "roles) may log in over the network")
    return problems


def _acl_least_privilege(rules):
    """True if an ACL rule list cannot reach @admin/@dangerous commands. Rules apply in order and
    categories overlap (+@slow includes CONFIG), so -@admin and -@dangerous must both follow the
    LAST grant. A pure allowlist of commands passes unless it names an admin/dangerous one."""
    low = [r.lower() for r in rules]
    if any(r.startswith("(") for r in low):
        return False  # a selector, e.g. "(+@all)", grants on its own; not analysed, so refused
    grants = [i for i, r in enumerate(low) if r.startswith("+") or r == "allcommands"]
    if not grants:
        return True
    category_grant = any(low[i].startswith("+@") or low[i] == "allcommands" for i in grants)
    risky = [low[i][1:].split("|")[0] for i in grants if low[i][1:].split("|")[0] in REDIS_ADMIN_COMMANDS]
    if not category_grant and not risky:
        return True
    after = low[max(grants) + 1:]
    return "-@admin" in after and "-@dangerous" in after


def _acl_enabled(rules):
    """Whether an ACL rule list leaves the user enabled: the last of on/off/reset wins."""
    state = False
    for r in (x.lower() for x in rules):
        if r == "on":
            state = True
        elif r in ("off", "reset"):
            state = False
    return state


def _acl_password_problems(rules):
    """An enabled user must authenticate with exactly one password, a required ${VAR:?}: one
    '>' rule holding a sentinel, no '#<hash>' (a second password), no nopass anywhere (any
    password works), and nothing after it that removes it again (resetpass, reset, '<', '!')."""
    low = [r.lower() for r in rules]
    problems = []
    passwords = [i for i, r in enumerate(rules) if r.startswith((">", "#"))]
    if "nopass" in low:
        problems.append("nopass (any password is accepted)")
    if len(passwords) != 1 or not rules[passwords[0]].startswith(">") or not _is_sentinel(rules[passwords[0]][1:]):
        problems.append(f"{len(passwords)} password rule(s); exactly one >${{VAR:?}} is required")
    if passwords:
        removed = [r for r in low[passwords[0] + 1:] if r in ("resetpass", "reset") or r.startswith(("<", "!"))]
        if removed:
            problems.append(f"{' '.join(removed)} after the password removes it")
    return problems


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
        if key not in PG_ALLOWED:
            problems.append(f"server option {key} is not on the allowlist ({', '.join(sorted(PG_ALLOWED))})")
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


def _dockerfile_bases(build):
    """Base images named by the FROM lines of a build (dockerfile_inline, or the Dockerfile in
    the context); [] when there is no readable Dockerfile (such a service cannot be built)."""
    text = build.get("dockerfile_inline")
    if text is None:
        dockerfile = Path(str(build.get("dockerfile") or "Dockerfile"))
        path = dockerfile if dockerfile.is_absolute() else Path(build.get("context", ".")) / dockerfile
        try:
            text = path.read_text()
        except (OSError, UnicodeDecodeError):
            return []
    bases = []
    for line in str(text).replace("\\\n", " ").splitlines():
        tokens = line.split()
        if tokens and tokens[0].upper() == "FROM":
            args = [t for t in tokens[1:] if not t.startswith("--")]
            if args:
                bases.append(args[0])
    return bases


def _store_kind_of_image(image):
    fam = _image_family(image)
    return "postgres" if fam in PG_FAMILY else "redis" if fam in REDIS_FAMILY else None


def _namespace_problems(svc):
    """Host-level access an app container may not have (re-audit R2-D4)."""
    problems = []
    if svc.get("privileged"):
        problems.append("privileged: true")
    if svc.get("cap_add"):
        problems.append(f"cap_add {svc['cap_add']}")
    if svc.get("devices"):
        problems.append("devices: host devices handed to the container")
    for key in HOST_NAMESPACE_KEYS:
        value = str(svc.get(key) or "")
        if value == "host" or value.startswith(("service:", "container:")):
            problems.append(f"{key}: {value} (shares the host's or another container's namespace)")
    return problems


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


def _classify(name, svc, project_dir, bad):
    """isolated | postgres | redis | app | unknown. A store is recognised by its image, by the
    base image of a repo build (FROM, also dockerfile_inline), or by its service name, so a
    store rebuilt from the repo is still checked as a store (re-audit R2-D4)."""
    build = svc.get("build") or {}
    if svc.get("network_mode") == "none" and not svc.get("ports"):
        return "isolated"
    kind = _store_kind_of_image(svc.get("image"))
    if kind:
        return kind
    # compose resolves a local context to an absolute path; a remote one (git URL, tarball) stays
    # as written, and must not pass for a path under the current directory.
    context = str(build.get("context") or "")
    if build and Path(context).is_absolute() and _inside(context, project_dir):
        bases = _dockerfile_bases(build)
        if any("$" in b for b in bases):
            bad("unknown-service", name, f"the build's base image is a build variable ({', '.join(bases)}); "
                "the policy cannot tell what runs")
            return "unknown"
        for base in bases:
            kind = _store_kind_of_image(base)
            if kind:
                return kind
        return STORE_SERVICE_NAMES.get(name, "app")
    bad("unknown-service", name, f"image {svc.get('image')!r} is not a known data store, not built from "
        "this repo, and the service is not network_mode: none")
    return "unknown"


def _resolved_checks(model, project_dir, bad):
    services = model.get("services") or {}
    nets = model.get("networks") or {}
    vdefs = model.get("volumes") or {}
    kinds = {name: _classify(name, svc, project_dir, bad) for name, svc in services.items()}
    stores = [name for name in services if kinds[name] in ("postgres", "redis")]
    apps = [name for name in services if kinds[name] == "app"]

    bootstrap, migration, app_role, store_vars = {"POSTGRES_USER", "POSTGRES_PASSWORD"}, set(), set(), set()
    # What the stores mount: no app may mount the same (re-audit R2-D2).
    store_mounts = {"secrets": set(), "configs": set(), "volume": set(), "bind": set(), "files": set()}
    for name in stores:
        svc = services[name]
        env = _env_of(svc)
        for v in list(env.values()) + _as_list(svc.get("command")):
            store_vars |= _sentinel_vars(v)
        for kind_key in ("secrets", "configs"):
            for s in svc.get(kind_key) or []:
                store_mounts[kind_key].add(s.get("source"))
                sdef = (model.get(kind_key) or {}).get(s.get("source")) or {}
                if sdef.get("environment"):
                    store_vars.add(sdef["environment"])
                if sdef.get("file"):  # the same file under another secret name is the same secret
                    store_mounts["files"].add(str(sdef["file"]))
                store_vars |= _sentinel_vars(json.dumps(sdef, sort_keys=True))
        for v in svc.get("volumes") or []:
            if v.get("type") == "volume" and v.get("source"):
                store_mounts["volume"].add(v["source"])
            elif v.get("type") == "bind" and v.get("source"):
                store_mounts["bind"].add(v["source"])
        if kinds[name] == "postgres":
            bootstrap |= _cred_vars(model, svc, "POSTGRES_USER") | _cred_vars(model, svc, "POSTGRES_PASSWORD")
            migration |= _cred_vars(model, svc, "MIGRATE_DB_USER") | _cred_vars(model, svc, "MIGRATE_DB_PASSWORD")
            app_role |= _cred_vars(model, svc, "APP_DB_USER") | _cred_vars(model, svc, "APP_DB_PASSWORD")
    migration |= {"MIGRATE_DB_USER", "MIGRATE_DB_PASSWORD"}
    redis_url_users = set()  # ACL users some client service connects as
    for name, svc in services.items():
        env = _env_of(svc)
        if name in apps:
            for key in ("DATABASE_URL", "REDIS_URL"):
                store_vars |= _sentinel_vars("".join(_userinfo(env.get(key, ""))))
        if name not in stores and env.get("REDIS_URL"):
            redis_url_users.add(_userinfo(env["REDIS_URL"])[0])
    store_vars |= bootstrap | migration | app_role

    def volume_name(key):
        return (vdefs.get(key) or {}).get("name") or key

    store_volume_names = {volume_name(k) for k in store_mounts["volume"]}

    for name, svc in services.items():
        kind = kinds[name]
        env = _env_of(svc)
        cmd = _as_list(svc.get("command"))
        if kind in ("postgres", "redis"):
            if svc.get("build"):
                bad("store-image", name, "data store built from a repository Dockerfile; run the pinned upstream "
                    "image (the policy cannot vet a custom image's entrypoint or baked-in configuration)")
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
            for key in sorted(PG_OPTION_ENV & set(env)):
                bad("pg-weakening-flag", name, f"{key} passes Postgres options outside the vetted command line")
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
            users = {}  # a user named twice: its rule lists apply in order
            for o, a in opts:
                if o == "user" and a:
                    users.setdefault(a[0], []).extend(a[1:])
                    if any(not r or r != r.strip() or len(r.split()) != 1 for r in a):
                        bad("redis-acl-user", name, f"--user {a[0]}: every ACL rule must be its own single-word "
                            "argument (a rule holding spaces cannot be vetted)")
            default_rules = [r.lower() for r in users.get("default", [])]
            if "requirepass" in flat or "off" not in default_rules or "on" in default_rules[default_rules.index("off"):]:
                bad("redis-default-user", name, "the default user must be disabled (--user default off) and requirepass unused")
            enabled = {u: rules for u, rules in users.items() if u != "default" and _acl_enabled(rules)}
            if not enabled:
                bad("redis-acl-user", name, "no enabled ACL user with a >${VAR:?} password")
            for u, rules in enabled.items():
                for p in _acl_password_problems(rules):
                    bad("redis-acl-user", name, f"ACL user {u}: {p}")
                if u not in redis_url_users:
                    bad("redis-acl-user", name, f"ACL user {u} is enabled but no app's REDIS_URL connects as it")
                if not _acl_least_privilege(rules):
                    bad("redis-acl-privilege", name, f"ACL user {u} must end with -@admin -@dangerous after its last "
                        "grant, and may not use (selectors)")
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
                if (uvars | pvars) & migration:
                    # Exactly the one-shot: this command, the image's own entrypoint, never restarted,
                    # nothing published, no Redis (re-audit R2-D2: a substring match let a long-running
                    # "migrate && serve" service hold the schema-owner role).
                    one_shot = (cmd == ["python", "-m", "scraper.migrate"] and not svc.get("entrypoint")
                                and str(svc.get("restart") or "no") == "no" and not svc.get("ports"))
                    if not one_shot or rd:
                        bad("app-credential-scope", name, "the migration (schema-owner) role may only be held by the "
                            "one-shot service whose command is exactly `python -m scraper.migrate` (no entrypoint "
                            "override, restart: \"no\", no ports), without Redis credentials")
            if rd:
                user, pw = _userinfo(rd)
                parts = urlsplit(rd)
                weak = [f"{k}={v}" for k, v in parse_qsl(parts.query, keep_blank_values=True)
                        if k.lower().startswith("ssl_")
                        and v.strip().lower() not in REDIS_STRICT_SSL_QUERY.get(k.lower(), ())]
                if parts.scheme != "rediss" or not user or user == "default" or weak:
                    bad("app-redis-tls", name, "REDIS_URL must be rediss://<acl user>:<password>@... with no ssl_* "
                        f"override weakening verification {weak}")
            _app_scope_checks(name, svc, env, model, project_dir, store_vars, store_mounts, store_volume_names,
                              volume_name, bad)


def _app_scope_checks(name, svc, env, model, project_dir, store_vars, store_mounts, store_volume_names,
                      volume_name, bad):
    """What an app container can reach besides its own two URLs (re-audit R2-D2, R2-D4)."""
    # Credentials: by name in the environment, and anywhere in the resolved service (command,
    # entrypoint, healthcheck, build args, labels, ...) outside the DATABASE_URL/REDIS_URL values.
    for key in env:
        if key not in ("DATABASE_URL", "REDIS_URL") and STORE_CRED_KEY.match(key):
            bad("app-credential-scope", name, f"{key} is a store credential; the app gets only its own URLs")
    scanned = dict(svc)
    scanned["environment"] = {k: v for k, v in env.items() if k not in ("DATABASE_URL", "REDIS_URL")}
    leaked = _sentinel_vars(json.dumps(scanned, sort_keys=True)) & store_vars
    if leaked:
        bad("app-credential-scope", name, f"store credential(s) {sorted(leaked)} outside DATABASE_URL/REDIS_URL")
    for kind_key in ("secrets", "configs"):
        defs = model.get(kind_key) or {}
        for s in svc.get(kind_key) or []:
            src = s.get("source")
            sdef = defs.get(src) or {}
            if src in store_mounts[kind_key]:
                bad("app-credential-scope", name, f"{kind_key[:-1]} {src} is mounted by a data store")
            elif sdef.get("environment") in store_vars or str(sdef.get("file")) in store_mounts["files"] \
                    or _sentinel_vars(json.dumps(sdef, sort_keys=True)) & store_vars:
                bad("app-credential-scope", name, f"{kind_key[:-1]} {src} is sourced from a store credential")

    # Host access.
    ports = svc.get("ports") or []
    if ports and ports != APP_ALLOWED_PORTS.get(name):
        bad("app-host-access", name, f"publishes {ports}; the only app port is the api's 127.0.0.1:8000 bind")
    for p in _namespace_problems(svc):
        bad("app-host-access", name, p)

    # Mounts: nothing a store mounts (the CA volume read-only excepted), nothing from outside the
    # repository, and no volume whose contents the policy cannot see (external, driver, custom name).
    if svc.get("volumes_from"):
        bad("app-store-volume", name, f"volumes_from {svc['volumes_from']} shares another container's mounts")
    project_name = model.get("name")
    env_file = Path(project_dir) / ".env"
    for v in svc.get("volumes") or []:
        vtype, src = v.get("type"), v.get("source")
        if vtype == "volume" and src:
            vname = volume_name(src)
            vdef = (model.get("volumes") or {}).get(src) or {}
            if src in APP_SHARED_STORE_VOLUMES:
                others = {volume_name(k) for k in store_mounts["volume"] if k != src}
                if not v.get("read_only") or vname in others:
                    bad("app-store-volume", name, f"volume {src} must be mounted read-only and be only the CA volume")
            elif src in store_mounts["volume"] or vname in store_volume_names:
                bad("app-store-volume", name, f"volume {src} ({vname}) is a data store's volume")
            elif vdef.get("external") or vdef.get("driver") or vdef.get("driver_opts") \
                    or vname != f"{project_name}_{src}":
                bad("app-host-access", name, f"volume {src} is external, driver-backed or renamed ({vname}); "
                    "the policy cannot see what it holds")
        elif vtype == "bind" and src:
            if not _inside(src, project_dir):
                bad("app-host-access", name, f"bind mount {src} is outside the repository")
                continue
            if _inside(env_file, src):
                bad("app-credential-scope", name, f"bind mount {src} exposes the compose .env (every secret)")
            for store_src in store_mounts["bind"]:
                if _inside(src, store_src) or _inside(store_src, src):
                    bad("app-store-volume", name, f"bind mount {src} overlaps a data store's mount {store_src}")


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
