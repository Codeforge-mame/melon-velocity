FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.31 /uv /uvx /bin/

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project \
    && uv pip install --python /app/.venv/bin/python --upgrade "yt-dlp[default,curl-cffi]"

COPY app ./app

EXPOSE 8000

CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
