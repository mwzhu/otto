# Operator Screenshare To Workflow Map Implementation Plan

## Task Description

Build the missing semantic workflow layer between an operator screenshare interview and the process map canvas. The system should not turn screen capture mechanics into workflow nodes. It should transform narrated operator behavior, screen evidence, visual observations, documents, and follow-up answers into business workflow logic: steps, decisions, waits, handoffs, exception paths, loops, systems, inputs, outputs, controls, roles, evidence, confidence, and open questions.

The target output should look like the `frontend-mockups/map1.png` through `map7.png` examples: business steps such as "Align on promo proposal with category team," decisions such as "Supplier funding confirmed?", wait states such as "Wait for promo launch date," exception loops such as "Resolve data errors and resubmit," and role/system annotations. It should never show technical labels like "Keyframe candidate," "operator-capture.webm," "screen frame sampled," "OCR pending," or "LiveKit connected" as workflow nodes.

## Context

The current pipeline stores capture artifacts correctly, and Inngest can process durable recordings. The current deterministic graph builder can produce a syntactically valid graph, but it is too close to the raw evidence layer. When transcription or OCR is missing, it promotes weak technical labels into nodes. That is useful for debugging ingestion but wrong for the product.

The correct architecture needs three separate layers:

1. Capture evidence: raw transcript segments, screen events, visual observations, artifacts, provisional steps.
2. Business workflow semantics: normalized operator actions, business objects, decisions, waits, handoffs, exceptions, systems, IO, roles, controls, timing, topology, confidence.
3. Workflow map rendering: nodes and edges laid out as a business process model.

The implementation should explicitly model layer 2 instead of hoping graph nodes can be inferred directly from layer 1.

The LLM proposes the business semantic model, including topology. Deterministic code verifies the model, translates it into graph rows, and lays it out. This means the model decides that "Revise promo plan per feedback" loops back to "All approvals obtained?"; the renderer only turns that verified topology into `GraphNode` and `GraphEdge` rows.

The verifier can guarantee well-formedness and grounding. It cannot prove that a plausible topology is factually correct if the evidence is ambiguous. Labeled workflow evals are therefore part of the extraction spike, not a late polish step.

## Scope

In scope:

- Convert screenshare interviews into business workflow candidates.
- Use transcript, visual evidence, OCR, documents, prior process claims, and structured slot states together.
- Generate task, decision, wait, handoff, exception, and end nodes.
- Generate sequential, conditional, handoff, loop, and exception edges.
- Attach evidence and confidence to every semantic claim.
- Block or quarantine technical capture artifacts.
- Surface low-confidence or missing semantics as follow-up questions, not fake workflow nodes.
- Add evals against hand-labeled workflows matching the map examples.

Out of scope for the first pass:

- Perfect BPMN compliance.
- Fully automated final approval.
- Real-time collaborative graph editing.
- Cross-process benchmarking.

## Business Workflow Logic

### Core Model

A business workflow is a sequence of business state transitions, not a sequence of screenshots. Each node should answer one of these questions:

- What business action happens?
- Who performs it?
- In which system or channel?
- What input is consumed?
- What output or state change is produced?
- What decision or condition changes the path?
- What wait, SLA, or external dependency delays the path?
- What exception, rework loop, or workaround occurs?
- What evidence supports this claim?

### Semantic Entities

Add an explicit intermediate model named `WorkflowSemanticModel`. This should extend the existing `OperatorEvidencePack`, `operator-graph-validation.ts`, slot enrichment, visual observation, synthesis stage output, and follow-up task infrastructure. Do not build a parallel graph stack that can drift from the current one.

Recommended shape:

```ts
type WorkflowEvidenceCitation = {
  evidenceId: string;
  sourceRef: { table: string; id: string };
  quote?: string;
  spanStart?: number;
  spanEnd?: number;
  timestampMs?: number;
};

type WorkflowSemanticStep = {
  id: string;
  kind: "task" | "decision" | "wait" | "handoff" | "exception" | "terminal";
  title: string;
  businessObject?: string;
  actionVerb?: string;
  actorRole?: string;
  systems: string[];
  inputs: WorkflowIO[];
  outputs: WorkflowIO[];
  decision?: {
    question: string;
    branches: Array<{ label: string; condition: string; targetHint?: string }>;
  };
  wait?: {
    reason: string;
    durationHint?: string;
    releaseCondition?: string;
  };
  exception?: {
    trigger: string;
    resolution: string;
    rejoinsAtHint?: string;
  };
  citations: WorkflowEvidenceCitation[];
  modelConfidence?: number;
  confidence: number; // verifier-derived, not trusted directly from the model
  grounding: "quoted" | "observed" | "documented" | "inferred";
  ambiguityReasons: string[];
};

type WorkflowSemanticEdge = {
  id: string;
  sourceStepId: string;
  targetStepId: string;
  kind: "sequence" | "conditional" | "handoff" | "exception_loop" | "parallel";
  label?: string;
  condition?: string;
  citations: WorkflowEvidenceCitation[];
  modelConfidence?: number;
  confidence: number; // verifier-derived, not trusted directly from the model
  grounding: "quoted" | "observed" | "documented" | "inferred";
};
```

The semantic model must use stable internal step IDs. Free-form `targetHint` and `rejoinsAtHint` strings can exist in the LLM response only as pre-resolution hints. A deterministic resolution pass must convert every hint into a real step ID before graph translation.

### LLM Business Extraction

Business workflow extraction is an LLM task with deterministic verification. Regex and deterministic transforms can pre-clean evidence and post-validate output, but they cannot reliably paraphrase operator narration into product-quality workflow semantics.

The extractor should call a configured model, initially:

- `ANTHROPIC_MODEL` or `OPERATOR_WORKFLOW_MODEL`, defaulting to the existing Anthropic model selection helper.
- JSON-only response validated with Zod.
- Batched by evidence window for long captures, then stitched globally.
- Cost bounded by max evidence windows, max frames, and max transcript chars.

The model should prefer business semantics in this order:

1. Operator narration: "I check supplier funding, then enter the promo."
2. Explicit UI text/OCR: button labels, table names, form fields, approval statuses.
3. Prior process knowledge and document chunks.
4. Screen signals: system switches, copy/paste, exports, waiting, approvals, errors.
5. Raw visual keyframes only as supporting evidence, not step titles.

The extractor should turn natural language and UI observations into action frames:

- "I align with the category manager" -> task: "Align on promo proposal with category team"
- "If supplier funding is not confirmed" -> decision: "Supplier funding confirmed?"
- "We wait until the vendor approves" -> wait: "Wait for supplier funding approval"
- "If the data looks wrong, I fix it and resubmit" -> exception loop: "Resolve data errors and resubmit"
- "Then marketing and store ops get briefed" -> handoff/task: "Brief marketing and store ops"

The prompt contract must forbid raw capture labels as workflow node titles. It must require every step and edge to cite evidence by ID and, where text is available, include a quote from that evidence row. The quote should be exact when possible, but publication should not depend on the model producing perfect verbatim text.

### Model Output Schema

Add a Zod schema for the LLM response:

```ts
const workflowSemanticExtractionSchema = z.object({
  steps: z.array(workflowSemanticStepSchema),
  edges: z.array(workflowSemanticEdgeSchema),
  unresolvedQuestions: z.array(z.object({
    question: z.string(),
    reason: z.string(),
    relatedEvidenceIds: z.array(z.string()),
  })),
  diagnostics: z.array(z.object({
    code: z.string(),
    message: z.string(),
    relatedEvidenceIds: z.array(z.string()),
  })),
});
```

Model output is a proposal. It is not publishable until deterministic verification resolves IDs, validates citations, checks quotes, checks topology, and applies confidence rules.

### Decision Inference

Create decision nodes when evidence contains:

- Conditional language: if, unless, when, otherwise, approved, rejected, confirmed.
- Status checks: approved/pending/failed/correct/errors found.
- UI state transitions from validation or approval screens.
- Slot states for `step.decision_criteria`.

Decision node titles should be questions:

- "Supplier funding confirmed?"
- "All approvals obtained?"
- "Data entry accurate?"

Branches should be short labels:

- Yes / No
- Approved / Changes requested
- Correct / Errors found
- Complete / Missing info

### Wait State Inference

Create wait nodes when evidence contains:

- waiting, pending, launch date, approval date, SLA, delay, scheduled.
- inactivity between business steps with narration indicating dependency.
- explicit follow-up needed from supplier, approver, finance, legal, store ops.

Wait nodes should include the dependency and release condition:

- "Wait for supplier funding approval"
- "Wait for promo launch date"
- "Wait for legal review"

### Handoff Inference

Create handoff edges or handoff nodes when:

- Actor role changes.
- System ownership changes.
- Output is sent to another team.
- Evidence contains "send to," "route to," "brief," "notify," "handoff," "approval."

Examples:

- Coordinator -> Supplier
- Coordinator -> Marketing / Store Operations
- Sales Ops -> Finance

### Exception And Loop Inference

Create exception paths when evidence contains:

- errors, rejected, mismatch, missing, duplicate entry, spreadsheet workaround.
- manual correction, resubmit, retry, refresh, export/import, copy/paste between systems.
- contradiction between SOP and observed screen behavior.

Exception paths should rejoin the main flow at a known target when possible:

- "Resolve data errors and resubmit" loops back to "Data entry accurate?"
- "Revise promo plan per feedback" loops back to "All approvals obtained?"

### Confidence Rules

Workflow nodes should be publishable only when one of the following is true:

- It has transcript evidence.
- It has OCR/vision evidence with business text.
- It has document evidence.
- It has slot state evidence.
- It is a low-confidence placeholder explicitly marked as needing follow-up.

Technical evidence labels alone are insufficient:

- keyframe candidate
- screen frame sampled
- live preview
- recording upload
- browser recording buffer
- LiveKit joined
- OCR pending

Those should be stored as diagnostics or evidence, not graph nodes.

### Topology Responsibility

The LLM proposes topology:

- node order
- decision placement
- branch labels
- branch targets
- exception loop rejoins
- handoff edges
- wait-state placement

The deterministic verifier checks topology:

- every source and target ID exists
- decisions satisfy the decision cardinality policy in Track 3
- exception loops rejoin a real node or create a follow-up
- terminal states are valid
- all non-terminal paths can reach an end state
- every edge has evidence or is explicitly marked `inferred`

The verifier does not prove the proposed order is true. Wrong-but-plausible topology is caught by labeled evals and user review.

### End State Policy

Current graph validation expects exactly one end node. The semantic layer may identify multiple terminal business outcomes, such as "Promotion launched" and "Promotion rejected." For v1, collapse multiple terminal outcomes into one graph `end` node and preserve outcome-specific terminal semantics as labeled incoming edges or terminal task nodes. Revisit multiple end-node support after the first semantic workflow release.

## Technical Implementation

### Track 0: Ingestion Gate

Screenshare interview evidence must become business text before semantic extraction can be trusted.

Required upgrades:

- Ensure MediaRecorder captures screen video plus mic audio.
- Require local dev warning when `DEEPGRAM_API_KEY` is missing.
- Fix ffmpeg frame extraction so durable recordings produce actual frame images.
- Enable OCR by default where available.
- Enable multimodal vision for selected frames when `OTTO_OPERATOR_VISION_PROVIDER=anthropic-vision`.
- Store extracted UI text and structured business observations in `visual_observations`.
- Add a capture-quality status to the UI: transcript ready, OCR ready, vision ready, semantic extraction ready.

The visual observation prompt/schema should extract:

- current business object
- visible system
- user action
- visible fields
- statuses
- validation messages
- approval state
- selected records
- exported/imported artifacts
- likely business purpose

This track gates semantic extraction. If transcript and OCR/vision are both missing or degraded, do not publish a workflow map; publish diagnostics and follow-up questions.

### Track 1: Minimal Eval Harness And LLM Extraction Spike

Before building the full semantic layer, create the smallest runnable eval harness. The spike has no success signal without it.

Minimum eval assets:

- Hand-label 1-2 maps from `frontend-mockups/map1.png` through `map7.png` into expected semantic graph JSON.
- Author synthetic evidence packs that should produce those graphs.
- Include at least one decision, one wait, one exception loop, and one handoff.
- Include one negative fixture with only technical keyframe labels.

Scoring must include:

- deterministic structural checks: decision count, branch cardinality, loop presence, wait count, handoff count, technical leakage.
- evidence grounding checks: every cited evidence ID exists and every quoted citation passes exact or fuzzy quote verification.
- semantic title/step recall: use key-phrase slot matching initially, with optional LLM judge later. Do not rely only on exact title matching.

Then build one LLM extractor against this harness:

- Input: compacted `OperatorEvidencePack` with evidence windows.
- Output: `WorkflowSemanticModel` proposal.
- Prompt: JSON only, business workflow only, no technical capture artifacts.
- Cost controls for the spike: at most 20 transcript segments, 20 visual observations, 12 frame references, 12 prior claims, and 2 extraction windows per capture. The full implementation can tune these limits.
- Grounding: every step and edge cites real evidence IDs and quotes when text exists.

Determinism and replay policy:

- Compute an `evidence_pack_hash` from redaction-safe normalized evidence inputs, prompt template ID/version, model ID, extraction config, prior process version ID, and capture session IDs.
- Before calling the model, look up a verified semantic model for `(org_id, workspace_id, process_id, evidence_pack_hash)`.
- If a verified cached model exists and its source rows have not changed, reuse it and skip LLM extraction.
- Store `llm_request_hash`, `llm_response_hash`, `prompt_template_id`, `prompt_template_version`, `model`, `semantic_model_hash`, and cache status for every semantic extraction attempt.
- New captures, changed redactions, changed prompt versions, or changed prior process versions must produce a new hash and a new draft semantic model.
- Never mutate an approved process version during replay. Reruns should create or update a draft linked to the prior version instead of reshuffling approved topology.

### Track 2: Define The Semantic Workflow Layer

Add or extend files:

- `otto-frontend/lib/workflow/semantic-model.ts`
- `otto-frontend/lib/workflow/semantic-llm-extractor.ts`
- `otto-frontend/lib/workflow/semantic-to-graph.ts`
- `otto-frontend/lib/workflow/semantic-validation.ts`

The semantic extractor should accept `OperatorEvidencePack` and return:

```ts
type WorkflowSemanticExtractionResult = {
  model: WorkflowSemanticModel;
  diagnostics: WorkflowSemanticDiagnostic[];
  followUpQuestions: WorkflowFollowUpQuestion[];
};
```

Diagnostics should include reasons like:

- `missing_transcript`
- `ocr_degraded`
- `technical_capture_artifact_filtered`
- `decision_branch_low_confidence`
- `wait_state_inferred`
- `exception_rejoin_unknown`
- `quote_not_found_in_evidence`
- `hallucinated_evidence_id`
- `unresolved_topology_target`

### Track 3: Deterministic Verification And Anti-Hallucination Gates

The verifier must block fabricated or ungrounded output.

Required checks:

- Every `evidenceId` resolves to a real, non-redacted row visible to the org/workspace.
- Every `sourceRef` resolves to a real, non-redacted row.
- Every quoted citation text either occurs in the cited source text/evidence quote/summary or passes fuzzy quote matching.
- Every step ID is unique.
- Every edge references existing step IDs.
- Every wait has a reason or release condition.
- Every exception loop has a resolved rejoin target or creates a follow-up task.
- Every non-placeholder step has citations or is marked `inferred`.
- Every inferred step is verifier-capped to low confidence and creates or links to a follow-up.
- No technical capture artifact text appears in node titles, edge labels, or terminal titles.

Decision cardinality policy:

- Publish a decision node when it has at least two grounded outgoing branch edges.
- Publish a decision node with one grounded branch and one inferred branch only when the missing branch can be stated safely as a low-confidence counterfactual and creates a follow-up, for example "What happens if approval is rejected?"
- If only one branch is evidenced and no safe inferred branch can be stated, demote the decision to a task/check step and create a `missing_decision_branch` follow-up.
- The LLM must not invent reject/error/alternate branches merely to satisfy cardinality.

Quote verification should be cheap and deterministic, but not brittle. Normalize whitespace and punctuation, then check the model's quoted substring against:

- `transcript_segments.text`
- `evidence.quote`
- `evidence.summary`
- `document_chunks.text`
- `visual_observations.ocr_text`
- `visual_observations.ui_summary`
- structured visual fields serialized as text

Grounding tiers:

- `quoted`: quote match passes exact or fuzzy verification.
- `observed`: evidence/source IDs are real, but no exact quote is available, common for screenshots or structured visual observations.
- `documented`: document evidence is cited and quote/summary verification passes.
- `inferred`: no direct quote/observation fully supports the claim; confidence is capped low and a follow-up is required.

Quoted snippets should be short, ideally under 25 words. Fuzzy quote matching should use normalized token overlap and edit distance, for example token overlap >= 0.8 or normalized edit distance <= 0.2. Fuzzy matching is allowed only for short quotes. Quotes longer than 25 words must pass contiguous normalized substring matching or be downgraded to `observed`/`inferred`. Exact quote grounding can be gated at 1.0; observed/inferred claims use different gates.

Verifier-derived confidence should replace model self-confidence:

- quoted or documented with verified citation: high confidence cap, e.g. `0.75-0.9`
- observed visual/OCR with real citation: medium confidence cap, e.g. `0.55-0.75`
- ID-only observed citation with degraded OCR/vision: lower medium cap, e.g. `0.45-0.6`
- inferred claim: low confidence cap, e.g. `<=0.45`
- unresolved topology, missing target, or fabricated citation: not publishable

The LLM can provide `modelConfidence` as a signal for diagnostics, but publish rules must use verifier-derived `confidence`.

### Track 4: Prompt Context Assembly

Replace direct graph seed generation with LLM semantic extraction. The current `taskSeedsFromPack` and the flat `buildDeterministicOperatorGraph` chain are temporary scaffolding. They should be deleted or made test-only when semantic graph generation lands. Do not keep the linear builder as a runtime fallback.

The old "extractor" names become prompt context assemblers, not independent node generators:

- `TranscriptContextAssembler`: selects narrated spans and conditional phrases for the prompt.
- `VisualContextAssembler`: selects OCR/vision observations, visible systems, fields, statuses, errors, and artifacts.
- `DocumentContextAssembler`: selects SOP/process document excerpts.
- `SlotStateContextAssembler`: selects existing structured slot states for systems, IO, exceptions, roles, handoffs.
- `PriorGraphContextAssembler`: summarizes current draft/approved graph and claims.

These modules may normalize, compact, rank, and redact evidence before prompting. They must not create competing workflow nodes or edges.

The LLM output should include:

- normalized business title
- node kind
- actor/target role when evidenced
- system/channel
- business object
- inputs/outputs
- time range
- evidence citations
- proposed topology
- model confidence for diagnostics

### Track 5: Semantic Merging, Ordering, And Long-Capture Stitching

Merge duplicate LLM-proposed semantic steps by meaning, not exact title.

Example equivalents:

- "Enter promo into system"
- "Manually enter promo into promo system"
- "Create promo record"

Ordering signals:

- transcript order
- screen timestamp
- document order
- transition language: before, after, then, once, if approved
- prior graph order

The merger should produce a coherent semantic model with stable step IDs and resolved edges.

Long captures are an explicit spike question. Extraction needs a global view for ordering and loop rejoin resolution, but long sessions may exceed context limits. Use a two-level strategy:

1. Window extraction: the LLM extracts local semantic steps/edges from 2-5 minute evidence windows.
2. Global stitching: default to an LLM stitching pass over window-level semantic summaries plus citation inventories. A deterministic resolver may resolve obvious exact IDs and duplicate titles, but should not invent cross-window loops.

The stitching pass must preserve source citations and must not invent new evidence. If a cross-window rejoin cannot be grounded with retained citations, it must remain unresolved and create a follow-up rather than publish a loop.

### Track 6: Semantic Enrichment And Consistency Checks

Build these on top of existing gap/contradiction logic where possible. These passes inspect and enrich the LLM model; they do not create an independent competing topology.

- `validateDecisionPoints(model)`: ensure decisions have branch labels, conditions, and targets.
- `validateWaitStates(model)`: ensure waits have a dependency or release condition.
- `validateHandoffs(model)`: ensure handoffs identify a target role/team when evidenced.
- `validateExceptionLoops(model)`: ensure loops have a rejoin target or follow-up.
- `enrichWorkarounds(model)`: attach workaround metadata to existing supported nodes/edges.

Example LLM-owned extraction:

Evidence:

> "If all approvals are obtained, I enter it into the promo system. If changes are requested, I revise the plan."

Semantic output:

- decision: "All approvals obtained?"
- branch "All approved" -> "Manually enter promo into promo system"
- branch "Changes requested" -> "Revise promo plan per feedback"
- loop from revise back to decision

Deterministic enrichment then checks that both branch targets exist, that each branch has citations or is explicitly inferred, and that the loop rejoin resolves to the decision step ID.

Actor and role attribution should be realistic. In a single-operator screenshare, the operator's own role is often implicit and target roles are frequently inferred from phrases like "send to marketing" or "brief store ops." Handoff/role fields should therefore allow `grounding: "inferred"` and low confidence. Evals should not require perfect actor attribution unless the evidence explicitly contains the role/team.

### Track 7: Semantic-To-Graph Translation

`semantic-to-graph.ts` should be the only module that writes `GraphNode` and `GraphEdge` candidates.

Mapping:

- semantic `task` -> graph node type `task`
- semantic `decision` -> graph node type `decision`
- semantic `wait` -> graph node type `wait`
- semantic `handoff` -> graph node type `handoff` or edge type `handoff`
- semantic `exception` -> graph node type `exception`
- semantic branch -> edge type `conditional`
- exception rework -> edge with `is_exception_path=true`

Graph node titles should be business-facing. Descriptions can mention supporting evidence and uncertainty, but never raw capture machinery.

### Track 8: Validation And Publish Rules

Extend `operator-graph-validation.ts`.

Validation rules:

- No technical capture artifact titles.
- Every non-placeholder node has evidence or is explicitly low confidence.
- Decision nodes must have at least two outgoing conditional edges.
- Wait nodes must include a wait reason or dependency.
- Exception nodes must either rejoin the graph or create a follow-up.
- Handoff nodes must identify a target role/team when possible.
- Main path must be reachable from start to end.
- Published graph topology must come from verified semantic topology, not direct evidence seeds.

If validation fails:

- Do not publish fake technical graphs.
- Publish a semantic diagnostic panel instead.
- Create follow-up tasks asking for missing business explanation.

### Track 9: UI Surfacing

The workspace page should distinguish three states:

1. No operator evidence yet: show capture CTA.
2. Evidence captured but semantic workflow not ready: show extraction diagnostics and follow-up questions.
3. Business workflow draft ready: show canvas.

The user should be able to inspect:

- transcript snippets
- captured screen frames
- extracted business observations
- why a node exists
- what evidence supports a decision or exception
- what follow-up is needed
- semantic extraction diagnostics and grounding tier per node/edge

### Track 10: Full Evaluations

Add fixtures based on `frontend-mockups/map1.png` through `map7.png`.

Eval metrics:

- business step recall
- decision recall
- branch label correctness
- wait state recall
- exception loop recall
- role/system attribution
- evidence attribution
- technical artifact leakage rate
- quote grounding rate
- hallucinated evidence ID count
- unresolved topology target count
- semantic model cache hit rate, as a diagnostic metric only

Hard gate:

- `technical_artifact_leakage_rate = 0`
- `hallucinated_evidence_id_count = 0`
- `quote_grounding_rate = 1.0` for citations marked `quoted`
- `unresolved_topology_target_count = 0` for published graphs

Suggested new eval file:

- `otto-frontend/tests/phase2/operator-semantic-workflow-eval.test.ts`

Suggested fixture file:

- `evals/operator/business-workflow-fixtures.json`

The fixture work has two separate tasks:

1. Label expected graph JSON from the images.
2. Author evidence packs that should produce those graphs.

The scoring harness should support both exact structural checks and semantic step matching. Title recall should use normalized key phrases or a judge, because exact title matching will punish correct paraphrases.

### Track 11: Operational Diagnostics

Add structured audit events:

- `workflow.semantic_extraction.started`
- `workflow.semantic_extraction.cache_hit`
- `workflow.semantic_extraction.cache_miss`
- `workflow.semantic_extraction.completed`
- `workflow.semantic_extraction.degraded`
- `workflow.graph_translation.completed`
- `workflow.graph_translation.blocked`

Add synthesis stage outputs:

- `stage-2a-semantic-extraction`
- `stage-2b-semantic-merge`
- `stage-3a-semantic-enrichment-and-validation`
- `stage-4-graph-build`

This will make future blank or low-quality maps diagnosable without querying raw tables.

Semantic model persistence:

- Add `workflow_semantic_models` or equivalent persisted JSON rows keyed by `synthesis_run_id`, `process_id`, `version_id`, and `capture_session_ids`.
- Persist `evidence_pack_hash`, `prompt_template_id`, `prompt_template_version`, `model`, `llm_request_hash`, `llm_response_hash`, `semantic_model_hash`, `source_process_version_id`, and `cache_status`.
- Store raw LLM proposal, verified semantic model, diagnostics, grounding results, and verifier-derived confidence.
- Store only redaction-safe text. The evidence pack must mask or omit redacted transcript/document/screen spans before the LLM sees them.
- Link graph nodes/edges back to semantic step/edge IDs through metadata so the UI can explain why a node exists.

## Implementation Order

1. Complete ingestion gate: real transcript, frame extraction, OCR/vision, and UI warnings for missing providers.
2. Build minimal eval harness with 1-2 hand-labeled workflow maps and synthetic evidence packs.
3. Spike one LLM semantic extractor with typed JSON output, citations, and topology.
4. Implement semantic model cache keyed by redaction-safe `evidence_pack_hash`.
5. Add deterministic verifier: evidence IDs, source refs, quote spans, topology, technical leakage, inference flags.
6. Define semantic model types and persistence/stage outputs.
7. Implement long-capture window extraction and global stitching strategy.
8. Implement semantic consistency/enrichment checks for decision/wait/handoff/exception/workaround semantics.
9. Replace direct `taskSeedsFromPack` graph construction with verified semantic-to-graph translation.
10. Delete or quarantine the linear graph builder so it cannot publish runtime maps.
11. Add degraded semantic diagnostic UI for captures that lack transcript/OCR.
12. Expand eval fixtures from all map examples and tune prompts/thresholds against real captures.

## Acceptance Criteria

- A screenshare interview with narration produces business workflow nodes, not keyframe nodes.
- Missing transcription or OCR creates a diagnostic and follow-up task, not a fake map.
- Map examples can be represented with task, decision, wait, exception, and handoff nodes.
- Every graph node has evidence, confidence, and source references.
- Every quoted citation exists verbatim, normalized, or short-fuzzy-matched in the cited evidence/source row. Long quotes must pass contiguous normalized substring matching.
- Every published edge references real semantic step IDs and has evidence or an explicit inferred flag.
- One-branch decisions are either demoted to task/check steps or published with a low-confidence inferred branch plus a follow-up.
- Rerunning unchanged evidence reuses the cached verified semantic model and does not reshuffle graph topology.
- The workflow canvas never displays raw capture artifact labels.
- Evals pass with zero technical artifact leakage.
- Evals pass with zero hallucinated evidence IDs and zero unresolved published topology targets.
- Local dev clearly warns when transcription, OCR, or vision providers are unavailable.
