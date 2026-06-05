# Otto

Otto is an AI operations consultant. It discovers how a business actually runs, maps each
workflow at fine granularity, and surfaces the highest-ROI automation opportunities. In other
words, it does the discovery-and-prioritization half of a forward-deployed engineer's job, run
as an agent.

Real processes live in people's heads, not in SOPs. The workarounds, exceptions, and handoffs
that decide whether a process can be automated are exactly the parts nobody wrote down. Otto
extracts that tacit knowledge through structured interviews and screen capture, grounds every
assertion in evidence, and turns it into a decision artifact: a visual process map plus an
automation plan with ROI estimates.

---

## Product Design

Otto mirrors how a good consultant works: breadth first, then depth.

### Director layer (breadth and prioritization)
- **Mechanism:** A short interview with a VP or director to build a high-level operational map: every process they own, who touches it, which systems are involved, how often it runs, and where the friction is. This is the prioritization view that decides *what* is worth a deep dive. Captured by voice and/or document upload.
- **Output:** Automation plan with implementation details and expected results grounded in high-impact ROI calculations for each process discovered.

### Operator layer (depth)
- **Mechanism:** Deep dives with the people doing the work, via live screen-share interview, screen-recording upload, or SOP upload. The agent asks questions while the operator walks through the work, producing an L4 map: every step, handoff, exception, workaround, and its financial impact.
- **Output:** BPMN-style process graph (Summary, Steps, Impact, and Risk tabs, plus a Transformation proposal) with owners, systems, and exceptions tagged.

---

## Architecture

Otto is a constellation of specialized agents coordinated by a deterministic orchestrator.

```
            ┌─────────────────────────────┐
            │   Orchestrator (Inngest)    │   workflow, not an LLM
            └─────────────────────────────┘
              │           │            │
   ┌──────────▼─┐  ┌──────▼──────┐  ┌──▼─────────────┐
   │  Director  │  │  Operator   │  │  Synthesis     │
   │  Agent     │  │  Agent      │  │  Pipeline      │
   │ (interview)│  │ (multimodal)│  │ (9-stage DAG)  │
   └─────┬──────┘  └──────┬──────┘  └────────┬───────┘
         │ split          │ split            │
   ┌─────▼─────┐    ┌─────▼─────┐            ▼
   │ FAST      │    │ FAST      │   ┌──────────────────┐
   │ speaker   │    │ speaker   │   │ Opportunity/ROI  │
   ├───────────┤    ├───────────┤   │ Agent (Opus)     │
   │ ASYNC     │    │ ASYNC     │   │ proposes + ranks,│
   │ extractor │    │ extractor │   │ deterministic    │
   │ (checker) │    │ (checker) │   │ engine grounds $ │
   └───────────┘    └───────────┘   └──────────────────┘
```

### Agents

Both interview agents (Director and Operator) split each turn into a fast speaking path and a slow
reasoning path: a small model speaks immediately from a deterministic steering plan while structured
extraction runs in the background. This supports low-latency UX while ensuring high-quality outputs. 

The Opportunity/ROI agent pairs an Opus reasoner with a deterministic ROI engine and persists its
output as a versioned synthesis artifact.

Every claim links to evidence and every model decision to an audit log, so any output is traceable
back to the interview moment or screen frame that produced it.

### Workflows

The synthesis pipeline (`lib/synthesis/operator-process.ts`) is a
workflow: a deterministic, checkpointed, idempotent 9-stage DAG that turns raw evidence into a
published process graph (evidence pack, semantic extraction, graph build, complexity, narrative,
publish). Inngest orchestrates it and fans interview and capture events out to synthesis, vision,
and redaction jobs.

### Model Selection

One model per role, not one model for everything (`lib/ai/models.ts`). The three jobs have different
latency and quality profiles:

- **Voice turn:** a small, fast model (Haiku class, `FAST_VOICE_MODEL`). It sits on the human
  critical path, so only speed is perceptible; a frontier model would add cost and latency for no
  felt gain.
- **Structured extraction:** a mid model (Sonnet class). It needs accuracy because it writes the
  claims that become the map, but it runs off the critical path.
- **Synthesis and opportunity reasoning:** the strongest model (Opus class). The hardest judgment
  in the system, and fully offline where latency does not matter.

Roles are env-overridable and a cost-aware pricing table sits next to the router, so cost is a
measured concern, not a guess.

### Tools

Agents act through a small, constrained tool set rather than free-form text: `recordProcess`,
`recordSystem`, `recordPerson`, `recordPainPoint`, `recordSpof`, `updateSlotState`,
`createFollowUpTask`, and claim writes. Calls are emitted as Anthropic tool-calls and validated
against `schemas/`. A claim allowlist (`lib/interview/director/claim-allowlist.ts`) restricts which
subjects and fields a model may write, so the tool surface cannot drift.

### Prompts

Prompts are versioned templates in `prompts/` with `template_id` and `template_version` frontmatter,
one per role (`director.turn.plan`, `*.voice.phrase-intent`, `operator.workflow_semantic_extraction`,
`synthesis.opportunities`, and so on). Each carries strict evidence rules: cite current-turn
evidence, use low confidence for inferred facts, never invent systems or metrics. The static,
reusable prefix is isolated so it can be cached while only the latest turn varies.

---

## Optimizations

### Context Management

Turns pass compacted slot and coverage state, not the raw transcript, which bounds hot-path token
count. Synthesis builds a per-process evidence pack instead of pushing all evidence into the prompt.

### Memory

Two tiers. Within-session: slot state and claims accumulate the interview. Cross-layer: the Operator
carries forward what the Director already established (systems, owners, process vocabulary, and
candidate-process context) so it does not re-ask known facts and terminology stays consistent across
layers.

### Retrieval

Evidence is the retrieval substrate. Claims resolve to evidence rows, and the opportunity agent
pulls a per-node evidence pack rather than the whole graph. Uploaded documents are chunked and
embedded (`lib/documents/`, `lib/adapters/vector.ts`) for semantic lookup.

### Accuracy

Accuracy is enforced structurally, not by prompting alone:

- Every assertion must cite `evidence_ids`; inferred facts are capped at low confidence.
- Quoted citations are verified against the source evidence (`lib/workflow/semantic-validation.ts`).
- The process graph is validated before publish (`lib/synthesis/operator-graph-validation.ts`).
- The opportunity agent proposes patterns and cites evidence, but every dollar figure is computed
  deterministically (`lib/roi.ts`), so ROI cannot be hallucinated.

The deliberate tradeoff: fewer high-confidence facts over broad, weak extraction.

### Latency and Cost

Prompt caching is built into the LLM adapter (`lib/adapters/llm.ts`): the static prompt prefix is
cached, only the latest turn varies. The voice path streams the spoken utterance as soon as it is
ready rather than waiting for the full structured result. Every generation logs tokens, cache hits,
cost, and latency, so cost and speed are observable per call.

---

## Production Practices

### Guardrails

The claim allowlist and `.strict()` structured-output schemas bound what a model can write. Both
interview agents run a non-blocking output checker on the spoken turn (`*.voice.output-checker`),
off the critical path. PII redaction (`lib/redactions/`) gates screen and recording evidence before
it ever reaches a model.

### Permissions

Every database transaction sets org context (`setOrgContext`) for tenant isolation, and internal
turn endpoints require a service token (`requireLiveKitAgentService`). The Python voice workers
never touch the database directly; they go through authenticated app endpoints.

### Resource Management

Retries use exponential backoff with jitter and error classification (rate-limit, timeout, network,
server) in `lib/adapters/retry.ts`. Synthesis runs carry a per-org Inngest concurrency limit
(`lib/inngest/functions.ts`) so one tenant cannot starve others. Voice prompts run under tight token
caps.

### Failure Handling

A failed extraction marks the turn degraded instead of breaking the conversation; a background job
(`reExtractDegradedTurns`) backfills it later. The opportunity stage is non-fatal and falls back to a
deterministic heuristic. Voice dispatch retries even after the agent has already spoken.

### Checkpointing

Each synthesis stage writes a `synthesis_stage_outputs` row with input and output references and a
per-stage version map, so runs are observable, partially replayable, and a single stage's prompt can
be versioned independently. Internal turn endpoints are idempotent (`lib/db/idempotency.ts`), so a
retried turn never double-writes.

### Input Validation and Structured Outputs

API inputs are validated with Zod at the route boundary. Model outputs come back as Anthropic
tool-calls validated against strict Zod schemas, and a schema-contract check keeps the Python workers
and the app in agreement on the wire format.

---

## Evals

"Is the agent good" is measured, not asserted. Scored, fixture-based evals in `evals/` cover each
agent:

- **Director:** process-inventory recall and prioritization agreement with a human FDE; live turn latency.
- **Operator:** L4 step precision and recall vs ground-truth graphs, and exception/workaround capture; 100% of claims must cite resolvable evidence (zero hallucination).
- **Synthesis:** graph validity and evidence-link coverage.
- **Opportunity/ROI:** ranking agreement with a human FDE and ROI within a sane band.

These run in CI and gate prompt and template-version changes: a regression fails the build instead
of shipping silently.

---

## Observability and Monitoring

Every model decision is logged to `agent_decision_log` (model, prompt version, tokens, cost, cache
hit, latency, degraded reasons); material changes go to `audit_log`. Because claims link to evidence
and decisions, any number on the map traces back to its source. This is the same telemetry that
surfaced and diagnosed real latency bugs during development.

An admin surface (`lib/admin/observability-queries.ts`) turns this into dashboards and alerts on the
signals that matter: latency percentiles, extraction-failure rate, cache-hit rate, degraded-turn
backlog, stage-failure rate, and cost per run. The loop closes back to evals: FDE corrections in the
workspace become labeled fixtures (`lib/admin/correction-eval-queries.ts`) that re-score the
affected agent.

---

## Next Steps

- Build an automation platform to implement the automation plan using the mapped workflows 
- Create agent improvement loops using human feedback on outputs

---

## Repository layout

```
otto-frontend/          Next.js app, the agent brain, API, persistence, and UI
  app/                  Routes: onboarding, capture, workspace, admin, and /api/* (incl. internal agent endpoints)
  lib/interview/        Director and operator interview brains (turn planning, slots, claims, tools)
  lib/synthesis/        The operator process-synthesis pipeline (evidence to graph to narrative)
  lib/workflow/         LLM semantic extraction and graph construction
  lib/processes/        Opportunity agent (evidence, extractor, grounding, persistence, queries) and ROI
  lib/vision/, lib/video/, lib/documents/   Multimodal ingest (screen frames, recordings, SOPs)
  lib/ai/models.ts      Per-role model routing and pricing
  lib/db/               Drizzle schema, claims and evidence, audit log, idempotency
  lib/inngest/          Async orchestration (events to synthesis, re-extraction, redaction)
  lib/admin/            Observability and correction-to-eval queries
  lib/redactions/, lib/security/            PII redaction and sanitization
  schemas/, prompts/, probes/, evals/       Structured-output schemas, prompt templates, probe libraries, eval fixtures
agents/director/        LiveKit Python voice worker for the director interview
agents/operator/        LiveKit Python voice worker for the operator interview
agents/realtime_core/   Shared voice-runtime helpers
```

---

## Running it

```bash
cp .env.example .env.local  # shared local secrets/config for app + workers
cd otto-frontend
npm install
npm run dev                 # Next.js app

npm run db:generate         # drizzle migrations from schema
npm run db:migrate

npm test                    # vitest (phase0 + phase1)
npm run eval:director:smoke # director evals + python worker contract/unit tests
```

The LiveKit voice workers run from `agents/director` and `agents/operator` (Python, `uv`). Shared
local secrets live in the repository root `.env.local`; per-service `.env` files are only for
overrides such as agent names, health ports, and capture-session smoke-test values. Use
`scripts/with-env.sh` to load the root env plus a service override file before starting workers.