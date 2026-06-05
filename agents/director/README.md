# Otto Director Agent

Python LiveKit Agents worker for the director voice interview path.

The worker owns the realtime audio loop:

1. Join the `director-{capture_session_id}` LiveKit room.
2. Use Deepgram streaming ASR, Silero VAD, LiveKit turn detection, and Cartesia TTS.
3. For each finalized user turn, checkpoint transcript/evidence through Otto's internal API:
   - `POST /api/internal/director-turns/opening`
   - `POST /api/internal/director-turns/ingest`
   - `POST /api/internal/director-turns/context` during worker startup/recovery
   - `POST /api/internal/director-turns/respond` as SSE for decoupled fast speech
   - `POST /api/internal/director-turns/extract` for async structured extraction
   - `POST /api/internal/director-turns/check` for async spoken-output checks
   - `POST /api/internal/director-turns/:turnIndex/delivery`
   - `POST /api/internal/director-turns/complete`
4. Stream the Next.js director respond route, speak from the fast phrasing event, and let
   structured extraction/checking finish asynchronously after delivery.
5. Listen for reliable LiveKit data-channel controls on `otto.director.control`:
   - `mute` and `unmute` track intentional silence without ending or recovering the interview.
   - `pause` and `resume` stop or resume turn handling and interrupt active speech.
   - `end` waits briefly for active delivery evidence, completes the capture session through the
     internal API, publishes `director.session.completed` on the data channel so the browser can
     navigate to synthesis, then disconnects the room. If completion fails, it publishes a
     retryable notice and keeps the room connected so **End** can be pressed again.

The worker also persists the opening voice prompt as `director.opening`. If persistence fails, the
prompt is sent over the data channel as text and is not spoken, preserving the persist before playback
audit invariant.
When a replacement worker starts after a crash, the planning context includes stale pending
deliveries for prior director turns and the opening prompt. The worker marks those as
`failed_text_fallback` before continuing, so completion is not blocked by a decision row whose
planned utterance was saved but whose delivery update never arrived.

## Local setup

```bash
cd agents/director
cp ../../.env.example ../../.env.local
cp .env.example .env
uv sync
uv run otto-director-agent download-files
uv run --no-sync python -m director_agent.schema_contract
../../scripts/with-env.sh .env -- uv run --no-sync otto-director-preflight
../../scripts/with-env.sh .env -- uv run --no-sync otto-director-preflight --strict
uv run --no-sync otto-director-preflight --env-file .env --strict
../../scripts/with-env.sh .env -- uv run --no-sync python -m director_agent.proof_readiness --app-env-file ../../otto-frontend/.env.local --worker-env-file .env --allow-runtime-overrides
OTTO_CAPTURE_SESSION_ID=<existing-director-capture-session-id> ../../scripts/with-env.sh .env -- uv run --no-sync otto-director-turn-smoke
OTTO_CAPTURE_SESSION_ID=<completed-director-capture-session-id> ../../scripts/with-env.sh .env -- uv run --no-sync otto-director-session-verify
../../scripts/with-env.sh .env -- uv run --no-sync otto-director-agent start
uv run --no-sync otto-director-agent start --env-file .env
```

`scripts/with-env.sh` loads the root `.env.local`, then the service `.env`, then restores any
explicit shell environment values. This is intentional for proof commands such as
`OTTO_CAPTURE_SESSION_ID=<id> ...`, where the checked-in template often leaves
`OTTO_CAPTURE_SESSION_ID` blank. Passing only `--env-file .env` to the worker loads only the
director override file and will miss shared values such as `LIVEKIT_URL` unless they are also
present in the shell environment.

## Deployment

The worker can be built as a small container from this directory:

```bash
docker build -f agents/director/Dockerfile -t otto-director-agent .
npm --prefix otto-frontend run eval:director:container
docker run --env-file .env.local --env-file agents/director/.env otto-director-agent
```

The container runs `uv run --no-sync otto-director-agent start`, which starts the LiveKit Agents
production worker using `LIVEKIT_AGENT_NAME` (default `otto-director`). The image also runs
`uv run --no-sync python -m director_agent.schema_contract` and
`uv run --no-sync python -m livekit.agents download-files` at build time, so schema drift fails the
build and Silero VAD / turn-detector assets are available before the first call. Build from the
repository root so the image includes the versioned `prompts/`, `schemas/`, and `probes/` artifacts
that the Python planner reads at runtime. Set the same required environment variables below in the
deployment target, and keep the server-side `LIVEKIT_AGENT_NAME` in sync with the worker so room
dispatches land on this process.

Required environment:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_AGENT_NAME` (defaults to `otto-director`; must match the server-side room dispatch)
- `OTTO_INTERNAL_API_BASE_URL`
- `LIVEKIT_AGENT_SERVICE_TOKEN`
- `DATABASE_URL` in the Next.js deployment. The room-minting route uses this app database URL
  before it dispatches the worker.
- `DATABASE_SERVICE_URL` in the Next.js deployment. This must be the service-role database URL,
  not the RLS-limited app URL, because internal director endpoints resolve `capture_session_id` to
  org/workspace/user before they can set tenant RLS context.
- `ANTHROPIC_API_KEY` for the Next.js `/respond`, `/extract`, and `/check` runtimes. Without it,
  the server/worker use deterministic conversational fallbacks where available.
- `OTTO_DIRECTOR_PREFLIGHT_STRICT=true` for production readiness checks in non-production
  environments. `NODE_ENV=production` automatically enables the same strict requirements. In strict
  mode, missing `ANTHROPIC_API_KEY` is a failure instead of a fallback warning. The worker and
  server-side LiveKit room minting both enforce this, so production startup cannot silently fall
  back to deterministic planning.
- `OTTO_VENDOR_PRIVACY_ACK=true` in strict mode, after confirming the full vendor privacy review
  for the tenant/account. The worker refuses to boot in strict mode without this acknowledgement.
- `OTTO_DEEPGRAM_NO_STORE_ACK=true`, `OTTO_CARTESIA_NO_RETENTION_ACK=true`, and
  `OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true` in strict mode, after confirming Deepgram no-store or
  LiveKit Inference equivalent controls, Cartesia no-retention controls, and Anthropic raw-payload
  logging controls.
- `DIRECTOR_BRAIN_MODEL` and `DIRECTOR_VOICE_MODEL` to override model roles. Director extraction
  defaults to Sonnet, while the latency-critical voice phraser defaults to Haiku.
- `OTTO_VOICE_PHRASE_TIMEOUT_MS` to bound the Sonnet voice rewrite before speech. The default is
  `2500`; if the voice model misses that deadline, the worker speaks the deterministic consultant
  phrasing for the brain's chosen intent and records `voice_timeout_fallback` in decision metadata.
  This marks voice phrasing as degraded without marking transcript extraction or claims as degraded.
- `OTTO_DIRECTOR_PLANNER_RUNTIME=next` to use the Next.js internal endpoints.

Provider environment depends on whether you use LiveKit Inference or direct provider plugins:

- `OTTO_USE_LIVEKIT_INFERENCE=true` to use LiveKit Inference provider strings, or
- `DEEPGRAM_API_KEY` for direct Deepgram plugin usage
- `CARTESIA_API_KEY` for direct Cartesia plugin usage
- `CARTESIA_VOICE_ID` to choose the voice

If `OTTO_USE_LIVEKIT_INFERENCE` is not enabled, the worker fails fast unless both direct provider
keys are present. This keeps a "livekit" room from looking healthy while the audio worker is missing
STT/TTS credentials.

Voice language selection is constrained to the languages both the installed Deepgram STT and
Cartesia TTS plugins can handle for director calls: `en`, `es`, `fr`, `de`, `pt`, `zh`, and `ja`.
If an older session still carries another language code, the worker keeps Deepgram on that requested
language where possible but falls back to English for Cartesia TTS instead of failing the call.

The preflight output includes a `vendor_controls` object for production review. LiveKit recording
and egress default to off, and LiveKit data-channel payloads are not used as a logging sink. Direct
Deepgram mode sets the installed plugin's request-level `mip_opt_out=True` control; the plugin does
not expose a request-level no-store option, so Deepgram no-store plus Cartesia no-retention are
tracked as account-level controls that must be confirmed before setting the strict-mode
acknowledgement variables.

The worker performs no direct database writes. It uses the internal API for transcript/evidence
checkpointing, external memory/context hydration, dispatch, and delivery updates.

## Full production proof

Use this runbook when the goal is to prove the complete voice product, not just the typed or smoke
path.

1. Configure the shared local environment in `.env.local` at the repository root:
   - `DATABASE_URL` and `DATABASE_SERVICE_URL`
   - WorkOS, R2, Inngest, Anthropic, and Voyage/OpenAI keys needed by the app
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_AGENT_NAME`
   - `LIVEKIT_AGENT_SERVICE_TOKEN`, which must exactly match the worker value
   - `OTTO_INTERNAL_API_BASE_URL`, usually `http://localhost:3000` for local proof
   - `OTTO_DIRECTOR_PLANNER_RUNTIME=next`
   - `OTTO_DIRECTOR_PREFLIGHT_STRICT=true`
   - `OTTO_VENDOR_PRIVACY_ACK=true`, `OTTO_DEEPGRAM_NO_STORE_ACK=true`,
     `OTTO_CARTESIA_NO_RETENTION_ACK=true`, and `OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK=true` after the
     vendor privacy review is complete
   - either `OTTO_USE_LIVEKIT_INFERENCE=true` or both `DEEPGRAM_API_KEY` and `CARTESIA_API_KEY`
2. Apply database migrations from `otto-frontend`:

   ```bash
   npm run db:migrate
   ```

3. Start the app:

   ```bash
   cd otto-frontend
   npm run dev
   ```

   For a production-mode check, use `OTTO_DEV_AUTH_BYPASS=false npm run build` and then
   `npm run start` with the same environment.

4. Configure `agents/director/.env` only for director-specific overrides such as
   `LIVEKIT_AGENT_NAME`, endpointing, or smoke-test capture-session values. Shared LiveKit,
   provider, database, and service-token values belong in the repository root `.env.local`.
5. Check the app and worker env together. This catches mismatched service tokens, agent names,
   provider modes, and missing privacy acknowledgements without printing secret values:

   ```bash
   cd agents/director
   ../../scripts/with-env.sh .env -- uv run --no-sync python -m director_agent.proof_readiness \
     --app-env-file ../../otto-frontend/.env.local \
     --worker-env-file .env \
     --allow-runtime-overrides
   ```

6. Prove the worker can boot in strict voice mode:

   ```bash
   cd agents/director
   ../../scripts/with-env.sh .env -- uv run --no-sync otto-director-preflight --strict
   ```

7. Start the worker in the same directory:

   ```bash
   ../../scripts/with-env.sh .env -- uv run --no-sync otto-director-agent start
   ```

   Or run the container after `npm --prefix otto-frontend run eval:director:container`:

   ```bash
   docker run --rm --env-file .env.local --env-file agents/director/.env otto-director-agent
   ```

8. In the browser, open `/onboarding/voice`, pass the consent/microphone gate, complete a real
   director interview, and press **End**. The browser should wait for the worker's
   `director.session.completed` data-channel event, then route to `/synthesis?next=/overview`.
   Note the capture session id shown in the session header or persisted in the capture session row.
9. Run the strict post-call verifier:

   ```bash
   OTTO_CAPTURE_SESSION_ID=<completed-director-capture-session-id> \
     ../../scripts/with-env.sh .env -- uv run --no-sync otto-director-session-verify \
       --env-file .env \
      --app-env-file ../../otto-frontend/.env.local \
       --strict-voice-env
   ```

The verifier must pass without `--allow-incomplete` for final acceptance. A passing result proves
the environment gate, LiveKit room use, vendor-export audit, Deepgram ASR timing, Cartesia TTS
playout timing, Anthropic brain/voice turns, cache telemetry, delivery terminality, synthesis
handoff, and overview readiness for that capture session.

## Verification

`uv run --no-sync python -m director_agent.schema_contract` is the preflight guard for the shared
structured-output contract. It compares `schemas/director-turn-plan.schema.json`,
`slot-state.schema.json`, `claim.schema.json`, and `claim-subject-fields.json` against the Python
Pydantic models and the Anthropic tool schema the worker sends. Run it before deploying the worker
when schema artifacts or planner models change; it exits non-zero on drift. The package also exposes
`otto-director-schema-check` after a fresh `uv sync`, but the module form reads directly from source
and avoids stale local entry points.

`otto-director-turn-smoke` runs the production turn contract without audio for an existing director
capture session:

1. ingest transcript/evidence through the internal API
2. stream `/respond` for the fast spoken utterance and mark delivery completed
3. run `/check` for spoken-output validation
4. run `/extract` for structured slot/claim updates
5. print `decision_log_id`, candidate ids, slot updates, degraded flag, latency timings, and a
   backend pre-TTS budget check

It is the backend proof step before the full LiveKit microphone/TTS session test. The smoke command
only requires `OTTO_INTERNAL_API_BASE_URL`, `LIVEKIT_AGENT_SERVICE_TOKEN`, and
`OTTO_CAPTURE_SESSION_ID`. It does not require LiveKit, Deepgram, Cartesia, or vendor privacy
acknowledgement environment because it only measures ingest + respond + extract; full production
acceptance still needs real LiveKit/Deepgram/Cartesia playout traces for ASR, TTS, interruption,
and end-to-end turn timing.

After a real voice run, verify the fast phraser wrote Haiku telemetry:

```bash
cd otto-frontend
VOICE_TELEMETRY_PROMPTS=director.voice.phrase-intent npm run verify:voice-telemetry
```

Use `VOICE_TELEMETRY_SINCE=<iso timestamp>` to scope the check to a rollout window, and optionally
set `VOICE_TELEMETRY_MAX_AVG_MS=<milliseconds>` when a latency threshold is part of the rollout gate.

`otto-director-session-verify` is the post-call evidence check for a real capture session. It calls
the internal service-token verification endpoint and prints transcript/decision counts, terminal
delivery counts, non-turn voice-prompt delivery counts, candidate-process count, coverage progress,
backend latency, cost/cache telemetry, candidate-process names, coverage ratio, acceptance booleans,
and sorted `failed_acceptance_checks` / `failed_acceptance_details` lists. The details explain the
usual cause and next evidence to inspect for each failed check. It fails sessions that are missing
the opening prompt, opening/non-turn TTS playout evidence, terminal delivery evidence, real ASR
timing, LLM brain/voice turns, candidate processes, or priority coverage progress. Real ASR timing
requires LiveKit/Deepgram transcript metadata, and TTS playout requires LiveKit/Cartesia delivery
metadata; synthetic smoke rows do not satisfy those acceptance checks. Use it
immediately after a real LiveKit session to capture the proof bundle for the plan's acceptance gate.
Unlike the worker preflight,
this verification command only requires `OTTO_INTERNAL_API_BASE_URL`,
`LIVEKIT_AGENT_SERVICE_TOKEN`, and `OTTO_CAPTURE_SESSION_ID`; it does not need LiveKit, Deepgram,
Cartesia, or Anthropic credentials because it reads already-persisted evidence. By default it exits
non-zero when any acceptance check is false; pass `--allow-incomplete` to print the evidence bundle
without failing. If the verification environment itself is incomplete, `--allow-incomplete` prints a
structured preflight bundle naming the missing env vars instead of raising a traceback.
For the final production proof, run it with `--strict-voice-env`; that mode also requires the full
LiveKit/provider/privacy configuration before reading the persisted session evidence, so a passing
verification cannot accidentally skip the provider setup gate. Use the wrapper with
`--env-file .env` and `--app-env-file ../../otto-frontend/.env.local`, as shown in the production proof runbook,
so the verifier sees both shared root config and director overrides.
