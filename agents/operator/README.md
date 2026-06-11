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

## Cloud hosting (Fly.io)

The operator worker is hosted on **Fly.io**. (The director worker runs on LiveKit
Cloud Agents, which on the current LiveKit plan is capped at a single agent — see
`agents/director/README.md` — so the operator is deployed to Fly instead.) The
worker registers with LiveKit Cloud (`otto-gcbsujid`) over an outbound WebSocket
as `otto-operator`, exposes no public ports, and Fly keeps one machine running so
it stays registered and restarts on crash. The app config is `agents/operator/fly.toml`.

One-time setup:

```bash
brew install flyctl
fly auth login                 # or: fly auth signup  (Fly account + payment method required)
fly apps create otto-operator  # once; or `fly launch --no-deploy --copy-config --name otto-operator`
```

Secrets live in the git-ignored `agents/operator/.env.fly`. Unlike LiveKit Cloud
Agents, Fly does **not** auto-inject the LiveKit project credentials, so
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are part of this file.
The worker does no direct DB writes, so DB URLs are omitted; it uses LiveKit
Inference, so no direct Deepgram/Cartesia keys are needed.

```bash
# Load secrets (encrypted on Fly)
fly secrets import --config agents/operator/fly.toml < agents/operator/.env.fly

# Build + deploy from the REPOSITORY ROOT (the Dockerfile needs repo-root context)
fly deploy . --config agents/operator/fly.toml --dockerfile agents/operator/Dockerfile
```

Operations and log access:

```bash
fly status   --config agents/operator/fly.toml
fly logs     --config agents/operator/fly.toml   # live tail; shows "registered worker · otto-operator"
fly machine list --config agents/operator/fly.toml
fly deploy . --config agents/operator/fly.toml --dockerfile agents/operator/Dockerfile  # ship a new version
fly apps destroy otto-operator                    # remove the deployment
```

The worker's `agent_name` (`LIVEKIT_OPERATOR_AGENT_NAME=otto-operator` in
`.env.fly`) **must** match the server-side dispatch name in `otto-frontend`
(`lib/adapters/livekit.ts`, env `LIVEKIT_OPERATOR_AGENT_NAME`), or dispatched
jobs never reach the worker.
