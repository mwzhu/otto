# Otto Operator Agent

LiveKit worker for operator workflow capture.

It joins rooms named `operator-{capture_session_id}` using
`LIVEKIT_OPERATOR_AGENT_NAME` (default `otto-operator`) and calls the split
operator turn runtime:

- `/api/internal/operator-turns/ingest`
- `/api/internal/operator-turns/plan`
- `/api/internal/operator-turns/dispatch`
- `/api/internal/operator-turns/:turnIndex/delivery`

The worker streams `/plan` with `Accept: text/event-stream`, starts TTS as soon
as `planned_agent_utterance` arrives, then dispatches the full structured plan
and records delivery telemetry after playout.

## Local Run

```bash
cd agents/operator
cp .env.example .env
uv run otto-operator-agent start --env-file .env
```

The operator worker uses health port `8082` by default so it can run beside the
director worker, which uses LiveKit's default `8081`. Override with
`LIVEKIT_OPERATOR_WORKER_HTTP_PORT` if needed.

Keep `LIVEKIT_AGENT_SERVICE_TOKEN` identical to the Next.js app value. In local
development, the frontend can fall back to typed operator turns if LiveKit or
audio provider credentials are missing.
