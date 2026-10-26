# Phase audit — F46 corpus runtime pins

Finding **F46** (issue #30): production `corpus_service/requirements.txt` and compose
images were mutable, while CI used a different pinned test set, so green tests did not
certify future runtime resolution or parser behaviour.

## RED / GREEN (ledger)

| State | Evidence | Result |
| --- | --- | --- |
| RED | `dcbba659` (main after F45 #149): unpinned `requirements.txt`, mutable `python:3.12-slim` / `pgvector:pg16` / `redis:7-alpine` tags, `requirements-test.txt` as a disjoint minimal pin set | Rebuilds could change SQLAlchemy, PDF parsers, or store images without a source change |
| GREEN (this PR) | `requirements.in` + hash-pinned `requirements.txt`; `requirements-test.txt` compiled as a superset of the production lock; `runtime-images.lock.json` digests in `Dockerfile` and `docker-compose.yml`; `runtime-sbom.json` for parser/stack versions; `ci_gates/check_corpus_runtime_pins.py` (Gate G-0 [24]) rejects unpinned requirement lines and non-`sha256:[0-9a-f]{64}` digests; CI installs with `--require-hashes` | `corpus_service/tests/test_f46_runtime_pins.py`; gate script PASS on shipped tree; re-audit FA-F46-001/002 probes in `ci_gates/test_check_corpus_runtime_pins.py` |

### Re-audit FA-F46-001 (python base digest)

The initial lock carried a **62-hex** `python:3.12-slim` digest (registry `DIGEST_INVALID`). It was replaced with the **64-hex** manifest-list digest returned by Docker Hub for tag `3.12-slim` (`sha256:5b8b1421…f3f3c`), verified with an authenticated registry `HEAD` on `manifests/3.12-slim` (HTTP 200 + `docker-content-digest`). Proof log: `/opt/cursor/artifacts/f46-python-digest-proof.txt` in agent runs.

## Refresh procedure

From `corpus_service/`:

```bash
bash scripts/compile_requirements.sh
```

Re-resolve container digests when bumping base images (update `runtime-images.lock.json`,
`Dockerfile`, `docker-compose.yml`, and `.github/workflows/gate-g0.yml` postgres service
to match). Regenerate `runtime-sbom.json` is included in the compile script.

## Scope note

This closes reproducible **Python** and **store image** pins for the corpus stack. It does
not build or sign the application image in CI (Docker daemon / disk budget); runtime smoke
still proves the locked venv the image would install.

| Claim | Value |
| --- | --- |
| OR-1..OR-4 | unchanged |
| backend_real | false |
| frontend_real | false |
| transport_stub | true |
