FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y tesseract-ocr libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0 libffi-dev shared-mime-info && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && playwright install chromium --with-deps
COPY . .
RUN mkdir -p /app/live /app/state /app/blackletter_state