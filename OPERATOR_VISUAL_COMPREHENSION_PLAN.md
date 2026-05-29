# Operator Visual Comprehension & Durable Capture Plan

Status: v4 — remaining Codex findings incorporated (fallback semantics, schema/idempotency, webhook source-of-truth, test coverage). Last updated 2026-05-29.

## Guiding idea

Keep live keyframes for responsiveness, add durable recording for completeness, and
build **one real visual comprehension pipeline** that both live and uploaded captures
use. Prove comprehension on uploaded recordings first (no infra risk, fully testable),
then wire live capture into the same analyzer via LiveKit Egress.

The single highest-leverage change is **comprehension, not recording**: perfect
recording with a deterministic "vision" stub barely improves output. Real frame
decoding + OCR + selective multimodal is what turns captured pixels into evidence the
workflow engine can reason over.

## Current architecture (verified)

- **Live screenshare** (`otto-frontend/app/process/[id]/capture/screenshare/ScreenshareClient.tsx`):
  hidden `<video>`/`<canvas>` samples a keyframe every 500ms, dedupes via a 16x9
  luminance perceptual hash (Hamming distance, threshold 0.08), uploads JPEG keyframes
  (<=960px, q0.72) as `screen_frame` artifacts. No `MediaRecorder`, no durable recording —
  a missed 500ms window is lost forever.
- Each frame -> `POST /operator-captures/:id/screen-frames` creates a `screen_event`
  (tagged `screen_keyframe_pending_vision`), an `evidence` row, optionally a
  `provisional_step`, and fires Inngest `operatorScreenFrameCaptured` ->
  `processOperatorScreenFrame` -> `analyzeScreenFrame`.
- **Upload flow**: a `video` artifact fires `operatorScreenRecordingUploadedEventName` ->
  `operatorCaptureReady` -> `processScreenRecordingArtifact` -> `analyzeScreenRecording`
  (real Deepgram audio transcription) -> synthesis. Idempotency via advisory locks +
  `audit_log` dedup.
- **The two holes:**
  1. `analyzeScreenFrame` (`lib/adapters/vision.ts`) is `provider: "deterministic-screen-vision"` —
     it never reads the image; it runs keyword heuristics over text it already has.
  2. `analyzeScreenRecording` (`lib/adapters/screen-recording-analyzer.ts`) emits
     `deterministicKeyframes` placeholders with `keyframe_ocr_provider_not_configured` —
     no real frame decode, OCR, or multimodal.
- **Anticipated infra already present**: `lib/adapters/livekit.ts` imports
  `RoomServiceClient`/`AccessToken` and carries an `egress_recording_default: "off"` flag;
  the installed LiveKit SDK exposes `EgressClient`, `startRoomCompositeEgress`,
  `startTrackCompositeEgress`, `S3Upload`, and webhooks. ffmpeg is already spawned for
  audio demux, so frame extraction extends an existing pattern.

## Goal & success criteria

1. A live screenshare produces a durable video artifact (no frame lost to the 500ms gap).
2. Keyframes get real OCR + selective multimodal labels (not `deterministic-screen-vision`).
3. Live and upload flows share **one** analyzer.
4. Synthesis flags gaps and the agent can ask about them.
5. Cost stays bounded by gating expensive calls.

---

## Phase 0 — Stabilize current dogfood

- Keep the live `Screen keyframes captured N` UI in `ScreenshareClient.tsx`.
- Add visible capture-health states: LiveKit connected, mic publishing, screen track
  publishing, keyframes saved, agent joined, recording active. (A 4s warning already
  exists in the sampler — extend it.)
- Add route-level logging around `/api/livekit/operator-room`,
  `/operator-captures/:id/screen-frames`, `/operator-captures/:id/complete`.
- Treat `0 keyframes after 5s` as **degraded** (warn), not failed.
- Make `/complete` succeed even if the background Inngest enqueue fails (decouple the
  user-facing completion from the async send).

## Phase 1 — Data model

Migration for durable recording + structured visual facts.

Extend `capture_sessions`:
- `recording_artifact_id uuid`
- `recording_status text`
- `recording_started_at`, `recording_completed_at`
- `recording_provider text`
- (egress metadata may also live in `metadata_json`)

Add `visual_observations`:
- identity/links: `id`, `org_id`, `workspace_id`, `capture_session_id`, `screen_event_id`,
  `artifact_id`, `ts_ms`
- content: `provider NOT NULL`, `ocr_text`, `ui_summary`, `structured_json`, `confidence`,
  `degraded_reasons`
- provenance (mirror existing tables): `model NOT NULL`, `prompt_template_id`,
  `prompt_template_version`,
  `idempotency_key NOT NULL`
- lifecycle: `emits_evidence boolean NOT NULL DEFAULT true`, `evidence_id uuid REFERENCES
  evidence(id)`, `redacted_at`, `tombstoned_at`, `created_at`, `updated_at`
- **unique constraint** to make retries idempotent:
  `UNIQUE (org_id, screen_event_id, provider, idempotency_key)`. `model` is encoded in the
  deterministic key; do not include nullable columns in the retry guard.
- **`provider`, `model`, and `idempotency_key` must be `NOT NULL`.** A plain unique constraint
  allows duplicate `NULL`s in Postgres, so nullable identity fields defeat the purpose. Use
  sentinel values such as `deterministic-local` / `none` when a real provider or model is absent.
  Derive the key deterministically per frame the way the existing pipeline already does for
  provisional steps (`screen-recording:{artifactId}:step:{index}`) — e.g.
  `screen-vision:{artifactId|captureSessionId}:{screenEventId}:{provider}:{model}:{promptVersion}`.
- **Evidence link constraint:** observations that emit evidence must link exactly one evidence row:
  `CHECK (emits_evidence = false OR evidence_id IS NOT NULL)` plus a partial unique index
  `UNIQUE (evidence_id) WHERE evidence_id IS NOT NULL`. Non-meaningful/degraded observations may
  set `emits_evidence = false` and skip evidence creation.

**Lifecycle ownership (resolves the "produces but must not duplicate" tension):**
`evidence` remains the single **source of record** that synthesis cites. `visual_observations`
is the **enrichment/provenance store**: the raw structured model output. Each observation with
`emits_evidence = true` generates exactly **one** `evidence` row, linked via `evidence_id`.
Synthesis reads `evidence` (optionally joining `visual_observations` for structured detail), never
both as independent evidence. Redaction tombstones the observation and its linked evidence together.

Multimodal `structured_json` schema:

```ts
{
  ui_state_label: string;
  ocr_text: string;
  systems: string[];
  visible_fields: string[];
  actions_observed: string[];
  errors_or_warnings: string[];
  decisions_or_approvals: string[];
  copied_values_or_artifacts: string[];
  confidence: number;
}
```

---

# Track A — Make upload analysis real first

Fastest path to quality; fully testable with a fixture video; no LiveKit Egress risk.
Every improvement here is reused by the live flow in Track B.

## Phase A1 — Real frame extraction

**Respect the existing adapter/persistence boundary.** `screen-recording-analyzer.ts` is a
pure analysis adapter; `processScreenRecordingArtifact` owns all persistence (artifacts,
`screen_events`, `evidence`, advisory-lock idempotency, audit logs, temp-file cleanup). Do
**not** move DB writes into the adapter.

- **Analyzer** (`lib/adapters/screen-recording-analyzer.ts`): replace `deterministicKeyframes`
  with real ffmpeg extraction (ffmpeg is already spawned for audio demux). It **returns** frame
  candidates as `{ tsMs, perceptualHash, bytes: Buffer }[]` plus the existing transcript. No
  artifact/DB writes here. **No temp paths cross the boundary** — the analyzer extracts to a
  temp dir, reads the frames into buffers, and deletes its own temp dir in a `finally` before
  returning. (If per-recording memory becomes a concern for very long captures, switch to
  returning temp paths **plus a `cleanup()` handle the processor calls in its own `finally`** —
  but do not have the analyzer both return paths and clean them up itself.)
  - **Scene-change detection primary** (`select='gt(scene,0.4)'`).
  - **Low FPS floor only** (~0.1–0.2 FPS) to avoid missing static-but-important screens.
    Do NOT use 1 FPS as a baseline — a 20-min capture at 1 FPS is ~1200 frames and will
    blow OCR/step time budgets.
  - Extra frames around transcript trigger words.
  - Dedupe with perceptual hash before returning.
- **Processor** (`processScreenRecordingArtifact`): owns presign+upload of each returned frame
  as a `screen_frame` artifact, creation of `screen_events`/`evidence`, idempotency, audit
  logs, and cleanup — same as it does today for the deterministic path.

Trigger words:

```text
click, submit, approve, reject, error, exception, wait, export,
download, upload, copy, paste, spreadsheet, reconcile, override
```

## Phase A2 — OCR provider abstraction

New `lib/adapters/ocr.ts` with pluggable providers:
- `deterministic` (fallback)
- `tesseract-local` (default; via `spawn`)
- `hosted-ocr`
- `multimodal-vision`

OCR's primary job here is the **cheap triage gate** ("did text change enough to spend a
multimodal call?"), not final evidence — important frames get read by multimodal anyway.
So Tesseract noise on small fonts/tables is tolerable for v1; don't over-invest in OCR
accuracy. Selectable per workspace/data tier.

**Runtime detection + degraded fallback (don't break dogfood/deploys):** `tesseract-local`
depends on a `tesseract` binary that may be absent locally or in a deploy image. On startup (or
first use) detect the binary; if missing, log a degraded reason and fall back to the
`deterministic` provider rather than throwing. The gate then runs on diff-score/transcript
triggers alone until OCR is available. Document the install requirement (e.g. a Docker layer)
for environments that want real OCR.

## Phase A3 — Gated multimodal vision

Replace the body of `analyzeScreenFrame` (`lib/adapters/vision.ts`) so that when a frame
passes the gate it calls a real multimodal model (via `lib/adapters/llm.ts` or a
dedicated vision client) with the image + OCR text, returning the structured schema
above. Keep `deterministic-screen-vision` as the fallback provider so nothing breaks when
keys are absent.

Call multimodal only when:
- visual diff is high,
- OCR changed meaningfully,
- transcript trigger nearby,
- frame contains forms/tables/errors,
- frame occurs near a step boundary,
- user/agent marked importance.

## Phase A4 — `visual_observations` + synthesis integration

- Write multimodal output to `visual_observations`; derive `evidence` from it.
- Update `lib/synthesis/operator-process.ts` to load `visual_observations`. Evidence pack:
  transcript segments, screen events, visual observations, extracted keyframes,
  provisional steps, degraded reasons.
- Synthesis prompt should explicitly ask: what did the operator say; what did the screen
  prove; where do narration and visual evidence disagree; which fields/systems/artifacts
  are visible; which steps are inferred vs observed.

## Phase A5 — Redaction of observations & frames (ships with the new evidence type)

Redaction is split across the two tracks because the policy depends on the recording format
(which doesn't exist until Track B). **Here in Track A**, extend the cascade in
`lib/redactions/operator-redaction.ts` to tombstone `visual_observations` and their linked
`evidence` (and the extracted `screen_frame` artifacts) for a redacted time-window. This is
well-defined now because these rows already carry `ts_ms` and `redacted_at`/`tombstoned_at`.

**Recording-artifact redaction is deferred to Phase B4** — its policy depends on whether the
recording is an Egress object, a chunk manifest, or a concatenated artifact.

---

# Track B — Make live screenshare produce a recording

Once Track A proves comprehension, live screenshare creates a durable video artifact and
sends it into the **same** analyzer.

## Phase B1 — LiveKit Egress (primary)

- Add an egress adapter to `lib/adapters/livekit.ts` named for the real unit of work (a track,
  not a room): `startOperatorTrackEgress`, `stopOperatorTrackEgress`,
  `getOperatorTrackEgressStatus`. `startOperatorTrackEgress` takes explicit
  `{ roomName, screenTrackSid, audioTrackSid?, captureSessionId }` — these come from the
  `track_published` webhook, so the names/params shouldn't pretend it's room-level work.
- **Egress mode is decided by a spike, not assumed.** Required outputs: screen-only video,
  operator mic audio, optionally agent audio, and synchronized timestamps. Track composite may
  require explicit video/audio track IDs and may not include "room audio" automatically. The
  spike chooses among `TrackCompositeEgress`, `ParticipantEgress`, and `RoomCompositeEgress`
  against those requirements. (`RoomComposite` is the fallback; it composites the audio-only
  agent participant into a layout, which is not what we want for clean process evidence.)
- **Start egress from a server-side LiveKit webhook receiver on the screen track's
  `track_published` event** — NOT browser-driven (fragile around tab close/network) and NOT at
  room creation (the screen track doesn't exist yet, so you'd record a blank room).
  - New route `app/api/internal/livekit/webhook/route.ts` is a **LiveKit webhook receiver**
    (not "egress-webhook"). It must verify the signature via LiveKit `WebhookReceiver`, be
    idempotent on `(room, track_sid, capture_session_id)`, and define a race policy for
    duplicate/replayed track events (start-once guard).
  - The webhook must derive `capture_session_id` from server-owned room identity: encode it in the
    room name (`operator-capture-{captureSessionId}` or equivalent) and/or signed room metadata
    written by `/api/livekit/operator-room`, then verify the mapping against `capture_sessions`
    before starting egress. Do not trust client-supplied track names or participant metadata as the
    sole source of truth.
- Store egress metadata + state on `capture_sessions` (`recording_status` drives the machine).
- **Egress finalization is a state machine, not a synchronous step.** The output is usually
  **not** ready at the moment the user clicks "complete." Flow:
  1. On capture complete → request `stopOperatorTrackEgress` and set `recording_status =
     "stopping"`. The user-facing `/complete` returns immediately (does not block on egress).
  2. Register the `video` artifact and fire `operatorScreenRecordingUploadedEventName` **only
     after** the LiveKit `egress_ended` webhook fires (or a verified status poll confirms the
     output object exists), then set `recording_status = "ready"`.
  3. On egress failure/timeout → `recording_status = "failed"`. If a MediaRecorder fallback was
     already recording in parallel, finalize that artifact; otherwise mark the capture degraded and
     use live-preview keyframes as the lossy fallback. Do **not** claim MediaRecorder fallback after
     the fact — if it was not running, the missing video cannot be recovered.
  - Reuses the Track A pipeline; respect the existing advisory-lock + audit-log idempotency —
    do not create a parallel processing entrypoint.

## Phase B2 — MediaRecorder fallback (secondary)

When Egress env is unconfigured, record with `MediaRecorder`. During early Egress rollout, optionally
run MediaRecorder in **shadow fallback** mode until Egress has proven healthy for the workspace; this
is the only way to recover a full recording if Egress fails mid-session. Uploading 5s chunks does
**not** by itself yield one usable `video` artifact — pick one finalization design:
- **Option A — best-effort local fallback (simplest, NOT crash-safe): single final Blob.**
  Accumulate chunks in memory/IndexedDB; on completion concatenate to one Blob and upload as a
  single `video` artifact, then fire `operatorScreenRecordingUploadedEventName`. Note clearly:
  this does **not** survive tab close or crash — if the session dies mid-capture, nothing is
  uploaded. Acceptable as a v1 best-effort fallback, but it is not a completeness guarantee.
- **Option B — resilient fallback: chunk artifacts + manifest + server-side concat.** Upload
  each chunk as an artifact during the session, plus a manifest (ordered chunk artifact IDs +
  timing); a server step ffmpeg-concats into the final recording artifact before firing the
  event. Survives tab close (chunks already uploaded), more moving parts.

Recommendation: ship Option A for v1 only if it's explicitly framed as best-effort; if the fallback
must actually guarantee a recording when Egress is off or when Egress fails mid-session, do Option B
and start it concurrently with Egress during the rollout window. (Egress remains the real durability
path — the fallback exists for unconfigured environments and temporary rollout confidence.)

Keep a rolling ~30s buffer regardless so redaction-last-30s stays coherent. If both Egress and
MediaRecorder fail, mark capture **degraded, not failed**, and fall back to live keyframes.

## Phase B3 — Resolve live-vs-extracted frame dedup (REQUIRED before B ships)

Live sampler frames and recording-extracted frames cover the same timestamps and would
double-count in synthesis. Decision: **demote live keyframes to in-call preview** and treat
recording-extracted frames as the sole evidence source.

Concrete mechanism (the live frame route already writes `screen_events`/`evidence`/
`provisional_steps`, so demotion needs an explicit marker, not just intent):
- Tag live-frame rows at creation: `screen_events.metadata_json.source = "live_preview"` and
  the derived `evidence.evidence_label = "preview"` (or a `preview` flag column).
- Synthesis **excludes** `preview` evidence whenever the capture session has a
  `recording_artifact_id` set. If no recording exists (Egress + MediaRecorder both failed),
  preview evidence is kept as the degraded fallback.
- **Provisional steps too, not just evidence.** The live frame route already inserts
  `provisional_steps` with `source = "live_screen_segmenter"`. These seed the process graph
  independently of the evidence filter, so graph seeding must **also** exclude
  `source = "live_screen_segmenter"` steps when `recording_artifact_id` is set (recording-derived
  steps use `source = "video_segmenter"`). Otherwise preview-derived steps leak into the graph
  even after the real recording is processed.

## Phase B4 — Recording-artifact redaction (deferred from A5)

Now that the recording format is known, extend the cascade to the recording. v1 policy: on a
time-window redaction overlapping the recording, **delete the whole recording (Egress object,
chunk artifacts + manifest, or concatenated artifact) but keep already-derived non-overlapping
observations/evidence** — those were tombstoned per-window in A5 and remain individually safe.
Do not build ffmpeg subclip excision in v1; the UI must state that redaction drops the source
video.

---

## Phase C — Live agent awareness & gap detection

## C1 — Adaptive in-call keyframes
Raise sample rate transiently on large diff scores; force a keyframe near transcript
trigger words; tag `operator_emphasis` so those always go to multimodal. This improves
*live* agent awareness; the durable recording already guarantees completeness for
synthesis.

## C2 — Gap detection & targeted follow-up
After synthesis, detect coverage gaps (steps with visual evidence but no narration;
decision points with no stated rule; unexplained transitions; low-confidence steps).
Route them through the existing `followUpTasks` mechanism (durable, assignable) **and**
feed open gaps to the live director/operator agent so it asks:
- "I saw an export step — what happens to that CSV?"
- "I noticed an error banner — is that common?"
- "You switched to a spreadsheet — is that the source of truth?"

This is the lever that decides whether output is trustworthy: capturing everything is not
understanding everything — the non-visual "why"/exceptions/branches require the agent to ask.

---

## Cost controls (cross-cutting)

```text
All frames:      hash + metadata
Selected frames: OCR
Important frames: multimodal
Final synthesis:  transcript + selected visual observations
```

Default production settings:
- baseline extraction: scene-change primary + ~0.1–0.2 FPS floor
- OCR: all selected frames (triage gate)
- multimodal: top 20–60 frames per capture, scaled by duration
- recording retention follows workspace/data tier: delete-after-extraction by default, retain with TTL
  only when replay/reprocessing is enabled
- cap multimodal calls per session; record spend via `writeAgentDecision` (`costCents`)

## Tests

- Live screenshare creates capture + room + recording metadata.
- `/complete` succeeds even if background enqueue fails.
- Recording analyzer extracts **real** frames from a fixture video (non-placeholder,
  `extraction_status: ocr_extracted` / multimodal).
- OCR provider populates `ocr_text`.
- Multimodal provider writes `visual_observations`.
- Synthesis evidence pack includes visual observations.
- Redaction deletes/tombstones recording, frames, observations, embeddings; preserves
  safe non-overlapping derived evidence.
- LiveKit webhook receiver verifies signatures and rejects unsigned/invalid requests.
- Duplicate/replayed `track_published` webhook starts Egress once, keyed by
  `(room, track_sid, capture_session_id)`.
- `egress_ended` finalization registers exactly one video artifact and fires
  `operatorScreenRecordingUploadedEventName` once, even under webhook replay or status-poll retry.
- MediaRecorder fallback test covers the selected finalization path:
  - Option A: final Blob upload creates one `video` artifact only when completion runs.
  - Option B: chunk manifest + server concat survives tab close and creates one `video` artifact.
- Egress failure with no concurrent MediaRecorder records a degraded capture and keeps only
  preview evidence; Egress failure with shadow MediaRecorder finalizes the fallback artifact.
- Regression: existing upload contract test still passes.

Fixture: a short workflow video with a visible form, spreadsheet, export, and error message.

## Rollout (feature-flagged)

1. Phase 0 health UI + no-500 completion.
2. `OTTO_OPERATOR_FRAME_EXTRACTION_ENABLED` — real frame extraction (Track A1).
3. `OTTO_OPERATOR_OCR_PROVIDER` — OCR (A2).
4. `OTTO_OPERATOR_VISION_PROVIDER` — gated multimodal (A3).
5. `visual_observations` + synthesis (A4) + observation/frame redaction (A5).
6. `OTTO_OPERATOR_EGRESS_ENABLED` — durable live recording (Track B1/B2).
7. Route live recordings through the same analyzer; resolve dedup (B3); recording redaction (B4).
8. Adaptive keyframes (C1).
9. Gap detection + targeted follow-up (C2).
10. Enable production-quality mode per workspace/data tier.

## Locked sequence (highest-leverage first)

1. Real ffmpeg frame extraction — analyzer **returns** candidates, `processScreenRecordingArtifact`
   **persists** (scene-change primary, low FPS floor).
2. Pluggable OCR (tesseract-local as triage gate).
3. Gated multimodal -> `visual_observations` (with idempotency unique constraint).
4. `visual_observations` table + wire into operator synthesis (evidence is source of record).
5. Redaction of observations/frames (A5).
6. LiveKit Egress — egress mode chosen by spike, started via server-side LiveKit **webhook
   receiver** on screen-track `track_published` -> durable video artifact.
7. Route live recording through the same analyzer; demote live frames to `preview` (B3);
   recording-artifact redaction (B4).
8. Adaptive in-call keyframes for live agent awareness.
9. Gap detection -> `followUpTasks` + targeted agent questions.

## Resolved (from review)

- **`visual_observations` ownership:** `evidence` is the synthesis source of record;
  observations are the enrichment/provenance store and generate exactly one evidence row each.
- **Redaction split:** observation/frame redaction in Track A (A5); recording-artifact
  redaction in Track B (B4), once the recording format is fixed.

## Open questions

- Confirm `lib/adapters/llm.ts` is image-capable, or add a dedicated vision client.
- Egress mode (`TrackComposite` vs `ParticipantEgress` vs `RoomComposite`) — resolve via the
  B1 spike against the required-outputs list.
- MediaRecorder finalization: Option A (single final Blob) vs Option B (chunks + manifest +
  server concat). Recommend A for v1.
- **Recording retention** (product/privacy call): recommend delete-after-extraction for the
  default data tier, retain-for-replay (with TTL) behind a per-workspace/higher-tier flag.
  Affects redaction, cost, and trust/replay.
- Should gap detection block "ready for approval" or only advise?
