# Front end: React + TypeScript, built to static files.
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Server: FastAPI + the daily sync, serving the built front end.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PYTHONIOENCODING=utf-8
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ingest/ ingest/
COPY --from=web /web/dist web/dist

# data/, raw/ and secrets/ are volumes (see docker-compose.yml); nothing personal goes in the image.
USER 1000:1000
EXPOSE 8000
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/status', timeout=5)"
CMD ["python", "-m", "ingest", "serve", "--host", "0.0.0.0", "--port", "8000"]
