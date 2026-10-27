# Corpus app image for the audit F30 end-to-end proof only (tests/e2e/compose.e2e.yml).
# Same application code and the same pinned database/broker client libraries as the unit suite
# (requirements-test.txt: SQLAlchemy, asyncpg, pgvector, Celery, kombu, redis) plus uvicorn. It
# leaves out the runtime image's Tesseract and WeasyPrint, which the store
# connections do not use. The runtime image's own dependency set (requirements.txt) is proven
# separately by tests/e2e/runtime_smoke.sh (audit F31).
FROM python:3.12-slim@sha256:5b8b1421ccb6a525860a77863c049eab5847076cda34e030c75a80c58faf3f3c
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements-test.txt .
RUN pip install --require-hashes --no-cache-dir -r requirements-test.txt
COPY . .
RUN mkdir -p /app/live /app/state
