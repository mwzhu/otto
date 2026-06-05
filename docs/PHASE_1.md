# Phase 1 Implementation Plan: Director Intake + Document Upload

This plan expands Phase 1 from `BUILD_PLAN.md` into an implementation-ready work plan for the current repo.

Phase 1 goal: a director can complete a 20-minute voice interview or upload documents, then see a high-level inventory dashboard with evidence-linked process cards and director-layer process detail pages.

Phase 1 scope is intentionally narrower than the full product. It includes director-layer breadth, document extraction, process inventory synthesis, coverage scoring, evidence links, and DB-backed overview/detail surfaces. It does not include operator capture, React Flow maps, screen-share capture, draft approval, ROI opportunities, or transformation proposals.

## Current Repo Baseline

The app already has a useful Phase 0 shell:

- Next app in `otto-frontend/` with routes for onboarding, upload, voice, overview, process detail, workspace, admin, synthesis, and settings.
- Phase 0 migration at `otto-frontend/migrations/0000_phase0_foundations.sql`.
- Drizzle schema in `otto-frontend/lib/db/schema.ts`.
- Adapter placeholders in `otto-frontend/lib/adapters/llm.ts`, `voice.ts`, `vector.ts`, and `storage.ts`.
- Inngest client/function scaffolding in `otto-frontend/lib/inngest/`.
- Fixture-driven UI under `otto-frontend/lib/fixtures/` and components under `otto-frontend/components/`.
- Static/high-fidelity mockup implementation already exists for many later surfaces.

Phase 1 should convert the relevant director intake surfaces from fixtures/static behavior to persisted, traceable product behavior while keeping the later mockup screens available as non-blocking placeholders.

## Exit Criteria

Phase 1 is complete when all of the following are true:

1. A director can create or enter a workspace and choose either voice interview or document upload.
2. Voice intake creates a `director_interview` capture session, persists transcript segments, updates slot state during the session, and records candidate process/system/person/pain-point claims with evidence.
3. Document upload creates a `document_upload` capture session, stores the original artifact, parses it into chunks, embeds chunks, extracts claims, and links every extracted claim to document evidence.
4. A subset synthesis DAG runs stages 1, 2, 4, 8, and 10 from `BUILD_PLAN.md`.
5. The overview dashboard renders DB-backed metrics and process cards: process name, status, description, people/roles, systems, frequency, complexity, documentation coverage, and evidence availability.
6. The process detail page renders director-layer summary, accountable roles, system pills, complexity breakdown, and risk/friction callouts, with evidence links.
7. FDE-visible coverage scorecard shows which director slots are filled, partial, conflicting, or missing.
8. RLS-backed org isolation remains enforced for every persisted query.
9. Integration tests cover the write paths, synthesis subset, and evidence linkage. Visual smoke tests cover onboarding, upload, voice, overview, and process detail.

## Guiding Decisions

- Use the existing Next.js monolith for Phase 1 API routes, server actions, UI, and Inngest functions.
- Keep JSON Schema as the cross-language source of truth even before Python LiveKit workers land in full.
- Implement voice intake in two layers, but make the first shipped version resilient: browser audio plus transcript ingestion can be simulated in dev/test while LiveKit/Deepgram/Cartesia integration is wired behind adapters.
- Treat every generated or extracted assertion as a `claim` linked to `evidence`; avoid direct denormalized writes without a claim trail.
- Keep deterministic complexity scoring in TypeScript; LLMs propose structured fields, not final numeric authority.
- Prefer one clear persisted model over temporary frontend state. Fixtures can remain only as fallback/demo data.
- Keep `candidate_processes` separate from canonical `processes` in Phase 1. Director/doc captures can generate weak or duplicate candidates that need discard/merge audit history before becoming real process records.

## Workstream 1: Data Model And Schema Contracts

### 1.1 Add Phase 1 Tables

Create `otto-frontend/migrations/0001_phase1_director_intake.sql` and update `otto-frontend/lib/db/schema.ts`.

Add `slot_states`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `capture_session_id`
- `slot_path text not null`
- `value jsonb`
- `status enum`: `empty`, `partial`, `filled`, `asked_unknown`, `conflicting`, `pending_re_extract`
- `confidence numeric(4,3) not null default 0`
- `evidence_ids uuid[] not null default '{}'`
- `last_asked_at timestamptz`
- `priority integer not null default 0`
- `candidates jsonb`
- timestamps
- unique index on `(capture_session_id, slot_path)`

Add `candidate_processes`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `capture_session_id`
- `proposed_name text not null`
- `proposed_function text`
- `proposed_owner_role_id uuid references roles(id)`
- `frequency text`
- `complexity_hint text`
- `status enum`: `pending`, `promoted`, `discarded`, `merged`
- `promoted_process_id uuid references processes(id)`
- `evidence_ids uuid[] not null default '{}'`
- `confidence numeric(4,3)`
- timestamps
- index on `(workspace_id, status)`

Add `capture_process_links`:

- `org_id`, `workspace_id`
- `capture_session_id`, `process_id`
- `link_type enum`: `created`, `enriched`, `corrected`, `candidate`
- `confidence numeric(4,3)`
- timestamps
- primary key on `(capture_session_id, process_id, link_type)`

Add `follow_up_tasks`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `process_id`, `capture_session_id`
- `task_type enum`: `open_question`, `conflicting_slot`, `low_confidence_claim`, `failed_stage`, `weak_merge`, `redaction_failure`
- `title text not null`
- `description text`
- `target_type text`
- `target_id uuid`
- `priority numeric(6,3) not null default 1.0`
- `status enum`: `open`, `in_progress`, `resolved`, `dismissed`
- `assigned_to_user_id uuid references users(id)`
- `context_json jsonb`
- timestamps

Add `agent_decision_log`:

- `id uuid primary key`
- `org_id`, `workspace_id`
- `capture_session_id uuid`
- `synthesis_run_id uuid`
- `turn_index integer`
- `stage_name text`
- `ts_start timestamptz not null`
- `ts_end timestamptz`
- `transcript_segment_ids uuid[] not null default '{}'`
- `slot_updates jsonb`
- `ranked_probe_intents jsonb`
- `chosen_intent jsonb`
- `sanitized_agent_utterance text`
- `prompt_template_id text`
- `prompt_template_version text`
- `tool_calls jsonb`
- `model text`
- `token_count_input integer`
- `token_count_output integer`
- `cost_cents numeric(10,3)`
- `latency_ms integer`
- `cache_hit boolean`
- `degraded_quality boolean not null default false`
- timestamps
- index on `(capture_session_id, ts_start)`
- index on `(synthesis_run_id, stage_name)`

This table replaces a narrower `interview_turns` table. It intentionally covers both live interview turns and synthesis stages, matching the audit/reconstructability contract in `BUILD_PLAN.md` §12.6 and enabling Phase 1 cost/cache/latency measurement.

Add `synthesis_runs`:

- `id uuid primary key`
- `org_id`, `workspace_id`
- `capture_session_ids uuid[] not null`
- `run_type text not null` with Phase 1 values `document_inventory`, `director_inventory`, `combined_inventory`
- `status text not null`: `queued`, `running`, `partial_synthesis`, `completed`, `failed`
- `stage text`
- `stage_versions jsonb not null default '{}'`
- `error_json jsonb`
- timestamps

Add `synthesis_stage_outputs`:

- `id uuid primary key`
- `org_id`, `workspace_id`, `synthesis_run_id`
- `stage_name text not null`
- `input_row_refs jsonb not null default '[]'`
- `output_row_refs jsonb not null default '[]'`
- `status text not null`
- `error_json jsonb`
- timestamps

Add projection tables for denormalized overview queries:

- `process_systems(process_id, system_id, org_id, workspace_id, evidence_ids uuid[])`
- `process_roles(process_id, role_id, org_id, workspace_id, evidence_ids uuid[])`
- `process_people(process_id, person_id, org_id, workspace_id, evidence_ids uuid[])`

These tables are projections derived from active claims and should not contain free-form relationship fields. The relationship semantics stay in claims; the projection tables exist only to make overview/detail reads fast.

Every new table must follow Phase 0's tenant model: include `org_id` where practical, enable and force RLS, and add `org_id = app_current_org_id()` policies. For tables without direct `org_id` access, prefer adding `org_id` over relying on parent-table joins.

### 1.2 Add Needed Enums

Add Postgres/Drizzle enums for:

- `slot_state_status`
- `candidate_process_status`
- `capture_link_type`
- `follow_up_task_type`
- `follow_up_task_status`
- `synthesis_run_status`
- `synthesis_run_type`
- `synthesis_stage_status`

Keep enum values conservative. Adding values later is easier than supporting broad vague states now.

### 1.3 Define JSON Schemas

Create a top-level `schemas/` directory, matching `BUILD_PLAN.md`.

Minimum Phase 1 schemas:

- `schemas/claim.schema.json`
- `schemas/evidence.schema.json`
- `schemas/slot-state.schema.json`
- `schemas/slot-extraction.schema.json`
- `schemas/probe-intent-ranking.schema.json`
- `schemas/director-process-inventory.schema.json`
- `schemas/document-extraction.schema.json`
- `schemas/complexity-score.schema.json`
- `schemas/narrative-tab.schema.json`

Generate TypeScript validators into `otto-frontend/lib/generated/schemas/` or hand-author Zod mirrors first if generation would slow the phase. The important invariant is that every LLM response is validated before writes.

### 1.4 Normalize Claim Subject Fields

Document and enforce Phase 1 claim shapes:

- `subject_type = 'process'`, `field = 'frequency' | 'description' | 'volume' | 'documentation_maturity' | 'complexity_signal' | 'pain_point' | 'risk' | 'kpi' | 'upstream_dependency' | 'downstream_dependency'`
- `subject_type = 'system'`, `field = 'vendor' | 'used_in_process' | 'source_of_truth' | 'shadow_system'`
- `subject_type = 'role'`, `field = 'owns_process' | 'participates_in_process' | 'handoff_target'`
- `subject_type = 'person'`, `field = 'role' | 'manager' | 'single_point_of_failure'`

Update `otto-frontend/lib/db/write-claim.ts` so the canonical claim-write helper can:

- accept an idempotency key
- supersede previous active claims for single-value fields
- append multi-value claims for lists like pain points and risks
- create claim/evidence links in one transaction
- write an `audit_log` entry for generated claims

Also implement the projection rule from `BUILD_PLAN.md` §6.4.1:

- Single-value projected claims are written transactionally with their parent-row projection.
- Projection tables (`process_systems`, `process_roles`, `process_people`) are updated only from the claim-write/synthesis projection path.
- Add a nightly Inngest reconciliation job that verifies active claims agree with parent-row and projection-table state, logs drift, and repairs deterministic projections.

## Workstream 2: Workspace And Intake Routing

### 2.1 Workspace Bootstrap

Finish DB-backed workspace creation in `otto-frontend/app/api/workspaces/route.ts`.

Expected behavior:

- Uses current WorkOS user/org from `lib/auth/session.ts`.
- Creates `organizations`, `users`, `workspaces`, and `workspace_memberships` as needed.
- Sets org context before every query.
- Returns the active workspace ID and role.

Add a server-side helper:

- `otto-frontend/lib/workspaces/current.ts`
- `getCurrentWorkspaceOrCreateDemo()`
- `requireWorkspaceAccess(workspaceId, allowedRoles)`

For local development without WorkOS credentials, support a clearly named demo mode controlled by env, using stable IDs from `lib/auth/stable-id.ts`.

### 2.2 Onboarding Entry Tiles

Convert `otto-frontend/app/onboarding/page.tsx` from simple links to workspace-aware navigation:

- Voice tile should route to `/workspaces/[workspaceId]/onboarding/voice` or keep current route with workspace query param if route churn is too high.
- Upload tile should route to the upload page with a real workspace context.
- Language selector should persist preferred interview language on the capture session or workspace settings.

Keep the current visual treatment. This is wiring work, not a redesign.

### 2.3 Route Organization

Preferred route shape for Phase 1:

- `/onboarding`
- `/onboarding/voice`
- `/onboarding/voice/live`
- `/onboarding/upload`
- `/overview`
- `/process/[id]`

Use the active workspace from session/demo context rather than forcing workspace IDs into every URL. Add workspace-scoped APIs underneath `/api/workspaces/[workspaceId]/...` only where explicit IDs are useful.

## Workstream 3: Director Voice Intake

### 3.1 Capture Session Lifecycle

Add API routes:

- `POST /api/director-interviews` creates a `capture_sessions` row with `capture_type = 'director_interview'`.
- `POST /api/director-interviews/[id]/turns` persists transcript segment(s), runs the brain, updates slots, and returns the next prompt.
- `POST /api/director-interviews/[id]/complete` marks the session complete and enqueues process inventory synthesis.
- `GET /api/director-interviews/[id]/coverage` returns slot-state coverage for FDE/admin UI.

Every mutating request must accept or create an idempotency key.

### 3.2 LiveKit Room Setup

Add a LiveKit token route:

- `POST /api/livekit/director-room`
- creates a room name based on workspace and capture session
- returns participant token and room metadata

Environment variables:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

For local dev when LiveKit env is missing, the voice page should enter simulated transcript mode, not crash.

### 3.3 Voice Page Behavior

Wire `otto-frontend/app/onboarding/voice/page.tsx` and `voice/live/page.tsx`.

Pre-start page:

- select language
- display consent/recording notice
- start button creates capture session and redirects to live room

Live page:

- shows transcript from persisted turns
- shows Operations Notes/slot coverage from latest `slot_states`
- supports mute, pause, and end controls
- when end is clicked, completes session and routes to `/overview`

Phase 1 can ship without true TTS playback if the text prompt path is working, but the adapter surface should be in place.

### 3.4 Director Interview Brain

Implement the two-layer brain in TypeScript for the fastest Phase 1 path, while explicitly preserving the `BUILD_PLAN.md` target of a Python LiveKit Agents runtime for the Director Interview Agent.

Decision: Phase 1 starts with a TypeScript brain behind API routes so local demo, CI fixtures, and DB writes land quickly in the existing monolith. In parallel, keep LiveKit room/token plumbing and the schema/tool contracts runtime-neutral. Before Phase 2 starts, decide whether to keep the TS brain as the production runtime or move the same contracts into a Python LiveKit worker. This is not free migration work; if real LiveKit turn handling becomes the critical path in Week 3, switch to Python then rather than building two stateful loops.

- `otto-frontend/lib/interview/director/slot-schema.ts`
- `otto-frontend/lib/interview/director/probe-library.ts`
- `otto-frontend/lib/interview/director/brain.ts`
- `otto-frontend/lib/interview/director/voice.ts`
- `otto-frontend/lib/interview/director/tools.ts`

Brain responsibilities per turn:

1. Read current slot states.
2. Extract claims and slot updates from the latest utterance using structured output.
3. Persist evidence for transcript spans.
4. Invoke typed tools for process/system/person/pain-point/SPOF slot changes.
5. Rank next probe intents.
6. Return a concise next question for the director.
7. Persist an `agent_decision_log` row with slot transitions, ranked intents, chosen utterance, tool calls, model/cost/latency metadata, cache hit/miss, and degraded-quality state.

Voice layer responsibilities:

- Phrase the selected intent naturally.
- Use last four turns plus persona/context.
- Keep prompts short, warm, and specific.
- Fall back to canned probe phrasing on LLM failure.

### 3.5 Prompt Caching

Implement the prompt-caching split from `BUILD_PLAN.md` §11.4 in the first brain version:

- Static cached block: system prompt, probe library YAML, slot schema definition, org ontology snapshot, and process/workspace metadata.
- Dynamic uncached block: current slot-state summary, last N transcript turns, recent live events if any, and latest utterance.
- Anthropic calls set cache control on the static block where supported.
- Every LLM call records `cache_hit`, model, token counts, latency, and estimated cost in `agent_decision_log`.

This is part of Phase 1, not later optimization, because it determines whether director interviews stay near the target cost.

### 3.6 Deterministic Fallback

Implement the failure behavior from `BUILD_PLAN.md` §12.7:

- If structured extraction fails after retry exhaustion, preserve the transcript segment, mark affected slots `pending_re_extract`, and set `degraded_quality = true`.
- Probe ranking falls back to strict rules: must-fire probes first, then highest-priority empty/partial slot, then playback confirmation, then last-bad-case after happy-path coverage.
- Voice phrasing falls back to the first canned phrasing on the selected probe.
- Add an hourly `re_extract_degraded_turns` Inngest job that reprocesses degraded turns once the LLM adapter is healthy and merges recovered claims/slot states through the normal write path.

### 3.7 Tool Implementations

Implement Phase 1 director tools as server-side functions:

- `recordProcess`
- `recordSystem`
- `recordPerson`
- `recordPainPoint`
- `recordSpof`
- `updateSlotState`
- `createFollowUpTask`

Tool writes:

- `recordProcess` inserts or updates `candidate_processes` and creates supporting claims/evidence. Promotion to `processes` happens later through the candidate review/promote flow.
- `recordSystem` upserts `systems`; `process_systems` is updated only by synthesis projection after a candidate is promoted.
- `recordPerson` upserts `people` and, if possible, `roles`.
- `recordPainPoint` writes a multi-value claim with `evidence_label = 'stated_director'`.
- `recordSpof` writes a risk/SPOF claim.
- `updateSlotState` upserts the slot state and evidence IDs.
- `createFollowUpTask` writes to `follow_up_tasks` and records an `audit_log` entry.

## Workstream 4: Document Upload Pipeline

### 4.1 Upload UI

Wire `otto-frontend/app/onboarding/upload/UploadClient.tsx` to real APIs.

Supported UX:

- drag/drop or browse
- allow PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG
- show per-file upload progress
- show parsing/extraction status
- route to `/overview` after extraction completes or let user continue while background processing runs

### 4.2 Storage Flow

Add API routes:

- `POST /api/artifacts/presign` returns R2 presigned upload metadata.
- `POST /api/artifacts/complete` creates/updates `artifacts`, creates a `document_upload` capture session if needed, and emits the Inngest event.
- `GET /api/artifacts/[id]` returns status and parse errors.

Use existing `otto-frontend/lib/adapters/storage.ts`; fill in R2 implementation with retry policy from `BUILD_PLAN.md`.

Environment variables:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_PUBLIC_BASE_URL` or signed-read equivalent

### 4.3 Parse And Chunk

Extend `otto-frontend/lib/inngest/functions.ts`:

- Current `artifactUploaded` only writes audit. Replace/extend it into a durable pipeline.
- Stage `parse-document`: call LlamaParse/Unstructured adapter.
- Stage `chunk-document`: split semantic chunks with stable ordinals.
- Stage `embed-chunks`: call vector adapter and write embeddings.
- Stage `extract-document-claims`: structured LLM extraction into process inventory candidates.
- Stage `publish-document-claims`: write evidence and claims.
- Stage `enqueue-inventory-synthesis`: starts the subset synthesis run.

Add adapter:

- `otto-frontend/lib/adapters/document-parser.ts`

Environment variables:

- `LLAMAPARSE_API_KEY` or `UNSTRUCTURED_API_KEY`

If parser env is missing in local dev, use a deterministic text/plain fallback for `.txt` and fixture parser for tests.

### 4.4 Evidence Creation

For every chunk:

- write `document_chunks`
- write at least one `evidence` row when a claim is extracted
- use `source_type = 'document_chunk'`
- use `evidence_label = 'documented'`
- preserve quote spans where possible in `span_start` and `span_end`

Claims without evidence should be rejected unless explicitly marked `inferred`.

## Workstream 5: Phase 1 Synthesis Subset

Implement only these stages from `BUILD_PLAN.md`:

1. Document extraction
2. Director-layer process inventory extraction
4. Ontology normalization
8. Complexity scoring
10. Narrative generation

### 5.1 Inngest Event Design

Add events in `otto-frontend/lib/inngest/client.ts`:

- `director/interview.completed`
- `document/artifact.uploaded`
- `synthesis/inventory.requested`

Each event payload includes:

- `orgId`
- `workspaceId`
- `captureSessionIds`
- triggering user ID when available
- idempotency key

### 5.2 Synthesis Function

Add `inventorySynthesis` in `otto-frontend/lib/inngest/functions.ts`.

Stage detail:

- `stage-1-document-extraction`: no-op for voice-only runs; for document runs, verify chunks/claims are ready.
- `stage-2-process-inventory`: merge director/doc candidate process claims into `candidate_processes`, preserving evidence IDs and confidence. Do not create canonical `processes` rows until user/FDE promotion.
- `stage-4-ontology-normalization`: canonicalize roles and systems into `roles`, `systems`, `ontology_terms`.
- `stage-8-complexity-scoring`: compute deterministic score from vulnerabilities, friction signals, external dependencies, system sprawl, frequency, and documentation maturity for each candidate. Store factor scores, assumptions, and evidence IDs on the candidate/narrative claim payload; project totals only after promotion.
- `stage-10-narrative-generation`: create director-layer summary/risk/impact snippets for candidate review cards and future process detail, not full operator-map narratives.
- `publish-draft-inventory`: mark synthesis complete and publish candidate cards. Do not write `process_versions` until a candidate is promoted to a canonical `process`.

Persist each stage in `synthesis_stage_outputs`.
Also write an `agent_decision_log` row per stage with prompt template, model, token/cost/latency metadata, cache hit/miss, row refs, and errors.

### 5.3 Complexity Score V1

Create `otto-frontend/lib/synthesis/complexity.ts`.

Suggested deterministic formula:

- `system_sprawl`: 0-20 based on unique systems per process.
- `handoff_count`: 0-15 based on roles/people touching process.
- `frequency_pressure`: 0-15 from frequency/volume.
- `friction_severity`: 0-20 from pain points severity/frequency.
- `spof_risk`: 0-15 from SPOF claims.
- `documentation_gap`: 0-15 inverse of documentation maturity/coverage.

Store for each candidate and later each promoted process:

- total score
- factor scores
- evidence IDs per factor
- assumptions where values are missing

When a candidate is promoted, write the score/factor payload through the claim path and update deterministic projections. The overview may read projected totals, but the detail page must be able to explain every score factor from evidence.

### 5.4 Narrative Generation V1

Create `otto-frontend/lib/synthesis/narrative.ts`.

Generate structured output:

- `summaryParagraph`
- `whatThisProcessInvolves`
- `topRisks[]`
- `frictionSignals[]`
- `recommendedDrilldownReason`
- `evidenceLinks[]`

Rules:

- Each paragraph-level claim must include supporting evidence IDs.
- Inferred statements must be labeled as inferred.
- If evidence is thin, say so in the generated structure rather than filling gaps.

## Workstream 6: Overview Dashboard From DB

### 6.1 Data Access Layer

Create query helpers:

- `otto-frontend/lib/overview/queries.ts`
- `getOverviewMetrics(workspaceId)`
- `getProcessCards(workspaceId)`
- `getDrilldownRecommendations(workspaceId)`

Queries should return the existing `ProcessSummary` shape where practical, then evolve components only where the DB shape requires it.

### 6.2 Overview Page

Update:

- `otto-frontend/app/overview/page.tsx`
- `otto-frontend/app/overview/OverviewClient.tsx`
- `otto-frontend/components/overview/ProcessCard.tsx`
- `otto-frontend/components/overview/DrilldownBanner.tsx`

Replace fixture imports with server-loaded DB data.

Dashboard metrics:

- `Processes Captured`: count of promoted draft/approved processes plus pending candidates, labeled clearly in the UI.
- `Documentation Coverage`: percent of processes with at least one documented evidence claim.
- `Complexity Score`: average of latest draft complexity score.
- `Single Points of Failure`: count of active SPOF claims.

Process card fields:

- name
- status
- description
- people/roles
- systems
- frequency
- complexity score
- documentation coverage
- evidence count

Candidate cards can open a candidate review/detail state or be promoted directly. Promoted cards route to `/process/[id]`; pending candidates must not be routed through `/process/[id]` until they have a real `processes.id`.

### 6.3 Empty And Partial States

Support three states:

- no captures yet: route back to onboarding with a clear CTA
- capture processing: show progress and partial cards as they become available
- synthesis failed/partial: show usable partial data and an FDE retry affordance

### 6.4 Candidate Promotion

Add candidate review/promote endpoints:

- `POST /api/candidate-processes/[id]/promote`
- `POST /api/candidate-processes/[id]/discard`
- `POST /api/candidate-processes/[id]/merge`

Promotion is atomic:

1. Insert a canonical `processes` row from the candidate fields.
2. Insert the initial `process_versions` draft row for that process.
3. Write `capture_process_links` with `link_type = 'created'`.
4. Rebuild `process_systems`, `process_roles`, and `process_people` projections from active claims.
5. Update `candidate_processes.status = 'promoted'` and `promoted_process_id`.
6. Write `audit_log` and `agent_decision_log` metadata.

Discard and merge preserve the candidate row and audit trail; never hard-delete candidate rows during Phase 1.

## Workstream 7: Director-Layer Process Detail

### 7.1 Process Detail Queries

Create:

- `otto-frontend/lib/processes/queries.ts`
- `getDirectorProcessDetail(processId)`
- `getProcessEvidence(processId)`

Return:

- process metadata
- latest draft version summary
- accountable roles/people
- touched systems
- complexity factor breakdown
- risks/friction callouts
- evidence links grouped by claim

### 7.2 Process Detail Page

Update `otto-frontend/app/process/[id]/page.tsx` and existing process components:

- `AccountabilityBlock`
- `ComplexityBreakdown`
- `RiskCallouts`
- `SystemPills`
- `EvidenceLink`

Keep this page director-layer only in Phase 1:

- no map/canvas
- no operator steps
- no Transformation Proposal
- `Add Capture` can link to the existing capture entry placeholder, but the operator flow remains Phase 2.

### 7.3 Evidence Link Behavior

Phase 1 evidence link can open a lightweight drawer/modal:

- source type
- source filename or transcript timestamp
- quote
- confidence
- evidence label

Do not build full video/screen playback yet.

## Workstream 8: FDE Coverage Scorecard

### 8.1 Coverage Query

Create:

- `otto-frontend/lib/admin/coverage-queries.ts`
- `getDirectorCoverage(workspaceId, captureSessionId?)`

Coverage groups should mirror director slots from `BUILD_PLAN.md`:

- scope and boundaries
- dependencies
- ownership and participating roles
- people
- systems of record and shadow systems
- frequency and volume
- handoffs
- KPIs
- pain points
- SPOFs
- controls/compliance exposure
- documentation maturity
- executive priority
- variants

### 8.2 Admin UI

Update:

- `otto-frontend/app/admin/coverage/page.tsx`
- `otto-frontend/components/admin/CoverageScorecard.tsx`

Show:

- filled/partial/missing/conflicting counts
- per-slot status
- confidence
- last asked time
- evidence count
- follow-up tasks

Gate this behind FDE/org admin role once RBAC is active. In demo mode, show it but label it as FDE-visible.

## Workstream 9: Adapters, Observability, And Failure Behavior

### 9.1 LLM Adapter

Finish `otto-frontend/lib/adapters/llm.ts`:

- `generate`
- `stream`
- `structured`
- validation retry once on schema failure
- model constants in `otto-frontend/lib/ai/models.ts`
- prompt template IDs and versions on every call

Add Anthropic env:

- `ANTHROPIC_API_KEY`

If missing, throw a structured permanent error in production and use deterministic fixtures in local/test.

### 9.2 Voice Adapter

Finish `otto-frontend/lib/adapters/voice.ts` enough for Phase 1:

- Deepgram transcription interface
- Cartesia TTS interface
- text-only fallback path

The frontend can display text prompts before audio playback is perfect.

### 9.3 Vector Adapter

Finish `otto-frontend/lib/adapters/vector.ts`:

- `embed(text)`
- `embedBatch(texts)`
- provider toggle for Voyage/OpenAI
- retry policy
- lexical fallback flag when embeddings fail

### 9.4 Audit Logging

Write audit entries for:

- capture session started/completed
- artifact uploaded/parsed/failed
- synthesis run started/completed/failed
- process inventory published
- generated claim written
- evidence opened by user

Keep raw user text out of audit metadata unless sanitized.

Add `otto-frontend/lib/security/sanitize.ts` in Phase 1. It should at minimum replace emails, phone numbers, SSNs, and credit-card-like numbers with `[PII:type]` tokens before writing `sanitized_agent_utterance`, small structured LLM outputs, or diagnostic metadata to `agent_decision_log`/`audit_log`. Raw transcripts stay in `transcript_segments` and remain subject to evidence/redaction policy rather than being duplicated into logs.

### 9.5 Cost, Cache, And Latency Telemetry

Every LLM adapter call used by interview or synthesis must return metadata:

- model
- input/output token counts
- estimated cost
- latency
- cache hit/miss where available
- prompt template ID/version

The caller writes this metadata to `agent_decision_log`. Add an FDE/admin query that can compute per-director-interview cost and synthesis p95 wall-clock from Phase 1 data.

## Workstream 10: Testing And Verification

### 10.1 Unit Tests

Add tests under `otto-frontend/tests/phase1/`.

Cover:

- slot state reducer/upsert behavior
- probe ranking fallback
- prompt-cache message assembly keeps static and dynamic blocks separate
- claim write/supersession rules
- document chunking
- complexity scoring
- narrative schema validation
- overview metric aggregation
- sanitizer replaces PII before log persistence
- cost/latency metadata is captured from adapter responses

### 10.2 Integration Tests

Add DB-backed tests:

- create workspace
- upload artifact metadata
- parse fixture document into chunks
- extract fixture claims
- run inventory synthesis
- verify process cards have evidence-linked claims
- verify RLS blocks cross-org reads
- verify degraded turns are re-extracted and merged through the normal claim/slot path
- verify candidate promotion creates a process, process version, capture link, audit row, and projections atomically

Use deterministic fixtures rather than real vendor calls.

### 10.3 API Tests

Cover:

- `POST /api/director-interviews`
- `POST /api/director-interviews/[id]/turns`
- `POST /api/director-interviews/[id]/complete`
- `POST /api/artifacts/presign`
- `POST /api/artifacts/complete`
- relevant status endpoints

### 10.4 Visual Smoke Tests

Extend existing Playwright visual tests:

- onboarding entry screen
- voice pre-start
- voice live transcript/notes
- upload progress/status
- overview with DB-backed cards
- process detail with evidence drawer
- FDE coverage scorecard

### 10.5 Manual Acceptance Script

Add `otto-frontend/docs/phase1-acceptance.md` with a script:

1. Start dev server.
2. Create demo workspace.
3. Complete simulated director voice interview using a provided transcript.
4. Upload a sample SOP.
5. Wait for synthesis completion.
6. Open overview.
7. Verify process cards and metrics.
8. Open a process detail page.
9. Click evidence links.
10. Open admin coverage.

## Week-By-Week Delivery Plan

### Week 2: Persistence And Intake Skeleton

Deliverables:

- Phase 1 migration and Drizzle schema updates.
- JSON/Zod schema contracts for slot extraction, document extraction, and inventory synthesis.
- Workspace bootstrap helper.
- Director capture session APIs.
- Upload presign/complete APIs.
- Inngest event names and skeleton pipeline.
- `agent_decision_log`, `candidate_processes`, `follow_up_tasks`, and projection-table RLS policies.
- Demo/test mode for missing external vendors.

Acceptance:

- Tests can create a workspace, create a director capture session, create a document artifact, and write a claim with evidence.

### Week 3: Director Brain And Document Pipeline

Deliverables:

- Director slot schema and probe library v1.
- Brain turn endpoint with structured extraction, prompt caching, deterministic fallback, and fallback probe ranking.
- Transcript segment, evidence, slot state, and `agent_decision_log` persistence.
- LlamaParse/fixture parser adapter.
- Document chunking, embedding, and structured extraction.
- Canonical tool functions for record process/system/person/pain/SPOF.

Acceptance:

- A simulated interview transcript produces candidate processes and coverage states.
- A fixture document produces chunks, evidence rows, and process/system/role claims.

### Week 4: Inventory Synthesis And DB-Backed UI

Deliverables:

- Inventory synthesis subset stages 1, 2, 4, 8, 10.
- Complexity score v1.
- Narrative generation v1.
- Candidate review/promote/discard flow.
- DB-backed overview metrics and process cards.
- DB-backed director process detail page.
- Evidence drawer/modal.
- Processing, empty, and partial states.

Acceptance:

- Completing a simulated voice interview or fixture document upload routes to overview with real DB-backed process cards.
- Process detail shows director-layer summary, systems, roles, risks, and evidence.

### Week 5: Hardening, Coverage, And Acceptance

Deliverables:

- FDE coverage scorecard wired to `slot_states`.
- Audit logging for Phase 1 events.
- RLS cross-org integration tests.
- API and visual smoke tests.
- Manual acceptance script.
- Error states for parser, LLM, vector, storage, and synthesis failures.
- Cost/cache/latency telemetry visible in FDE/admin queries.
- Sanitizer tests for logged agent utterances and diagnostic metadata.

Acceptance:

- Phase 1 exit criteria pass using deterministic fixtures.
- External-vendor happy path works in a configured environment.
- Missing vendor env does not break local demo/test flows.
- Director interview observed cost and synthesis latency can be measured from `agent_decision_log`/`synthesis_runs`.

## Open Questions To Resolve Before Implementation

1. Should Phase 1 use real browser microphone audio immediately, or should it first ship transcript-driven simulated voice while LiveKit is wired in parallel?
2. Which document parser is preferred for the first vendor integration: LlamaParse or Unstructured?
3. Which embedding provider should be used first: Voyage `voyage-3` or OpenAI `text-embedding-3-large`?
4. Should demo mode seed a single workspace automatically, or require an explicit "Create demo workspace" action?
5. How strict should duplicate process merging be in Phase 1: exact/canonical-name matching only, or LLM-assisted semantic merge?

Recommended defaults:

- Ship simulated transcript mode plus LiveKit room token plumbing in Week 2, then real microphone/audio in Week 3.
- Use LlamaParse first, with fixture fallback.
- Use one embedding provider behind `vector.ts`; choose whichever API key is already available in deployment.
- Auto-create one demo workspace only when `NEXT_PUBLIC_DEMO_MODE=true`.
- Use deterministic canonical-name merge plus explicit synonym normalization in Phase 1; defer semantic merge sophistication to Phase 4.

## Main Risks

- Voice integration can consume the phase if treated as a full realtime product too early. Keep text prompt and transcript simulation working at all times.
- Evidence linkage can become inconsistent if synthesis writes denormalized fields directly. Route generated assertions through `writeClaim`.
- Overview cards can look complete while still being fixture-backed. Remove fixture imports from Phase 1 routes once DB queries exist.
- LLM extraction quality will be uneven without tight schemas and validation. Treat schema validation failures as first-class errors.
- RLS can break local tests if org context is not set consistently. Centralize workspace-scoped DB access helpers.

## Definition Of Done Checklist

- [ ] `0001_phase1_director_intake.sql` migration exists and applies cleanly.
- [ ] Drizzle schema matches the migration.
- [ ] Phase 1 JSON/Zod schemas validate all LLM outputs.
- [ ] Director interview APIs persist sessions, transcript segments, slot states, evidence, claims, and `agent_decision_log` rows.
- [ ] Prompt caching uses the static/dynamic split and logs cache hit/miss, token counts, cost, and latency.
- [ ] Deterministic fallback marks degraded turns and `re_extract_degraded_turns` can recover them.
- [ ] Document upload pipeline persists artifacts, chunks, embeddings, evidence, and claims.
- [ ] Inventory synthesis subset publishes candidate process cards and promotes selected candidates into process drafts.
- [ ] Overview dashboard reads from DB, not fixtures.
- [ ] Process detail reads from DB, not fixtures.
- [ ] Evidence links show source quotes and metadata.
- [ ] FDE coverage scorecard reads from `slot_states`.
- [ ] Audit log records Phase 1 security events, and agent events are sanitized before being stored in `agent_decision_log`.
- [ ] Phase 1 cost and latency targets are measured: director interview cost at or below the approved target buffer, and synthesis p95 at or below 5 minutes on acceptance fixtures.
- [ ] Tests cover RLS, claim/evidence linkage, synthesis subset, and UI smoke paths.
- [ ] Manual acceptance script passes for both voice and upload entry paths.
