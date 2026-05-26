FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY prompts ./prompts
COPY probes ./probes
COPY schemas ./schemas
COPY agents/director/pyproject.toml agents/director/uv.lock ./agents/director/
COPY agents/director/director_agent ./agents/director/director_agent

WORKDIR /app/agents/director

RUN uv sync --locked --no-dev
RUN uv run --no-sync python -m director_agent.schema_contract
RUN uv run --no-sync python -m livekit.agents download-files

CMD ["uv", "run", "--no-sync", "otto-director-agent", "start"]
