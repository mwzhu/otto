# Operator Capture -> Process Map — Phase 2 + 3 Plan v2

This is the updated implementation plan for the operator layer: voice-only interview, screen-share + voice interview, screen-recording upload, and SOP/document upload all feeding one evidence-backed, versioned workflow map.

This version folds in the director voice latency learning: the live agent should not do a sequential "brain call" and "voice phrasing call" by default. The hot path should use one Sonnet planning call that returns both structured control data and the exact sentence/question to speak next.

---

## Core Thesis

**Decouple capture from synthesis, but keep live response latency sacred.**

```
capture modes                                  synthesis
────────────────────────────────────          ────────────────────────────────
voice interview ─┐
screen + voice ──┤  write to one evidence      read one evidence pack
video upload ────┼─ substrate ───────────────▶ graph builder ─▶ draft version
SOP upload ──────┘

evidence substrate:
  transcript_segments
  screen_events
  document_chunks
  provisional_steps
  evidence
  claims
```

Capture modes are different ways of collecting evidence. Synthesis produces the canonical map from that evidence. The graph builder is mode-blind for process semantics, but it still sees evidence quality/provenance through `evidence.source_type`, `evidence.evidence_label`, and capture/source metadata for confidence, retention, debugging, and UX.

For live interviews:

```
ASR final
  -> ingest transcript/evidence
  -> one Sonnet plan call returns structured plan + planned_agent_utterance
  -> dispatch/write telemetry
  -> TTS starts
```

Screen vision and live segmentation are advisory. They must not block TTS.

---

## What We Are Building

Four operator capture modes:

1. **Voice-only interview**
   The operator explains the workflow while Otto asks step-boundary, handoff, system, source-of-truth, exception, and workaround questions.

2. **Screen-share + voice interview**
   The operator walks Otto through the live process. Otto uses transcript plus screen events to ask about missing context, observed workarounds, exceptions, duplicate entry, and SOP contradictions.

3. **Screen-recording upload**
   The user uploads a narrated or silent process recording. Batch processing extracts transcript, screen events, provisional steps, and follow-up gaps.

4. **SOP/document upload**
   The user uploads process documentation attached to an existing process. SOPs are documented evidence, not truth; contradictions with observed behavior are preserved.

Output:

- draft `process_versions` row
- canonical graph tables
- `process_versions.graph_json` render cache
- Summary and Steps tabs backed by DB
- node-level evidence links
- approval flow

Explicitly out of this phase:

- multi-operator semantic merge/Hungarian alignment
- ROI dollar engine
- full Impact/Insights/Risk tab depth
- desktop helper

Instead, a second capture creates a **new draft version**. FDE/director review chooses which draft to approve. Automatic merge lands in Phase 4.

---

## Current Repo Baseline

Already exists:

- `capture_sessions`, `artifacts`, `transcript_segments`, `document_chunks`, `evidence`, `claims`, `slot_states`, `agent_decision_log`, `interview_state`, `probe_firings`, `synthesis_runs`, `synthesis_stage_outputs`
- `capture_type` includes `operator_interview`, `screen_recording_upload`, `document_upload`, `mixed`
- `artifact_type` includes `video`, `screen_frame`
- Director realtime agent and split internal route pattern
- R2 presigned upload and document pipeline
- `ProcessCanvas`, graph node components, `ProcessGraph` type, workspace tabs, evidence drawer shell

Missing:

- canonical graph tables
- screen events table
- provisional step model
- operator slot schema/tools/brain
- operator capture APIs
- process-specific upload completion
- operator synthesis DAG
- screen frame/keyframe/vision pipeline
- redaction saga for screen/audio-derived artifacts

---

## Design Decisions

### 1. One Evidence Substrate

Every capture mode writes the same kinds of rows. Synthesis reads an `OperatorEvidencePack`, not four mode-specific pipelines.

Evidence pack includes:

- process and workspace
- capture sessions
- transcript segments
- screen events
- document chunks
- provisional steps
- active claims
- existing process version, if any
- source/capture metadata for provenance

### 2. One-Call Live Planning

For live director and operator interviews, the default is one Sonnet call per turn that returns:

- structured extraction/control data
- slot updates
- claims/tool calls
- ranked intents
- phase state
- chosen intent
- `planned_agent_utterance`

Separate voice phrasing remains only for fallback/debug:

```env
OTTO_DIRECTOR_USE_SEPARATE_VOICE_LLM=false
OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM=false
```

Fallback order for live utterance:

1. `plan.planned_agent_utterance`
2. deterministic phrase from chosen intent
3. generic safe fallback: "What part of that should we go deeper on next?"

Missing or invalid `planned_agent_utterance` should not degrade the whole extraction turn. Record it in voice/delivery metadata:

```json
{
  "utterance_source": "deterministic_phrase_fallback",
  "reason": "missing_planned_agent_utterance"
}
```

### 2.1 Live Latency Mechanism

Collapsing two LLM calls into one is necessary, but not sufficient. The hot path should not wait for the entire structured JSON plan before starting speech.

The plan call must be optimized for early speech:

1. Prompt Sonnet to decide the next question first, then do bookkeeping.
2. Order the model/tool schema and examples so these fields are emitted before heavier arrays:
   - `chosen_intent`
   - `planned_agent_utterance`
   - compact phase state
   - slot updates, claims, tool calls, ranked intents, contradiction signals
3. Stream the planning response.
4. Detect when the `planned_agent_utterance` JSON string value is *closed* (its closing quote arrives in the streamed `input_json_delta`) — not on the first delta, so a half-token fragment is never spoken.
5. Start TTS immediately from that completed utterance.
6. Continue reading/parsing/validating the rest of the structured plan.
7. Run dispatch writes concurrently with TTS where possible.

For Anthropic tool-use streaming, this means parsing streamed `input_json_delta` chunks enough to identify a complete `planned_agent_utterance` string. Existing metadata should record whether the stream stopped at the first question/utterance or waited for message completion:

```json
{
  "streaming": true,
  "stream_cutoff": "first_question",
  "utterance_source": "brain_planned_utterance"
}
```

The prompt should keep the quality tradeoff explicit: the model should choose the next intent and utterance first, then emit extraction/bookkeeping fields. That preserves conversational responsiveness without asking the voice phrase to be invented before the strategic choice is made.

TTS does not need to wait for the dispatch DB transaction once the utterance is known. The worker should start TTS and dispatch concurrently, then reconcile delivery telemetry once `decision_log_id` is available.

**Where the stream lives (decision).** Streaming only helps if the worker can read `planned_agent_utterance` before the rest of the JSON arrives, so the live planning call must stream *to the worker*. Resolution: `/api/internal/{kind}-turns/plan` returns a streaming response (SSE/chunked) that forwards the Anthropic `input_json_delta` stream as it arrives, and the Python worker's HTTP client stream-parses it for the utterance. This keeps the brain (prompt assembly, schema, controller) in TypeScript, consistent with the rest of the director design. It requires two concrete changes: `/plan` must stream rather than return a single JSON body, and `agents/*/otto_api.py` must stop calling `response.json()` on the plan call and instead consume the stream. The buffered `response.json()` path survives only for the dev/sim/typed-fallback route. (Rejected alternative: the worker calling Anthropic directly — lowest latency, but it would duplicate prompt/schema assembly in Python. A fully buffered `/plan` is an acceptable first cut, but it yields only the round-trip savings, not the early-utterance savings, so treat it as a fallback, not the target.)

**Barge-in before dispatch.** Because TTS can now start before `/dispatch` returns `decision_log_id`, supersession can fire while no decision row exists yet. The worker tags the turn with a local correlation ID at plan time, and must handle "superseded before `decision_log_id` existed": cancel TTS, hold the correlation ID, and reconcile the eventual delivery status (`truncated` / `not_spoken`) against the decision row once dispatch returns. Delivery telemetry is keyed by correlation ID until it can be joined to `decision_log_id`.

Failure rule:

- If TTS starts but dispatch fails, retry dispatch with the same idempotency key.
- If dispatch cannot be recovered, write a durable notice/fallback decision log on the next successful internal call.
- Delivery telemetry should carry a local turn correlation ID so spoken audio can be tied back to the eventual decision row.

Move the important persona/phrasing guidance from the standalone voice prompt into the plan prompt's cached static block:

- warm but efficient operations consultant
- do not sound like a survey
- acknowledge briefly, then ask one targeted question
- keep it short for voice
- anchor in concrete examples where useful

**Cost.** One Sonnet planning call per turn replaces the prior Haiku-brain + Sonnet-voice pair from `BUILD_PLAN.md` §14. The added `planned_agent_utterance` output (~30-50 tokens) is marginal on top of the existing ~500-token structured output; moving extraction from Haiku to Sonnet raises per-call cost but removes a whole call, so net per-interview cost is roughly a wash at higher quality. Confirm against the §14 budget once measured, and keep the §14.1 2x-baseline cost alert.

### 3. Relational Graph Is Canonical; `graph_json` Is Cache

The canvas should read `process_versions.graph_json` for speed. But nodes, edges, exceptions, workarounds, variants, and claims need stable row IDs. Graph writes are relational-first, then projected to `graph_json` in the same transaction.

Node evidence is not optional. It is the trust model.

### 4. Draft Version Exists Before Graph Rows

`process_nodes.version_id` references `process_versions.id`, so the draft version row must exist before graph rows are inserted.

Correct stage shape:

1. Create hidden draft `process_versions` row at the start of graph build.
2. Write graph rows against it.
3. Write `graph_json`.
4. Only at publish stage set `processes.current_draft_version_id`.

If synthesis fails mid-run, the draft row may exist, but it is not visible as current because the process pointer was never moved.

### 5. Shared Realtime Core, Flexible Deployment

Do not copy the director worker wholesale into a second divergent operator worker.

Extract a shared realtime core for:

- session lifecycle
- LiveKit data-channel handling
- turn supersession/interruption
- delivery telemetry
- pause/mute/end controls
- completion retry
- deterministic fallback tagging

Deployment can still be:

- one worker with director/operator entrypoints, or
- two deploy targets importing the same shared core

That deployment choice can be driven later by screen dependencies, memory pressure, or failure isolation.

### 6. Extract Shared Interview Core Incrementally

Do not begin by extracting the whole director controller. Start with boring primitives:

- prompt/static block builder
- decision log writer
- delivery metadata helper
- fallback/degraded tagging
- idempotency and timing helpers
- transcript/evidence ingest utilities where safe

Defer extracting the rules controller and claim preflight until operator behavior is concrete.

### 7. Hierarchical Graph Build

A 45-minute operator capture can produce 40+ steps. One LLM call emitting the whole graph can exceed output limits and become brittle.

Graph build should be hierarchical:

1. Segment evidence into phases/chunks.
2. Build step candidates per chunk.
3. Normalize roles/systems across chunks.
4. Stitch chunk boundaries and cross-chunk edges.
5. Build final graph rows and render cache.

### 8. No Ordinal Uniqueness On Provisional Inserts

Live segmenter and `markStepBoundary` may both produce provisional steps concurrently. Do not enforce `unique(capture_session_id, ordinal)` at insert time.

Store:

- `source`
- `source_event_id` or `idempotency_key`
- `ts_start_ms`
- `ts_end_ms`
- optional `ordinal_hint`

Stage 2 dedupes and assigns canonical order.

### 9. Minimal Redaction Ships With Screen Capture

The moment screen capture can store frames, the product must be able to redact a time window.

Minimum same-milestone redaction:

- stop future reads/synthesis from using the time window
- tombstone transcript/screen rows in the window
- hard-delete raw/keyframe artifacts for the window
- audit outcome

Full cascade can deepen after:

- claim confidence/reversion
- embedding purge
- trace purge
- draft regeneration

---

## Data Model

Use migrations `0005` through `0007`, plus Drizzle updates in `otto-frontend/lib/db/schema.ts`.

Every table gets `org_id`, RLS enabled/forced, and `org_id = app_current_org_id()` policy.

### `0005_operator_graph.sql`

Add enums:

- `process_node_type`: `start`, `task`, `decision`, `wait`, `handoff`, `exception`, `end`
- `process_edge_type`: `seq`, `conditional`, `handoff`, `parallel`
- `process_node_level`: `L3`, `L4`

Add `process_nodes`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `process_id uuid not null references processes(id)`
- `version_id uuid not null references process_versions(id)`
- `parent_node_id uuid references process_nodes(id)`
- `ordinal integer not null`
- `level process_node_level not null default 'L4'`
- `node_type process_node_type not null`
- `title text not null`
- `description text`
- `lane_role_id uuid references roles(id)`
- `owner_role_id uuid references roles(id)`
- `owner_person_id uuid references people(id)`
- `sla_seconds integer`
- `frequency text`
- `est_minutes_per_run numeric(10,2)`
- `automation_candidate boolean default false not null`
- `confidence numeric(4,3) default 0 not null`
- `position_json jsonb default '{}' not null`
- `metadata_json jsonb default '{}' not null`
- `evidence_count integer default 0 not null`
- `top_evidence_ids uuid[] default '{}' not null`
- timestamps

Add `process_edges`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `process_id uuid not null references processes(id)`
- `version_id uuid not null references process_versions(id)`
- `source_node_id uuid not null references process_nodes(id)`
- `target_node_id uuid not null references process_nodes(id)`
- `edge_type process_edge_type not null`
- `label text`
- `condition text`
- `probability numeric(5,4)`
- `is_exception_path boolean default false not null`
- `metadata_json jsonb default '{}' not null`
- `evidence_count integer default 0 not null`
- `top_evidence_ids uuid[] default '{}' not null`
- timestamps

Add:

- `node_systems(node_id, system_id, usage, evidence_ids[])`
- `node_io(id, node_id, kind, name, description, evidence_ids[])`
- `exceptions(id, node_id, sub_type, label, trigger, detection, handler_role_id, frequency_pct, time_to_resolve_seconds, impact_cents, evidence_count, top_evidence_ids[])`
- `workarounds(id, node_id, description, why_it_exists, evidence_count, top_evidence_ids[])`
- `variants(id, node_id, condition, alt_node_id, evidence_count, top_evidence_ids[])`

Add claim subjects to `schemas/claim-subject-fields.json`:

- `process_node`
- `process_edge`
- `exception`
- `workaround`
- `variant`
- `narrative_paragraph`

### `0006_capture_evidence.sql`

Add `screen_events`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `capture_session_id uuid not null references capture_sessions(id)`
- `ts_ms integer not null`
- `event_type text not null`
- `app_name text`
- `window_title text`
- `url text`
- `ocr_text text`
- `ui_state_label text`
- `screenshot_artifact_id uuid references artifacts(id)`
- `signal_tags text[] default '{}' not null`
- `metadata_json jsonb default '{}' not null`
- `deleted_at timestamptz`
- `redacted_at timestamptz`
- timestamps

Add `provisional_steps`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `capture_session_id uuid not null references capture_sessions(id)`
- `process_id uuid references processes(id)`
- `ts_start_ms integer not null`
- `ts_end_ms integer`
- `ordinal_hint integer`
- `action_verb text`
- `action_object text`
- `system_id_set uuid[] default '{}' not null`
- `candidate_role_id uuid references roles(id)`
- `source text not null`
- `source_event_id text`
- `idempotency_key text`
- `superseded_by_node_id uuid references process_nodes(id)`
- `confidence numeric(4,3) default 0 not null`
- `metadata_json jsonb default '{}' not null`
- timestamps

Indexes:

- `(capture_session_id, ts_start_ms)`
- unique partial `(capture_session_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
- `(process_id)`

Extend `slot_states`:

- `provisional_step_id uuid references provisional_steps(id)`
- partial unique index:
  `(capture_session_id, provisional_step_id, slot_path) WHERE provisional_step_id IS NOT NULL`

Step-scoped slots use `provisional_step_id`. Capture-level slots remain global. Candidate-process scoped slots remain for director inventory.

Add `capture_mode` as a real column on `capture_sessions`:

- values enforced in code first: `director_voice`, `operator_voice`, `operator_screenshare`, `screen_recording_upload`, `process_document_upload`, `mixed`

Keep `capture_type` as broad lifecycle category; use `capture_mode` for analytics, UX, retention, and synthesis provenance.

### `0007_redactions.sql`

Add `redactions`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `capture_session_id uuid not null references capture_sessions(id)`
- `start_ms integer not null`
- `end_ms integer not null`
- `requested_by_user_id uuid references users(id)`
- `reason text`
- `status text not null`
- `failure_reason text`
- `affected_artifact_ids uuid[] default '{}' not null`
- `affected_trace_ids uuid[] default '{}' not null`
- `started_at timestamptz`
- `completed_at timestamptz`
- timestamps

Extend `synthesis_run_type` with:

- `process_graph`

---

## Plan Schema And Live Planner Contract

Extend director and operator turn plan schemas with:

```json
{
  "planned_agent_utterance": {
    "type": "string",
    "minLength": 1,
    "description": "The exact next sentence/question Otto should say aloud. Must be concise, natural, and ask at most one question."
  }
}
```

Guardrails:

- one question max
- no internal slot names
- no extraction mechanics
- concise enough for voice
- reflects `chosen_intent`
- acknowledges corrections or contradictions when relevant

Schema tolerance:

- The model-facing Anthropic tool schema may list `planned_agent_utterance` as required, to nudge the model toward always producing it.
- The server-side validators (Zod/Pydantic) must NOT mark it required: an absent field must not fail the turn. Keep `minLength: 1` so it is rejected only when present-and-empty.
- On missing or blank, fall back to deterministic phrasing and record voice fallback metadata; never drop the rest of the extraction.
- Tests should cover three cases: valid utterance, present-but-empty, and absent.

Update:

- `schemas/director-turn-plan.schema.json`
- new `schemas/operator-turn-plan.schema.json`
- Python Pydantic models
- TypeScript Zod schemas
- schema contract tests

Telemetry in `delivery_json.voice_metadata`:

```json
{
  "utterance_source": "brain_planned_utterance",
  "llm_call_elided": true,
  "model": "claude-sonnet-4-6"
}
```

Other possible sources:

- `separate_voice_llm`
- `deterministic_phrase_fallback`
- `generic_safe_fallback`

Track:

- `pre_tts_total_ms`
- brain latency
- utterance source
- fallback rate
- old separate voice call usage

---

## Live Turn Runtime

The real LiveKit path uses split internal routes, not a single fat turn endpoint.

Pattern:

1. ASR final in Python worker.
2. `POST /api/internal/{kind}-turns/ingest`
   - writes transcript segments
   - creates evidence
   - returns `turn_index`, `transcript_segment_ids`, `evidence_ids`
3. `POST /api/internal/{kind}-turns/plan`
   - one Sonnet call
   - returns structured plan plus `planned_agent_utterance`
   - streams the response (SSE/chunked); the worker stream-parses for the early utterance (see §2.1 "Where the stream lives"). A buffered single-JSON response is dev/fallback only.
4. Worker chooses utterance from streamed plan field or fallback.
5. Worker starts TTS as soon as utterance is available.
6. `POST /api/internal/{kind}-turns/dispatch` runs concurrently when possible
   - writes slot updates, claims, tool calls, phase state, decision log
   - receives `planned_agent_utterance`
   - returns `decision_log_id`
7. Worker reports delivery once dispatch identity is known:
   - `POST /api/internal/{kind}-turns/[turnIndex]/delivery`

This preserves barge-in, supersession, partial delivery, text fallback, and telemetry.

If dispatch finishes before TTS playback ends, delivery accounting behaves normally. If TTS finishes first, the worker holds local delivery telemetry and flushes it after dispatch returns. If dispatch permanently fails, the worker emits a recoverable session notice and retries through the existing idempotent internal route pattern.

Public/dev fallback route may exist:

- `POST /api/operator-interviews/[captureSessionId]/turns`

But that route is for typed simulation and tests, not the production voice loop.

---

## Operator Interview Agent

### Slot Schema

Create `otto-frontend/lib/interview/operator/slot-schema.ts`.

Capture-level slots:

- `process.trigger`
- `process.boundary`
- `process.happy_path_complete`
- `process.hard_case_complete`
- `process.primary_roles`
- `process.primary_systems`
- `process.source_of_truth`
- `process.frequency`
- `process.volume`
- `process.known_variants`

Step-scoped slots:

- `step.trigger`
- `step.action_verb`
- `step.action_object`
- `step.systems`
- `step.source_of_truth`
- `step.data_copied_from`
- `step.data_copied_to`
- `step.decision_criteria`
- `step.output`
- `step.next_owner`
- `step.approval_control_point`
- `step.time_typical`
- `step.time_max`
- `step.frequency_per_month`
- `step.exceptions`
- `step.workarounds`
- `step.intentional_deviations`
- `step.tacit_rules`
- `step.variant_conditions`
- `step.what_makes_this_case_hard`

Priority order:

`exceptions > controls > source_of_truth > decision_criteria > handoffs > frequency > variants`

A step is not finalized until `step.exceptions` is `filled` or `asked_unknown`.

### Phase Machine

Persist in `interview_state.current_phase`:

- `orient`
- `happy_path`
- `hard_case`
- `exception_sweep`
- `playback`
- `closeout`

Behavior:

- `orient`: confirm process and choose a recent real case.
- `happy_path`: capture normal flow from trigger to output.
- `hard_case`: walk through an annoying, late, blocked, wrong, or exception-heavy case.
- `exception_sweep`: pressure-test steps with counterfactuals.
- `playback`: summarize the map and ask for corrections.
- `closeout`: surface unresolved high-priority gaps.

Normal close:

- priority-1 step slots meet threshold
- no priority-1 slots are `partial` or `conflicting`

Forced close:

- 45-minute budget
- fatigue
- 3 turns with no new information

Forced close writes `follow_up_tasks`.

### Operator Tools

Create `otto-frontend/lib/interview/operator/tools.ts`.

Tools:

- `markStepBoundary`
- `recordException`
- `recordWorkaround`
- `recordHandoff`
- `flagIntentionalDeviation`
- `requestRedaction`
- `updateSlotState`
- `createFollowUpTask`

All live tools write scratch/evidence tables. Canonical graph rows are synthesis-only.

---

## Screen Intelligence

Voice-only must continue working when no screen track exists.

### Capture

Browser:

- `getDisplayMedia`
- publish screen track to LiveKit
- local dimmed preview
- pause/resume/complete/redact data-channel controls

Worker:

- subscribe to screen track
- sample at 2 fps
- compute SSIM/perceptual diff
- drop near duplicates
- upload keyframe candidates to R2
- call internal frame route

### Vision Processing

Keep expensive vision out of the pre-TTS path.

Frame route:

1. Receives keyframe artifact reference.
2. Enqueues Inngest fan-out.
3. Cheap model gates meaningful state change.
4. Vision model extracts OCR, UI label, and signal tags.
5. Write `screen_events`.
6. Create `evidence(source_type = screen_event, evidence_label = observed)`.

Signal tags:

- `copy_paste_between_systems`
- `alt_tab_to_spreadsheet`
- `manual_search_or_filtering`
- `file_download_upload`
- `waiting_or_refreshing`
- `duplicate_data_entry`
- `comments_or_notes_as_state`
- `left_system_of_record`

These feed high-priority intents into the next live planner call, but delayed screen processing should not stall speech.

### Live Segmenter

The live segmenter runs every 10-20 seconds on a sliding window:

- recent transcript
- recent screen events
- active phase
- provisional step hints

It writes `provisional_steps`.

Use the same segmentation function for live and uploaded video. Batch calls it over the full timeline.

### Live Contradiction

Run a lightweight gap detector during live sessions against:

- attached SOP chunks
- director claims
- prior approved/draft version
- recent screen events
- recent operator statements

Contradictions produce immediate `reconciliation` intents that bypass cooldown.

Example:

> "Quick check — the SOP says this approval happens in the promo system, but I just saw you track it in Excel. Is Excel the normal workflow now, or only a workaround for this case?"

---

## Upload Paths

### Screen Recording Upload

Use `capture_type = screen_recording_upload`.

Flow:

1. User uploads video artifact to R2.
2. Create process-linked capture session with `capture_mode = screen_recording_upload`.
3. Demux audio with ffmpeg.
4. Batch transcribe audio if present.
5. Sample frames at 2 fps.
6. Run same keyframe/vision pipeline.
7. Run same segmenter over full timeline.
8. Set `completed_at`.
9. Trigger `synthesizeProcess`.

No live brain runs. Missing questions become follow-up tasks.

Silent recordings:

- produce screen events and weak provisional steps
- usually require follow-up voice pass before approval
- should be flagged as low confidence unless screen evidence is unusually clear

### Process SOP Upload

Different from onboarding upload.

Flow:

1. User uploads document on `/process/[id]/capture/upload-document`.
2. Create `capture_type = document_upload`, `capture_mode = process_document_upload`, `process_id` set.
3. Write `capture_process_links(link_type = enriched)`.
4. Parse/chunk/embed document.
5. Create documented evidence and process/step hypotheses.
6. Do not create candidate processes by default.
7. Synthesis compares documented flow to observed flow.

SOPs never overwrite observed reality automatically.

---

## Operator Synthesis DAG

Create `otto-frontend/lib/synthesis/operator.ts`.

Trigger: `process/capture.completed`

### Stage 0: Load Evidence Pack

Load:

- capture session
- process
- prior version
- transcript
- screen events
- document chunks
- provisional steps
- director/process claims
- active redaction windows

Do not create the draft `process_versions` row in this stage. It is created at the start of Stage 4 (graph build), so a failure in stages 1-3 leaves no orphan draft row.

### Stage 1: Document Claims

Runs when SOP/document chunks exist.

Outputs:

- documented step hypotheses
- controls
- documented systems/roles
- open questions

### Stage 2: Hierarchical Re-segmentation

Inputs:

- transcript segments
- screen events
- provisional steps
- document step hypotheses

Outputs:

- phase/chunk segmentation
- canonical step candidates per chunk
- dedupe mapping from provisional step IDs

Set `provisional_steps.superseded_by_node_id` after graph rows are created.

### Stage 3: Ontology Normalization

Normalize:

- systems
- roles
- people
- input/output artifacts
- common terms

Reuse existing normalization helpers where possible.

### Stage 4: Graph Build

Transaction:

1. Ensure hidden draft version exists.
2. Insert nodes.
3. Insert edges.
4. Insert node systems/I/O.
5. Insert exceptions/workarounds/variants.
6. Write claims and evidence links.
7. Compute layout.
8. Write `graph_json`.

Use chunked/hierarchical LLM outputs to avoid output ceiling:

- build per phase
- stitch phase boundaries
- validate graph invariants in code

Graph invariants:

- one start
- at least one end
- every non-start node reachable
- every non-end node has outgoing edge unless explicitly terminal
- node IDs referenced by edges exist
- every synthesized node has evidence or is marked inferred with low confidence

### Stage 5: Gap And Contradiction Detection

Compare:

- SOP vs observed
- director vs operator
- narration vs screen events
- current capture vs prior version

Outputs:

- contradiction claims
- `follow_up_tasks`
- draft metadata warnings

No auto-merge across captures in this phase.

### Stage 6: Complexity And Documentation Coverage

Deterministic scoring from:

- node count
- decision count
- handoff count
- exception count
- workaround count
- system count
- contradiction count
- evidence coverage

### Stage 7: Narrative

Generate:

- Summary
- Steps tab rows
- gap warnings

Keep Impact/Insights/Risk mostly stubbed until Phase 4.

### Stage 8: Publish Draft

Publish means:

- set `processes.current_draft_version_id`
- leave prior approved version intact
- write `capture_process_links(enriched)`
- complete `synthesis_runs`
- audit `synthesis.operator.completed`

If this stage never runs, the hidden draft remains non-current and should be recoverable/cleanable by admin tooling.

---

## UI Wiring

### Capture Entry

Update `/process/[id]/capture` to show four options:

- Voice-only interview
- Screen-share + voice interview
- Upload screen recording
- Upload SOP/document

Operator capture should require a promoted/canonical process. If the user only has a director candidate, route them through promotion first.

### Workspace

`/process/[id]/workspace`:

- load graph from `current_draft_version_id` if present
- otherwise `current_approved_version_id`
- otherwise show empty state with capture CTAs

Drafts:

- show draft badge
- allow approval for `director`/`fde`
- second capture creates another draft candidate, not an auto-merge

### Evidence Drawer

Show:

- transcript evidence
- document evidence
- screen evidence
- screenshot thumbnail if retained
- "Frame expired by retention policy" when screenshot artifact TTL has passed

### Approval

Add:

- `POST /api/processes/[processId]/versions/[versionId]/approve`

Behavior:

- validate role
- set approved version
- update process pointer
- audit
- later edits fork new draft

---

## Redaction

### Minimal Screen-Milestone Redaction

Ships with first screen capture milestone:

1. Insert `redactions(pending)`.
2. Prevent synthesis/read paths from using overlapping rows.
3. Tombstone overlapping transcript and screen rows.
4. Hard-delete overlapping raw/keyframe artifacts where possible.
5. Audit success/failure.

### Full Redaction Saga

Follow-up depth:

1. Mark redaction `running`.
2. Redact transcript segments.
3. Redact screen events.
4. Redact document/video artifacts if needed.
5. Redact evidence rows.
6. Redact claim-evidence links.
7. Recompute affected graph/narrative if already drafted.
8. Purge traces by capture/time band.
9. Mark complete.

Failures:

- mark failed
- create `follow_up_tasks(redaction_failure)`
- show FDE alert

---

## Build Order

### Milestone 1: Fixture Graph Vertical Slice

Deliver:

- graph migration
- hidden draft version creation
- graph tables
- graph JSON projection
- fixture evidence pack
- hierarchical graph builder first pass
- workspace graph render
- Steps tab from graph
- evidence drawer from node claims
- approve draft API

Exit:

- A hand-authored transcript fixture becomes an approvable evidence-linked diagram.

### Milestone 2: Shared Live Core And One-Call Director Parity

Deliver:

- `planned_agent_utterance` in director schema
- one-call director planner
- streamed early utterance extraction from the plan response
- TTS starts from early utterance before full plan completion where supported
- dispatch write can run concurrently with TTS
- separate voice LLM behind debug flag
- telemetry source tags
- stream cutoff telemetry
- local turn correlation ID for dispatch/TTS reconciliation
- tests proving separate voice call is not called by default
- first shared realtime primitives extracted
- conversational-quality eval for one-call phrasing

Exit:

- Director pre-TTS latency drops materially, current director tests pass, and one-call phrasing remains acceptable on naturalness/survey-likeness evals.

### Milestone 3: Voice-Only Operator

Deliver:

- operator slot schema
- operator probes
- operator tools
- operator internal split routes
- operator one-call planner
- operator room token route
- typed fallback route
- operator transcript/evidence/provisional-step persistence

Exit:

- Voice-only operator interview produces a draft workflow diagram.

### Milestone 4: Draft Stacking

Deliver:

- second capture creates a new draft version
- FDE/director can choose draft
- no overwrite of approved version
- no auto-merge

Exit:

- Multiple captures do not clobber one another.

### Milestone 5: Screen Capture With Minimal Redaction

Deliver:

- screen publishing
- keyframe sampling
- SSIM/perceptual diff
- frame artifact upload with TTL
- `screen_events`
- minimal redaction window

Exit:

- Screen events persist, and sensitive time windows can be removed before synthesis uses them.

### Milestone 6: Screen Intelligence

Deliver:

- vision gate
- OCR/UI label/signal tags
- live segmenter
- screen-signal probes
- live contradiction prompts

Exit:

- Agent catches at least one workaround or contradiction not explicitly narrated.

### Milestone 7: Uploads And Full Redaction

Deliver:

- screen-recording upload
- audio transcription from video
- batch frame processing
- process SOP upload
- full redaction cascade

Exit:

- All four capture modes feed the same map.

---

## Tests And Evals

### Early Eval Gate

Before live operator rollout, create 5-10 hand-labeled workflow fixtures.

Measure:

- step precision/recall
- edge precision/recall
- order correlation
- exception recall
- workaround recall
- evidence attribution rate
- contradiction detection

This gates Stage 4 graph build.

### Unit/Integration Tests

Add tests for:

- graph write transaction
- hidden draft not visible until publish
- `graph_json` matches relational graph
- per-step slot scoping
- provisional step dedupe
- one-call planner does not call separate voice LLM by default
- streamed planner starts TTS after `planned_agent_utterance` without waiting for full JSON
- TTS/dispatch concurrency preserves delivery telemetry
- dispatch retry recovers when TTS started before dispatch succeeded
- missing utterance fallback
- public dev route vs internal split route
- screen redaction blocks synthesis
- process-specific SOP does not create candidates
- screen recording uses `capture_type = screen_recording_upload`
- draft stacking creates new version

### Visual Tests

Cover:

- four-mode capture entry
- voice prestart/live shell
- screenshare shell
- upload video
- upload document
- graph empty state
- populated graph
- evidence drawer with screen evidence
- draft approval UI

### Conversational Quality Eval

Milestone 2 needs a small eval specifically for the one-call phrasing regression risk.

Score director/operator utterances for:

- asks at most one question
- sounds warm and natural
- does not sound like a survey
- acknowledges the user's answer when useful
- matches `chosen_intent`
- does not expose slot names or extraction mechanics
- stays short enough for voice

Compare:

- one-call `planned_agent_utterance`
- old separate voice LLM output under debug flag
- deterministic fallback

Use this to decide whether the separate voice path can remain rollback-only or needs selective use for difficult turns.

---

## Files To Create Or Modify

Create:

- `otto-frontend/migrations/0005_operator_graph.sql`
- `otto-frontend/migrations/0006_capture_evidence.sql`
- `otto-frontend/migrations/0007_redactions.sql`
- `otto-frontend/lib/interview/_core/*`
- `otto-frontend/lib/interview/operator/slot-schema.ts`
- `otto-frontend/lib/interview/operator/tools.ts`
- `otto-frontend/lib/interview/operator/brain.ts`
- `otto-frontend/lib/synthesis/operator.ts`
- `otto-frontend/lib/synthesis/operator-layout.ts`
- `otto-frontend/lib/processes/graph-queries.ts`
- `otto-frontend/lib/adapters/vision.ts`
- `schemas/operator-turn-plan.schema.json`
- `probes/operator.yaml`
- `prompts/operator.turn.plan.md`
- `prompts/operator.voice.phrase-intent.md`
- operator API routes under `app/api/internal/operator-turns/*`
- `app/api/livekit/operator-room/route.ts`
- process upload and approval routes
- operator capture pages

Modify:

- `schemas/director-turn-plan.schema.json`
- `agents/director/director_agent/planner.py`
- `agents/director/director_agent/schemas.py`
- `otto-frontend/lib/interview/director/brain.ts`
- `otto-frontend/app/api/internal/director-turns/plan/route.ts`
- `otto-frontend/lib/db/schema.ts`
- `otto-frontend/lib/inngest/client.ts`
- `otto-frontend/lib/inngest/functions.ts`
- `otto-frontend/lib/adapters/livekit.ts`
- `otto-frontend/app/process/[id]/capture/page.tsx`
- `otto-frontend/app/process/[id]/capture/screenshare/ScreenshareClient.tsx`
- workspace tabs and evidence drawer

---

## Definition Of Done

The phase is complete when:

1. Director live turns use one Sonnet call by default and cut p50 pre-TTS latency by at least 30% vs. the two-call baseline (measured ASR-final to first TTS audio), with no regression on the conversational-quality eval.
2. Voice-only operator interview generates an evidence-linked draft workflow diagram.
3. Screen-share + voice interview enriches a new draft with observed systems, workarounds, exceptions, and contradictions.
4. Screen-recording upload produces the same evidence substrate and can generate a draft or follow-up tasks.
5. Process SOP upload contributes documented evidence and contradiction detection without overwriting observed behavior.
6. Redaction works for screen/audio windows before data is used in synthesis.
7. Graph rows are canonical, `graph_json` is cache, and every synthesized node has evidence or explicit low-confidence inference.
8. A user can approve a draft version from the workspace.
