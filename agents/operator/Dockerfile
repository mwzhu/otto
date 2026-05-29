FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
COPY operator_agent ./operator_agent

RUN uv pip install --system .

CMD ["otto-operator-agent", "start"]
