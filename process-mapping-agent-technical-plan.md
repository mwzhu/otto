# Process Mapping Agent Technical Plan

## 1. Product Thesis

The product is an AI-assisted process discovery workspace for forward deployed engineering work.

Its job is to learn how a business function actually operates, not just how the SOP says it operates. It should capture the implicit knowledge in directors' heads, operators' workflows, shared documents, screen recordings, tools, exceptions, handoffs, and repeated workarounds, then convert that evidence into:

- A department-level operating map.
- A process inventory with people, systems, cadence, risks, and complexity.
- L4 process maps for selected workflows.
- Quantified friction, risk, and business impact.
- Ranked automation opportunities and eventually automation proposals.

The product should feel like the mockups:

- Simple intake choices: voice interview or document upload.
- A director-level overview that maps functions and prioritizes drilldowns.
- Operator-level captures using live screen interviews, recordings, SOPs, and uploads.
- A process detail workspace with a visual map on the left and evidence-backed analysis on the right.
- Tabs for Summary, Steps, Impact, Insights, and Risk & Vulnerabilities.
- A "Refine Process" loop where the user can correct or deepen the map.

## 2. Core Workflow

### Phase A: Director Layer

Goal: build a high-level map of a department or function.

Inputs:

- 20-40 minute director interview.
- Org charts, process docs, team overviews, SOPs, KPI docs, dashboards, or meeting notes.
- Optional imported tool list and team roster.

Outputs:

- Function overview.
- Process inventory.
- People and role map.
- System map.
- Process complexity scores.
- Documentation coverage estimate.
- Single points of failure.
- Recommended process drilldowns.

Screens reflected in mockups:

- Start page with "Start Voice Interview" and "Upload Documents".
- Language selection and voice interview.
- High-level dashboard with captured processes, documentation coverage, complexity score, single points of failure.
- Process cards for Product Lifecycle Management, Promotion Management, Fresh Produce Ordering, Demand Forecasting, Supply Chain Ordering, Warehouse Inbound, etc.
- Detailed director summary with accountable roles, systems touched, risks, and friction.

### Phase B: Operator Deep Dive

Goal: pick a process from the map and capture how work is actually done.

Inputs:

- Live interview with screen sharing.
- Uploaded screen recording.
- Uploaded SOP or working doc.
- Invite links for multiple operators.
- Optional process guidance from director or FDE.

Outputs:

- Evidence-linked transcript.
- Tool and screen timeline.
- Step-by-step L4 map.
- Handoffs and exceptions.
- Variants between operators.
- Workarounds and undocumented rules.
- Quantified impact and automation candidates.

Screens reflected in mockups:

- "Capture Promotion Management process" page with interview, upload, invite, and process guidance.
- Screen-sharing interview with recording state, dimmed preview, and conversation panel.
- External business tool shown on screen with floating interview agent.
- Process workspace with map, transcript, and analysis tabs.
- Visual process map with decision points, waits, handoffs, and branches.

### Phase C: Opportunity and Automation Planning

Goal: turn discovered process friction into ranked software/agent opportunities.

Outputs:

- ROI-ranked opportunity list.
- Automation feasibility score.
- Implementation effort estimate.
- Data and integration requirements.
- Risk reduction estimate.
- Draft transformation proposal.
- Optional automation spec for engineering.

This can be a later product layer, but the data model must support it from day one.

## 3. Recommended Architecture

### High-Level Components

1. Web App
   - Process discovery workspace.
   - Interview UI.
   - Upload flows.
   - Visual process map.
   - Analysis panels.
   - Refinement and review tools.

2. API Backend
   - Auth, org, project, process, capture, and artifact APIs.
   - Orchestrates jobs and agent runs.
   - Serves process graphs and analysis.

3. Realtime Capture Service
   - Browser-based audio capture.
   - Screen sharing capture.
   - Live transcription.
   - Interview agent conversation loop.
   - Timestamped event stream.

4. Ingestion Pipeline
   - Document parsing.
   - Video/audio transcription.
   - OCR and screen-frame analysis.
   - Tool/activity timeline extraction.
   - Chunking and embedding.

5. Agent Orchestration Layer
   - Director interview agent.
   - Document extraction agent.
   - Operator interview agent.
   - Process synthesis agent.
   - Ontology builder.
   - Contradiction and gap detector.
   - ROI/opportunity analyst.

6. Process Graph Store
   - Canonical structured representation of process maps.
   - Supports L0-L4 granularity, branches, decisions, waits, handoffs, systems, evidence links, and variants.

7. Evidence Store
   - Stores citations back to transcript spans, document snippets, screen frames, uploaded files, and user corrections.
   - Every generated claim should be evidence-backed or explicitly marked inferred.

8. Visualization Engine
   - Converts process graph into a canvas layout.
   - Supports drilldown, swimlanes, branches, step detail, and evidence linking.

9. Scoring Engine
   - Complexity, documentation coverage, risk, automation ROI, implementation effort, and confidence scores.

## 4. Suggested Stack

This is a practical first-build stack, optimized for speed and long-term flexibility.

Frontend:

- Next.js with React and TypeScript.
- Tailwind or a small design-system layer matching the mockups.
- React Flow for process maps.
- Zustand or TanStack Query for client state.
- WebRTC/screen capture APIs for browser recording.

Backend:

- Node.js/TypeScript service using Fastify, Hono, or NestJS.
- PostgreSQL as primary database.
- pgvector for semantic retrieval over transcripts, docs, and observations.
- Object storage for uploads, recordings, frames, and generated artifacts.
- Redis for realtime session state and job coordination.
- Temporal, Trigger.dev, or a queue worker system for long-running ingestion and synthesis jobs.

AI and Media:

- Model adapter layer for LLM, vision, speech-to-text, and realtime voice APIs.
- Streaming transcription for interviews.
- Batch transcription for uploaded recordings.
- OCR and multimodal frame analysis for screen recordings.
- Structured output validation with Zod or JSON Schema.

Infra:

- Dockerized local development.
- Managed Postgres.
- Managed object storage.
- Background workers deployed separately from the API.
- Observability with structured logs, traces, job dashboards, and per-agent run logs.

## 5. Core Data Model

The most important design decision is to make "process knowledge" structured and evidence-backed.

### Organization and Workspace

`organizations`

- `id`
- `name`
- `industry`
- `created_at`

`users`

- `id`
- `organization_id`
- `email`
- `name`
- `role`
- `created_at`

`workspaces`

- `id`
- `organization_id`
- `name`
- `function_name`
- `status`
- `created_by`
- `created_at`

Example: "Commercial Operations", "Supply Chain", "Finance Ops".

### People, Roles, and Systems

`people`

- `id`
- `organization_id`
- `name`
- `title`
- `department`
- `manager_id`
- `source`

`roles`

- `id`
- `organization_id`
- `name`
- `description`
- `canonical_key`

`systems`

- `id`
- `organization_id`
- `name`
- `type`
- `description`
- `integration_status`
- `canonical_key`

`ontology_terms`

- `id`
- `organization_id`
- `term`
- `type`
- `definition`
- `aliases`
- `source_evidence_ids`
- `confidence`

This is where company-specific language lives: "promo build", "category manager", "Rohlik Admin", "supplier funding", "OTIF", etc.

### Processes

`processes`

- `id`
- `workspace_id`
- `name`
- `description`
- `level`
- `status`
- `owner_role_id`
- `frequency`
- `complexity_score`
- `documentation_coverage_score`
- `risk_score`
- `automation_potential_score`
- `confidence`
- `created_at`
- `updated_at`

`process_participants`

- `process_id`
- `person_id`
- `role_id`
- `involvement_type`
- `is_owner`

`process_systems`

- `process_id`
- `system_id`
- `usage_type`
- `criticality`

### Process Graph

`process_versions`

- `id`
- `process_id`
- `version_number`
- `status`
- `created_by_agent_run_id`
- `approved_by_user_id`
- `created_at`

`process_nodes`

- `id`
- `process_version_id`
- `node_type`
- `title`
- `description`
- `sequence_index`
- `lane_role_id`
- `system_id`
- `owner_role_id`
- `input_artifacts`
- `output_artifacts`
- `sla`
- `frequency`
- `automation_candidate`
- `confidence`

Supported node types:

- `start`
- `task`
- `decision`
- `wait`
- `handoff`
- `exception`
- `system_action`
- `manual_action`
- `end`

`process_edges`

- `id`
- `process_version_id`
- `source_node_id`
- `target_node_id`
- `label`
- `condition`
- `probability`
- `is_exception_path`

`process_node_evidence`

- `node_id`
- `evidence_id`
- `claim_type`
- `confidence`

### Captures and Evidence

`capture_sessions`

- `id`
- `workspace_id`
- `process_id`
- `capture_type`
- `status`
- `participant_person_id`
- `interviewer_agent_id`
- `started_at`
- `completed_at`
- `metadata`

Capture types:

- `director_interview`
- `operator_interview`
- `screen_recording`
- `document_upload`
- `sop_upload`
- `mixed`

`artifacts`

- `id`
- `organization_id`
- `workspace_id`
- `capture_session_id`
- `artifact_type`
- `storage_url`
- `filename`
- `mime_type`
- `duration_seconds`
- `created_at`

Artifact types:

- `audio`
- `video`
- `screen_recording`
- `document`
- `image`
- `transcript`
- `screen_frame`
- `generated_report`

`transcript_segments`

- `id`
- `capture_session_id`
- `speaker`
- `speaker_role`
- `start_ms`
- `end_ms`
- `text`
- `confidence`

`screen_events`

- `id`
- `capture_session_id`
- `timestamp_ms`
- `event_type`
- `app_name`
- `window_title`
- `url`
- `ocr_text`
- `detected_objects`
- `screenshot_artifact_id`

`evidence`

- `id`
- `workspace_id`
- `process_id`
- `source_type`
- `source_id`
- `span_start`
- `span_end`
- `quote`
- `summary`
- `confidence`
- `created_at`

Source types:

- `transcript_segment`
- `document_chunk`
- `screen_event`
- `user_correction`
- `agent_inference`

### Insights, Risks, and Opportunities

`process_insights`

- `id`
- `process_id`
- `title`
- `issue`
- `recommendation`
- `impact_estimate`
- `confidence`
- `evidence_ids`

`process_risks`

- `id`
- `process_id`
- `risk_type`
- `title`
- `description`
- `severity`
- `likelihood`
- `business_impact`
- `mitigation`
- `evidence_ids`

`automation_opportunities`

- `id`
- `process_id`
- `title`
- `problem`
- `proposed_solution`
- `automation_type`
- `roi_score`
- `annual_value_estimate`
- `time_saved_estimate`
- `risk_reduction_estimate`
- `implementation_effort`
- `integration_requirements`
- `dependencies`
- `confidence`
- `evidence_ids`

Automation types:

- `workflow_automation`
- `agent_assistant`
- `data_validation`
- `intake_form`
- `system_integration`
- `exception_monitoring`
- `report_generation`
- `approval_routing`
- `knowledge_base`

## 6. Process Granularity Model

The agent should explicitly track process levels.

L0: Business function

- Example: Commercial Operations.

L1: Major operating area

- Example: Product Lifecycle Management.

L2: Process

- Example: Promotion Management.

L3: Subprocess or phase

- Example: Supplier negotiation, campaign setup, post-promo reconciliation.

L4: Operator step

- Example: Open supplier email, copy funding amount, check SKU list, paste details into promo system, notify category manager.

The director layer should reliably produce L0-L2 and partial L3. The operator layer should produce L3-L4.

## 7. Agent System Design

### Agent 1: Director Interview Agent

Purpose:

- Interview a director or VP to map how a function operates at a useful executive level.

Responsibilities:

- Identify teams, roles, KPIs, processes, systems, cadences, handoffs, pain points, and undocumented work.
- Ask broad but targeted questions.
- Avoid going too deep too early.
- Produce a process inventory and drilldown recommendations.

State machine:

1. Establish function scope.
2. Identify major teams and responsibilities.
3. Identify repeated processes and cadences.
4. Identify systems and data flow.
5. Identify risks, bottlenecks, exceptions, and workarounds.
6. Quantify rough impact.
7. Confirm top drilldown candidates.
8. Generate department map.

Example outputs:

- "Promotion Management is medium complexity, recurring weekly/biweekly, touches 4 roles and 3 systems, and has high automation potential due to manual re-entry."
- "Product Lifecycle Management is high complexity, continuous, touches supplier portal, admin system, sheets, email, ERP, and WMS."

### Agent 2: Document Extraction Agent

Purpose:

- Extract operating structure from documents.

Responsibilities:

- Parse org charts, SOPs, spreadsheets, PDFs, docs, slides, and uploaded notes.
- Extract people, roles, systems, processes, KPIs, policies, and terminology.
- Flag gaps between documents and interview claims.
- Mark extracted claims as "documented" evidence.

Outputs:

- Candidate process inventory.
- Ontology terms.
- Documented steps and policies.
- Confidence scores and evidence links.

### Agent 3: Operator Interview Agent

Purpose:

- Walk an operator through real work while capturing screen and voice.

Responsibilities:

- Ask contextual questions while watching the workflow.
- Keep the participant moving through an actual example.
- Ask for triggers, inputs, outputs, exceptions, systems, handoffs, and decision criteria.
- Detect when the user is switching apps, using spreadsheets, copying values, checking email, or waiting for approvals.
- Ask follow-up questions when something important is implicit.

Interview style:

- "What triggered this case?"
- "What do you check before you decide this is ready?"
- "Where does this value come from?"
- "What happens if the supplier does not respond?"
- "Who owns the next step?"
- "How often does this exception happen?"
- "What do you do differently when it is urgent?"
- "Is this written down anywhere?"

### Agent 4: Screen Understanding Agent

Purpose:

- Convert screen recordings into structured workflow events.

Responsibilities:

- Sample frames and OCR visible text.
- Detect active application, URL, document title, and high-level UI context.
- Identify repeated copy/paste, search, filtering, form-fill, download/upload, approval, and messaging patterns.
- Link screen events to transcript timestamps.
- Produce a timeline of observed work.

The first version can be modest:

- Browser APIs for screen capture.
- Periodic frame extraction.
- OCR text extraction.
- App/window metadata when available.
- LLM/vision summarization of selected frames.

### Agent 5: Process Synthesis Agent

Purpose:

- Merge interviews, documents, transcripts, and screen events into a canonical process graph.

Responsibilities:

- Create/update process steps.
- Assign owners, systems, inputs, outputs, and SLAs.
- Identify decisions, waits, exceptions, handoffs, and loops.
- Detect contradictions and variants.
- Attach evidence to each node and claim.
- Generate summary, step list, impact narrative, insights, and risk analysis.

Important behavior:

- Never overwrite a reviewed process version silently.
- Create draft versions.
- Show confidence and unresolved questions.
- Preserve variants instead of forcing false consensus.

### Agent 6: Ontology Builder

Purpose:

- Learn company-specific language.

Responsibilities:

- Extract terms, aliases, system names, role names, document names, business metrics, and domain phrases.
- Normalize terms across speakers.
- Ask clarification questions when a term is ambiguous.
- Use ontology terms to improve later interviews.

Example:

- "Promo build" = quarterly promotional calendar creation.
- "Coordinator" = central process owner for all five phases.
- "Rohlik Admin" = internal admin system used for product and promo entry.

### Agent 7: Gap and Contradiction Detector

Purpose:

- Identify what is missing, inconsistent, or risky in the current map.

Responsibilities:

- Compare director description vs operator reality.
- Compare SOP vs observed workflow.
- Compare one operator vs another.
- Identify undocumented exceptions.
- Generate clarification tasks.

Examples:

- SOP says promotions are entered through the promo system, but observed workflow starts in email and shared docs.
- Director believes category managers own approvals, but operator shows coordinator manually follows up.
- Two operators use different spreadsheets for the same SKU validation step.

### Agent 8: ROI and Automation Analyst

Purpose:

- Rank where software or agents can create the most value.

Inputs:

- Process graph.
- Volume and frequency.
- Time per step.
- Exception frequency.
- Rework cost.
- Cycle time impact.
- Error impact.
- Role cost assumptions.
- Integration complexity.
- Confidence.

Outputs:

- Automation opportunities.
- Business case.
- Proposed solution type.
- Implementation estimate.
- Data/integration requirements.
- Expected value and confidence.

## 8. Scoring Models

### Documentation Coverage

Estimate how much of the process has reliable written support.

Signals:

- Number of steps backed by SOP/document evidence.
- Number of steps backed only by oral interview.
- Number of exceptions documented.
- Number of handoffs documented.
- Recency of documents.
- User confirmation.

Formula:

`coverage = documented_claims / total_material_claims`, adjusted for document recency and confidence.

### Complexity Score

Signals:

- Number of steps.
- Number of roles.
- Number of systems.
- Number of handoffs.
- Number of exception paths.
- Manual re-entry count.
- Unstructured communication count.
- Volume and frequency.
- Decision ambiguity.

Example:

`complexity = weighted_sum(steps, roles, systems, handoffs, exceptions, manual_work, ambiguity)`

### Single Point of Failure Score

Signals:

- Steps owned by one person.
- No backup owner.
- No documented recovery path.
- High-volume or deadline-sensitive process.
- Knowledge not documented.

### Automation ROI Score

This should be explainable, not a mysterious black box.

Inputs:

- `annual_volume`
- `minutes_saved_per_case`
- `loaded_hourly_cost`
- `error_rate`
- `cost_per_error`
- `exception_rate`
- `delay_cost`
- `implementation_effort`
- `integration_complexity`
- `confidence`

Formula:

`annual_time_value = annual_volume * minutes_saved_per_case / 60 * loaded_hourly_cost`

`annual_error_value = annual_volume * error_rate * cost_per_error`

`annual_delay_value = annual_volume * exception_rate * delay_cost`

`gross_value = annual_time_value + annual_error_value + annual_delay_value`

`net_score = gross_value * confidence / effort_penalty`

The UI should expose the reasoning:

- "Manual re-entry creates 2-3 errors/month, each costing about 1 day of rework."
- "Supplier delay tracking affects 10% of promotions and adds 2-3 days per occurrence."
- "Data entry time could drop from 2 days to under 4 hours per promo."

## 9. Frontend Product Surfaces

### 1. Workspace Home

Purpose:

- Start discovery.
- Resume existing function maps.
- Upload docs.

Primary actions:

- Start Voice Interview.
- Upload Documents.
- Create Workspace.

### 2. Director Interview

Features:

- Language selection.
- Voice-only interview.
- Conversation transcript.
- Live structured notes.
- Pause/resume.
- Complete interview.
- Auto-save partial state.

### 3. High-Level Overview

Features:

- Metrics cards:
  - Processes Captured.
  - Documentation Coverage.
  - Complexity Score.
  - Single Point of Failure.
- Process cards:
  - Name.
  - Status.
  - Description.
  - People and roles.
  - Systems.
  - Frequency.
  - Complexity label.
  - View details.
- Team responsibilities tab.
- Drilldown recommendation banner.

### 4. Process Detail From Director Layer

Features:

- What this process involves.
- Who is accountable.
- Systems it touches.
- Risks and friction.
- Suggested operator captures.
- Add capture button.

### 5. Capture Process Page

Features:

- Start live interview.
- Upload video or SOP.
- Invite colleagues.
- Process guidance accordion.
- Capture status and list of prior captures.

### 6. Live Screen Interview

Features:

- Browser screen-sharing.
- Audio recording.
- Conversation panel.
- Agent prompts.
- Mute, pause, complete.
- Dimmed preview to avoid mirror effect.
- Timestamped transcript.
- Event timeline.

### 7. Uploaded Capture Review

Features:

- Uploaded video/SOP processing state.
- Transcript and OCR review.
- Agent-extracted candidate steps.
- Human approval/correction before merging into process.

### 8. Process Workspace

The core screen from the mockups.

Left side:

- Visual process map.
- Zoom controls.
- Fit-to-view.
- Branch and exception display.
- Swimlanes by role or system.
- Click node to inspect evidence.

Right side:

- Current Process panel.
- Tabs:
  - Summary.
  - Steps.
  - Impact.
  - Insights.
  - Risk & Vulnerabilities.
- Refine Process button.

Top nav:

- Current Process.
- Transformation Proposal.
- Automation.
- Add Captures.
- Invite colleague.

### 9. Refinement UI

Features:

- Chat-style correction.
- Node-level edit.
- "This is wrong" feedback.
- Merge/split steps.
- Add missing exception.
- Mark claim confirmed.
- Request more evidence.
- Regenerate map version.

## 10. Backend API Shape

Representative endpoints:

`POST /api/workspaces`

- Create a function discovery workspace.

`POST /api/workspaces/:id/director-interviews`

- Start a director interview capture session.

`POST /api/workspaces/:id/artifacts`

- Upload documents, SOPs, videos, or audio.

`POST /api/processes/:id/captures`

- Start operator capture.

`GET /api/processes/:id`

- Return process metadata and latest approved/draft version.

`GET /api/processes/:id/graph`

- Return nodes, edges, layout hints, and evidence counts.

`GET /api/processes/:id/analysis`

- Return summary, steps, impact, insights, risks, and opportunities.

`POST /api/processes/:id/refinements`

- Submit user correction or refinement request.

`POST /api/processes/:id/versions/:versionId/approve`

- Approve a generated process version.

`POST /api/capture-sessions/:id/complete`

- Finalize capture and enqueue synthesis.

`GET /api/jobs/:id`

- Poll or subscribe to ingestion/synthesis job state.

Realtime:

- WebSocket or SSE channel for transcript segments, agent messages, capture events, and job progress.

## 11. Agent Output Schemas

Structured outputs are non-negotiable. The agents can write prose, but the system should store maps, insights, and opportunities as typed objects.

### Process Inventory Schema

```json
{
  "processes": [
    {
      "name": "Promotion Management",
      "description": "Plans, negotiates, schedules, executes, and reviews retail promotions.",
      "owner_roles": ["Coordinator", "Category Manager"],
      "participant_roles": ["Supplier", "Marketing", "Store Operations", "Analytics"],
      "systems": ["Email", "Shared Documents", "Promo Management System", "ERP"],
      "frequency": "Weekly adjustments; quarterly promo build",
      "complexity": "medium",
      "documentation_status": "partially_documented",
      "risks": ["manual re-entry", "supplier funding delays"],
      "recommended_for_drilldown": true,
      "confidence": 0.78,
      "evidence_ids": ["ev_123", "ev_456"]
    }
  ]
}
```

### Process Graph Schema

```json
{
  "nodes": [
    {
      "id": "node_1",
      "type": "task",
      "title": "Align on promo proposal with category team",
      "description": "Coordinator and category manager align on target products, discount depth, and calendar fit.",
      "role": "Coordinator",
      "systems": ["Shared Documents", "Email"],
      "inputs": ["Supplier funding offer", "Historical promo performance"],
      "outputs": ["Promo proposal document"],
      "sla": "Approximately 1 week",
      "exceptions": ["Analytics delay slows this phase"],
      "confidence": 0.84,
      "evidence_ids": ["ev_789"]
    }
  ],
  "edges": [
    {
      "source": "node_1",
      "target": "node_2",
      "label": "Proposal ready"
    }
  ]
}
```

### Insight Schema

```json
{
  "title": "Manual Re-Entry Data Bridge",
  "issue": "Final promo details are manually transcribed from planning documents and email into the promo management system.",
  "recommendation": "Create a structured digital intake form mapped to required promo system fields.",
  "impact_estimate": "2-3 data errors per month; 2-3 days of unplanned rework monthly.",
  "confidence": 0.82,
  "evidence_ids": ["ev_111", "ev_112"]
}
```

## 12. Ingestion and Synthesis Pipeline

### Director Interview Pipeline

1. Start capture session.
2. Stream audio to transcription.
3. Interview agent asks questions and updates session memory.
4. Extract roles, systems, processes, risks, KPIs, and terms incrementally.
5. At completion, run process inventory synthesis.
6. Generate high-level dashboard metrics.
7. Store all claims with evidence links.
8. Ask user to review generated process cards.

### Document Upload Pipeline

1. Upload artifact.
2. Detect file type.
3. Extract text, tables, images, and structure.
4. Chunk content.
5. Embed chunks.
6. Extract process claims.
7. Merge with existing ontology and process inventory.
8. Flag conflicts and gaps.

### Live Operator Capture Pipeline

1. Start capture session.
2. Start audio transcription.
3. Start screen recording.
4. Sample screen frames.
5. Extract OCR and app/window context.
6. Agent asks contextual questions during workflow.
7. Store transcript and screen events with timestamps.
8. On completion, run timeline synthesis.
9. Convert timeline into candidate L4 process graph.
10. Merge with prior graph as draft version.
11. Generate analysis tabs.
12. Ask user to review/refine.

### Uploaded Video/SOP Pipeline

1. Upload video or SOP.
2. For video: transcribe audio, sample frames, OCR, summarize frame timeline.
3. For SOP: parse steps, systems, roles, and exception rules.
4. Extract candidate graph.
5. Compare against current graph.
6. Generate "new evidence found" review.

## 13. Evidence and Trust Model

The product will fail if the user cannot trust where claims came from.

Every generated step, risk, insight, and ROI claim should have:

- Evidence source.
- Confidence.
- Timestamp or document location.
- Whether it was observed, stated, documented, inferred, or confirmed.

Evidence labels:

- Observed on screen.
- Stated by operator.
- Stated by director.
- Found in SOP.
- Inferred by agent.
- Confirmed by user.

UI behavior:

- Clicking a process node opens supporting transcript snippets and screen moments.
- Clicking an insight shows the source quotes and frequency assumptions.
- User corrections become high-priority evidence.
- Low-confidence claims are visually softened or marked "needs confirmation".

## 14. Process Map Visualization

Use React Flow with a custom layout layer.

Node types:

- Start circle.
- Task rectangle.
- Decision diamond.
- Wait circle.
- Exception marker.
- Handoff connector.
- End circle.

Visual metadata:

- Role labels as pills.
- System labels as pills.
- Evidence count badge.
- Risk marker.
- Automation candidate marker.
- Low-confidence dotted outline.

Layout modes:

- Default vertical flow, matching the mockups.
- Swimlanes by role.
- Swimlanes by system.
- Exception-focused view.
- L3/L4 collapse and expand.

Editing:

- Drag nodes.
- Rename steps.
- Merge/split steps.
- Add exception branch.
- Attach evidence.
- Approve draft version.

## 15. Review and Refinement Loop

The agent should not pretend it has perfect understanding after one interview.

Refinement flows:

- "Refine Process" chat.
- Node-level edit.
- Low-confidence gap questions.
- Invite missing role.
- Upload missing SOP.
- Compare variant.

Example refinement prompts:

- "The map says supplier funding approval always happens before setup. Is that true?"
- "I found two different systems used for SKU validation. Are both current?"
- "The SOP does not mention the coordinator manually following up with suppliers. Should this be added as an exception path?"

Versioning:

- Every synthesis creates a draft process version.
- User can approve, reject, or request changes.
- Approved versions become the source for ROI and automation planning.

## 16. Automation Opportunity Engine

Automation opportunities should be generated from recurring process patterns.

Common opportunity patterns:

- Manual re-entry between documents and systems.
- Email-driven status tracking.
- Spreadsheet reconciliation.
- Repeated document generation.
- Approval follow-up.
- Exception monitoring.
- Data validation.
- Report creation.
- Intake normalization.
- Knowledge lookup.

Opportunity output:

- Problem.
- Proposed automation.
- Trigger.
- Inputs.
- Systems needed.
- Human approval points.
- Expected time saved.
- Error/risk reduction.
- Implementation complexity.
- Dependencies.
- First MVP scope.

Example:

Title: Structured Promo Intake and Validation

Problem:

- Finalized promo details are copied from email/docs into the promo system, creating 2-3 data errors per month.

Solution:

- Build an intake form or agent that extracts promo details from supplier emails/docs, validates required fields, routes missing fields for clarification, and writes approved data to the promo management system.

Expected value:

- Reduce re-entry errors to near zero.
- Reduce promo setup time from 2 days to under 4 hours.
- Improve downstream readiness for marketing and store ops.

## 17. Security and Compliance

This product will capture sensitive operational data, screens, emails, documents, supplier details, employee names, and possibly customer or financial information.

Required controls:

- SSO/SAML for enterprise customers.
- Role-based access control.
- Workspace-level permissions.
- Capture consent and visible recording indicators.
- Configurable retention policies.
- PII and secret detection in transcripts and OCR.
- Encryption at rest and in transit.
- Audit log for file access, process edits, exports, and agent runs.
- Ability to delete capture artifacts while preserving approved structured summaries if allowed.
- Redaction workflow before sharing executive outputs.
- Tenant isolation.

## 18. Evaluation Strategy

We need evals because this is a high-trust, high-ambiguity agent.

### Extraction Accuracy Evals

Measure:

- Did the agent identify the right steps?
- Did it assign the right owner?
- Did it identify systems correctly?
- Did it preserve order?
- Did it capture exceptions?
- Did it distinguish observed vs inferred claims?

Dataset:

- Synthetic operator interviews.
- Hand-labeled screen recordings.
- Real anonymized customer sessions once available.

### Interview Quality Evals

Measure:

- Did the agent ask useful follow-up questions?
- Did it avoid interrupting too much?
- Did it capture triggers, inputs, outputs, systems, roles, exceptions, frequency, and impact?
- Did it adapt to company-specific terms?

### ROI Quality Evals

Measure:

- Are value estimates traceable?
- Are assumptions visible?
- Are opportunities ranked correctly by human FDEs?
- Does the agent avoid overclaiming when evidence is weak?

### UX Evals

Measure:

- Can a director complete intake without setup help?
- Can an operator complete screen capture without confusion?
- Can a user trace an insight back to evidence?
- Can an FDE refine a process map quickly?

## 19. MVP Build Plan

### Milestone 0: Foundations

Build:

- Auth-lite user model.
- Workspace creation.
- Process, artifact, capture, transcript, evidence, and graph tables.
- Object storage.
- Background job runner.
- Basic model adapter.

Exit criteria:

- Can create a workspace and upload/store artifacts.
- Can create a process and store a graph version.

### Milestone 1: Director Intake

Build:

- Start screen with voice interview and document upload.
- Voice interview UI.
- Transcript capture.
- Director interview agent.
- Document upload and text extraction.
- Process inventory synthesis.
- High-level overview dashboard.

Exit criteria:

- A director can complete an interview.
- System generates process cards with roles, systems, frequency, complexity, documentation coverage, and risks.
- Each card has evidence links.

### Milestone 2: Process Detail and Drilldown

Build:

- Process detail page from director layer.
- Accountable roles section.
- Systems touched section.
- Risks and friction section.
- "Add Capture" flow.

Exit criteria:

- User can pick a process and understand why it was recommended for deeper discovery.

### Milestone 3: Operator Capture

Build:

- Capture process page.
- Live screen sharing and audio recording.
- Conversation panel.
- Operator interview agent.
- Timestamped transcript.
- Screen frame sampling and OCR.
- Upload video/SOP path.

Exit criteria:

- Operator can complete a live walkthrough.
- System stores transcript, recording, and screen events.
- Agent asks basic contextual follow-ups.

### Milestone 4: L4 Process Synthesis

Build:

- Process synthesis agent.
- Graph schema generation.
- React Flow visualization.
- Summary, Steps, Impact, Insights, Risk tabs.
- Evidence linking.
- Draft/approved process versions.

Exit criteria:

- A captured operator session becomes a visual L4 process map.
- Steps include roles, systems, inputs, outputs, SLAs, and exceptions.
- User can click nodes and inspect evidence.

### Milestone 5: Refinement and Multi-Capture Merge

Build:

- Refine Process interaction.
- User corrections.
- Merge multiple captures into one process version.
- Variant detection.
- Contradiction/gap detector.
- Invite colleague flow.

Exit criteria:

- Two operator captures can be merged.
- Variants and contradictions are preserved and reviewed.
- User can approve a reliable current-state process.

### Milestone 6: Opportunity Ranking

Build:

- ROI scoring engine.
- Automation opportunity generation.
- Opportunity list.
- Transformation Proposal tab.
- Exportable executive summary.

Exit criteria:

- System ranks top automation candidates with evidence, assumptions, value estimate, confidence, and implementation notes.

### Milestone 7: Automation Handoff

Build:

- Automation spec generator.
- Integration requirement checklist.
- Human-in-the-loop points.
- Acceptance criteria.
- Technical implementation brief for FDE/software team.

Exit criteria:

- For a selected opportunity, the system produces a build-ready automation proposal.

## 20. Development Order

Recommended first 6 weeks:

Week 1:

- Data model.
- Workspace shell.
- Upload plumbing.
- Transcript and evidence primitives.

Week 2:

- Director interview flow.
- First process inventory extraction.
- Process cards dashboard.

Week 3:

- Process detail page.
- Document extraction.
- Evidence-backed claims.

Week 4:

- Operator capture UI.
- Screen/audio recording.
- Transcript and event timeline.

Week 5:

- L4 synthesis.
- React Flow process map.
- Steps/Summary tabs.

Week 6:

- Impact/Insights/Risk tabs.
- Refinement loop.
- First ROI scoring.

## 21. Important Product Decisions

### Build the Evidence Layer Early

Do not postpone citations. If the first version produces nice summaries without evidence, it will be hard to retrofit trust.

### Prefer Drafts Over Silent Updates

Generated maps should be draft versions until approved. This lets the product feel powerful without feeling reckless.

### Preserve Variants

The point of the product is that real processes differ by person, region, exception, and workaround. The system should represent variants, not average them away.

### Ask for Quantification During Interviews

The ROI engine only works if the agent asks:

- How often does this happen?
- How long does it take?
- How many people are involved?
- What happens when it goes wrong?
- How often does it go wrong?
- What is the downstream impact?

### Separate Current State From Future State

The mockups already suggest:

- Current Process.
- Transformation Proposal.
- Automation.

Keep those separate in data and UI.

Current state is evidence.

Future state is recommendation.

Automation is implementation.

## 22. Biggest Technical Risks

### Screen Understanding Is Noisy

Mitigation:

- Use transcript as primary source.
- Use screen events as supporting evidence.
- Ask the operator to narrate.
- Sample frames around key transcript moments.

### Process Graphs Can Become Messy

Mitigation:

- Use structured schemas.
- Use confidence and evidence.
- Version maps.
- Keep L3 and L4 levels distinct.
- Provide collapse/expand.

### ROI Can Become Hand-Wavy

Mitigation:

- Store assumptions explicitly.
- Show confidence.
- Require evidence for time, volume, and error claims.
- Let users edit assumptions.

### Agents May Over-Ask Questions

Mitigation:

- Interview state machine.
- Question budget.
- "Let operator work" mode.
- Ask follow-ups at natural pauses.

### Enterprise Privacy Concerns

Mitigation:

- Consent-first recording UX.
- Retention controls.
- Redaction.
- Access control.
- Clear evidence provenance.

## 23. Open Questions

Product:

- Is the first target user the FDE, the director, or the operator?
- Should the FDE be able to manually seed process hypotheses before interviews?
- Should customer users see raw transcripts and screen recordings, or only structured outputs?
- How much editing should happen on the map vs through chat?

Technical:

- Which realtime voice/speech provider should be used for latency and cost?
- Do we need native desktop capture for better app metadata, or is browser capture enough for MVP?
- Will customers allow screen recording storage, or do we need ephemeral processing?
- Which export formats matter first: PDF, PPTX, BPMN, CSV, or JSON?

Go-to-market:

- Which vertical is first: retail/CPG, supply chain, finance ops, customer ops, or healthcare ops?
- Should the scoring model be vertical-specific from the start?
- Is the wedge "process mapping" or "automation opportunity assessment"?

## 24. MVP Definition

The first lovable version should do this:

1. A director starts a voice interview or uploads documents.
2. The system produces a high-level process inventory with complexity, documentation coverage, systems, roles, risks, and drilldown recommendations.
3. The user selects one process.
4. An operator completes a screen-sharing interview.
5. The system generates a visual L4 current-state process map.
6. The right panel shows Summary, Steps, Impact, Insights, and Risk & Vulnerabilities.
7. Every important claim links back to evidence.
8. The system recommends the top 3 automation opportunities with value, effort, confidence, and assumptions.

That is enough to replace the first half of a forward deployed engineer's discovery work in a focused, credible way.

