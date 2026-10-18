# Corpus app image for the audit F30 end-to-end proof only (tests/e2e/compose.e2e.yml).
# Same application code and the same pinned database/broker client libraries as the unit suite
# (requirements-test.txt: SQLAlchemy, asyncpg, pgvector, Celery, kombu, redis) plus uvicorn. It
# leaves out the runtime image's Playwright/Chromium, Tesseract and WeasyPrint, which the store
# connections do not use. The runtime image's own dependency set (requirements.txt) is proven
# separately by tests/e2e/runtime_smoke.sh (audit F31).
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements-test.txt .
RUN pip install --no-cache-dir -r requirements-test.txt uvicorn==0.54.0
COPY . .
RUN mkdir -p /app/live /app/state
