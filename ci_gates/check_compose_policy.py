#!/usr/bin/env python3
"""Compose data-store exposure policy (audit F30).

Fails if a database/broker service publishes host ports, uses a literal or defaulted credential,
runs Redis without a password, or is not on an internal-only network.
Usage: check_compose_policy.py <docker-compose.yml> [...]
"""
import re
import sys

import yaml

STORE_IMAGES = ("postgres", "pgvector", "redis", "mysql", "mariadb", "mongo", "rabbitmq")
KNOWN_DEFAULTS = {"legal", "postgres", "password", "changeme", "admin", "root", "secret", ""}
REQUIRED_VAR = re.compile(r"^\$\{[A-Z0-9_]+:\?[^}]*\}$")


def check(path):
    doc = yaml.safe_load(open(path)) or {}
    errors = []
    nets = doc.get("networks") or {}
    for name, svc in (doc.get("services") or {}).items():
        image = str(svc.get("image", ""))
        if not any(s in image for s in STORE_IMAGES):
            continue
        if svc.get("ports"):
            errors.append(f"{name}: data store publishes host ports {svc['ports']}")
        svc_nets = svc.get("networks") or ["default"]
        svc_nets = list(svc_nets.keys()) if isinstance(svc_nets, dict) else svc_nets
        for n in svc_nets:
            if not (nets.get(n) or {}).get("internal"):
                errors.append(f"{name}: network '{n}' is not internal: true")
        env = svc.get("environment") or {}
        if isinstance(env, list):
            env = dict(e.split("=", 1) if "=" in e else (e, "") for e in env)
        for key in ("POSTGRES_PASSWORD", "POSTGRES_USER", "MYSQL_ROOT_PASSWORD"):
            if key in env:
                val = str(env[key])
                if not REQUIRED_VAR.match(val):
                    errors.append(f"{name}: {key} must be a required ${{VAR:?}} reference, got {val!r}")
                elif val.strip().lower() in KNOWN_DEFAULTS:
                    errors.append(f"{name}: {key} uses a known default")
        if "redis" in image:
            cmd = svc.get("command") or []
            cmd = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
            m = re.search(r"--requirepass\s+(\S+)", cmd)
            if not m:
                errors.append(f"{name}: redis runs without --requirepass")
            elif not REQUIRED_VAR.match(m.group(1).strip("\"'")):
                errors.append(f"{name}: redis password must be a required ${{VAR:?}} reference")
    return errors


def main(paths):
    bad = 0
    for p in paths:
        errs = check(p)
        for e in errs:
            print(f"FAIL {p}: {e}")
        if not errs:
            print(f"PASS {p}")
        bad += bool(errs)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
