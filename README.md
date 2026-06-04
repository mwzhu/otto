# Otto

Otto is an AI operations consultant. It discovers how a business actually runs, maps each
workflow at fine granularity, and surfaces the highest-ROI automation opportunities. In other
words, it does the discovery-and-prioritization half of a forward-deployed engineer's job, run
as an agent.

The insight the whole system is built around: real processes live in people's heads, not in
SOPs. The workarounds, exceptions, and handoffs that decide whether a process can be automated
are exactly the parts nobody wrote down. Otto extracts that tacit knowledge through structured
interviews and screen capture, grounds every assertion in evidence, and turns it into a decision
artifact: a visual process map plus a ranked list of automation opportunities with ROI estimates.

This document is as much about *why* the system is shaped the way it is as about what it does. The
interesting engineering here is not any single model call; it is the set of tradeoffs that make a
multimodal, latency-sensitive, hallucination-intolerant agent product actually hold together.

---

## The product, in two layers

Otto mirrors how a good consultant works: breadth first, then depth.

- **Director layer (breadth and prioritization).** A short interview with a VP or director to
  build a high-level operational map: every process they own, who touches it, which systems are
  involved, how often it runs, and where the friction is. This is the prioritization view that
  decides *what* is worth a deep dive. Captured by voice or by document upload.

- **Operator layer (depth and ground truth).** Deep dives with the people doing the work, via live
  screen-share interview, screen-recording upload, or SOP upload. The agent asks questions while
  the operator walks through the work, producing an L4 map: every step, handoff, exception,
  workaround, and its financial impact.

Both layers feed a synthesis pipeline that produces the headline output: a BPMN-style process
graph (Summary, Steps, Impact, and Risk tabs, plus a Transformation proposal) with owners,
systems, and exceptions tagged, and a ranked automation-opportunity list with deterministic ROI
math behind every number.

---

## Architecture at a glance

The system is a small constellation of specialized agents over a deterministic orchestrator,
not one monolithic agent. Each interview agent is itself split into a fast speaking path and a
slow reasoning path (explained below).

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

All three legs are in place. Both interview agents run the fast-speaker and async-extractor split
over shared `respond` and `extract` endpoints. The Opportunity/ROI agent pairs an Opus reasoner
with a deterministic ROI engine and persists its output as a synthesis artifact. Everything an
agent asserts becomes a claim linked to evidence, and every model decision is written to an audit
log, so the final map is fully traceable back to the moment in the interview or the frame on screen
that produced it.

---

## Design decisions and tradeoffs

### Deciding what is an agent and what is a workflow

The first and most consequential decision was refusing to make everything an agent. Agency is
expensive: it costs latency, money, and predictability. So each sub-problem was classified by
whether it genuinely needs open-ended decision-making:

- **The interviews are agents.** Choosing what to ask next depends on conversation state with no
  fixed script, which is the definition of a task that needs an agent.
- **The synthesis pipeline is a workflow,** a versioned, checkpointed, idempotent 9-stage DAG
  (`lib/synthesis/operator-process.ts`). Its reliability comes from being deterministic and
  replayable. Making it agentic would have traded away the checkpointing and resumability that
  make it trustworthy, for no benefit.
- **Redaction is a deterministic classifier, never an agent,** because it is safety-critical and
  must be predictable.

The tradeoff: this hybrid is more moving parts than a single do-everything agent, but each part is
independently testable, independently scalable, and fails in a contained way.

### Decoupling speech from reasoning (the latency architecture)

A live voice interview has a hard human-perceptible latency budget. The naive design puts a single
heavy model call on the critical path: the model both decides what was learned (structured
extraction) and produces what to say next. That call's latency floor becomes the agent's response
time, and any failure in it silences the agent mid-conversation.

Otto splits every interview turn into two paths:

1. A **fast speaking path** that builds a deterministic steering plan (next objective, target
   slots, what not to re-ask) and phrases the spoken reply with a small, low-latency model call,
   then speaks immediately.
2. A **slow reasoning path** that runs structured extraction in the background as an
   eventually-consistent checker, writing slots, claims, and process facts after the agent has
   already responded.

Both interview agents run this split: `buildDirectorSteeringPlan` and `phraseDirectorSteeringTurn`
for the Director's spoken turn (and `buildOperatorSteeringPlan` and `phraseOperatorSteeringTurn`
for the Operator), with background `extractDirectorTurn` and `extractOperatorTurn` doing the
reasoning, exposed over SSE as separate `respond` and `extract` endpoints.

The tradeoff is explicit: the spoken turn is steered by topic and coverage, not by the very latest
structured extraction, so coverage is eventually consistent rather than turn-synchronous. This was
validated against how production voice-agent companies actually build (cascades of specialized
models with parallel non-blocking checkers, not single end-to-end models), and it is the right
call because conversational responsiveness matters more than the agent's notes being one turn
ahead. A failed extraction now degrades to a retryable background job instead of breaking the
conversation.

### Choosing a model per role, not one model for everything

There is no single model. `lib/ai/models.ts` routes each prompt to a model and token budget by
role, because the three jobs have completely different cost, latency, and quality profiles:

- **Spoken voice turn:** a small, fast model (Haiku class, `FAST_VOICE_MODEL`) with a tight token
  cap. Phrasing one acknowledged question is easy; what matters is time-to-first-token, and the
  call is on the human-facing critical path. Spending a frontier model here would buy quality
  nobody can perceive while hurting the only metric that matters (speed).
- **Structured extraction:** a mid-tier model (Sonnet class). Extraction needs real accuracy
  because it writes the claims that become the map, but it runs off the critical path, so it can
  take the time to be careful.
- **Synthesis and opportunity reasoning:** the strongest model (Opus class). Reasoning over messy
  evidence to build a graph and identify automation opportunities is the hardest judgment in the
  system, and it runs offline where latency is irrelevant. This is the one place worth paying for
  the best model.

Roles are overridable per environment (`DIRECTOR_VOICE_MODEL`, `OPERATOR_VOICE_MODEL`,
`DIRECTOR_BRAIN_MODEL`, `OPERATOR_BRAIN_MODEL`, `OPERATOR_WORKFLOW_MODEL`,
`SYNTHESIS_PLANNER_MODEL`), and a cost-aware pricing table sits next to the router so cost is a
first-class, measured concern rather than an afterthought.

### Splitting judgment from arithmetic (the opportunity agent)

The headline output is a ranked, costed automation-opportunity list, and it is the one place where
a hallucinated number is most damaging. So the Opportunity/ROI agent is a deliberate hybrid: the
Opus reasoner does the judgment, and code does the arithmetic.

- The model reads the validated process graph and its evidence and proposes opportunities: the
  automation pattern, the current-to-target narrative, which steps it touches, and the
  evidence it cites. It also supplies operational quantities (volume, minutes saved, error and
  exception rates). It never emits a dollar figure or a score.
- A deterministic grounding engine (`lib/processes/opportunity-grounding.ts`) validates the cited
  evidence and node references, clamps the quantities to sane bounds, injects workspace finance
  prices (`workspace_roi_prices`), and runs the unchanged ROI math (`lib/roi.ts`). Numbers stay
  defensible because a model cannot invent them.

It runs as a non-fatal synthesis stage (`stage-9-opportunity-synthesis`) that persists an immutable,
versioned artifact (`automation_opportunity_sets`), is gated behind a flag, and falls back to a
deterministic heuristic if it is disabled or fails. The read path (`getProcessOpportunities`) is the
single entry point every surface uses.

### Grounding: evidence or it did not happen

A consulting deliverable that hallucinates a system, a volume, or a risk is worse than useless; it
is a liability. So accuracy is enforced structurally, not hoped for through prompting alone:

- Every extracted assertion must cite `evidence_ids` from the current turn.
- Inferred-but-unstated facts are capped at low confidence and flagged as inferred.
- A claim allowlist (`lib/interview/director/claim-allowlist.ts`) constrains which subjects and
  fields a model is even allowed to write, a hard guardrail against schema drift.
- The operator semantic extractor validates that quoted citations actually appear in the evidence
  (`lib/workflow/semantic-validation.ts`).
- The produced graph is validated before it can be published
  (`lib/synthesis/operator-graph-validation.ts`).

The tradeoff is less raw extraction breadth in exchange for trust: the design deliberately prefers
fewer high-confidence, evidence-backed facts over broad weak extraction.

### Context, memory, and retrieval

Interview turns pass compacted slot and coverage state rather than raw transcript wherever
possible, which bounds the hot-path token count. Slot state and claims are the within-session
memory; the Operator layer also carries forward what the Director already established (systems,
owners, process vocabulary, and candidate-process context) so it does not re-ask known facts and
terminology stays consistent across layers. Evidence is the retrieval substrate: claims resolve to
evidence rows, and synthesis builds a per-process evidence pack rather than dumping everything into
the prompt.

### Latency and cost engineering

Prompt caching is built into the LLM adapter (`lib/adapters/llm.ts`) using ephemeral
`cache_control` with a minimum static-prefix size, and the static, reusable portion of each prompt
(system instructions, schema, probe library) is isolated so it caches while only the latest turn
varies. The voice path streams, emitting the spoken utterance as soon as it is ready rather than
waiting for a full structured result. Every generation records input and output tokens, cache
hits, cost in cents, and latency, so both cost and speed are observable per call.

### Reliability and failure handling

- **Retry with exponential backoff and jitter,** plus error classification into rate-limit,
  timeout, network, and server categories (`lib/adapters/retry.ts`).
- **Idempotency on internal turn endpoints** (`lib/db/idempotency.ts`) so a retried turn never
  double-writes.
- **Checkpointing:** each synthesis stage is a `synthesis_stage_outputs` row with input and output
  references and a per-stage version map, so a run is observable and partially replayable, and a
  prompt change to one stage can be versioned independently.
- **Per-tenant isolation:** synthesis runs carry an Inngest concurrency limit keyed by org
  (`lib/inngest/functions.ts`) so one workspace's load cannot starve another's.
- **Graceful degradation:** a failed extraction marks the turn degraded instead of breaking the
  conversation, and a background job (`reExtractDegradedTurns`) backfills it later.

### Safety

Screen-share frames and recordings pass through a redaction pipeline (`lib/redactions/`) before
they ever become evidence, with a cascade for operator captures, and logs are sanitized
(`lib/security/`). PII handling is a deterministic gate in front of the models, not something the
models are trusted to get right. Separately, both interview agents vet their spoken turn with a
non-blocking output checker (`*.voice.output-checker`) that runs in parallel, off the critical
path, so quality and moderation checks add no user-visible latency.

---

## What we evaluate

Success criteria are concrete and per-agent, and they map directly to scored, fixture-based evals
in `evals/` plus the voice workers' schema-contract and unit suites. The point is that "is the
agent good" is a measurable question here, not a vibe.

- **Director interview:** process-inventory recall (did it surface every process the VP owns), and
  prioritization quality (does its ranking of what to drill agree with a human FDE). On the live
  path the bar is latency: time-to-first-token and per-turn response time.

- **Operator interview and graph:** L4 step precision and recall against ground-truth graphs, plus
  exception and workaround capture rate. The hard gate is hallucination: every claim must cite
  evidence, so cited-evidence validity must be 100 percent.

- **Synthesis:** graph validity (the produced graph passes structural validation before publish)
  and evidence-link coverage (what fraction of nodes and edges are backed by evidence).

- **Opportunity and ROI:** ranking agreement with an FDE's ranking, ROI estimates that stay within
  a sane band, and again zero hallucinated evidence. This is the criterion most tied to the product
  thesis, because the headline output is the ranked opportunity list.

These evals produce scored reports and gate prompt and template-version bumps in CI: a change that
regresses a fixture fails the build rather than shipping silently.

---

## Observability and audit

Every model decision is written to `agent_decision_log` with model, prompt id and version, input
and output tokens, cost, cache hit, latency, and degraded reasons; material changes go to
`audit_log`. Because claims link to both evidence and decisions, any number on the final map can be
traced back to its source, and the same telemetry is what surfaced and diagnosed real production
latency issues during development.

An admin observability surface (`lib/admin/observability-queries.ts`) turns this telemetry into
dashboards and alerts on the operational signals that matter: turn latency percentiles,
extraction-failure rate, cache-hit rate, degraded-turn backlog, synthesis stage-failure rate, and
cost per run. The loop closes back to evals: FDE corrections made in the workspace are captured as
labeled examples and fed into the eval fixtures (`lib/admin/correction-eval-queries.ts`), so a real
correction becomes a regression test and re-scores the affected agent.

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
cd otto-frontend
npm install
npm run dev                 # Next.js app

npm run db:generate         # drizzle migrations from schema
npm run db:migrate

npm test                    # vitest (phase0 + phase1)
npm run eval:director:smoke # director evals + python worker contract/unit tests
```

The LiveKit voice workers run from `agents/director` and `agents/operator` (Python, `uv`); see each
agent's `README.md` and `.env.example` for required keys (LiveKit, Deepgram STT, Cartesia TTS,
Anthropic).

---

## Status

The architecture described above is implemented. Design records for the larger build-outs (the
hybrid opportunity agent and the voice-runtime decoupling) live in the `docs/` folder, for example
[`docs/OPPORTUNITY_AGENT_PLAN.md`](docs/OPPORTUNITY_AGENT_PLAN.md) and
[`docs/VOICE_DECOUPLE_CLEANUP_PLAN.md`](docs/VOICE_DECOUPLE_CLEANUP_PLAN.md).
