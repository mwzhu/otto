# Phase 2 + Phase 3 Implementation Plan: Operator Capture, Multimodal Synthesis, Workflow Map

This plan combines `BUILD_PLAN.md` Phase 2 and Phase 3 into one implementation track for the current repo. The reason to combine them is product-level: voice-only operator interviews, live screen-share interviews, screen-recording uploads, and SOP uploads should not become four separate pipelines. They are four capture modes that feed one evidence model, one synthesis DAG, and one workflow diagram.

## Goal

An operator or FDE can add capture to a promoted process through any of these modes:

1. **Voice-only interview**: the user explains the process while the agent asks targeted operator questions.
2. **Screen-share + voice interview**: the user walks the agent through the process live; the voice agent asks relevant questions when screen or transcript signals indicate missing context, workarounds, exceptions, or contradictions.
3. **Screen-recording upload**: the user uploads a video walkthrough of the process, optionally with narration.
4. **SOP upload**: the user uploads process documentation for extraction and comparison.

All four modes produce the same output: a draft process version with an evidence-backed workflow diagram, Summary and Steps tabs, node-level evidence, exceptions, workarounds, and an approval path.

## Current Repo Baseline

The repo already has several foundations this plan should extend instead of replacing:

- `otto-frontend/lib/db/schema.ts` already contains org/workspace/process/version/capture/artifact/transcript/document/evidence/claim/candidate/slot/synthesis/audit tables.
- `capture_type` already includes `operator_interview`, `screen_recording_upload`, `document_upload`, and `mixed`.
- `artifacts` already supports `document`, `audio`, `video`, `screen_frame`, `image`, and R2 presigned upload.
- `otto-frontend/app/api/workspaces/[workspaceId]/artifacts/presign/route.ts` can create upload slots, but uploaded documents are currently the only artifacts converted into capture sessions by `otto-frontend/app/api/artifacts/[artifactId]/complete/route.ts`.
- Director intake is implemented around `capture_sessions`, `transcript_segments`, `evidence`, `claims`, `slot_states`, `agent_decision_log`, `interview_state`, and `probe_firings`.
- LiveKit voice is implemented for the Director path in `otto-frontend/lib/adapters/livekit.ts`, `otto-frontend/app/api/livekit/director-room/route.ts`, and `agents/director/director_agent/*`.
- The operator capture UI exists as a shell at `otto-frontend/app/process/[id]/capture/page.tsx`; it currently offers "Take interview" and "Upload SOP document".
- The screenshare UI exists as a mock shell at `otto-frontend/app/process/[id]/capture/screenshare/ScreenshareClient.tsx`, with `ScreenSharePreview`, `ConversationPanel`, and `CaptureControls`, but it does not yet create an operator capture session, join LiveKit, publish a screen track, persist transcript, or complete synthesis.
- `ProcessCanvas` and graph types exist, but the graph is currently loaded from `process_versions.graph_json`; normalized graph tables from `BUILD_PLAN.md` do not exist yet.
- Synthesis currently implements the Phase 1 inventory subset in `otto-frontend/lib/synthesis/inventory.ts`. It does not yet build operator step graphs from transcript/screen evidence.
- Existing workspace tabs beyond Summary/Steps are still mostly placeholders. This plan focuses on diagram + Summary + Steps, leaving ROI-heavy Impact/Insights/Risk depth for Phase 4.

## Design Principle

Build the operator layer as a single capture-and-synthesis substrate:

```
operator capture modes
  voice-only live
  screen-share + voice live
  screen-recording upload
  SOP upload
       |
       v
capture_sessions + artifacts + transcript_segments + screen_events + document_chunks
       |
       v
operator evidence pack
       |
       v
operator synthesis DAG
       |
       v
process_versions + process_nodes + process_edges + claims + evidence
       |
       v
ProcessCanvas + Summary tab + Steps tab + approval UI
```

The capture mode changes how evidence is collected. It must not change how the canonical graph is written or rendered.

## Exit Criteria

Phase 2 + 3 is complete when:

1. A user can start voice-only operator capture from `/process/[id]/capture`.
2. A user can start screen-share + voice capture from `/process/[id]/capture`.
3. A user can upload a screen recording for a specific process.
4. A user can upload an SOP/document for a specific process, not only workspace-level onboarding.
5. All four modes create or enrich `capture_sessions` linked to `process_id`.
6. Live operator turns persist transcript segments, evidence rows, slot updates, agent decisions, and agent utterances.
7. Screen-share capture persists screen events derived from keyframes, not raw browser state alone.
8. Screen-recording upload extracts audio transcript and keyframe screen events using the same downstream shape as live screen-share.
9. SOP upload reuses document parsing/chunking but attaches evidence to the target process and participates in contradiction detection.
10. The synthesis DAG builds a draft `process_version` with nodes, edges, exceptions, workarounds, and evidence-backed claims.
11. The process workspace renders the draft workflow diagram from DB-backed graph data.
12. Summary and Steps tabs render from the same canonical graph/claim/evidence model.
13. Node clicks open evidence.
14. The user can approve the draft version.
15. Tests cover the capture APIs, upload modes, operator synthesis stages, graph writing, and evidence linkage.

## Workstream 1: Data Model

### 1.1 Add Canonical Graph Tables

Create `otto-frontend/migrations/0005_operator_capture_graph.sql` and update `otto-frontend/lib/db/schema.ts`.

Add `process_node_type` enum:

- `start`
- `task`
- `decision`
- `wait`
- `handoff`
- `exception`
- `end`

Add `process_edge_type` enum:

- `seq`
- `conditional`
- `handoff`
- `parallel`

Add `process_node_level` enum:

- `L3`
- `L4`

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
- `position_json jsonb not null default '{}'`
- `metadata_json jsonb not null default '{}'`
- `evidence_count integer default 0 not null`
- `top_evidence_ids uuid[] default '{}' not null`
- timestamps

Indexes:

- `(org_id)`
- `(workspace_id, process_id)`
- `(version_id, ordinal)`
- `(parent_node_id)`

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
- `metadata_json jsonb not null default '{}'`
- `evidence_count integer default 0 not null`
- `top_evidence_ids uuid[] default '{}' not null`
- timestamps

Indexes:

- `(version_id)`
- `(source_node_id)`
- `(target_node_id)`

Add `node_systems`:

- `org_id`, `workspace_id`, `node_id`, `system_id`
- `usage text not null` with values validated in code: `read`, `write`, `both`, `unknown`
- `evidence_ids uuid[] default '{}' not null`
- timestamps
- primary key `(node_id, system_id, usage)`

Add `node_io`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `node_id`
- `kind text not null` with code validation: `input`, `output`, `artifact`
- `name text not null`
- `description text`
- `evidence_ids uuid[] default '{}' not null`
- timestamps

Add `node_exceptions`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `process_id`, `version_id`, `node_id`
- `sub_type text not null`
- `label text not null`
- `trigger text`
- `detection text`
- `handler_role_id uuid references roles(id)`
- `frequency_pct numeric(5,2)`
- `time_to_resolve_seconds integer`
- `impact_cents integer`
- `evidence_ids uuid[] default '{}' not null`
- timestamps

Add `node_workarounds`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `process_id`, `version_id`, `node_id`
- `description text not null`
- `why_it_exists text`
- `evidence_ids uuid[] default '{}' not null`
- timestamps

Add `node_variants`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `process_id`, `version_id`, `node_id`
- `condition text not null`
- `alt_node_id uuid references process_nodes(id)`
- `evidence_ids uuid[] default '{}' not null`
- timestamps

Keep `process_versions.graph_json` as a read-optimized render cache. The normalized tables are canonical for graph writes; `graph_json` is rebuilt after graph synthesis and after layout.

### 1.2 Add Operator Evidence Tables

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
- `metadata_json jsonb not null default '{}'`
- `deleted_at timestamptz`
- `redacted_at timestamptz`
- timestamps

Indexes:

- `(capture_session_id, ts_ms)`
- `(workspace_id)`
- GIN index on OCR text can be added later; start simple unless query latency demands it.

Add `provisional_steps`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `capture_session_id uuid not null references capture_sessions(id)`
- `process_id uuid references processes(id)`
- `ordinal integer not null`
- `ts_start_ms integer not null`
- `ts_end_ms integer`
- `action_verb text`
- `action_object text`
- `system_id_set uuid[] default '{}' not null`
- `candidate_role_id uuid references roles(id)`
- `source text not null` with values validated in code: `live_segmenter`, `operator_tool_call`, `video_segmenter`
- `superseded_by_node_id uuid references process_nodes(id)`
- `confidence numeric(4,3) default 0 not null`
- `metadata_json jsonb not null default '{}'`
- timestamps

Indexes:

- `(capture_session_id, ordinal)`
- `(process_id)`

Add `redactions`:

- `id uuid primary key`
- `org_id uuid not null`
- `workspace_id uuid not null`
- `capture_session_id uuid not null references capture_sessions(id)`
- `start_ms integer not null`
- `end_ms integer not null`
- `requested_by_user_id uuid references users(id)`
- `reason text`
- `status text not null` with code validation: `pending`, `running`, `complete`, `failed`
- `failure_reason text`
- `affected_artifact_ids uuid[] default '{}' not null`
- `affected_trace_ids uuid[] default '{}' not null`
- timestamps plus `started_at`, `completed_at`

### 1.3 Extend Existing Tables

Extend `capture_sessions.metadata_json` contract rather than adding many columns:

- `mode`: `operator_voice`, `operator_screenshare`, `screen_recording_upload`, `process_document_upload`, `mixed`
- `participant_user_id`
- `consent_text_version`
- `screen_recording_retention_days`
- `raw_frame_retention_hours`
- `livekit_room`
- `agent_name`
- `source_artifact_ids`

Extend `artifacts` use:

- `artifact_type = video` for uploaded screen recordings.
- `artifact_type = screen_frame` for persisted keyframes.
- `ttl_at` should be populated for raw/keyframe artifacts according to retention policy.

Extend `synthesis_run_type` enum:

- `operator_capture`
- `process_document`
- `screen_recording`
- `operator_combined`

If changing an existing enum is cumbersome in Drizzle, add the SQL enum value migration explicitly and update the TypeScript enum.

### 1.4 Claim Subject Fields

Update `schemas/claim-subject-fields.json` and `otto-frontend/lib/interview/director/claim-allowlist.ts` equivalent for operator writes.

Add allowed claim subjects:

- `process_node.title`
- `process_node.description`
- `process_node.owner_role`
- `process_node.sla_seconds`
- `process_node.est_minutes_per_run`
- `process_node.frequency`
- `process_edge.condition`
- `process_edge.label`
- `node_exception.trigger`
- `node_exception.frequency_pct`
- `node_exception.time_to_resolve_seconds`
- `node_workaround.description`
- `node_variant.condition`
- `narrative_paragraph.summary`
- `narrative_paragraph.steps`

Rule: synthesis writes normalized graph rows and claim rows in the same transaction. Parent graph rows are projections of active claims wherever the field is synthesized.

## Workstream 2: Capture Mode UX

### 2.1 Replace Capture Entry With Four Modes

Update `otto-frontend/app/process/[id]/capture/page.tsx`.

Cards:

- **Voice-only interview**
  - Route: `/process/[id]/capture/voice`
  - Description: "Talk through the process while Otto asks targeted questions."

- **Screen-share + voice interview**
  - Route: `/process/[id]/capture/screenshare`
  - Description: "Walk through the workflow live while Otto watches for steps, handoffs, workarounds, and exceptions."

- **Upload screen recording**
  - Route: `/process/[id]/capture/upload-video`
  - Description: "Upload a narrated or silent recording of the workflow."

- **Upload SOP / document**
  - Route: `/process/[id]/capture/upload-document`
  - Description: "Attach process documentation and compare it to actual operator behavior."

Keep the existing visual language. This is a product surface change, not a redesign.

### 2.2 Operator Voice Prestart

Add:

- `otto-frontend/app/process/[id]/capture/voice/page.tsx`
- `otto-frontend/app/process/[id]/capture/voice/OperatorVoicePreStartClient.tsx`
- `otto-frontend/app/process/[id]/capture/voice/live/page.tsx`
- `otto-frontend/app/process/[id]/capture/voice/live/OperatorVoiceLiveClient.tsx`

Behavior:

- Require workspace access as `director` or `operator`.
- Show process name and a concise consent checkbox.
- Create an `operator_interview` capture session attached to `process_id`.
- Request microphone permission.
- Join an operator LiveKit room if configured.
- Fall back to typed transcript simulation in local/dev, matching the director path.

Reuse the Director `TranscriptChat` concepts but do not reuse its copy or endpoint names. Operator interviews have different slots, phases, stopping rules, and tool calls.

### 2.3 Screen-share + Voice Live Page

Replace the current mock `ScreenshareClient` behavior with real session lifecycle.

Start sequence:

1. Create an `operator_interview` capture session with `metadata_json.mode = operator_screenshare`.
2. Mint an operator LiveKit room token.
3. Join the LiveKit room.
4. Publish microphone track.
5. Ask user to select a screen/window/tab with `getDisplayMedia`.
6. Publish screen track.
7. Show a dimmed local preview.
8. Listen for data-channel events from the operator agent:
   - transcript updates
   - agent question dispatch
   - provisional steps
   - coverage updates
   - redaction acknowledgement
   - completion state

Controls:

- Mute/unmute mic.
- Pause/resume interview. Pause should stop agent probing and mark capture state, but should not destroy the room.
- Complete interview. This sets `capture_sessions.completed_at`, sends an Inngest event, and navigates to synthesis.
- Redact last 30 seconds. This creates a `redactions` row and starts a redaction saga.

### 2.4 Upload Screen Recording

Add:

- `otto-frontend/app/process/[id]/capture/upload-video/page.tsx`
- `otto-frontend/app/process/[id]/capture/upload-video/UploadVideoClient.tsx`

Implementation:

- Use existing presigned artifact upload route.
- Pass `artifact_type = video`.
- Add `process_id` and `capture_type = screen_recording_upload` to the completion request. The current `complete` route only creates `document_upload` capture sessions for documents; add a process-specific completion route instead of overloading too much:
  - `POST /api/processes/[processId]/captures/uploads`
  - body: `{ workspace_id, artifact_id, upload_kind: "screen_recording" | "document" }`
- The route creates a capture session linked to `process_id`, attaches the artifact, marks it uploaded, writes audit logs, and sends the right Inngest event.

Accepted video types:

- `video/mp4`
- `video/quicktime`
- `video/webm`
- `video/x-matroska` if parser support exists

Start with a 1 GB product limit in validation, but keep env-configurable max size.

### 2.5 Upload SOP For A Specific Process

Add:

- `otto-frontend/app/process/[id]/capture/upload-document/page.tsx`
- `otto-frontend/app/process/[id]/capture/upload-document/UploadProcessDocumentClient.tsx`

Reuse `UploadClient` mechanics, but attach the upload to `process_id`. This matters because current onboarding upload is workspace-level and produces candidate processes; process-specific SOP uploads should enrich or contradict an existing process.

The process-specific document capture should:

- Create `capture_type = document_upload`.
- Set `process_id`.
- Link `capture_process_links(link_type = enriched)`.
- Reuse document parsing/chunking.
- Skip candidate process creation by default.
- Emit document evidence and process/step hypotheses for synthesis.

## Workstream 3: Operator APIs

### 3.1 Capture Session Routes

Add `POST /api/processes/[processId]/operator-captures`.

Body:

```ts
{
  workspace_id: string;
  mode: "voice" | "screenshare";
  language: string;
  consent_acknowledged: true;
  consent_text_version: string;
}
```

Response:

```ts
{
  capture_session: CaptureSession;
  room_readiness: OperatorRoomReadiness;
}
```

Checks:

- Authenticated user.
- Workspace role in `director | operator`.
- Process belongs to workspace and org.
- Idempotency key required.
- Audit log: `capture.operator.started`.

### 3.2 Operator LiveKit Room Route

Add `POST /api/livekit/operator-room`.

Body:

```ts
{
  workspace_id: string;
  process_id: string;
  capture_session_id: string;
}
```

Response mirrors director room:

```ts
{
  mode: "simulated" | "livekit";
  room: string;
  url: string | null;
  token: string | null;
  tokenExpiresAt: string | null;
  agentName?: string;
  agentParticipantIdentity?: string;
  dispatchId?: string;
  reason?: string;
}
```

Use shared helpers in `otto-frontend/lib/adapters/livekit.ts`:

- `operatorVoiceReadiness`
- `createOperatorRoomToken`
- `operatorAgentParticipantIdentity`

Do not make the director adapter understand operator-specific behavior through flags. Share lower-level helpers for room creation, dispatch, token minting, and readiness checks.

### 3.3 Operator Turn Routes

Add:

- `POST /api/operator-interviews/[captureSessionId]/turns`
- `GET /api/operator-interviews/[captureSessionId]/turns`
- `GET /api/operator-interviews/[captureSessionId]/coverage`
- `POST /api/operator-interviews/[captureSessionId]/complete`

The POST route accepts either:

```ts
{ workspace_id, process_id, utterance }
```

or:

```ts
{ workspace_id, process_id, transcript_segments: [...] }
```

It should parallel the director path:

1. Ingest transcript segments.
2. Create `evidence(source_type = transcript_segment, evidence_label = stated_operator)`.
3. Run or dispatch the operator turn planner.
4. Write slot updates, provisional steps, claims, and decision log.
5. Return next prompt plus coverage and provisional step updates.

### 3.4 Screen Event Routes

Add internal routes used by the Python agent and frame processor:

- `POST /api/internal/operator-screen-events`
- `POST /api/internal/operator-provisional-steps`
- `POST /api/internal/operator-redactions`

Authentication:

- Service token only.
- Resolve org/workspace/process from `capture_session_id`.
- Do not trust org/workspace/process values from the agent.

### 3.5 Upload Completion Route

Add `POST /api/processes/[processId]/captures/uploads`.

Body:

```ts
{
  workspace_id: string;
  artifact_id: string;
  upload_kind: "screen_recording" | "document";
}
```

Behavior:

- Validate artifact belongs to org/workspace and current user can access it.
- Create capture session:
  - `screen_recording_upload` for video.
  - `document_upload` for SOP.
- Set `process_id`.
- Attach artifact to capture session.
- Write `capture_process_links`.
- Emit either `operatorScreenRecordingUploaded` or `processDocumentUploaded`.

## Workstream 4: Operator Agent

### 4.1 Runtime Shape

Create a new Python package beside director:

- `agents/operator/operator_agent/__init__.py`
- `agents/operator/operator_agent/agent.py`
- `agents/operator/operator_agent/planner.py`
- `agents/operator/operator_agent/otto_api.py`
- `agents/operator/operator_agent/schemas.py`
- `agents/operator/operator_agent/screen.py`
- `agents/operator/tests/*`
- `agents/operator/pyproject.toml`
- `agents/operator/Dockerfile`

Alternatively, if deployment simplicity matters more, create `agents/director/operator_agent/*` inside the existing agent service and dispatch by `LIVEKIT_AGENT_NAME`. The cleaner long-term boundary is a separate package because screen capture and segmenting dependencies will diverge.

### 4.2 Operator Interview Phases

Persist phase state in `interview_state.current_phase`:

- `orient`
- `happy_path`
- `hard_case`
- `exception_sweep`
- `playback`
- `closeout`

Phase behavior:

- `orient`: confirm the process and ask user to choose a recent real case.
- `happy_path`: capture the normal workflow from trigger to outcome.
- `hard_case`: ask for an annoying, late, blocked, wrong, or exception-heavy case.
- `exception_sweep`: pressure-test each step for missing input, late approval, wrong data, system outage, urgent case, absent approver, and non-responsive external party.
- `playback`: summarize the draft flow and ask for corrections.
- `closeout`: surface unresolved high-priority gaps.

Stopping rule:

- Normal close: priority-1 operator slots >= 90% covered and no priority-1 slot is `partial` or `conflicting`.
- Forced close: 45 minute budget, user fatigue, or last 3 turns produce no new evidence.
- Forced close creates `follow_up_tasks`.

### 4.3 Operator Slot Schema

Add `otto-frontend/lib/interview/operator/slot-schema.ts`.

Top-level process slots:

- `trigger`
- `happy_path_start`
- `happy_path_end`
- `primary_roles`
- `primary_systems`
- `source_of_truth`
- `overall_frequency`
- `overall_volume`
- `average_cycle_time`
- `known_variants`

Per-step slots:

- `step[n].trigger`
- `step[n].action_verb`
- `step[n].action_object`
- `step[n].systems`
- `step[n].source_of_truth`
- `step[n].data_copied_from`
- `step[n].data_copied_to`
- `step[n].decision_criteria`
- `step[n].output`
- `step[n].next_owner`
- `step[n].approval_control_point`
- `step[n].time_typical`
- `step[n].time_max`
- `step[n].frequency_per_month`
- `step[n].exceptions`
- `step[n].workarounds`
- `step[n].intentional_deviations`
- `step[n].tacit_rules`
- `step[n].variant_conditions`
- `step[n].what_makes_this_case_hard`

### 4.4 Operator Tools

Add TypeScript tool implementations under `otto-frontend/lib/interview/operator/tools.ts` and Python schemas under `agents/operator/operator_agent/schemas.py`.

Tools:

- `mark_step_boundary(action_verb, action_object, systems[], time_ms, evidence_ids[])`
- `record_exception(target_ref, sub_type, frequency_pct, evidence_ids[])`
- `record_workaround(target_ref, description, why_it_exists, evidence_ids[])`
- `record_handoff(from_ref, to_role, channel, sla_seconds, evidence_ids[])`
- `flag_intentional_deviation(target_ref, condition, evidence_ids[])`
- `update_slot_state(slot_path, value, status, confidence, evidence_ids[])`
- `create_follow_up_task(reason, target_slot)`
- `request_redaction(start_ms, end_ms)`

All tools write to scratch/evidence tables during live capture. They do not write canonical graph rows directly except through post-interview synthesis.

### 4.5 Voice-Only Operator Brain

Inputs per turn:

- Last 4-6 transcript turns.
- Current phase and focus step.
- Slot coverage summary.
- Provisional steps so far.
- Existing director-layer process detail and SOP chunks relevant to the current topic.

Outputs:

- Slot updates.
- Tool calls.
- Ranked probe intents.
- Next phase.
- Chosen intent.
- Planned agent utterance.

Voice-only mode should be strong enough to produce a useful flowchart without screen evidence. It should ask explicitly for step boundaries:

- "What happens immediately before that?"
- "What do you do next?"
- "Which system are you in for that step?"
- "Where does that value come from?"
- "Who gets it after you?"
- "When does this step not go cleanly?"

### 4.6 Screen-aware Operator Brain

Screen-share mode adds:

- Recent screen events.
- Recent active app/window labels.
- Live provisional step hypotheses.
- Screen-signal triggers.
- SOP contradiction signals.

Screen triggers should be routed to the same controller as regular probe intents, but with elevated priority:

- `copy_paste_between_systems` -> source/destination question.
- `alt_tab_to_spreadsheet` -> workaround question.
- `manual_search_or_filtering` -> decision criteria/source-of-truth question.
- `file_download_upload` -> artifact/input/output question.
- `waiting_or_refreshing` -> SLA/blocker question.
- `duplicate_data_entry` -> integration/automation candidate question.
- `comment_or_note_as_state` -> shadow workflow question.
- `left_system_of_record` -> workaround or exception question.

Example agent behavior:

- User silently opens Excel after narrating an ERP step.
- Screen event: `{ event_type: "alt_tab", app_name: "Excel" }`
- Brain emits `workaround_probe` with high priority.
- Voice asks: "I noticed we moved from the ERP into Excel. Is this spreadsheet part of the official process, or is it the place people track what the system misses?"

## Workstream 5: Screen Capture Pipeline

### 5.1 Live Browser Capture

Browser:

- Use `navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })`.
- Publish the screen video track to LiveKit.
- Render local preview with mirror protection.
- Notify agent of pause/resume/complete/redaction through LiveKit data channel.

Server/agent:

- Subscribe to screen track.
- Sample frames at 2 fps.
- Store candidate keyframes as `artifacts(artifact_type = screen_frame)` in R2 with `ttl_at`.
- Write `screen_events` for meaningful keyframes.

### 5.2 Keyframe Processing

Pipeline:

1. Decode frame.
2. Compute perceptual hash or SSIM versus previous accepted frame.
3. Drop if similarity is above threshold.
4. Run cheap classifier: "meaningful workflow state change?"
5. If meaningful, run vision labeling:
   - OCR text.
   - App/screen label.
   - Detected UI action.
   - Evidence summary.
6. Write `screen_events`.
7. Create `evidence(source_type = screen_event, evidence_label = observed)`.

Implementation choice:

- Start with Python frame processing in `agents/operator/operator_agent/screen.py` because the LiveKit screen track is already in the worker.
- Store frame artifacts through internal Next API, not direct DB writes.
- If Python-to-R2 upload adds latency, use a presigned internal artifact route and upload directly from the worker.

### 5.3 Uploaded Video Processing

Add an Inngest function `operatorScreenRecordingUploaded`.

Stages:

1. Load artifact metadata.
2. Extract audio track.
3. Transcribe audio into `transcript_segments` if audio exists.
4. Sample video frames at 2 fps.
5. Apply the same keyframe/vision labeling pipeline as live screen-share.
6. Write `screen_events` and observed evidence.
7. Run provisional segmentation.
8. Trigger operator synthesis.

Use the same `screen_events` shape as live capture. Synthesis should not know whether a screen event came from live screen-share or uploaded video except through metadata.

### 5.4 Privacy And Retention

Default retention:

- Raw/keyframe screen artifacts: 72 hours after successful synthesis.
- OCR and screen labels: persistent unless redacted.
- Transcript segments: persistent unless redacted.
- Uploaded source video: configurable; default 30 days for trials, workspace policy later.

Implementation:

- Populate `artifacts.ttl_at`.
- Add cleanup Inngest function for expired artifacts.
- Redaction marks rows first, physical deletion can be async.

## Workstream 6: SOP Processing For Existing Processes

Current document upload produces candidate processes. Add a process-specific path.

Create `otto-frontend/lib/documents/process-pipeline.ts`.

It should reuse:

- `parseDocument`
- `chunkDocument`
- `embedBatch`
- `createDocumentEvidence`

But it should not call `recordProcess` by default.

Outputs:

- `document_chunks`
- `evidence(source_type = document_chunk, evidence_label = documented)`
- process-level claims such as frequency, owner, systems, controls where directly stated
- provisional step hypotheses stored as stage output JSON, not canonical graph rows
- contradiction candidates for synthesis: SOP says X, operator observed Y

SOP extraction schema:

```ts
{
  process_summary: string;
  systems: string[];
  roles: string[];
  steps: Array<{
    title: string;
    description?: string;
    role?: string;
    system?: string[];
    inputs?: string[];
    outputs?: string[];
    exceptions?: string[];
    controls?: string[];
    evidence_ids: string[];
  }>;
  policies: string[];
  open_questions: string[];
}
```

## Workstream 7: Operator Synthesis DAG

Create `otto-frontend/lib/synthesis/operator.ts`.

Add Inngest event names in `otto-frontend/lib/inngest/client.ts`:

- `operatorCaptureCompleted`
- `operatorScreenRecordingUploaded`
- `processDocumentUploaded`
- `operatorSynthesisRequested`

Add Inngest functions in `otto-frontend/lib/inngest/functions.ts`:

- `operatorCaptureCompleted`
- `operatorScreenRecordingUploaded`
- `processDocumentUploaded`
- `operatorSynthesis`

### 7.1 Stage 0: Load Evidence Pack

Inputs:

- `capture_sessions`
- `transcript_segments`
- `screen_events`
- `document_chunks`
- `provisional_steps`
- existing director claims for the process
- existing current draft/approved version, if any

Output:

- compact `OperatorEvidencePack`

### 7.2 Stage 1: Document Extraction

Only runs when SOP/document artifacts are present.

Outputs:

- document step hypotheses
- documented controls
- documented role/system claims
- open questions

### 7.3 Stage 2: Transcript And Screen Re-segmentation

Inputs:

- transcript segments
- screen events
- provisional steps
- uploaded video-derived events, if any

Output:

```ts
Array<CanonicalStepCandidate>
```

Each step:

- `title`
- `action_verb`
- `action_object`
- `description`
- `ts_start_ms`
- `ts_end_ms`
- `role_name`
- `system_names`
- `inputs`
- `outputs`
- `decision_criteria`
- `evidence_ids`
- `confidence`

This stage supersedes `provisional_steps` by later setting `superseded_by_node_id`.

### 7.4 Stage 3: Ontology Normalization

Normalize:

- system names to `systems`
- role names to `roles`
- person names to `people`
- common input/output artifact terms to ontology terms later

Use existing normalization helpers from document code where possible.

### 7.5 Stage 4: Graph Build

Build:

- one `start` node
- L4 task nodes
- decision nodes where branching criteria are explicit
- handoff nodes/edges where ownership changes
- wait nodes for waiting states
- exception nodes/exception-path edges
- one `end` node

Write:

- `process_versions` draft row
- `process_nodes`
- `process_edges`
- `node_systems`
- `node_io`
- `node_exceptions`
- `node_workarounds`
- `node_variants`
- claims and claim evidence

Use a transaction for each draft version publish. If the graph build fails, do not leave partial graph rows attached to a current draft version.

### 7.6 Stage 5: Gap And Contradiction Detection

Compare:

- SOP/documented steps vs observed steps.
- Director description vs operator reality.
- Transcript narration vs screen behavior.
- Voice-only capture vs later screen recording for the same process.

Outputs:

- `follow_up_tasks`
- contradiction claims
- warnings on draft version metadata

Examples:

- SOP says approval happens in ERP, screen shows approval tracked in Sheets.
- Director says weekly, operator says daily.
- SOP has a control step that operator skipped.
- Screen recording shows a system not mentioned in voice.

### 7.7 Stage 6: Layout And Render Cache

Use `elkjs` in TypeScript to compute node positions.

Write:

- `process_nodes.position_json`
- `process_versions.graph_json`

`graph_json` should match the existing `ProcessGraph` type so `ProcessCanvas` can render without a major UI rewrite.

### 7.8 Stage 7: Complexity And Documentation Coverage

Extend existing `computeComplexityScore` or create `operatorComplexity.ts`.

Inputs:

- node count
- decision count
- exception count
- handoff count
- system count
- workaround count
- evidence coverage
- contradiction count

Outputs:

- `process` claim: `complexity_score`
- `process` claim: `doc_coverage`
- process projection update

### 7.9 Stage 8: Narrative Generation

Generate only Phase 2/3 scope:

- Summary paragraph.
- Steps tab rows.
- Evidence-backed warnings for gaps.

Do not implement full ROI/automation narrative here except lightweight flags like `automation_candidate = true` on duplicated-entry or manual-copy nodes. Phase 4 owns ranked ROI.

### 7.10 Stage 9: Publish Draft

Update:

- `processes.current_draft_version_id`
- `capture_process_links(link_type = enriched)`
- `synthesis_runs.status = completed`
- audit log: `synthesis.operator.completed`

Notify the UI via polling first. Realtime notifications can come later.

## Workstream 8: Graph Query And Workspace UI

### 8.1 Graph Query

Add `otto-frontend/lib/processes/graph-queries.ts`.

Functions:

- `getCurrentProcessGraph(orgId, workspaceId, processId)`
- `getProcessSteps(orgId, workspaceId, processId)`
- `getNodeEvidenceBundle(orgId, workspaceId, nodeId)`
- `getDraftVersionStatus(orgId, workspaceId, processId)`

`getCurrentProcessGraph`:

- Prefer `processes.current_draft_version_id`.
- Fall back to `currentApprovedVersionId`.
- Load `graph_json` if available.
- If missing, build from normalized node/edge rows.
- If no graph exists, return an empty state.

### 8.2 Workspace Page

Update `otto-frontend/app/process/[id]/workspace/page.tsx` to load the DB graph instead of fixture/static graph data.

Empty state:

- If no operator synthesis exists, show a centered call to action:
  - "Add a capture to generate the workflow map"
  - Buttons to voice, screenshare, upload video, upload document

Draft state:

- Show a draft badge.
- Show approve button.
- Show regenerate link only for FDE/director.

Approved state:

- Show approved badge.
- Keep draft approval controls hidden unless a newer draft exists.

### 8.3 Steps Tab

Update `otto-frontend/components/workspace/tabs/StepsTab.tsx`.

Render canonical node data:

- step number
- action
- role
- systems
- inputs
- outputs
- typical time
- exceptions
- workarounds
- evidence links

Group by L3 parent if present. If only L4 nodes exist, render flat.

### 8.4 Summary Tab

Update `SummaryTab` to read narrative claims:

- current process summary
- evidence coverage
- unresolved gaps
- linked captures used

### 8.5 Evidence Drawer

Extend `EvidenceDrawer` so it can display:

- transcript evidence
- document evidence
- screen event evidence with OCR label and screenshot thumbnail if the artifact is still retained

If frame artifact expired, show OCR/label plus "frame expired by retention policy".

### 8.6 Approval UI

Add route:

- `POST /api/processes/[processId]/versions/[versionId]/approve`

Behavior:

- Validate role `director` or `fde`.
- Set old approved version to historical if necessary.
- Set version status `approved`.
- Update `processes.current_approved_version_id`.
- Keep current draft if it is the same version or clear it according to status policy.
- Audit log: `process_version.approved`.

## Workstream 9: Redaction

### 9.1 Live Redaction Request

`request_redaction(start_ms, end_ms)` should:

- Insert `redactions(status = pending)`.
- Publish data-channel acknowledgement.
- Emit Inngest event `operatorRedactionRequested`.

### 9.2 Redaction Saga

Inngest function:

1. Mark redaction `running`.
2. Mark transcript segments overlapping range as redacted.
3. Mark screen events overlapping range as redacted.
4. Mark evidence rows sourced from those segments/events as redacted.
5. Mark claim_evidence links as redacted.
6. Mark artifacts/keyframes overlapping range as redacted or delete immediately.
7. Recompute affected graph/narrative if a draft had already been built.
8. Mark redaction `complete`.

If any step fails:

- status `failed`
- create `follow_up_tasks(task_type = redaction_failure)`
- audit log

Do not physically delete first. First make reads respect `redacted_at`; physical deletion can lag.

## Workstream 10: Testing And Evals

### 10.1 Database Tests

Add tests under `otto-frontend/tests/phase2/`:

- `operator-capture-api.test.ts`
- `operator-upload-api.test.ts`
- `operator-graph-write.test.ts`
- `operator-redaction.test.ts`
- `operator-rls.test.ts`

Cover:

- capture session creation
- process-specific upload completion
- graph rows written transactionally
- graph JSON cache matches normalized rows
- redacted evidence is hidden
- cross-org access denied

### 10.2 Synthesis Unit Tests

Fixtures:

- voice-only transcript
- screenshare transcript + screen events
- uploaded video-derived events
- SOP chunks
- mixed SOP + operator contradiction

Assertions:

- expected number of nodes/edges
- expected systems/roles attached
- exceptions and workarounds preserved
- evidence IDs present on every synthesized claim
- no graph publish on failed stage

### 10.3 Agent Contract Tests

Python:

- schema round-trip for operator turn plan
- data-channel event parsing
- pause/resume behavior
- redaction request behavior
- transcript timing idempotency

TypeScript:

- operator tool validation
- claim allowlist validation
- fallback brain behavior

### 10.4 Visual Tests

Extend Playwright tests:

- capture entry has four modes
- voice prestart renders
- screenshare page renders preview/controls/conversation panel
- upload video flow renders
- upload document flow renders
- workspace graph empty state
- workspace graph populated state
- steps tab populated state
- evidence drawer handles screen evidence

### 10.5 Evals

Create `otto-frontend/evals/operator/`.

Golden tasks:

- happy-path voice-only purchase-order workflow
- hard-case exception-heavy returns workflow
- screenshare with Excel workaround
- SOP says one system, screen shows another
- silent screen recording with no narration
- narrated video with app switches

Metrics:

- step precision/recall
- edge precision/recall
- exception recall
- workaround recall
- evidence attribution rate
- contradiction detection rate
- bad-question rate for live agent turns

## Workstream 11: Sequencing

### Milestone A: Shared Operator Capture Foundation

Deliver:

- migration for graph/screen/provisional/redaction tables
- capture entry with four modes
- operator capture session API
- process-specific upload completion API
- graph query empty state

Exit:

- User can create the right capture sessions for all four modes.
- No synthesis yet required.

### Milestone B: Voice-only Operator Interview

Deliver:

- operator voice routes
- operator turn APIs
- operator slot schema/tools
- simulated typed fallback
- Python LiveKit operator voice worker or shared worker mode

Exit:

- Voice-only interview persists operator transcript/evidence/slot/provisional-step data.

### Milestone C: First Graph Synthesis

Deliver:

- operator synthesis stages 0, 2, 3, 4, 6, 9
- normalized graph writes
- graph JSON cache
- workspace graph render
- Steps tab from graph
- approve draft API

Exit:

- Voice-only interview produces an approvable workflow diagram.

### Milestone D: SOP And Screen Recording Upload

Deliver:

- process-specific SOP pipeline
- uploaded video processing
- audio transcription from video
- frame sampling/keyframe/screen event pipeline
- operator synthesis can consume documents and video screen events

Exit:

- Screen recording and SOP uploads can generate or improve the workflow diagram.

### Milestone E: Live Screen-share Intelligence

Deliver:

- browser screen publishing
- operator agent subscribes to screen track
- live keyframe processing
- screen-signal triggers
- live provisional segmentation
- screen-aware operator questioning

Exit:

- Live screenshare + voice capture catches at least one workaround/exception that was not narrated.

### Milestone F: Redaction And Hardening

Deliver:

- live redaction request
- redaction saga
- retention cleanup
- contradiction detection
- full eval and visual coverage

Exit:

- Product is safe enough for pilot operator captures.

## Implementation Notes

### Keep Synthesis As Source Of Truth

The live operator agent can write `provisional_steps`, exceptions, workarounds, and slot state. It should not write final `process_nodes`. Final graph creation belongs to operator synthesis because it needs the whole transcript, screen events, SOP context, contradictions, and layout pass.

### Prefer One Upload Flow With Process Context

Do not clone the workspace onboarding upload pipeline wholesale. Extract reusable upload primitives, then layer process-specific behavior on top:

- generic presign
- generic upload progress
- process capture completion
- mode-specific Inngest event

### Keep `graph_json` As Cache

`ProcessCanvas` already consumes `ProcessGraph`. Use normalized graph tables for correctness and claims, but keep `graph_json` to avoid a large frontend rewrite and to provide stable render performance.

### Screen Events Are Evidence, Not UI Telemetry

Do not store screen events merely as debug logs. Every meaningful screen event should either create observed evidence or be explicitly marked as dropped/no-evidence in stage metadata.

### SOP Upload Is Not Truth By Default

SOPs are documented evidence, not necessarily current reality. Synthesis should preserve contradictions instead of automatically forcing operator behavior to match the SOP.

### Voice-only Must Stand Alone

Screen-share is the richer path, but voice-only is not a placeholder. It must produce a complete enough map by asking direct step-boundary, handoff, system, exception, and workaround probes.

## Risks And Mitigations

### Risk: Too Many Parallel Pipelines

Mitigation: make all modes produce `transcript_segments`, `screen_events`, `document_chunks`, `evidence`, and `provisional_steps`, then synthesize from an `OperatorEvidencePack`.

### Risk: Live Screen Processing Slows The Interview

Mitigation: frame processing is advisory. The interview continues if screen labeling lags; delayed screen events can still influence later probes and post-interview synthesis.

### Risk: Graph Writes Drift From Claims

Mitigation: graph rows and claims are written in the same synthesis transaction; `graph_json` is cache only. Add a reconciliation test before adding a nightly job.

### Risk: Uploaded Video Is Huge

Mitigation: size limits, async processing, staged progress, retention TTL, and no blocking UI wait for full synthesis.

### Risk: Redaction Misses Derived Artifacts

Mitigation: every evidence row references source IDs. Redaction cascades from source rows to evidence to claim links and then triggers affected draft regeneration.

## Files To Create Or Modify

Create:

- `PHASE_2_3.md`
- `otto-frontend/migrations/0005_operator_capture_graph.sql`
- `otto-frontend/lib/interview/operator/slot-schema.ts`
- `otto-frontend/lib/interview/operator/tools.ts`
- `otto-frontend/lib/interview/operator/brain.ts`
- `otto-frontend/lib/synthesis/operator.ts`
- `otto-frontend/lib/synthesis/operator-layout.ts`
- `otto-frontend/lib/processes/graph-queries.ts`
- `otto-frontend/app/api/processes/[processId]/operator-captures/route.ts`
- `otto-frontend/app/api/livekit/operator-room/route.ts`
- `otto-frontend/app/api/operator-interviews/[captureSessionId]/turns/route.ts`
- `otto-frontend/app/api/operator-interviews/[captureSessionId]/coverage/route.ts`
- `otto-frontend/app/api/operator-interviews/[captureSessionId]/complete/route.ts`
- `otto-frontend/app/api/processes/[processId]/captures/uploads/route.ts`
- `otto-frontend/app/api/processes/[processId]/versions/[versionId]/approve/route.ts`
- `otto-frontend/app/process/[id]/capture/voice/*`
- `otto-frontend/app/process/[id]/capture/upload-video/*`
- `otto-frontend/app/process/[id]/capture/upload-document/*`
- `agents/operator/*` or equivalent shared agent package

Modify:

- `otto-frontend/lib/db/schema.ts`
- `otto-frontend/lib/inngest/client.ts`
- `otto-frontend/lib/inngest/functions.ts`
- `otto-frontend/lib/adapters/livekit.ts`
- `otto-frontend/app/process/[id]/capture/page.tsx`
- `otto-frontend/app/process/[id]/capture/screenshare/ScreenshareClient.tsx`
- `otto-frontend/components/capture/ConversationPanel.tsx`
- `otto-frontend/components/capture/CaptureControls.tsx`
- `otto-frontend/components/capture/ScreenSharePreview.tsx`
- `otto-frontend/app/process/[id]/workspace/page.tsx`
- `otto-frontend/app/process/[id]/workspace/WorkspaceClient.tsx`
- `otto-frontend/components/workspace/tabs/SummaryTab.tsx`
- `otto-frontend/components/workspace/tabs/StepsTab.tsx`
- `otto-frontend/components/workspace/EvidenceDrawer.tsx`
- `schemas/claim-subject-fields.json`
- `schemas/evidence.schema.json`
- `schemas/slot-state.schema.json`

## Definition Of Done

The combined phase is done when one process can be built three ways in a local/staging workspace:

1. Voice-only operator interview creates a draft workflow diagram.
2. Screen-share + voice operator interview enriches the same process with observed systems, workarounds, and exceptions.
3. Uploaded screen recording plus SOP produces the same graph shape and flags contradictions between documented and observed behavior.

The resulting workspace must show the workflow diagram, Summary, Steps, evidence drawer, and approval action from persisted DB data only.
