"""Attack fixtures for ci_gates/check_compose_policy.py (audit F30, re-audit round 2).

Each case is ONE mutation of the shipped corpus_service tree, applied to a fresh copy of it by
ci_gates/test_check_compose_policy.py (ShippedComposeAttacks), which asserts that the policy
reports exactly the rules in "expect" (an empty set means the deployment must pass).

Cases A01-A32 are the round-2 independent auditor's attack compose mutations, copied verbatim
(same anchor strings, same replacements). Cases S01-S27 are siblings of those attacks that the
same fixes must also catch. Review findings on dc265e3: D01-D11 replace the build ignore file
(Docker applies the last matching .dockerignore line), C01-C10 add or reach a network-isolated
helper that holds a store credential or a store's files, H01-H02 change the hba method.
Round-4 re-audit of fd5151b: C11* launder through a chain of helpers (R4-D1), C12* let a
secret-holding helper touch the CA volume apps read (R4-D2). Data only: nothing runs on import.

Edit forms, applied in order to docker-compose.yml:
  ("replace", OLD, NEW)              first occurrence of OLD (it must exist)
  ("splice", START, END, NEW)        text from START up to (not including) END, replaced by NEW
  ("replace_after", ANCHOR, OLD, NEW) first OLD after the first ANCHOR
  ("pg_command_string",)             the postgres command list rewritten as one string
"files" writes extra files (paths relative to corpus_service/); "hba" is (OLD, NEW) in
docker/postgres/pg_hba.conf.

A31/A32 keep the auditor's exact second edit: its anchor ("  redis:\n" / "  postgres:\n") first
matches inside x-runtime-depends, so it moves celery-beat (not the store) onto [edge, data]; the
store itself stays on the internal network and is caught for its build, ports and flags.
"""

API_CMD = "    command: uvicorn scraper.main:app --host 0.0.0.0 --port 8000\n"
PG_LAST_C = "      - ident_file=/etc/postgresql/corpus/pg_ident.conf\n"
PG_NOPORTS = '    # No "ports:" on purpose: reachable only from the internal data network.\n'
REDIS_FN = '      - "-function"\n'
REDIS_NOPORTS = '    # No "ports:" on purpose.\n'
MIGRATE_HDR = "  # One-shot schema migration"
PG_ENV_DB = "      POSTGRES_DB: legal_scraper\n"
API_VOLUMES_END = "      - tls-ca:/run/tls-ca:ro\n    networks: [edge, data]"
HBA_APP_LINE = "hostssl    legal_scraper   +corpus_clients  all       scram-sha-256"
MIGRATE_CMD = '    command: python -m scraper.migrate\n    restart: "no"\n'
WORKER_EMBED_TAIL = (
    "    networks: [edge, data]\n    depends_on: *runtime-depends\n"
    "    command: celery -A scraper.tasks.celery_app worker -Q celery,embeddings --loglevel=INFO\n"
    "    restart: unless-stopped\n\n  # Beat imports"
)
CELERY_BEAT_VOLUMES = "    volumes:\n      - tls-ca:/run/tls-ca:ro\n    networks: [data]\n"
CELERY_BEAT_HDR = (
    "  celery-beat:\n    build: .\n    env_file: app.env\n    environment:\n      <<: *runtime-env\n"
)
# A one-shot, network-isolated helper (C cases): {creds} gives it a store credential, {mounts} its storage.
HELPER = ('  pw-copier:\n    image: pgvector/pgvector:pg16\n'
          '    entrypoint: ["/bin/sh", "-c", "cp /run/secrets/postgres_password /out/pw"]\n'
          '{creds}    volumes:\n{mounts}    network_mode: none\n    restart: "no"\n')


# Round-4 anchors, as the auditor's helper_attacks.py wrote them.
AUD_API_VOLS = ("    volumes:\n      - ./live:/app/live\n      - ./blackletter_state:/app/state\n"
                "      - tls-ca:/run/tls-ca:ro\n    networks: [edge, data]")
PREFLIGHT_VOLS = "    volumes:\n      - ./docker/preflight/check-secrets.sh:/usr/local/bin/check-secrets.sh:ro\n"
CERTS_COMMENT = "  # One-shot: issue (or validate operator-supplied) TLS material"
VOLUMES_BLOCK = "volumes:\n  pgdata:\n  tls-ca:\n  tls-postgres:\n  tls-redis:\n"
# An isolated helper holding no credential of its own, only the volumes it is given (C11/C12 hops).
HOP = ('  {name}:\n    image: pgvector/pgvector:pg16\n    network_mode: none\n    restart: "no"\n'
       '    command: ["true"]\n    volumes:\n{vols}\n')


def pg_c(opt):
    return ("replace", PG_LAST_C, PG_LAST_C + f"      - -c\n      - {opt}\n")


CASES = [
    # ---- the auditor's round-2 attacks (scratchpad f30r2/attacks.py, attacks_build.py) -----------
    {"id": "A01", "title": "profiles: app under profiles:[debug] holding the migration password",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_HDR,
                "  debug-shell:\n    build: .\n    profiles: [debug]\n    env_file: app.env\n"
                "    environment:\n      <<: *runtime-env\n      MIGRATE_DB_PASSWORD: ${MIGRATE_DB_PASSWORD:?x}\n"
                "    networks: [data]\n\n" + MIGRATE_HDR)]},
    {"id": "A02", "title": "network_mode: host on api",
     "expect": ["app-host-access"],
     "edits": [("replace", "    networks: [edge, data]\n    depends_on: *runtime-depends\n" + API_CMD,
                "    network_mode: host\n    depends_on: *runtime-depends\n" + API_CMD)]},
    {"id": "A03", "title": "network_mode: service:postgres on worker-embed (joins the store's namespace)",
     "expect": ["app-host-access"],
     "edits": [("replace", WORKER_EMBED_TAIL,
                '    network_mode: "service:postgres"\n    depends_on: *runtime-depends\n'
                "    command: celery -A scraper.tasks.celery_app worker -Q celery,embeddings --loglevel=INFO\n"
                "    restart: unless-stopped\n\n  # Beat imports")]},
    {"id": "A04", "title": "long-syntax port with host_ip on redis (control)",
     "expect": ["store-ports"],
     "edits": [("replace", REDIS_NOPORTS,
                '    ports:\n      - target: 6379\n        published: "6379"\n        host_ip: 0.0.0.0\n')]},
    {"id": "A06", "title": "privileged + pid: host + cap_add: [ALL] on api",
     "expect": ["app-host-access"],
     "edits": [("replace", API_CMD, API_CMD + "    privileged: true\n    pid: host\n    cap_add: [ALL]\n")]},
    {"id": "A07", "title": "postgres command as one string (control: same settings, must pass)",
     "expect": [],
     "edits": [("pg_command_string",)]},
    {"id": "A08", "title": "postgres -c log_statement=all (provisioning SQL carries passwords)",
     "expect": ["pg-weakening-flag"], "edits": [pg_c("log_statement=all")]},
    {"id": "A09", "title": "postgres -c scram_iterations=1",
     "expect": ["pg-weakening-flag"], "edits": [pg_c("scram_iterations=1")]},
    {"id": "A10", "title": "postgres -c config_file=<repo file> (settings not on the command line become unvetted)",
     "expect": ["pg-weakening-flag"],
     "edits": [pg_c("config_file=/etc/postgresql/corpus/extra.conf"),
               ("replace", "      - ./docker/postgres/pg_ident.conf:/etc/postgresql/corpus/pg_ident.conf:ro\n",
                "      - ./docker/postgres/pg_ident.conf:/etc/postgresql/corpus/pg_ident.conf:ro\n"
                "      - ./docker/postgres/extra.conf:/etc/postgresql/corpus/extra.conf:ro\n")],
     "files": {"docker/postgres/extra.conf": "lo_compat_privileges = on\nscram_iterations = 1\n"}},
    {"id": "A11", "title": "POSTGRES_INITDB_ARGS trust + PGOPTIONS ssl=off in the postgres env",
     "expect": ["pg-weakening-flag"],
     "edits": [("replace", PG_ENV_DB, PG_ENV_DB + '      POSTGRES_INITDB_ARGS: "--auth-host=trust --auth-local=trust"\n'
                '      PGOPTIONS: "-c ssl=off"\n')]},
    {"id": "A12", "title": "pg_hba.conf: hostssl all all all scram-sha-256 (superuser network login over TLS)",
     "expect": ["pg-hba"], "edits": [],
     "hba": (HBA_APP_LINE, "hostssl    all             all              all       scram-sha-256")},
    {"id": "A13", "title": "second bind mount of an insecure hba file at the same target (control)",
     "expect": ["pg-hba"],
     "edits": [("replace", "      - ./docker/postgres/pg_hba.conf:/etc/postgresql/corpus/pg_hba.conf:ro\n",
                "      - ./docker/postgres/pg_hba.conf:/etc/postgresql/corpus/pg_hba.conf:ro\n"
                "      - ./docker/postgres/evil_hba.conf:/etc/postgresql/corpus/pg_hba.conf:ro\n")],
     "files": {"docker/postgres/evil_hba.conf": "host all all all trust\n"}},
    {"id": "A14", "title": "Redis: nopass appended to the app ACL user",
     "expect": ["redis-acl-user"], "edits": [("replace", REDIS_FN, REDIS_FN + '      - "nopass"\n')]},
    {"id": "A15", "title": "Redis: extra enabled ACL user with nopass",
     "expect": ["redis-acl-user"],
     "edits": [("replace", REDIS_FN, REDIS_FN + '      - --user\n      - ops\n      - "on"\n      - "nopass"\n      - "~*"\n'
                '      - "&*"\n      - "+@all"\n      - "-@admin"\n      - "-@dangerous"\n')]},
    {"id": "A18", "title": "x- anchor merges the migration password into api env (control)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", "x-runtime-depends: &runtime-depends\n",
                "x-evil: &evil\n  MIGRATE_DB_PASSWORD: ${MIGRATE_DB_PASSWORD:?x}\n\nx-runtime-depends: &runtime-depends\n"),
               ("replace", "    env_file: app.env\n    environment:\n      <<: *runtime-env\n    volumes:\n      - ./live:/app/live\n"
                "      - ./blackletter_state:/app/state\n      - tls-ca:/run/tls-ca:ro\n    networks: [edge, data]",
                "    env_file: app.env\n    environment:\n      <<: [*runtime-env, *evil]\n    volumes:\n      - ./live:/app/live\n"
                "      - ./blackletter_state:/app/state\n      - tls-ca:/run/tls-ca:ro\n    networks: [edge, data]")]},
    {"id": "A19", "title": "uppercase store image name with a published port (control)",
     "expect": ["app-role", "pg-credentials", "pg-hba", "pg-password-encryption", "pg-tls", "store-network", "store-ports"],
     "edits": [("replace", MIGRATE_HDR, '  pgdebug:\n    image: PGVECTOR/PGVECTOR:PG16\n    ports: ["5433:5432"]\n\n' + MIGRATE_HDR)]},
    {"id": "A20", "title": "digest-pinned image from a non-standard repo with a published port (control)",
     "expect": ["unknown-service"],
     "edits": [("replace", MIGRATE_HDR, "  db2:\n    image: registry.example.com/team/db@sha256:" + "a" * 64
                + '\n    ports: ["5433:5432"]\n\n' + MIGRATE_HDR)]},
    {"id": "A21", "title": "build: context outside the repo, publishing a port (control)",
     "expect": ["unknown-service"],
     "edits": [("replace", MIGRATE_HDR, '  tool:\n    build: /opt/elsewhere\n    ports: ["6380:6379"]\n\n' + MIGRATE_HDR)]},
    {"id": "A22", "title": "repo-built service whose inline Dockerfile is a plaintext Redis, published on 0.0.0.0",
     "expect": ["store-image", "store-ports", "store-network", "redis-tls", "redis-default-user", "redis-acl-user"],
     "edits": [("replace", MIGRATE_HDR, "  cache-debug:\n    build:\n      context: .\n      dockerfile_inline: |\n"
                "        FROM redis:7-alpine\n"
                '        CMD ["redis-server", "--protected-mode", "no"]\n    ports: ["0.0.0.0:6380:6379"]\n'
                "    networks: [edge, data]\n\n" + MIGRATE_HDR)]},
    {"id": "A24", "title": "file-sourced store secrets also handed to api",
     "expect": ["app-credential-scope"],
     "edits": [("replace", "  postgres_password:\n    environment: POSTGRES_PASSWORD\n",
                "  postgres_password:\n    file: ${POSTGRES_PASSWORD_FILE:?x}\n"),
               ("replace", "  migrate_db_password:\n    environment: MIGRATE_DB_PASSWORD\n",
                "  migrate_db_password:\n    file: ${MIGRATE_DB_PASSWORD_FILE:?x}\n"),
               ("replace", API_CMD, API_CMD + "    secrets: [postgres_password, migrate_db_password]\n")]},
    {"id": "A25", "title": "api command carries the migration password into its process env",
     "expect": ["app-credential-scope"],
     "edits": [("replace", API_CMD, '    command: ["sh", "-c", "MIG=${MIGRATE_DB_PASSWORD:?x} exec uvicorn scraper.main:app '
                '--host 0.0.0.0 --port 8000"]\n')]},
    {"id": "A26", "title": "api healthcheck carries the superuser password",
     "expect": ["app-credential-scope"],
     "edits": [("replace", API_CMD, API_CMD + '    healthcheck:\n      test: ["CMD-SHELL", "PGPASSWORD=${POSTGRES_PASSWORD:?x} true"]\n')]},
    {"id": "A27", "title": "api mounts the pgdata volume (raw database files)",
     "expect": ["app-store-volume"],
     "edits": [("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - pgdata:/srv/pgdata:ro\n    networks: [edge, data]")]},
    {"id": "A28", "title": "api mounts the postgres TLS volume (server private key)",
     "expect": ["app-store-volume"],
     "edits": [("replace", API_VOLUMES_END,
                "      - tls-ca:/run/tls-ca:ro\n      - tls-postgres:/srv/pgtls:ro\n    networks: [edge, data]")]},
    {"id": "A29", "title": "environment as a list with a bare MIGRATE_DB_PASSWORD key on celery-beat (control)",
     "expect": ["app-credential-scope", "literal-credential"],
     "edits": [("replace", CELERY_BEAT_HDR,
                "  celery-beat:\n    build: .\n    env_file: app.env\n    environment:\n      - MIGRATE_DB_PASSWORD\n      - PLACEHOLDER=1\n")]},
    {"id": "A30", "title": "long-running API that runs 'scraper.migrate' first, as the migration role (one-shot exemption)",
     "expect": ["app-credential-scope", "app-host-access"],
     "edits": [("replace", MIGRATE_HDR, "  api2:\n    build: .\n    env_file: app.env\n    environment:\n      <<: *app-secrets\n"
                '      DATABASE_URL: "postgresql+asyncpg://${MIGRATE_DB_USER:?x}:${MIGRATE_DB_PASSWORD:?x}@postgres:5432/legal_scraper'
                '?sslmode=verify-full&sslrootcert=/run/tls-ca/ca.crt"\n'
                '      REDIS_URL: ""\n    ports: ["127.0.0.1:8001:8000"]\n    volumes:\n      - tls-ca:/run/tls-ca:ro\n'
                "    networks: [edge, data]\n"
                '    restart: "no"\n    command: sh -c "python -m scraper.migrate && exec uvicorn scraper.main:app --host 0.0.0.0 '
                '--port 8000"\n\n' + MIGRATE_HDR)]},
    {"id": "A31", "title": "the redis service rebuilt from a repo Dockerfile (FROM redis), plaintext and published",
     "expect": ["store-image", "store-ports", "redis-tls", "redis-default-user", "redis-acl-user", "redis-weakening-flag"],
     "edits": [("splice", "  redis:\n    image: redis:7-alpine\n", "    environment:\n      REDIS_APP_USER",
                '  redis:\n    build: ./docker/redis\n    command: ["redis-server", "--protected-mode", "no"]\n'
                '    ports: ["0.0.0.0:6379:6379"]\n'),
               ("replace_after", "  redis:\n", "    networks: [data]\n", "    networks: [edge, data]\n")],
     "files": {"docker/redis/Dockerfile": "FROM redis:7-alpine\n"}},
    {"id": "A32", "title": "the postgres service rebuilt from a repo Dockerfile (FROM pgvector), ssl=off and published",
     "expect": ["store-image", "store-ports", "pg-tls", "pg-password-encryption", "pg-hba"],
     "edits": [("splice", "  postgres:\n    image: pgvector/pgvector:pg16\n", "    environment:\n      POSTGRES_USER",
                '  postgres:\n    build: ./docker/pgimage\n    command: ["postgres", "-c", "ssl=off"]\n'
                '    ports: ["0.0.0.0:5432:5432"]\n'),
               ("replace_after", "  postgres:\n", "    networks: [data]\n", "    networks: [edge, data]\n")],
     "files": {"docker/pgimage/Dockerfile": "FROM pgvector/pgvector:pg16\n"}},

    # ---- siblings the same fixes must also catch --------------------------------------------------
    # R2-D4: host-level access on an app container.
    {"id": "S01", "title": "ipc: host on api", "expect": ["app-host-access"],
     "edits": [("replace", API_CMD, API_CMD + "    ipc: host\n")]},
    {"id": "S02", "title": "a host device handed to api", "expect": ["app-host-access"],
     "edits": [("replace", API_CMD, API_CMD + "    devices: [/dev/sda:/dev/sda]\n")]},
    {"id": "S03", "title": "userns_mode: host on api", "expect": ["app-host-access"],
     "edits": [("replace", API_CMD, API_CMD + "    userns_mode: host\n")]},
    {"id": "S04", "title": "worker-embed joins another container's network namespace", "expect": ["app-host-access"],
     "edits": [("replace", WORKER_EMBED_TAIL,
                '    network_mode: "container:f30-other"\n    depends_on: *runtime-depends\n'
                "    command: celery -A scraper.tasks.celery_app worker -Q celery,embeddings --loglevel=INFO\n"
                "    restart: unless-stopped\n\n  # Beat imports")]},
    {"id": "S05", "title": "celery-beat bind-mounts the Docker socket (a path outside the repository)", "expect": ["app-host-access"],
     "edits": [("replace", CELERY_BEAT_VOLUMES,
                "    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n      - tls-ca:/run/tls-ca:ro\n    networks: [data]\n")]},
    {"id": "S06", "title": "api binds 0.0.0.0 instead of loopback", "expect": ["app-host-access"],
     "edits": [("replace", '      - "${API_BIND:-127.0.0.1}:8000:8000"\n', '      - "0.0.0.0:8000:8000"\n')]},
    {"id": "S07", "title": "celery-beat publishes a port", "expect": ["app-host-access"],
     "edits": [("replace", CELERY_BEAT_HDR, CELERY_BEAT_HDR + '    ports: ["127.0.0.1:9000:9000"]\n')]},
    # R2-D2: store volumes and credentials reaching an app another way.
    {"id": "S08", "title": "api inherits every postgres mount via volumes_from", "expect": ["app-store-volume"],
     "edits": [("replace", API_CMD, API_CMD + "    volumes_from: [postgres]\n")]},
    {"id": "S09", "title": "api mounts the CA volume read-write", "expect": ["app-store-volume"],
     "edits": [("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca\n    networks: [edge, data]")]},
    {"id": "S10", "title": "api mounts the pgdata docker volume under another key (same volume name)",
     "expect": ["app-store-volume"],
     "edits": [("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - pgcopy:/srv/pg:ro\n    networks: [edge, data]"),
               ("replace", "volumes:\n  pgdata:\n", "volumes:\n  pgcopy:\n    name: corpus_service_pgdata\n  pgdata:\n")]},
    {"id": "S11", "title": "api mounts an external volume (contents unknown to the policy)", "expect": ["app-host-access"],
     "edits": [("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - ext:/srv/ext:ro\n    networks: [edge, data]"),
               ("replace", "volumes:\n  pgdata:\n", "volumes:\n  ext:\n    external: true\n  pgdata:\n")]},
    {"id": "S23", "title": "celery-beat bind-mounts the whole project (the compose .env and the store's mounted files)",
     "expect": ["app-credential-scope", "app-store-volume"],
     "edits": [("replace", CELERY_BEAT_VOLUMES,
                "    volumes:\n      - .:/srv/repo:ro\n      - tls-ca:/run/tls-ca:ro\n    networks: [data]\n")]},
    {"id": "S12", "title": "api mounts a compose config sourced from the superuser password", "expect": ["app-credential-scope"],
     "edits": [("replace", API_CMD, API_CMD + "    configs: [pgpw]\n"),
               ("replace", "secrets:\n  postgres_password:\n", "configs:\n  pgpw:\n    environment: POSTGRES_PASSWORD\n\n"
                "secrets:\n  postgres_password:\n")]},
    {"id": "S13", "title": "the superuser password baked into the api image as a build arg", "expect": ["app-credential-scope"],
     "edits": [("replace", "  api:\n    build: .\n", "  api:\n    build:\n      context: .\n      args:\n"
                "        PW: ${POSTGRES_PASSWORD:?x}\n")]},
    {"id": "S14", "title": "migrate runs a shell that serves after migrating (same role, restart no, no ports)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_CMD, '    command: sh -c "python -m scraper.migrate && exec uvicorn scraper.main:app"\n'
                '    restart: "no"\n')]},
    {"id": "S15", "title": "migrate keeps the exact command but an entrypoint runs something else",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_CMD, MIGRATE_CMD + '    entrypoint: ["sh", "-c", "exec sleep infinity", "--"]\n')]},
    # R2-D1: other ways to give a Redis user a second or no password.
    {"id": "S16", "title": "Redis: a second password on the app ACL user", "expect": ["redis-acl-user"],
     "edits": [("replace", REDIS_FN, REDIS_FN + '      - ">${REDIS_PASSWORD:?x}"\n')]},
    {"id": "S17", "title": "Redis: resetpass after the app user's password", "expect": ["redis-acl-user"],
     "edits": [("replace", REDIS_FN, REDIS_FN + '      - "resetpass"\n')]},
    {"id": "S18", "title": "Redis: extra enabled ACL user with a required password, used by no app", "expect": ["redis-acl-user"],
     "edits": [("replace", REDIS_FN, REDIS_FN + '      - --user\n      - ops\n      - "on"\n      - ">${REDIS_OPS_PASSWORD:?x}"\n'
                '      - "~*"\n      - "&*"\n      - "+@all"\n      - "-@admin"\n      - "-@dangerous"\n')]},
    # R2-D3: the same server option through the long form; another hba USER widening.
    {"id": "S19", "title": "postgres --log_statement=all (long option form)", "expect": ["pg-weakening-flag"],
     "edits": [("replace", PG_LAST_C, PG_LAST_C + "      - --log_statement=all\n")]},
    {"id": "S20", "title": "pg_hba.conf: the application line also admits another user", "expect": ["pg-hba"], "edits": [],
     "hba": (HBA_APP_LINE, "hostssl    legal_scraper   +corpus_clients,boot  all       scram-sha-256")},
    # R2-D4: store classification by name, and FROM given by a build variable.
    {"id": "S21", "title": "the redis service built from the repo (otherwise unchanged)", "expect": ["store-image"],
     "edits": [("replace", "  redis:\n    image: redis:7-alpine\n", "  redis:\n    build: ./docker/redis\n")],
     "files": {"docker/redis/Dockerfile": "FROM alpine:3.20\n"}},
    {"id": "S22", "title": "repo-built service whose base image is a build variable", "expect": ["unknown-service"],
     "edits": [("replace", MIGRATE_HDR, "  cache2:\n    build:\n      context: .\n      dockerfile_inline: |\n"
                "        ARG BASE=redis:7-alpine\n        FROM $${BASE}\n    networks: [data]\n\n" + MIGRATE_HDR)]},
    # A21 sibling: compose leaves a remote context as written; checked from corpus_service/ (as the
    # README runs it) it must not pass for a directory of the repository.
    {"id": "S24", "title": "service built from a remote git context, publishing a port", "expect": ["unknown-service"],
     "edits": [("replace", MIGRATE_HDR, '  tool:\n    build: https://github.com/example/evil.git#main\n'
                '    ports: ["6380:6379"]\n\n' + MIGRATE_HDR)]},
    # R2-D1 / redis-acl-privilege siblings: rules the token checks cannot read.
    {"id": "S25", "title": "Redis: nopass hidden inside a multi-word ACL argument", "expect": ["redis-acl-user"],
     "edits": [("replace", REDIS_FN, REDIS_FN + '      - --user\n      - ops\n      - "on nopass ~* +@all -@admin -@dangerous"\n')]},
    {"id": "S26", "title": "Redis: a selector grants the app user every command back", "expect": ["redis-acl-privilege"],
     "edits": [("replace", REDIS_FN, REDIS_FN + '      - "(+@all)"\n')]},
    # A24 sibling: the store's file-sourced secret, handed to api under another secret name.
    {"id": "S27", "title": "the superuser password file mounted on api under another secret name",
     "expect": ["app-credential-scope"],
     "edits": [("replace", "  postgres_password:\n    environment: POSTGRES_PASSWORD\n",
                "  postgres_password:\n    file: ${POSTGRES_PASSWORD_FILE:?x}\n  pw_copy:\n    file: ${POSTGRES_PASSWORD_FILE:?x}\n"),
               ("replace", API_CMD, API_CMD + "    secrets: [pw_copy]\n")]},

    # ---- review P1 on dc265e3: the build ignore file, read the way Docker reads it ----------------
    # The shipped app services build "." with ./Dockerfile, so ./.dockerignore decides whether the
    # compose .env (every secret) is copied into the image by `COPY . .`. Docker applies the LAST
    # matching line, '!' lines re-include, '#' in column 1 is a comment, blank lines are skipped,
    # patterns are relative to the context root ('/' and './' prefixes, trailing '/' are cleaned),
    # and '**' spans any number of directories, none included.
    {"id": "D01", "title": ".dockerignore: .env then !.env (re-included)", "expect": ["app-image-secrets"],
     "edits": [], "files": {".dockerignore": ".env\n!.env\n"}},
    {"id": "D02", "title": ".dockerignore: * then !.env (re-included)", "expect": ["app-image-secrets"],
     "edits": [], "files": {".dockerignore": "*\n!.env\n"}},
    {"id": "D03", "title": ".dockerignore: .env* then !.env.example (.env stays excluded; must pass)", "expect": [],
     "edits": [], "files": {".dockerignore": ".env*\n!.env.example\n"}},
    {"id": "D04", "title": ".dockerignore: **/.env (matches .env at the root; must pass)", "expect": [],
     "edits": [], "files": {".dockerignore": "**/.env\n"}},
    {"id": "D05", "title": ".dockerignore: **/.env then !**/.env (re-included)", "expect": ["app-image-secrets"],
     "edits": [], "files": {".dockerignore": "**/.env\n!**/.env\n"}},
    {"id": "D06", "title": ".dockerignore: a comment and a blank line are ignored (must pass)", "expect": [],
     "edits": [], "files": {".dockerignore": "# !.env would re-include it, but this line is a comment\n\n.env\n#!.env\n"}},
    {"id": "D07", "title": ".dockerignore: /.env and ./.env/ forms are cleaned to .env (must pass)", "expect": [],
     "edits": [], "files": {".dockerignore": "/.env\n!.env\n./.env/\n"}},
    {"id": "D08", "title": ".dockerignore: .env/** excludes only what is under a directory .env", "expect": ["app-image-secrets"],
     "edits": [], "files": {".dockerignore": ".env/**\n"}},
    {"id": "D09", "title": ".dockerignore: a character class the policy does not model excludes nothing (fail closed)",
     "expect": ["app-image-secrets"], "edits": [], "files": {".dockerignore": "[.]env\n"}},
    {"id": "D10", "title": ".dockerignore: an unmodelled negation counts as re-including (fail closed)",
     "expect": ["app-image-secrets"], "edits": [], "files": {".dockerignore": ".env\n!.e[n]v\n"}},
    {"id": "D11", "title": ".dockerignore: a space before # makes it a pattern, not a comment (still excluded; must pass)",
     "expect": [], "edits": [], "files": {".dockerignore": ".env\n #!.env\n"}},

    # ---- review HIGH on dc265e3: a network-isolated helper laundering a store credential ----------
    # The helper holds a store credential and shares storage with an app; network_mode: none must
    # not exempt it. C01 is the reviewer's mutation; C06 (tmpfs, not shared) must pass.
    {"id": "C01", "title": "isolated helper copies the postgres_password secret into a volume api mounts",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_HDR, HELPER.format(creds="    secrets: [postgres_password]\n", mounts="      - shared:/out\n")
                + "\n" + MIGRATE_HDR),
               ("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - shared:/srv/shared:ro\n    networks: [edge, data]"),
               ("replace", "volumes:\n  pgdata:\n", "volumes:\n  shared:\n  pgdata:\n")]},
    {"id": "C02", "title": "the same through a bind-mounted repository directory",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_HDR, HELPER.format(creds="    secrets: [postgres_password]\n", mounts="      - ./handoff:/out\n")
                + "\n" + MIGRATE_HDR),
               ("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - ./handoff:/srv/handoff:ro\n    networks: [edge, data]")]},
    {"id": "C03", "title": "api takes the helper's mounts with volumes_from",
     "expect": ["app-credential-scope", "app-store-volume"],
     "edits": [("replace", MIGRATE_HDR, HELPER.format(creds="    secrets: [postgres_password]\n", mounts="      - shared:/out\n")
                + "\n" + MIGRATE_HDR),
               ("replace", API_CMD, API_CMD + "    volumes_from: [pw-copier]\n"),
               ("replace", "volumes:\n  pgdata:\n", "volumes:\n  shared:\n  pgdata:\n")]},
    {"id": "C04", "title": "the helper takes api's mounts with volumes_from and writes into them",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_HDR, HELPER.format(creds="    secrets: [postgres_password]\n", mounts="      - shared:/out\n")
                .replace("    network_mode: none\n", "    volumes_from: [api]\n    network_mode: none\n") + "\n" + MIGRATE_HDR),
               ("replace", "volumes:\n  pgdata:\n", "volumes:\n  shared:\n  pgdata:\n")]},
    {"id": "C05", "title": "the helper gets the superuser password through environment, not a secret",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_HDR, HELPER.format(creds="    environment:\n      PW: ${POSTGRES_PASSWORD:?x}\n",
                                                       mounts="      - shared:/out\n") + "\n" + MIGRATE_HDR),
               ("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - shared:/srv/shared:ro\n    networks: [edge, data]"),
               ("replace", "volumes:\n  pgdata:\n", "volumes:\n  shared:\n  pgdata:\n")]},
    {"id": "C06", "title": "helper and api each use a tmpfs at the same path (not shared storage; must pass)", "expect": [],
     "edits": [("replace", MIGRATE_HDR, HELPER.format(creds="    secrets: [postgres_password]\n", mounts="")
                .replace("    volumes:\n", "    tmpfs: [/out]\n") + "\n" + MIGRATE_HDR),
               ("replace", API_CMD, API_CMD + "    tmpfs: [/out]\n")]},
    {"id": "C07", "title": "an isolated service built from the repository is checked as an app",
     "expect": ["app-credential-scope"],
     "edits": [("replace", MIGRATE_HDR, "  tool:\n    build: .\n    secrets: [postgres_password]\n    network_mode: none\n\n"
                + MIGRATE_HDR)]},
    {"id": "C08", "title": "an isolated service with an image the policy does not know", "expect": ["unknown-service"],
     "edits": [("replace", MIGRATE_HDR, "  tool:\n    image: alpine:3.20\n    network_mode: none\n\n" + MIGRATE_HDR)]},
    # The shipped helpers are checked too: secrets-preflight holds every store password, certs
    # writes the store TLS volumes; neither may share a mount with an app (tls-ca:ro excepted).
    {"id": "C09", "title": "api binds the directory whose script the shipped secrets-preflight mounts",
     "expect": ["app-credential-scope"],
     "edits": [("replace", API_VOLUMES_END, "      - tls-ca:/run/tls-ca:ro\n      - ./docker/preflight:/srv/pf:ro\n"
                "    networks: [edge, data]")]},
    {"id": "C10", "title": "celery-beat binds the directory whose script the shipped certs one-shot mounts",
     "expect": ["app-credential-scope"],
     "edits": [("replace", CELERY_BEAT_VOLUMES,
                "    volumes:\n      - ./docker/certs:/srv/certs:ro\n      - tls-ca:/run/tls-ca:ro\n    networks: [data]\n")]},

    # ---- review MEDIUM on dc265e3: hostssl lines accept SCRAM only ----------------------------------
    {"id": "H01", "title": "pg_hba.conf: the application line uses cert instead of scram-sha-256", "expect": ["pg-hba"],
     "edits": [], "hba": (HBA_APP_LINE, "hostssl    legal_scraper   +corpus_clients  all       cert")},
    {"id": "H02", "title": "pg_hba.conf: the application line uses md5 over TLS", "expect": ["pg-hba"],
     "edits": [], "hba": (HBA_APP_LINE, "hostssl    legal_scraper   +corpus_clients  all       md5")},

    # ---- re-audit round 4 (delta of fd5151b) --------------------------------------------------------
    # R4-D1: laundering through a chain of isolated helpers. C11 is the auditor's C_two_hop, verbatim.
    {"id": "C11", "title": "secrets-preflight -> hopA -> hop2 -> hopB -> api (two hops)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", PREFLIGHT_VOLS, PREFLIGHT_VOLS + "      - hopA:/out\n"),
               ("replace", AUD_API_VOLS, AUD_API_VOLS.replace("      - tls-ca:/run/tls-ca:ro\n",
                                                               "      - tls-ca:/run/tls-ca:ro\n      - hopB:/in\n")),
               ("replace", CERTS_COMMENT, HOP.format(name="hop2", vols="      - hopA:/a\n      - hopB:/b\n") + CERTS_COMMENT),
               ("replace", VOLUMES_BLOCK, VOLUMES_BLOCK + "  hopA:\n  hopB:\n")]},
    {"id": "C11b", "title": "secrets-preflight -> hopA -> hop2 -> hopB -> hop3 -> hopC -> api (three hops)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", PREFLIGHT_VOLS, PREFLIGHT_VOLS + "      - hopA:/out\n"),
               ("replace", AUD_API_VOLS, AUD_API_VOLS.replace("      - tls-ca:/run/tls-ca:ro\n",
                                                               "      - tls-ca:/run/tls-ca:ro\n      - hopC:/in\n")),
               ("replace", CERTS_COMMENT, HOP.format(name="hop2", vols="      - hopA:/a\n      - hopB:/b\n")
                + HOP.format(name="hop3", vols="      - hopB:/b\n      - hopC:/c\n") + CERTS_COMMENT),
               ("replace", VOLUMES_BLOCK, VOLUMES_BLOCK + "  hopA:\n  hopB:\n  hopC:\n")]},
    {"id": "C11c", "title": "the hop through a bind-mounted repository directory (preflight -> ./handoff -> hop2 -> hopB -> api)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", PREFLIGHT_VOLS, PREFLIGHT_VOLS + "      - ./handoff:/out\n"),
               ("replace", AUD_API_VOLS, AUD_API_VOLS.replace("      - tls-ca:/run/tls-ca:ro\n",
                                                               "      - tls-ca:/run/tls-ca:ro\n      - hopB:/in\n")),
               ("replace", CERTS_COMMENT, HOP.format(name="hop2", vols="      - ./handoff:/a\n      - hopB:/b\n") + CERTS_COMMENT),
               ("replace", VOLUMES_BLOCK, VOLUMES_BLOCK + "  hopB:\n")]},
    # R4-D2: only a helper that holds no store secret (the shipped certs) may write the CA volume
    # apps read. C12 is the auditor's C_write_tls_ca, verbatim.
    {"id": "C12", "title": "an isolated helper holding a store secret writes tls-ca (api reads tls-ca:ro)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", CERTS_COMMENT, "  poison:\n    image: pgvector/pgvector:pg16\n    network_mode: none\n"
                "    restart: \"no\"\n    command: [\"true\"]\n    secrets: [postgres_password]\n    volumes:\n"
                "      - tls-ca:/tls/ca\n\n" + CERTS_COMMENT)]},
    {"id": "C12b", "title": "a helper tainted only through a shared volume (preflight -> hopA) writes tls-ca",
     "expect": ["app-credential-scope"],
     "edits": [("replace", PREFLIGHT_VOLS, PREFLIGHT_VOLS + "      - hopA:/out\n"),
               ("replace", CERTS_COMMENT, HOP.format(name="poison2", vols="      - hopA:/a\n      - tls-ca:/tls/ca\n")
                + CERTS_COMMENT),
               ("replace", VOLUMES_BLOCK, VOLUMES_BLOCK + "  hopA:\n")]},
    {"id": "C12c", "title": "a helper holding a store secret mounts tls-ca even read-only (refused: it may not touch it)",
     "expect": ["app-credential-scope"],
     "edits": [("replace", CERTS_COMMENT, "  poison:\n    image: pgvector/pgvector:pg16\n    network_mode: none\n"
                "    restart: \"no\"\n    command: [\"true\"]\n    secrets: [postgres_password]\n    volumes:\n"
                "      - tls-ca:/tls/ca:ro\n\n" + CERTS_COMMENT)]},
    {"id": "C12d", "title": "a renamed volume that is tls-ca under another key, written by a secret-holding helper",
     "expect": ["app-credential-scope"],
     "edits": [("replace", CERTS_COMMENT, "  poison:\n    image: pgvector/pgvector:pg16\n    network_mode: none\n"
                "    restart: \"no\"\n    command: [\"true\"]\n    secrets: [postgres_password]\n    volumes:\n"
                "      - ca-alias:/tls/ca\n\n" + CERTS_COMMENT),
               ("replace", VOLUMES_BLOCK, VOLUMES_BLOCK + "  ca-alias:\n    name: corpus_service_tls-ca\n")]},
]
