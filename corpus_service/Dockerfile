FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y tesseract-ocr libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0 libffi-dev shared-mime-info && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
# FA-D3C-001 (OR-4, L17.12, Layer 18 W-6): no headless browser in this runtime. No harvester uses one
# (F25: every source is fetched over HTTPS by scraper/net/fetch_policy.py); a source that ever needs a
# rendered page belongs in the separate corpus repository, never in this image.
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN mkdir -p /app/live /app/state /app/blackletter_state