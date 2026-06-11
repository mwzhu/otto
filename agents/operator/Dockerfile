FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY prompts ./prompts
COPY probes ./probes
COPY schemas ./schemas
COPY agents/realtime_core ./agents/realtime_core
COPY agents/operator/pyproject.toml agents/operator/uv.lock ./agents/operator/
COPY agents/operator/operator_agent ./agents/operator/operator_agent

WORKDIR /app/agents/operator

RUN uv sync --locked --no-dev
RUN uv run --no-sync python -m livekit.agents download-files

CMD ["uv", "run", "--no-sync", "otto-operator-agent", "start"]
