# Otto / Duvo — Technical Plan

A process-mapping agent that replaces the discovery half of a forward-deployed engineer: interview a business, map every process at L4 granularity, surface the highest-ROI automation opportunities.

This plan is derived from the 16 design mockups in this folder.

---

## 1. What the product actually does (synthesized from mockups)

Two interview layers feeding one structured artifact:

**Layer 1 — Director map (breadth).** 15-20 min voice (or doc-upload) interview with a VP/Director. Produces a "High Level Overview" dashboard:
- Process inventory (cards) — Product Lifecycle Mgmt, Promotion Mgmt, Fresh Produce Ordering, Demand Forecasting, Supply Chain & Supplier Mgmt, Warehouse Inbound & QC, etc.
- Per-card metadata: complexity, status (Documented / In progress), people involved, systems touched, frequency.
- Top-level KPIs: Processes Captured, Documentation Coverage %, Complexity Score, Single Points of Failure.
- Per-process detail page: description, complexity-score breakdown (identified vulnerabilities, friction signals, external dependencies, system sprawl), accountability map, systems touched, risk & friction call-outs.

**Layer 2 — Operator deep dive (depth).** Per chosen process, capture how it's actually done via:
- Voice interview, OR
- Upload (video + SOP doc), OR
- **Live screen-share interview** — agent watches, narrates questions, the operator walks through steps in real tools (ERP, Outlook, Excel, Slack, etc.).
- Multi-person: "Invite colleagues" so all touchpoints get captured.

**Output artifact.** A `Current Process` view with:
- Visual BPMN-style flowchart (action nodes, decision diamonds, end states, owner tags).
- Tabs: **Summary / Steps (L4) / Impact / Insights / Risk & Vulnerabilities**.
- Each step: Action, Role, System(s), Inputs, Outputs, SLA, Exception handling.
- A parallel **Transformation Proposal** tab — the to-be process with automation candidates and projected ROI.

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser (Next.js)                            │
│   Voice UI · Screen-share UI · Map canvas (React Flow) · Tabs        │
└───────────┬────────────────────────────────────────────┬─────────────┘
            │ WebRTC (audio + screen track + data)       │ HTTPS
            ▼                                            ▼
   ┌────────────────────────┐                ┌────────────────────────┐
   │   LiveKit room (SFU)   │                │   API (Hono on edge)   │
   │   audio + screen + data│                │   auth · CRUD · query  │
   └─────────┬──────────────┘                └────────────┬───────────┘
             │                                            │
             ▼                                            ▼
   ┌────────────────────────┐                ┌────────────────────────┐
   │ Realtime Agent worker  │                │     Postgres + pgvector│
   │ (Python, LiveKit       │◀──────────────▶│  org · process graph · │
   │  Agents framework)     │                │  transcripts · embed.  │
   │ ASR · Claude · TTS     │                └────────────┬───────────┘
   └─────────┬──────────────┘                             │
             │ frames / utterances / events               │
             ▼                                            ▼
   ┌────────────────────────┐                ┌────────────────────────┐
   │  Object storage (R2)   │                │ Durable workflows      │
   │  recordings · uploads  │                │ (Inngest / Trigger.dev)│
   └────────────────────────┘                │  extract → synthesize  │
                                              │  → score → publish    │
                                              └────────────┬───────────┘
                                                           ▼
                                              ┌────────────────────────┐
                                              │  Synthesis agents      │
                                              │  (Claude Opus 4.7      │
                                              │  + Sonnet 4.6 workers) │
                                              └────────────────────────┘
```

Reasoning behind the picks:
- **LiveKit** gives one room with audio + screen track + a data channel, plus server-side egress for recording. It's the cleanest way to support both the voice-only Director interview and the screen-share Operator interview with the same stack.
- **Inngest / Trigger.dev** because extraction is bursty, multi-step, retryable, and benefits from durable execution; we don't want this in request handlers.
- **Postgres + pgvector** keeps the process graph and embeddings together; no need for a separate vector DB at this scale.
- **Claude Opus 4.7** as the planning/synthesis brain, **Sonnet 4.6** as the realtime interview agent (latency-sensitive) and as the per-frame vision worker, **Haiku 4.5** for cheap classification passes (e.g., "is this frame a meaningful state change?").

---

## 3. The central data model

This is the most important part — everything else exists to populate this graph.

```
Organization
 └── Department (Commercial, Supply Chain, Warehouse, ...)
      └── Function (Promotion Management, Fresh Produce Ordering, ...)
           └── Process (versioned: v_current, v_proposed)
                └── Phase (Identify → Plan → Negotiate → Execute → Evaluate)
                     └── Step (L3)
                          └── Sub-step / Action (L4)
```

### Core tables (Postgres)

```sql
organizations(id, name, created_at)
people(id, org_id, name, role, email, manager_id)            -- the org graph
systems(id, org_id, name, vendor, category, auth_method)     -- tool stack
processes(
  id, org_id, function_id, name, status,                     -- documented / in_progress
  complexity_score, frequency, current_version_id, proposed_version_id
)
process_versions(id, process_id, version_label, created_at, created_by)
steps(
  id, version_id, parent_step_id, ordinal, level,            -- 1..4
  action, owner_role, owner_person_id, sla_seconds,
  frequency, est_minutes_per_run, financial_impact_cents
)
step_systems(step_id, system_id, usage)                      -- read/write/both
step_io(step_id, kind, name, description)                    -- kind: input/output
edges(
  id, version_id, from_step_id, to_step_id,
  edge_type,                                                 -- seq / conditional / handoff / parallel
  condition_label                                            -- "All approved", "Errors found"
)
exceptions(id, step_id, label, frequency_pct, handler_role, est_extra_minutes)
workarounds(id, step_id, description, why_it_exists)
pain_points(id, version_id, label, severity, $impact, evidence_chunk_ids)
opportunities(
  id, version_id, label, pattern,                            -- doc-extract / agent / rpa / integration
  est_time_saved_min_per_run, est_dollar_saved_per_year,
  feasibility, dependencies_jsonb, rank
)
```

### Capture tables

```sql
interviews(
  id, org_id, process_id, kind,                              -- director / operator
  participants, started_at, ended_at, recording_url, language
)
utterances(id, interview_id, ts_ms, speaker, text, embedding vector(1536))
screen_events(
  id, interview_id, ts_ms, event_type,                       -- frame / click / nav / app_switch
  app_name, window_title, frame_url, ocr_text, ui_state_label
)
uploads(id, org_id, kind, mime, url, parsed_text, embedding)
evidence_links(claim_id, source_kind, source_id, span)       -- every claim is provenanced
```

**Provenance is non-negotiable.** Every step / exception / opportunity must link back to the utterance, frame, or document chunk it came from. This is how you (a) earn director trust, (b) regenerate cleanly when the model is upgraded.

---

## 4. The three agents

### 4.1 Director Interview Agent (voice)

- **Runtime:** LiveKit Agents (Python), Sonnet 4.6 in streaming mode, Deepgram Nova-3 for ASR, Cartesia Sonic-2 for TTS (≈250ms TTFB).
- **State machine, not free-form chat.** A topic checklist drives it: team structure → main processes → tools per process → cadence → biggest pain points → SPOFs. The LLM phrases the next question; a deterministic controller decides *which* question is next based on what's already covered. This is how you get reliably structured output instead of meandering.
- **Tools the agent can call mid-call:** `record_process(name, function, frequency)`, `record_system(name, used_by_process)`, `record_pain_point(process, severity, $impact)`, `record_person(name, role)`. These hit Postgres immediately so the UI can render the in-progress map.
- **Termination criterion:** controller hits "checklist coverage ≥ 90% AND no high-uncertainty slots" → agent wraps with "anything I missed?" → ends.

### 4.2 Operator Interview Agent (screen-share)

The hardest one. Three concurrent signal streams:

1. **Speech** — same ASR + TTS pipeline as Director.
2. **Screen frames** — egressed from LiveKit at 2 fps, written to R2.
3. **Active-window metadata** — if running via a desktop helper (Electron/Tauri), capture app name + window title at 4 Hz. Otherwise OCR + Claude vision on the frame to label it.

Pipeline:

```
audio  ───► ASR ─► utterances stream
frames ───► SSIM diff ──(keep ~5% as keyframes)──► Claude vision ─► UI state labels
labels + utterances  ──► step segmenter  ──► provisional Step records
```

- **Step segmenter** runs every 10s: groups recent utterances + labels into candidate steps, asks Claude "is this a new step, continuation, or exception?", emits provisional steps to the DB so the agent can ask informed questions ("you just opened the supplier portal — does this happen every promo or only when X?").
- **Interview agent prompt** keeps a rolling summary of {process-so-far, current-step-hypothesis, open-questions}. It asks one focused question per ~30s of work — never over-talks the operator.
- **Workarounds & exceptions** are first-class. Whenever the segmenter sees off-pattern behavior (jumping to a doc that isn't the SOP, copy-pasting from email to ERP) the agent is nudged to ask "is that the normal flow or a workaround?"

### 4.3 Synthesis Agent (batch, post-interview)

Triggered by Inngest when an interview ends. Steps:

1. **Re-segment** the full transcript + frame timeline into canonical steps (the live segmenter is fast-and-loose; this pass is the source of truth).
2. **Normalize ontology** — map mentioned systems/roles to the org's existing entries (fuzzy match + LLM confirm). This is where the per-company ontology accretes.
3. **Build graph** — produce `steps`, `edges`, `exceptions`, `workarounds` rows. Decision diamonds come from conditional language ("if approved, then…").
4. **Score complexity** — formula from the mockup: identified vulnerabilities, friction signals, external dependencies, system sprawl. Each subcomponent is a deterministic count; total is weighted sum (visible in mockup as 78/100 breakdown).
5. **Generate the 5 tabs:**
   - *Summary* — narrative paragraph (Claude).
   - *Steps* — structured table (already in DB).
   - *Impact* — narrative + quantified metrics (e.g., "~10% of promos absorb 5 extra days/month" — pulled from frequency × est_minutes × wage).
   - *Insights* — top issues with Issue + Recommendation pairs (Claude, grounded in evidence_links).
   - *Risk & Vulnerabilities* — narrative scenario analysis ("most dangerous risk is coordinator unavailability during high-volume periods…").
6. **Cite everything** — every sentence in narrative tabs carries hidden evidence_link IDs; UI surfaces them on hover.

Runs as a DAG of Claude calls behind Inngest (retry on rate limit, snapshot intermediate state). Opus 4.7 for steps 3, 5, 6; Sonnet 4.6 for 1, 2, 4.

---

## 5. The ROI / Opportunity engine

Separate pass after synthesis. Inputs: full process graph + a curated **automation pattern library**.

Pattern library entries look like:

```yaml
- id: manual-reentry-bridge
  match: step.owner.role == "human" AND step.action ~ "re-enter|copy.*from.*to" AND inputs.system != outputs.system
  remediation: integration | doc-extract-agent
  est_time_saved: minutes_per_run * 0.9
  feasibility_factors: [api_available(outputs.system), structured_input]
```

For each process version, the engine:
1. Walks every step + edge, runs every pattern.
2. For matches, calls Claude to estimate `time_saved_min`, `dollar_saved_per_year`, `feasibility (1-5)`, `implementation_pattern`.
3. Ranks by `dollar_saved * feasibility / effort`.
4. Writes `opportunities` rows + generates the Transformation Proposal view: same flowchart, automation candidates shown as overlay nodes with projected impact tags.

This is also the place where the "highest-ROI" director-level view comes from — aggregate opportunities up to the process card grid so the Director sees "$X recoverable in Promotion Mgmt, $Y in Demand Forecasting."

---

## 6. Frontend

- **Next.js 15 (App Router) + React 19 + TS.** Server components for the read-heavy dashboards; client components for the canvas and call UI.
- **Tailwind + shadcn/ui** — matches the mockup aesthetic out of the box.
- **React Flow (Pro)** for the BPMN canvas. Custom node types: `ActionNode` (rectangle with owner tag), `DecisionNode` (diamond), `EndNode` (circle), `TimerNode` (clock circle for "Wait for promo launch"). Auto-layout via `elkjs` (layered, top-down).
- **LiveKit React SDK** for voice + screen share UI. Side-by-side layout matches screenshot 8 — recording preview + conversation panel.
- **TipTap** for the inline narrative editing (Director can "Refine Process" — visible button top right of process detail).
- **State:** TanStack Query for server data; Zustand for local map/canvas state.

Page structure mirrors the mockups:
```
/onboarding/voice                    (screenshot 1-3)
/clarity                             (high-level overview — screenshot 4)
/clarity/process/[id]                (process detail — screenshots 5-6)
/clarity/process/[id]/capture        (capture entry — screenshot 7)
/clarity/process/[id]/interview/live (screen-share UI — screenshot 8)
/clarity/process/[id]/map            (canvas + tabs — screenshots 10-16)
/clarity/process/[id]/map?view=proposed  (Transformation Proposal)
```

---

## 7. Backend & infra

- **API:** Hono on Cloudflare Workers (low cold-start, fits Vercel-style deploys). Endpoints are CRUD over the schema + a few RPC-style mutations (`startInterview`, `endInterview`, `regenerateSynthesis`).
- **Auth:** Clerk or WorkOS — need SSO for enterprise customers early; this is FDE-replacement, buyers are mid-market+.
- **DB:** Neon (serverless Postgres, branching for preview envs) + pgvector extension.
- **Queues / workflows:** Inngest. Each interview triggers a `synthesize.process.v1` workflow that fans out the synthesis steps and can be replayed cleanly when prompts change.
- **Storage:** Cloudflare R2 for recordings (free egress matters here) + uploaded docs.
- **Realtime infra:** LiveKit Cloud (managed) initially; self-host if egress costs become real.
- **Observability:** Langfuse or Helicone for LLM trace, Axiom for app logs, Sentry for errors. Every Claude call is traced with the `evidence_link` IDs it touched — this is how you debug bad synthesis output.

---

## 8. Integrations & data capture nuances

- **Screen-share without a desktop app** (browser-only): works for web apps but loses native ERP/Outlook fidelity. Use OCR + vision to recover.
- **Optional desktop helper** (Tauri, ≈10MB): captures window titles, active app, clipboard transitions, foreground app duration. Massively improves segmenter accuracy. Pitch as "for high-fidelity capture sessions." Sandbox heavily, read-only, no keystroke logging.
- **Document upload pipeline:** PDFs/DOCX → Unstructured.io or LlamaParse → chunk → embed → store. The Director onboarding doc-upload path feeds the same `evidence_links` table as interviews, so the synthesis agent treats them identically.
- **Email / Outlook context** (screenshot 9 shows a PO email): later milestone — read-only Gmail/Outlook OAuth scope to import recent emails for a process the operator is walking through. Used as additional evidence; never written to.
- **Per-company ontology accretion:** every new interview enriches the org's `systems` and `people` tables via the normalization step in synthesis. After 3-4 interviews the agent is no longer asking "what's the ERP called here" — it knows.

---

## 9. Critical engineering risks

| Risk | Mitigation |
|---|---|
| **Live segmenter latency.** Step boundaries that arrive 30s late make the agent ask stale questions. | Run segmenter on a sliding window every 10s with Sonnet 4.6; tolerate provisional segments; reconcile in batch synthesis. |
| **Vision frame cost.** 2 fps × 30 min interview × Claude vision = expensive. | SSIM diff to keep only ~5% of frames; Haiku 4.5 first-pass classifier ("is this a state change?") before invoking Sonnet. |
| **Synthesis hallucination.** A made-up exception kills director trust. | Every claim row carries `evidence_link` IDs; UI shows the source on hover; synthesis prompt is "extract only — refuse if no evidence." Add an eval set of 20 recorded interviews + golden process graphs, score every prompt change. |
| **Ontology drift.** Same system called "the portal", "Rohlik Admin", "the internal tool". | Normalization step runs against existing `systems` table for the org, LLM proposes merges, surfaces them for human confirm on first 5 occurrences then auto-merges with high confidence. |
| **Operator interview feels invasive.** People hate being watched. | Make pause/edit-out trivial. Show the live transcript so they know exactly what's captured. Never persist raw frames after synthesis (only OCR + labels). |
| **Map auto-layout is ugly.** Hand-drawn BPMN is hard. | elkjs layered layout, then allow Director to drag-tweak; persist node positions. |
| **Multi-language.** Mockup shows language selector. | Keep ASR + TTS multilingual (Deepgram + Cartesia both support EU langs); synthesis prompts can run in English regardless because the LLM does the translation, but store original-language transcripts. |

---

## 10. Build phases

**Phase 0 — Skeleton (week 1-2)**
- Next.js + Hono + Neon + Clerk wired up. Empty schema. Deploy pipeline.

**Phase 1 — Director interview MVP (week 3-5)**
- LiveKit voice room, Sonnet 4.6 agent, state-machine controller, tool-calling into Postgres.
- High Level Overview dashboard (screenshot 4) renders from DB.
- Process detail page (screenshot 5-6) — no map yet, just metadata.
- *Demo target: a Director can do a 15-min voice call and see their process inventory.*

**Phase 2 — Synthesis + visual map (week 6-9)**
- Inngest pipeline. Director-level synthesis produces the process cards.
- Operator voice-only interview path (no screen yet) — produces structured steps.
- React Flow canvas with auto-layout, Steps + Summary tabs.
- *Demo target: from a voice-only operator interview, generate the flowchart in screenshot 10-12.*

**Phase 3 — Screen-share capture (week 10-13)**
- LiveKit screen track + R2 egress + frame sampler.
- SSIM keyframe pipeline + Claude vision labeling.
- Live segmenter feeding the operator agent.
- *Demo target: screen-share interview that produces a richer map than voice-only, with system tags grounded in what the agent literally saw.*

**Phase 4 — Insights & Risk tabs + ROI engine (week 14-16)**
- Impact / Insights / Risk & Vulnerabilities tabs fully generated.
- Automation pattern library v1 (~30 patterns).
- Opportunity ranking + Transformation Proposal view.
- *Demo target: end-to-end — Director onboarding → operator deep dive → ranked $X of automation opportunities.*

**Phase 5 — Hardening (week 17-20)**
- Eval harness for synthesis quality (20 golden interviews).
- Optional desktop helper (Tauri).
- Document upload path (PDF/DOCX → evidence).
- SSO / multi-tenant polish.
- Team invite flow + multi-operator merge.

---

## 11. Open questions to resolve before building

1. **Voice agent vendor for the interview brain** — Anthropic doesn't ship a realtime voice model, so the architecture is ASR → Claude → TTS. Confirm that ~700ms turn-taking latency is acceptable. (Alternative: use OpenAI Realtime gpt-4o for the interview turn-taking and hand off transcripts to Claude for synthesis — uglier but faster perceived latency.)
2. **Desktop helper or browser-only?** Affects screen-share fidelity dramatically and changes go-to-market (browser-only = self-serve, helper = sales-led pilots).
3. **Where do dollar estimates come from?** Operator-stated wages? An assumption table per role + region? Need a defensible source so the ROI tab doesn't get dismissed.
4. **How opinionated is the L4 ontology?** Strict schema (Action / Role / System / I/O / SLA / Exception) is what the mockup shows — confirm we never need to bend it for a vertical other than retail/CPG.
5. **Single-tenant per customer DB or shared multi-tenant?** Enterprise procurement often demands isolation; affects Neon usage from day one.

---

## 12. Cost & latency back-of-envelope

For a 30-min operator screen-share interview:
- ASR (Deepgram Nova-3): ~$0.20
- TTS (Cartesia): ~$0.50
- Frames: 30min × 2fps × 5% kept = 180 frames × Sonnet vision @ ~$0.003 = $0.54
- Live segmenter: ~180 Sonnet calls × $0.01 = $1.80
- Live interview brain: ~60 Sonnet calls × $0.02 = $1.20
- Batch synthesis (Opus + Sonnet mix): ~$3-5
- LiveKit + R2: <$0.50
- **Total ≈ $8-10 per deep-dive interview.** Director interview is ~$2.

Latency targets:
- Voice turn-taking: <1s p50, <1.5s p95.
- Live step segmenter lag: <15s.
- Post-interview synthesis: <5min for a 30-min interview (acceptable since user is no longer in-flow).
