# Director Continuous Reconciliation Plan

**Status:** Proposed (v2 — incorporates Claude + Codex plan review, 2026-06-17)

**Context:** The director interview should behave like a rolling understanding
of the business, not a one-shot form fill. A director can clarify, correct,
split, merge, or add information at any point in the interview. Our current
process-inventory fix prevented a real production failure, but the discussion
exposed a broader design issue: we need continuous reconciliation across all
director slots, not only process names.

## Problem

The director agent currently mixes two concepts:

1. **What the director mentioned**
2. **What the system treats as durable current truth**

In the failed production session `71569919-775d-44bd-bd33-f5b6faf096f1`, the
director first gave a broad scope answer:

```text
I own everything from when a customer order comes in through getting it picked,
shipped, invoiced, plus purchasing and vendor payments.
```

Then they gave the actual process inventory:

```text
Six big ones: order intake, purchasing and replenishment,
vendor invoice processing, inventory cycle counts,
new customer onboarding and credit setup, and returns and credit memos.
```

The old behavior treated early scope words like `Shipping`, `Invoicing`, and
`Vendor Payments` as peer process candidates. The first repair gated candidate
creation more tightly so those scope verbs would not become durable candidates.
That was useful as a regression fix, but it is not the ideal long-term product
model.

The better model is:

```text
listen broadly
-> extract evidence-backed hypotheses
-> reconcile with current understanding
-> update durable state only after deciding create / merge / rename / demote / conflict
```

This should apply to processes and every other director slot.

## User-Visible Failure Modes

Without continuous reconciliation, users experience these failures:

- The agent makes up or over-promotes process names from broad narration.
- The agent ignores valid process information because it arrived outside the
  expected "inventory" moment.
- The agent cannot revise an earlier process list when the director clarifies
  mid-interview.
- Slots can be overwritten by later weak or ambiguous answers.
- Contradictions are not consistently preserved as conflicts.
- The agent repeats questions because its durable state is stale, polluted, or
  less nuanced than the transcript.

## Current Implementation

### Slot State

Director slot state is stored in `slot_states`.

Current important fields:

- `slot_path`
- `candidate_process_id`
- `value`
- `status`
- `confidence`
- `evidence_ids`
- `candidates`
- `last_asked_at`

Current statuses:

- `empty`
- `partial`
- `filled`
- `asked_unknown`
- `conflicting`
- `pending_re_extract`

Current behavior in
`otto-frontend/lib/interview/director/tools.ts:updateSlotState`:

- A slot can be inserted or updated across turns.
- Existing values are overwritten by the latest accepted slot update; the
  accepted write also **replaces** `evidence_ids` and `candidates` wholesale
  (`tools.ts` `updateSlotState`) — it does not merge them.
- A filled slot is protected from being downgraded by a non-answer or a lower
  confidence extraction. This guard (`shouldBlockSlotDowngrade`) **already
  ships**, and it only covers `filled`; `partial`/`conflicting` are freely
  overwritten.
- `partial`, `asked_unknown`, and `conflicting` slots can be refined later.
- There is **no** merge/preserve of prior evidence or prior candidate values
  today. Reconciliation introduces that as net-new behavior, not a tweak.

This means we have **basic slot revision**, but not a true reconciliation
system.

### Process State

Process candidates are stored in `candidate_processes`.

Current process behavior is more advanced than generic slots:

- `recordProcess` rejects implausible names.
- It locks the session for candidate reconciliation.
- It merges exact or token-subset related names.
- It can rename a weaker process name to a fuller compound name.
- It preserves merged evidence ids.
- It can block brand-new candidate creation when `allowNewCandidate === false`.

This is closer to the right pattern, but it is bespoke to process names and too
tightly tied to candidate creation gates.

## Desired Product Model

The director agent should continuously revise its understanding throughout the
interview.

Every new turn can produce:

- new facts
- corrections
- refinements
- conflicts
- aliases
- broader/narrower process names
- additions to the process inventory
- demotions from "top-level process" to "substep/detail"

The system should not ask, "Is this the one allowed moment to create state?"

It should ask:

```text
Given the current state and this new evidence, what is the correct durable state now?
```

## State Lifecycle

Use a common lifecycle for processes and slots:

```text
raw mention
-> extracted hypothesis
-> reconciled decision
-> durable current state
```

### Raw Mention

Something the director said.

Examples:

- `picked`
- `Salesforce`
- `daily`
- `Marcus`
- `returns`
- `manual credit holds`

### Extracted Hypothesis

The model believes the mention may update a known field.

Examples:

- possible process: `Shipping`
- possible system: `Salesforce`
- possible frequency: `daily`
- possible owner: `Marcus`
- possible pain point: `manual credit holds`

Hypotheses should be evidence-backed and cheap to store or trace.

### Reconciled Decision

A deterministic or LLM-assisted reconciler compares the hypothesis to current
state and chooses an action.

Actions:

- `create`
- `confirm`
- `enrich`
- `merge`
- `rename`
- `demote`
- `correct`
- `conflict`
- `ignore`
- `needs_clarification`

### Durable Current State

Only reconciled state should drive:

- focus rotation
- process switching
- coverage scoring
- "already answered" checks
- synthesis
- downstream process promotion

## Target Architecture

Introduce a director reconciliation layer between extraction and durable writes.

```text
director utterance
-> extraction model emits hypotheses
-> reconciler reads current state + recent evidence
-> reconciler emits state actions
-> dispatcher applies durable writes
-> trace records extraction, reconciliation, and write results
```

## Proposed Data Model

### Minimal v1: No New Tables

Start by using existing tables:

- `slot_states.value`
- `slot_states.status`
- `slot_states.evidence_ids`
- `slot_states.candidates`
- `candidate_processes`
- `claims`
- `claim_evidence`
- `audit_log`
- `follow_up_tasks`
- `agent_decision_log`

Store reconciliation decisions in:

- `agent_decision_log.delivery_json.reconciliation`
- `audit_log` events for durable changes
- `slot_states.candidates` for alternative/conflicting slot values

This keeps implementation small and avoids a migration-heavy first step.

### Later: Add Hypothesis / Revision Tables

If we need better inspectability, add:

```text
director_extracted_hypotheses
director_reconciliation_decisions
slot_state_revisions
candidate_process_revisions
```

Do this only after the minimal approach proves useful.

## Reconciliation Actions

### Processes

Process-specific actions:

- `create_candidate`: new top-level candidate process
- `merge_candidate`: incoming process is the same as an existing candidate
- `rename_candidate`: incoming name is the better canonical display name
- `demote_to_candidate_detail`: incoming phrase is not a top-level candidate;
  retain its evidence as a detail/claim on the parent candidate (or as
  session-scoped scope evidence if no parent exists — Phase 0.3)
- `discard_as_junk`: incoming phrase is not a process
- `needs_clarification`: not enough evidence to decide

Example from the incident:

| Incoming mention | Reconciled action |
|---|---|
| `Order Picking` | demote to candidate detail under `Order Intake` (Phase 0.3) |
| `Shipping` | demote to candidate detail under order fulfillment/intake context |
| `Invoicing` | demote or reconcile with `Vendor Invoice Processing`, depending on evidence |
| `Purchasing` | merge/rename into `Purchasing And Replenishment` |
| `Vendor Payments` | reconcile against `Vendor Invoice Processing` or keep as separate only if later evidence supports it |
| `Returns` | merge/resolve to `Returns And Credit Memos` |

### Generic Slots

Generic slot actions:

- `fill_empty`: empty slot receives new value
- `confirm_existing`: new evidence supports current value
- `enrich_existing`: add detail without replacing old value
- `replace_with_correction`: director clearly corrected prior value
- `mark_conflicting`: new value contradicts current value without clear correction
- `merge_values`: slot supports multiple true values
- `ignore_non_answer`: director did not answer the slot
- `ask_clarification`: model cannot safely resolve the difference

Examples:

| Slot | Existing | New evidence | Reconciled action |
|---|---|---|---|
| `frequency.volume` | `weekly` | `Actually daily during month-end` | enrich or conflict depending wording |
| `systems.systems_of_record` | `Salesforce` | `NetSuite handles invoicing` | merge values, not replace |
| `ownership.roles` | `VP Ops` | `Customer service owns intake` | enrich if scoped to process, conflict if same scope |
| `friction.pain_points` | `manual entry` | `approval delays` | merge values |
| `metrics.kpis` | `cycle time` | `we also track error rate` | merge values |

## Ambiguity And Conflict Handling

Ambiguity must become first-class state. The reconciler should not silently pick
one interpretation when the evidence supports multiple plausible meanings.

Default rule:

```text
new value conflicts with existing value
-> check whether wording clearly signals correction, addition, or scope split
-> if clear, reconcile automatically
-> if unclear, preserve both values, mark unresolved, and ask a targeted clarification
```

### Correction Vs Addition Vs Scope Split

The reconciler should classify an apparent conflict into one of these cases:

| Case | Signal | Action |
|---|---|---|
| Correction | "Actually", "I meant", "replace that", "not X, Y" | Replace current value, preserve prior value in `candidates`/audit history |
| Addition | "Also", "plus", "we also use", "another team" | Merge value if slot is list-like; enrich if slot is descriptive |
| Scope split | "For invoicing", "day-to-day", "overall owner", "during month-end" | Preserve both values with scope metadata if possible |
| True conflict | Values disagree and no scope/correction signal is clear | Mark `conflicting` or `needs_clarification` |

### Required Stored State

For ambiguous/conflicting slots, durable state should preserve:

- current best value, if one exists
- alternate candidate values
- evidence ids for each value
- conflict reason
- clarification question
- unresolved/resolved status

Use existing fields in v1:

- `slot_states.status = 'conflicting'` or `partial`
- `slot_states.value` for the current best value or structured multi-value state
- `slot_states.candidates` for alternate values and evidence
- `follow_up_tasks` for unresolved clarification work when needed
- `agent_decision_log.delivery_json.reconciliation` for the decision trace

### Examples

| Situation | Reconciler action | Agent clarification |
|---|---|---|
| System changes from `Salesforce` to `NetSuite` | Preserve both. If no wording says replacement or addition, mark unresolved/conflicting. | "Is NetSuite replacing Salesforce here, or are they used for different parts of the process?" |
| Frequency changes from `weekly` to `daily` | If wording says "actually daily", correct. If wording says "daily during month-end", enrich. Otherwise mark conflicting. | "Should I treat this as daily overall, or weekly with daily spikes during month-end?" |
| Owner changes from `VP Ops` to `Customer Service` | Preserve both. Decide whether this is executive owner vs day-to-day owner only if wording makes scope clear. | "Is Customer Service the day-to-day owner while VP Ops owns it overall, or should I replace VP Ops with Customer Service?" |

### Steering Implication

Unresolved ambiguity should affect the next question. A `conflicting` or
`needs_clarification` slot should outrank generic next-topic questions unless
the director explicitly asks to move on.

The agent should prefer:

```text
"I heard two possibilities here. Is it X, Y, or are both true in different parts of the process?"
```

over silently continuing as if the slot were settled.

## Technical Implementation Plan

### Phase 0: Foundations (Blocking)

Settle the decisions below before any reconciliation code. Two are design
blockers that gate the code in Phases 2-3; the other four are invariants that
need to be written down once and then enforced — not iterated on. This section
supersedes the draft "Slot Policy" table below wherever they disagree.

Lean checklist:

1. Blocking design — slot taxonomy + durable source of truth (0.1).
2. Blocking design — reconciler inputs + safe creation floor (0.2).
3. Phase 3 blocker — concrete demotion storage (0.3).
4. Invariant — reconciliation cannot block voice latency (0.4).
5. Invariant — traces must be bounded (0.5).
6. Invariant — acknowledged unresolved conflicts count as covered for flow but
   remain follow-up tasks (0.6).

#### 0.1 Slot taxonomy and durable source of truth (blocks Phase 2)

Reconciliation verbs (`merge`, `conflict`, `enrich`) are undefined until each
slot path is classified by *where its durable truth lives*. Today that is not
uniform: most slots are projections of the `claims`/entity tables, not the slot
value.

| Class | Slot paths | Durable truth | Reconciliation primitive |
|---|---|---|---|
| Candidate-backed | `process.inventory` | `candidate_processes` rows | process reconciler (Phase 3) |
| Claim-backed | `systems.systems_of_record`, `ownership.roles`, `people.key_people`, `friction.pain_points`, `risk.spofs`, `metrics.kpis`, `handoffs.dependencies` | `claims` rows (`recordSystem`/`recordRole`/`recordPerson`/`recordPainPoint`/`recordSpof`/`recordCandidateProcessClaim` with field `kpi`/`upstream_dependency`/`downstream_dependency`) | merge happens in the claim layer; `slot_states` holds only coverage/probe summary |
| Slot-state-backed | `function.name`, `scope.boundaries`, `outcomes.business_outcomes`, `frequency.volume`, `controls.compliance`, `documentation.maturity`, `priority.executive_priority`, `variants.exceptions` | `slot_states.value` | per-kind compare/merge in `reconcileSlotUpdate` |

Claim-backed is the **majority** class — it is not just systems/roles/people;
pain points, SPOFs, KPIs, and dependencies are all claim-backed. For every
claim-backed path, to avoid two divergent truths:

```text
claims table = durable truth
slot_states  = coverage / probe / summary state only
```

`reconcileSlotUpdate` must not invent a second merged list inside
`slot_states.value` for a claim-backed path; it summarizes what the claim layer
already reconciled.

Deliverable: a `slotValueKind(slotPath)` classifier living next to
`slot-schema.ts`, plus per-kind compare/merge helpers for the slot-state-backed
scalars and structured objects.

#### 0.2 Reconciler inputs and the safe creation floor (blocks Phase 3)

Process creation stays **asymmetric**: reconciliation is *additive on top of*
the deterministic gate, never a replacement that lowers the bar.

```text
Create a durable candidate process if EITHER:
  1. the deterministic high-precision inventory signal allows it
     (promptingIntent === "discover_processes" OR >= 2 explicitly enumerated
     names — brain.ts ~2325), OR
  2. the reconciler sees a high-confidence *new* mid-interview process with
     corroborating evidence (e.g. "actually, we also have a separate warranty
     claims process").
```

Reconciliation must **not** make non-enumeration scope narration easier to
mint. This preserves the `71569919` fix while adding mid-interview additions.
The model is "safe creation floor + additive reconciler", **not** "replace the
gate with a confidence score" — a confident-sounding turn-0 scope sentence must
still not mint phantom candidates.

Required reconciler inputs (prompting context is first-class evidence, not just
current state):

- current durable state (candidates + slots)
- incoming hypotheses with evidence ids
- prompting context for the turn (which prompt the director actually answered)
- recent transcript context
- name plausibility (`isPlausibleCandidateProcessName`)
- allowed actions

#### 0.3 Demotion storage (blocks Phase 3 demotion)

`demote_to_candidate_detail` gets exactly one concrete v1 meaning. There is no
director-layer substep table (steps are an operator-layer concept), and a
follow-up note is not queryable enough for later promotion, so:

```text
demotion =
  no candidate_processes row
  + retain the evidence as a claim/detail on the PARENT candidate
    (claim subject = candidate_process, the parent's id)
  + if no parent candidate exists yet, record the mention in the
    process.inventory slot's `candidates` array (candidateProcessId = null) as a
    non-promoted entry { name, evidence_ids, reason }; the evidence rows
    themselves already persist and stay queryable
```

Demotion must be **reversible**: if later evidence promotes the phrase to a real
process, the reconciler finds the retained, queryable evidence and creates the
candidate then. No follow-up-note path as primary storage. The no-parent
`slot_states.candidates` target is a **temporary** v1 home; once the
hypothesis/revision tables land (see "Later: Add Hypothesis / Revision Tables")
demoted-unattached mentions move there, so `slot_states.candidates` does not
become a junk drawer.

#### 0.4 Invariant: reconciliation never blocks voice latency

This is a real-time voice interview; extraction is already deliberately
decoupled from speech. All reconciliation — deterministic and **especially** the
Phase 4 LLM reconciler — runs on the async extraction/dispatch path inside the
turn transaction. It must never block probe phrasing, or we reintroduce the
planner-timeout / turn-split latency class we already worked around.

#### 0.5 Invariant: traces are bounded

`agent_decision_log.delivery_json` is re-read on the next turn
(`checkerVerdictSignalFromDeliveryJson`). The reconciliation blob must be bounded
(cap decision count; store evidence ids + short rationale, not full transcript
spans) or move to the dedicated revision tables sooner than "later".

#### 0.6 Invariant: acknowledged unresolved conflicts count as covered

Many reconcilable slots are `mustFire` (`function.name`, `process.inventory`,
`scope.boundaries`, `outcomes.business_outcomes`, `ownership.roles`,
`systems.systems_of_record`). If a clarification fires, the director stays
ambiguous, and the slot remains `conflicting`, the interview must not re-ask
forever. Distinguish two states:

```text
unasked conflict       -> ask the targeted clarification (once)
acknowledged conflict  -> counts as covered for rotation/completion,
                          still emits a human follow-up task
```

Coverage/rotation (`brain.ts` ~6256) must treat an acknowledged-unresolved
conflict as satisfied for flow, never as an unfilled `mustFire` slot.

### Phase 1: Define Reconciliation Contracts

Create typed reconciliation outputs.

Suggested types:

```ts
// Emitted by the extraction model (it has full transcript context) and consumed
// by the reconciler — see Open Question #3. Avoids regex-matching correction
// wording in downstream deterministic code.
type DirectorSlotChangeKind =
  | "new"          // slot is being populated for the first time
  | "restate"      // same fact restated; confirm / no-op
  | "correction"   // director is replacing the prior value
  | "addition"     // director is adding another true value
  | "scope_split"; // both values are true but for different scopes

type DirectorExtractedSlotHypothesis = {
  slotPath: string;
  candidateProcessId?: string;
  value: unknown;
  changeKind: DirectorSlotChangeKind;
  confidence: number;
  evidenceIds: string[];
};

type DirectorReconciliationAction =
  | "create"
  | "confirm"
  | "enrich"
  | "merge"
  | "rename"
  | "demote"
  | "correct"
  | "conflict"
  | "ignore"
  | "needs_clarification";

type DirectorSlotReconciliationDecision = {
  slotPath: string;
  candidateProcessId?: string;
  action: DirectorReconciliationAction;
  value?: unknown;
  previousValue?: unknown;
  confidence: number;
  evidenceIds: string[];
  changeKind?: DirectorSlotChangeKind;
  rationale: string;
  followUpQuestion?: string;
};

type DirectorProcessReconciliationDecision = {
  incomingName: string;
  action:
    | "create_candidate"
    | "merge_candidate"
    | "rename_candidate"
    | "demote_to_candidate_detail"
    | "discard_as_junk"
    | "needs_clarification";
  targetCandidateProcessId?: string;
  canonicalName?: string;
  confidence: number;
  evidenceIds: string[];
  rationale: string;
};
```

Acceptance:

- Reconciliation decisions are included in `agent_decision_log`.
- Every durable state write can be traced back to a reconciliation decision.

### Phase 2: Generalize Slot Writes

Replace direct "latest update wins" behavior with a reconciled update helper.
The filled-slot downgrade guard (`shouldBlockSlotDowngrade`) **already ships** —
Phase 2 *generalizes* it (merge evidence, preserve prior candidates, extend
protection beyond `filled`); it does not introduce it. Slot kind comes from
Phase 0.1, and claim-backed slots merge in the claim layer, not in
`slot_states.value`.

Add:

```ts
reconcileSlotUpdate(existingSlot, incomingUpdate, transcriptContext)
```

Initial deterministic behavior:

- If existing is empty: fill.
- If incoming is non-answer: ignore.
- If existing is filled and incoming confidence is lower: ignore unless the
  incoming wording is an explicit correction.
- If slot is a *slot-state-backed* list-like value: merge unique values. (For
  claim-backed slots the merge happens in the claim/entity layer — Phase 0.1 —
  not in `slot_states.value`.)
- If slot is scalar and incoming clearly differs: mark `conflicting` unless the
  director used correction language.
- Preserve previous candidates in `slot_states.candidates`.
- Merge evidence ids instead of replacing them.

Do not add an LLM reconciler here first. Start deterministic and only use LLM
where code cannot reliably decide.

Acceptance:

- Filled slots are not clobbered by weak later answers.
- List-like slots accumulate values.
- Contradictory scalar values become `conflicting` with both candidates stored.
- Clear corrections replace the current value but preserve prior value in
  candidates/audit history.

### Phase 3: Layer Process Reconciliation On The Safe Creation Floor

Move from "can this turn mint a candidate?" to "what should this process-like
mention become?"

New behavior (creation follows the **safe floor + additive reconciler** rule
from Phase 0.2 — the deterministic gate stays as a precision floor; the
reconciler may only *add* creations, never lower the bar):

- Extract process-like mentions broadly.
- Feed mentions plus existing candidates into `reconcileProcessMentions`.
- Allow creation when the deterministic floor allows it (Phase 0.2), or when
  reconciliation classifies the mention as a high-confidence new top-level
  process with corroborating evidence.
- Allow mid-interview additions when evidence supports a new top-level process.
- Demote scope verbs into candidate detail / scope evidence (Phase 0.3) instead
  of losing them entirely.

This preserves the original bug fix's safety — the deterministic floor stays —
while adding reconciled mid-interview creation on top of it.

Acceptance:

- Turn 0 scope phrases from `71569919` do not become focus candidates.
- Those phrases can still be preserved as candidate detail / scope evidence
  (Phase 0.3).
- Turn 1 creates the six real inventory candidates.
- Mid-interview new process additions are supported.
- Mid-interview refinements can merge or rename existing candidates.

### Phase 4: Add LLM Reconciler For Ambiguous Cases

Use an LLM only when deterministic rules cannot decide safely.

Good LLM-reconciler cases:

- Is `Vendor Payments` distinct from `Vendor Invoice Processing` in this
  transcript?
- Did the director correct the frequency or add a seasonal exception?
- Is `Shipping` a top-level process or a substep in this business context?

The LLM reconciler should return structured JSON only. It should receive:

- current durable state
- incoming hypotheses
- evidence snippets
- recent transcript context
- allowed actions

It should not directly write DB rows.

Acceptance:

- LLM reconciliation decisions are logged.
- Deterministic guards still validate writes.
- Ambiguous decisions can produce `needs_clarification` instead of guessing.

### Phase 5: Let Reconciled State Drive Conversation

Update steering so only reconciled durable state drives:

- focus candidate selection
- named process switching
- next-process rotation
- coverage scoring
- "already answered" detection
- follow-up question selection

Raw mentions should inform context, but not control interview state.

Acceptance:

- The agent does not rotate into demoted mentions.
- The agent can switch to newly added mid-interview candidates after
  reconciliation.
- The agent avoids asking for slots that are filled, confirmed, or recently
  answered.
- The agent asks clarification when a slot is conflicting or unresolved.

## Efficiency Strategy

Continuous reconciliation does not mean rerunning a full expensive pass every
turn.

Use triggers:

- incoming extraction includes new process-like mentions
- incoming slot value differs from existing slot value
- incoming answer contains correction language
- incoming answer contains multiple candidate values for one slot
- director requests a process switch to an unknown name
- before focus rotation if candidate list changed

Use cheap deterministic reconciliation first:

- exact match
- token subset/superset
- list merge
- non-answer detection
- confidence comparison
- explicit correction phrases
- scalar-vs-list slot policy

Only call the LLM reconciler for ambiguous cases.

## Slot Policy

Define slot behavior by type. **Phase 0.1's taxonomy is the source of truth for
where each slot's durable state lives** (candidate-backed / claim-backed /
slot-state-backed); this table is the per-slot *reconciliation* default and must
stay consistent with it. In particular the "list-like" rows below
(`systems.systems_of_record`, `ownership.roles`, `friction.pain_points`,
`risk.spofs`, `metrics.kpis`) are **claim-backed** — their durable merge happens
in the claim layer and the slot holds only summary/coverage state.

| Slot type | Examples | Default reconciliation |
|---|---|---|
| Scalar identity | `function.name` | slot-state; correction or conflict |
| Process inventory | `process.inventory` | candidate; process reconciler |
| Boundary text | `scope.boundaries` | slot-state; enrich/replace if correction |
| List-like entities | `systems.systems_of_record`, `ownership.roles`, `people.key_people` | claim-backed; merge in claim layer |
| List-like problems | `friction.pain_points`, `risk.spofs` | claim-backed; merge in claim layer |
| Metrics | `metrics.kpis` | claim-backed; merge in claim layer |
| Dependencies | `handoffs.dependencies` | claim-backed; merge in claim layer |
| Frequency/volume | `frequency.volume` | slot-state; enrich if exception, conflict if incompatible |
| Outcomes | `outcomes.business_outcomes` | slot-state; merge/enrich |

This policy should live near `slot-schema.ts` or `slot-values.ts`, not scattered
through prompt text.

## Trace And Debugging Requirements

Every reconciliation run should be inspectable in one table view.

Trace fields to add to `agent_decision_log.delivery_json`:

```json
{
  "reconciliation": {
    "slot_decisions": [],
    "process_decisions": [],
    "ambiguous_cases": [],
    "llm_reconciler_used": false
  }
}
```

Each decision should include:

- incoming value/name
- previous value/name
- action
- target slot/candidate
- evidence ids
- confidence
- rationale
- write result

Bounds (Phase 0.5): at most 10 slot decisions and 10 process decisions per turn;
rationale capped at 240 chars; evidence ids only, never full transcript
excerpts. Overflow is counted, not stored inline.

This lets us debug:

- what the model heard
- what the reconciler decided
- what was persisted
- why the agent asked the next question

## Evals

Add or update evals in `docs/evals.md`.

Required regression evals:

1. `71569919` replay:
   - turn 0 scope phrases do not become focus candidates
   - turn 1 six real processes are created
   - process switching to `Returns And Credit Memos` succeeds
2. Mid-interview process addition:
   - director introduces a new valid process after several turns
   - reconciler creates it
   - agent can switch/rotate to it
3. Mid-interview process refinement:
   - director says `Purchasing`
   - later clarifies `Purchasing And Replenishment`
   - one candidate remains with fuller name and merged evidence
4. Slot correction:
   - director says weekly, later says actually daily
   - slot is corrected or marked conflicting based on wording
5. List-like slot enrichment:
   - systems, pain points, or KPIs accumulate rather than overwrite
   - graded from `claims` / entity tables (the durable truth for claim-backed
     slots — Phase 0.1), not from `slot_states.value`
6. Non-answer protection:
   - weak/non-answer does not clobber a filled slot

Graders:

- Code graders for persisted state and tool/write actions. For claim-backed
  slots assert against `claims` / entity tables; for slot-state-backed slots
  assert against `slot_states.value` (Phase 0.1).
- LLM judge for conversational quality:
  - did the agent avoid repeated answered questions?
  - did it ask clarification when state was conflicting?
  - did it naturally acknowledge corrections?

## Open Questions

1. Should raw hypotheses be persisted immediately or only logged in
   `agent_decision_log` until we add hypothesis tables?
2. ~~Which slot paths are scalar vs list-like vs process-specific?~~ **Resolved
   by Phase 0.1** (candidate-backed / claim-backed / slot-state-backed taxonomy).
3. ~~What exact wording counts as an explicit correction?~~ **Promoted to a
   Phase 1 contract**: the extraction model emits a structured `change_kind`
   (`new`/`restate`/`correction`/`addition`/`scope_split`) per slot hypothesis
   rather than regex-matching transcript text downstream. Extraction already has
   full context, and this shrinks the need for a separate Phase 4 LLM call. See
   the `DirectorSlotChangeKind` contract in Phase 1.
4. ~~Should demoted process mentions become provisional steps, candidate claims,
   or slot evidence?~~ **Resolved by Phase 0.3** (claim/detail on parent
   candidate, or session-scoped scope evidence; reversible; no follow-up-note
   path).
5. When should the agent proactively confirm a reconciliation decision with the
   director? (Still open — product call.)

## Recommended Next Step

Do not rewrite everything at once.

Start with a small vertical slice:

1. Add reconciliation decision types and trace logging.
2. Generalize `updateSlotState` to merge evidence and preserve prior candidates.
3. Add slot policies for scalar vs list-like slots.
4. Layer process reconciliation on the safe creation floor (Phase 0.2 / Phase 3)
   for the `71569919` replay plus one mid-interview process-addition fixture.

That gives us the product behavior we want without turning every turn into a
large, expensive LLM reconciliation pass.
