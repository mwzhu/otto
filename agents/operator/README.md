# Otto Operator Agent

LiveKit worker for operator workflow capture.

It joins rooms named `operator-{capture_session_id}` using
`LIVEKIT_OPERATOR_AGENT_NAME` (default `otto-operator`) and calls Otto's
operator turn runtime.

- `/api/internal/operator-turns/ingest`
- `/api/internal/operator-turns/respond` when `OTTO_OPERATOR_VOICE_RUNTIME=steered_cascade`
- `/api/internal/operator-turns/extract` for async structured extraction in `steered_cascade`
- `/api/internal/operator-turns/check` for async spoken-output checks in `steered_cascade`
- `/api/internal/operator-turns/plan` and `/dispatch` while the legacy runtime remains enabled
- `/api/internal/operator-turns/:turnIndex/delivery`

By default the operator worker stays on `planned_cascade` during rollout. Set
`OTTO_OPERATOR_VOICE_RUNTIME=steered_cascade` to stream `/respond`, start TTS as
soon as `planned_agent_utterance` arrives, and let structured extraction finish
through `/extract` in the background. `OPERATOR_VOICE_MODEL` controls the fast
voice phraser and defaults to Haiku in `.env.example`.

After a real steered-cascade voice run, verify the fast phraser wrote Haiku
telemetry:

```bash
cd otto-frontend
VOICE_TELEMETRY_PROMPTS=operator.voice.phrase-intent npm run verify:voice-telemetry
```

Use `VOICE_TELEMETRY_SINCE=<iso timestamp>` to scope the check to a rollout
window, and optionally set `VOICE_TELEMETRY_MAX_AVG_MS=<milliseconds>` when a
latency threshold is part of the rollout gate.

## Local Run

```bash
cd agents/operator
cp ../../.env.example ../../.env.local
cp .env.example .env
../../scripts/with-env.sh .env -- uv run --no-sync otto-operator-agent start
```

The operator worker uses health port `8082` by default so it can run beside the
director worker, which uses LiveKit's default `8081`. Override with
`LIVEKIT_OPERATOR_WORKER_HTTP_PORT` if needed.

Shared local secrets live in the repository root `.env.local`; keep
`agents/operator/.env` limited to operator-specific overrides such as
`LIVEKIT_OPERATOR_AGENT_NAME`, health port, language, or runtime rollout flags.
Passing only `--env-file .env` to the worker loads only the operator override
file and will miss shared values such as `LIVEKIT_URL` unless they are also
present in the shell environment.
In local development, the frontend can fall back to typed operator turns if
LiveKit or audio provider credentials are missing.
