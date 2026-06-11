# BUG_FIXES — Director Interview Quality

Source: live demo run of the director voice interview on 2026-06-09
(capture session `251a4914-9f45-4538-95fb-8fa664884a06`, prod DB). The run
surfaced six distinct defects. Each task below is self-contained: context,
problem, evidence from the session, desired outcome, solution, and
implementation detail.

Shared architecture context (applies to all tasks): the director interview runs
the `steered_cascade` runtime. Per user turn: (1) `buildDirectorSteeringPlan`
([otto-frontend/lib/interview/director/brain.ts:300](../otto-frontend/lib/interview/director/brain.ts))
builds a **deterministic** plan from committed DB state (slot_states, interview_state,
candidate_processes) in ~50ms and picks one probe intent; (2)
`phraseDirectorSteeringTurn` (brain.ts:402) has the voice model (Haiku,
`DIRECTOR_VOICE_MODEL` → `FAST_VOICE_MODEL`) phrase the spoken utterance, which
TTS speaks immediately; (3) `/extract` runs the heavy Sonnet structured
extraction async (1.8–25s observed) which writes slots/claims/entities via
`dispatchDirectorTurnPlan` (brain.ts:893). An async post-hoc output checker
(brain.ts:~1590) reviews the spoken utterance after delivery.

---

## Task 1 — Phraser directive + YAML anchors (ask the planned question)

### Context
The deterministic steering plan picks the right probe intent nearly every turn,
but the spoken question is generated free-form by the Haiku phraser. The probe
library `probes/director.yaml` contains canonical `phrasings` per intent, loaded
by [otto-frontend/lib/interview/director/probe-library.ts:174](../otto-frontend/lib/interview/director/probe-library.ts)
— but those phrasings never reach the phraser.

### Problem
The phraser ignores the chosen intent. Two causes:

1. `steering_context.next_objective` is set to `chosenIntent.reason`
   (brain.ts:~373) — a **status** string like "High-level process inventory is
   partial", not an instruction. The phraser can't act on a status report.
2. The whole steering context is serialized as a JSON blob appended as a
   pseudo-turn (`Steering: ${JSON.stringify(...)}` in
   `phraseDirectorSteeringTurn`, brain.ts:402–425). A fast model weights
   conversational momentum over an unlabeled JSON blob, and
   `prompts/director.voice.phrase-intent.md` gives no hard rule that the
   question MUST target the chosen intent.

### Evidence
In the demo session, the plan chose `discover_processes` ("No process inventory
is captured yet", target `process.inventory`) on turn 0 and again on turns
5,6,8,10,11,12 — **eight turns**. The phraser never once asked it; it produced
L4 drill-downs instead ("walk me through the first thing your team does",
"what are the main steps Marcus is working through"). The director-level breadth
sweep never happened; the user volunteered the second process themselves.

### Desired outcome
The spoken question always targets the chosen intent's slot. Wording stays
natural and contextual, but topic/altitude fidelity is enforced. If the same
intent is chosen twice without its slot filling, the agent speaks a canonical
YAML phrasing verbatim.

### Solution
- Convert `next_objective` from the reason string into an **imperative
  directive** generated per intent (e.g. `discover_processes` → "Ask the
  director what other recurring processes their team owns. Do not drill into
  steps of a single process.").
- Pass the chosen probe's `phrasings` from `probes/director.yaml` into the
  phrase prompt as anchor examples ("adapt one of these to the conversation").
- Restructure the phrase input so the directive is a labeled, prominent section
  of the prompt, not a JSON pseudo-turn.
- Escalation: if the same intent has been chosen ≥2 consecutive turns and its
  target slot is still `empty`/`partial`, bypass the phraser's freedom and
  instruct it to use the canonical phrasing verbatim (acknowledgment may still
  be generated).

### Implementation detail
- `otto-frontend/lib/interview/director/brain.ts`
  - In `buildDirectorSteeringPlan`: add an `intentDirective(chosenIntent)`
    mapping (intent id → imperative sentence; derive from probe-library
    metadata so new probes get directives automatically). Add
    `anchor_phrasings: string[]` to `steering_context`, looked up from
    `probe-library.ts` by chosen intent/probe id. Add
    `consecutive_intent_count` (compare against `interview_state.prior_intent`,
    or count recent `probe_firings` rows for the probe id) and a
    `verbatim_required: boolean` flag when ≥2.
  - In `phraseDirectorSteeringTurn`: stop appending the steering context as a
    JSON pseudo-turn. Pass directive, anchors, do_not_ask, and verbatim flag as
    explicit prompt sections.
- `otto-frontend/lib/interview/director/probe-library.ts`: export a lookup
  `probePhrasingsForIntent(intent: string): string[]`.
- `prompts/director.voice.phrase-intent.md`: add hard rules — "Your question
  MUST target the stated objective. The anchor phrasings show what to ask;
  adapt wording, never the target. If `verbatim_required`, speak an anchor
  phrasing verbatim after a brief acknowledgment. Director interviews stay at
  process level: never ask for step-by-step detail; if the director defers to
  an operator, acknowledge and move to the next objective."
- Mirror the same change for the operator phraser
  (`prompts/operator.voice.phrase-intent.md`, `probes/operator.yaml`,
  `otto-frontend/lib/interview/operator/brain.ts`) — same architecture, same
  latent bug.

---

## Task 2 — Cooldown + provisional-answer enforcement (don't re-ask answered questions)

### Context
The steering plan is computed from **committed** slot state, but slots are
written by the async extraction (1.8–25s). Users answer faster than extraction
commits, so plan N+1 often runs on state that excludes turn N's answer.
`probes/director.yaml` defines `cooldown_seconds` and `max_fires` per probe,
and `probe_firings` records every firing. The respond route already threads
`pending_extraction_turns` / `pending_slot_paths` into the plan
([otto-frontend/app/api/internal/director-turns/respond/route.ts:93](../otto-frontend/app/api/internal/director-turns/respond/route.ts)),
but they only land in the phraser's `do_not_ask` list — they do not constrain
the deterministic intent chooser.

### Problem
1. **Stale-state repeats:** the intent chooser re-selects probes whose answers
   are in-flight in a pending extraction.
2. **Cooldowns not enforced:** the YAML cooldown/max_fires policy is not
   binding in `deterministicTurnPlan`.

### Evidence
`capture_outcome` fired on turns 2, 3, and 4 — three firings in 65 seconds
(timestamps 21:41:32, 21:42:01, 21:42:36), each with
`resolved_status_after: empty`, while the user was actively answering the
outcome question (extraction for those turns took 11–19s). The user eventually
said "I already told you it was just Marcus" and "I literally already told you."

### Desired outcome
A probe that was asked and substantively answered is not re-asked while its
extraction is pending. Cooldown/max_fires from the YAML are hard constraints.
No added speech latency, no requirement that extraction get faster.

### Solution
**Provisional-answer guard:** when probe X fired at turn N and the user's reply
was substantive (non-trivial length, not classified `dont_know`/`non_answer`),
treat X's target slot as *provisionally answered* until the turn-N extraction
commits. The chooser skips it and selects the next-priority intent. If
extraction later leaves the slot empty, the probe becomes eligible again.
**Deterministic cooldown:** filter candidate intents by
`cooldown_seconds`/`max_fires` against `probe_firings` before ranking.

### Implementation detail
- `otto-frontend/lib/interview/director/brain.ts`
  - `deterministicTurnPlan` (called from `buildDirectorSteeringPlan`,
    brain.ts:325): accept and apply two new exclusion inputs:
    `provisionallyAnsweredSlots: string[]` and probe-firing summaries.
  - Build `provisionallyAnsweredSlots` from `pendingSlotPaths` +
    `probe_firings` rows whose turn's extraction has not committed (join
    against `director_extraction_windows` / `agent_decision_log` stage
    `director.extraction` per turn) + a substantive-reply check on the turn
    transcript.
  - Reuse `readProbeFiringSummaries` (already used by
    `applyDirectorController`, brain.ts:2907) inside the steering path; enforce
    `cooldown_seconds`/`max_fires` from `probe-library.ts` as a hard filter,
    with `exhaustedProbeEscalation` (brain.ts:3305) as the fallback when all
    candidates are filtered.
  - Extend `do_not_ask` to include the last 2–3 asked questions (verbatim
    utterances from `recent_turns`) so the phraser also avoids re-asking
    paraphrases.
- `otto-frontend/app/api/internal/director-turns/respond/route.ts`: verify the
  client actually populates `pending_extraction_turns`/`pending_slot_paths`
  (the LiveKit worker in `agents/director/` supplies them); if not, derive
  server-side from uncommitted extraction turns for the session.
- Same enforcement in the operator brain
  (`otto-frontend/lib/interview/operator/brain.ts`, `probes/operator.yaml`).

---

## Task 3 — Don't store non-answers as slot values

### Context
The Sonnet extraction (`director.turn.extract`,
`planDirectorTurnWithExtractionPlanner`, brain.ts:~426–560) writes slot values
with statuses (`filled`/`partial`/`asked_unknown`/...) and confidences. Prompt
rules say don't-know answers mark the slot `asked_unknown`, and inferred facts
must have `confidence <= 0.45` with `metadata.inferred = true`.

### Problem
The extractor stores verbatim non-answers as high-confidence filled slots, and
the inferred-confidence cap is not enforced anywhere in code.

### Evidence (all from the demo session's `slot_states`)
- `friction.pain_points` = **filled, conf 0.78**, value:
  `{"pain_point": "Not sure. You would have to ask him, but I think he there's also some manual work. That happens. When we hit exceptions and things like that."}`
  — a don't-know answer stored verbatim as the department's pain point. It
  rendered in the Operations Notes panel as a "filled" note during the demo.
- `risk.spofs` = partial, `inferred: true`, **conf 0.72** — violates the
  inferred ≤ 0.45 rule.
- `scope.boundaries` = **filled** with only `{"process_names": ["Order Intake"]}`
  while the user's actual start/end conditions ("starts when an order email
  lands… done once it's in Odoo, confirmed, released") were never stored.

### Desired outcome
Non-answers never become slot values: a don't-know reply marks the slot
`asked_unknown` (which also redirects the planner via the existing
`pivot_from_unknown` styling). Inferred values are capped at 0.45 by code, not
by prompt hope. `filled` status requires the value to actually satisfy the
slot's expected shape.

### Solution
Add a deterministic post-extraction normalization pass (extend
`normalizeSlotExtractionEvidence`, brain.ts:795) that:
1. Detects non-answer values — value text matching don't-know patterns
   ("not sure", "you'd have to ask", "I don't know", …) or utterance_type
   `dont_know`/`non_answer` for the source turn — and converts the update to
   `status: asked_unknown`, value dropped.
2. Clamps confidence to 0.45 when `metadata.inferred === true` (and sets
   `inferred: true` when confidence-vs-evidence heuristics demand it).
3. Demotes `filled` → `partial` when the value is missing required components
   for that slot path (e.g. `scope.boundaries` without start/end conditions) —
   per-slot shape expectations live in
   `otto-frontend/lib/interview/director/slot-schema.ts`.

### Implementation detail
- `otto-frontend/lib/interview/director/brain.ts`: implement the three rules in
  `normalizeSlotExtractionEvidence` (it already normalizes evidence ids — same
  seam). Unit-test with the exact pain_points payload from the session.
- `otto-frontend/lib/interview/director/slot-schema.ts` /
  `slot-values.ts`: add per-slot "filled requires" shape hints (start with
  `scope.boundaries`, `friction.pain_points`, `outcomes.business_outcomes`).
- Prompt reinforcement (cheap, secondary): in the extraction tool description /
  `prompts/director.turn.plan.md`, state explicitly that quoting a refusal or
  uncertainty as a slot value is forbidden.
- Mirror in the operator extraction path (`operator.turn.plan`,
  `otto-frontend/lib/interview/operator/brain.ts`) — same slot mechanics.

---

## Task 4 — Output checker: fix the crash, then close the loop

### Context
After each spoken turn, an async checker reviews the utterance against the
steering context (`director.voice.output-checker`, brain.ts:~1590) and records
the verdict via `recordDirectorOutputCheck` (flags
`unsupported claims / repeated questions / ignored steering / multiple
questions / verbosity`). It is post-hoc by design (never blocks speech). It is
the safety net that should have caught Task 1's disobedience.

### Problem
1. **The checker crashes on 100% of turns.** Template id
   `director.voice.output-checker` matches the `director.voice.` prefix in
   [otto-frontend/lib/ai/models.ts](../otto-frontend/lib/ai/models.ts)
   (`anthropicModelForPrompt` / `anthropicMaxTokensForPrompt`), so it inherits
   the voice phraser's budget: **max_tokens 200**. A verdict JSON with a
   `violations[]` array cannot fit in 200 tokens → `stop_reason: max_tokens` →
   `StructuredOutputError` → catch → `checker_status: "failed"`. Every
   `director.turn` row in the session is `degraded: ["output_checker_failed"]`.
   It is also on the weakest output path (free-text "Return JSON only", no
   tool — see Task 6).
2. **Even when working, the verdict goes nowhere operationally** — it writes
   `delivery_json` + a follow-up task, but the next turn's steering never sees
   it, so a one-turn drift can become an eight-turn drift (and did).

The operator checker (`operator.voice.output-checker`,
`otto-frontend/lib/interview/operator/brain.ts:~583`) has the identical
routing collision — it will fail the same way in operator interviews.

### Desired outcome
The checker runs successfully, and an "ignored steering" or "repeated/stale
question" verdict on turn N changes turn N+1's behavior (escalating to
verbatim-probe mode from Task 1).

### Solution
- Rename the checker templates out of the voice namespace
  (`director.checker.output`, `operator.checker.output`) and add explicit
  routing: Haiku is fine, but give a ~1500-token budget.
- Move both checkers onto the tool-call path (`anthropic_tool` + strict once
  Task 6 lands) instead of free-text JSON.
- Feedback loop: persist the latest verdict per session
  (`delivery_json.checker_status` already lands on the `director.turn` decision
  row — read the previous turn's row in `buildDirectorSteeringPlan`), and when
  the prior verdict includes `ignored_steering` or `stale_question`, set
  `verbatim_required = true` (Task 1's escalation flag) and add the offending
  utterance to `do_not_ask`.

### Implementation detail
- `otto-frontend/lib/ai/models.ts`: add explicit branches in
  `anthropicModelForPrompt` and `anthropicMaxTokensForPrompt` for
  `director.checker.` / `operator.checker.` (Haiku, 1500 tokens). Audit other
  `startsWith` prefix routes for similar collisions.
- `otto-frontend/lib/interview/director/brain.ts`: update the
  `prompt_template_id` in the checker call (~brain.ts:1595); convert the call
  to pass `anthropic_tool` with `directorOutputCheckSchema`'s JSON-schema
  equivalent; in `buildDirectorSteeringPlan`, read the prior turn's
  `agent_decision_log.delivery_json` checker fields and wire the escalation.
- `otto-frontend/lib/interview/operator/brain.ts`: same rename + tool
  conversion for the operator checker.
- Verify end-to-end: run one interview turn and confirm the `director.turn`
  row has `checker_status: "passed"|"violation"` and zero
  `output_checker_failed` degradations.

---

## Task 5 — Claim dispatch: ordering, name resolution, find-or-create, auto-drain

### Context
Extraction emits one payload per turn: entity-creating `tool_calls`
(`recordPerson`, `recordSystem`, candidate materialization via
`materializeDirectorProcessInventory`) **and** `claims[]` about those entities.
Dispatch (`dispatchDirectorTurnPlan` brain.ts:893 → `dispatchPlanClaims`
brain.ts:2748 → `preflightDirectorPlanClaimSubjects` brain.ts:~2840 →
`writeClaim` in [otto-frontend/lib/db/write-claim.ts](../otto-frontend/lib/db/write-claim.ts))
validates claim subjects strictly **by row id** against existing DB rows.

### Problem
True, evidence-backed facts are dropped at the gate for repairable reasons:
1. **Same-turn race:** claims reference entities created in the same payload;
   validation runs against pre-existing rows only.
2. **No name resolution:** the model can't know UUIDs for new entities, so it
   references them by name; `directorClaimSubjectFailure` (brain.ts:2862) and
   `write-claim.ts` (System/Person "not found", lines ~297/324) only resolve ids.
3. **No find-or-create:** claims about a person/system nobody has explicitly
   recorded yet are rejected outright, even though the interview is *building*
   the directory.
4. **Phase rule rejects instead of remapping:** `process.*` subjects in phase 1
   are dropped even though the identical field exists on `candidate_process`.
5. **Retry queue never drains:** failures create "Retry director claim"
   follow-up tasks that nothing replays during the interview.

### Evidence (13 dropped claims in the demo session)
- 6× `candidate_process.proposed_name` (Order intake, Order picking, Shipping,
  Invoicing, Purchasing, Vendor payments) + 1×
  `candidate_process.process_relationship` ("Order intake → Order picking →
  Shipping → Invoicing (sequential end-to-end); Purchasing and Vendor payments
  are parallel") — rejected "must target a candidate from this capture
  session" while those candidates were being created in the same turn. The
  relationship claim was the session's single best extraction: the entire
  department topology, discarded.
- `person.role` + `person.single_point_of_failure` for **Marcus** — "Person not
  found." The demo's headline SPOF never made it into notes (only Priya shows,
  inferred).
- `process.business_outcome` + `process.kpi` (the "week delay → ~10% customer
  loss, hundreds of thousands lost" facts) — rejected by the phase rule;
  remappable to the focus candidate.
- 2× `system.used_in_process` for Gmail/Google Sheets — value-shape error
  (string vs object; fixed at generation by Task 6, coerced here as backstop).

Downstream effect: slots stayed `partial`/`empty` → the planner kept hammering
the same targets → fed Task 2's repeat loop. Data loss and question-looping
compound each other.

### Desired outcome
A claim that names a real entity mentioned in the conversation is written, in
the same turn, regardless of entity creation order. The gate continues to
reject only genuine hallucinations (nonexistent evidence ids, entities never
mentioned).

### Solution
Restructure dispatch into an ordered, transactional pipeline:
1. **Entities first:** execute entity-creating tool_calls + candidate
   materialization, collecting created/known rows.
2. **Name→id resolution:** build a per-session resolution map (candidates,
   people, systems, roles — existing + just-created; normalized-name matching).
   Resolve claim `subject_id` values that are names or unknown ids against it.
3. **Find-or-create:** for `person`/`system` subjects that resolve to nothing
   but carry evidence, create the row (same semantics as
   `recordPerson`/`recordSystem`) and attach the claim.
4. **Remap, don't reject, the phase rule:** `process.*`/`process_version.*`
   claims retarget to the focus candidate (or name-matched candidate) with
   `metadata.remapped_from` noted.
5. **Auto-drain:** on entity creation, replay queued "Retry director claim"
   tasks targeting that entity (cross-turn out-of-order extractions are real:
   turn 5 extraction took 20.9s, turn 6 took 3.3s and could commit first).
6. Keep hard rejection for: unresolvable subjects, hallucinated evidence ids.

### Implementation detail
- `otto-frontend/lib/interview/director/brain.ts`:
  - In `dispatchDirectorTurnPlan`, enforce tool_calls-before-claims ordering
    inside one transaction (`turn-transaction.ts` is the existing seam).
  - Rewrite `preflightDirectorPlanClaimSubjects` /
    `directorClaimSubjectFailure` to take the resolution map; add
    `resolveClaimSubjects(claims, sessionEntities)`.
  - `dispatchPlanClaims`: implement remap rule + find-or-create branch +
    queue-drain trigger.
- `otto-frontend/lib/db/write-claim.ts`: allow caller-supplied resolved
  subjects; add create-on-miss option for person/system (gated to director
  interview context), keeping `FOR UPDATE` locking.
- `otto-frontend/lib/interview/director/claim-allowlist.ts`: single source for
  subject/field validation used by both dispatch and the Task 6 schema.
- Drain: small helper that, after entity insert, selects open
  `follow_up_tasks` with `task_type` retry-claim targeting the entity
  name/session and re-runs `writeClaim`.
- Test with the session's exact 13 payloads (they're preserved in
  `follow_up_tasks.context_json`) — all 13 should write; a 14th synthetic claim
  with a hallucinated evidence id should still reject.

---

## Task 6 — Codebase-wide structured outputs enforcement

### Context
All LLM calls flow through
[otto-frontend/lib/adapters/llm.ts](../otto-frontend/lib/adapters/llm.ts)
(`generate`, `generateStream`, `structured`, `structuredStream` — raw `fetch`
to the Anthropic API, no SDK). The team believed "we use structured outputs."

### Problem
Nothing uses API-enforced structured outputs. `structured()` has two paths:
- **Tool path** (`anthropic_tool` + forced `tool_choice`): schema is advisory —
  **no `strict: true` anywhere** — the model is steered, not constrained.
- **Text path** (no tool): appends "Return only valid JSON for schema X",
  regex-extracts from markdown fences, parses. Prompt-and-pray.

Both validate client-side with Zod afterward, and on failure **re-call the full
model** as a repair attempt (doubling latency — a contributor to the 19–25s
extraction turns). Worse, the highest-stakes schema is loose at every layer:
`looseSlotExtractionSchema` (brain.ts:159) uses `subject_type: z.string()`,
`value: z.unknown()`, `.passthrough()`, and `schemas/claim.schema.json` has no
subject enum, no field enum, `value: {}`. So even strict mode with today's
schema would not have blocked `process.kpi` or string-valued
`used_in_process`. The allowlist (`schemas/claim-subject-fields.json`) is
enforced only post-hoc at dispatch.

### Call-site audit
| Call site | Path | Model / max_tokens | Status |
|---|---|---|---|
| Director extraction (`director.turn.extract`, brain.ts:469) | tool, no strict | Sonnet / 8000 | 🔴 + unconstrained claim schema |
| Director output checker (brain.ts:1595) | text JSON | Haiku / **200** | 🔴 crashes (Task 4) |
| Operator output checker (operator brain ~583) | text JSON | Haiku / **200** | 🔴 same latent crash |
| Operator turn plan (`structuredStream`, operator brain) | tool, no strict | Sonnet / **700** | 🟠 truncation risk on the speech hot path (operator speech is still gated on this call) |
| Workflow semantic extractor (`semantic-llm-extractor.ts:82`) | tool, no strict | Sonnet / 16000 | 🟡 |
| Opportunity extractor (`opportunity-extractor.ts:43`) | tool, no strict | Opus / 4000 | 🟡 has real enums — strict gives instant enforcement |
| Director automation plan (`director-automation.ts:247`) | tool, no strict | Opus / 6000 | 🟡 |
| Document claims (`documents/pipeline.ts:471`) | tool, no strict | Sonnet / 8000 | 🟡 same claim-shape looseness |
| Voice phrasers (`*.voice.phrase*`) | free text | Haiku / 200 | 🟢 correct (speech, no schema) |

### Desired outcome
Schema-shaped outputs are guaranteed at generation time wherever a schema
exists: wrong subject types, wrong value shapes, and prose-wrapped JSON become
unrepresentable. Client Zod remains as the checker for constraints strict mode
can't express. Repair re-calls become rare instead of routine.

### Solution
1. **Adapter support:** add `strict: true` to the tool definition in
   `generateAnthropic` (llm.ts:~323–337) and `generateAnthropicToolStream`
   (llm.ts:~501–512), behind a per-call `strict?: boolean` opt (default on once
   call sites are verified).
2. **Schema scrub:** strict mode rejects unsupported JSON Schema keywords —
   `minLength`, `format: "uuid"`, numeric `minimum`/`maximum` — all present in
   the `schemas/*.json` artifacts. Because the adapter uses raw fetch (no SDK
   to scrub), add a deterministic `scrubForStrict(schema)` pass (strip
   unsupported keywords, force `additionalProperties: false` everywhere) before
   sending. Zod keeps enforcing the stripped constraints client-side. Keep the
   scrubbed schema byte-stable per template (it participates in the prompt
   cache prefix).
3. **Tighten the claim schema** (the real fix for the demo's dropped shapes):
   generate the extraction tool's claims schema from
   `schemas/claim-subject-fields.json` — `subject_type` as a **phase-aware
   enum** (director phase 1: `candidate_process|system|person|role`), and a
   `field` + `value` discriminated union (`anyOf` of
   `{field: const X, value: <shape>}`) per subject type. Subject references
   become `{type, id?} | {type, name}` to pair with Task 5's name resolution.
   Drop `.passthrough()` from the Zod mirrors so client validation matches.
4. **Convert text-path callers to the tool path** (the two checkers — Task 4).
5. **Budgets:** raise `operator.turn.plan` max_tokens 700 → ~2000 in
   `anthropicMaxTokensForPrompt`
   ([otto-frontend/lib/ai/models.ts:97](../otto-frontend/lib/ai/models.ts)).
6. Roll `strict: true` out to all 8 tool call sites after a per-schema dry run
   (strict schemas compile on first request, then cache 24h — expect one slow
   first call per template).

### Implementation detail
- `otto-frontend/lib/adapters/llm.ts`: `strict` flag on `anthropic_tool`;
  `scrubForStrict()`; thread through both tool request builders. Log
  `strict: true/false` into `Generation` metadata for observability.
- `otto-frontend/lib/interview/director/schema-artifacts.ts` +
  `claim-allowlist.ts`: build the discriminated-union claims schema from
  `schemas/claim-subject-fields.json` (single source shared with dispatch
  validation); use it in `directorSlotExtractionAnthropicToolSchema`
  (brain.ts:1892), parameterized by interview phase.
- `otto-frontend/lib/interview/director/brain.ts:159`: tighten
  `looseSlotExtractionSchema` claims/slot_updates (enum subject types, no
  passthrough); keep the deterministic fallback plan intact.
- Call sites to flip to strict: brain.ts:469 (extraction), operator brain
  `structuredStream` turn plan, `lib/workflow/semantic-llm-extractor.ts:82`,
  `lib/processes/opportunity-extractor.ts:43`,
  `lib/synthesis/director-automation.ts:247`, `lib/documents/pipeline.ts:471`,
  plus the two converted checkers.
- Eval guard: re-run the director/operator eval suites
  (`otto-frontend/evals/`, `tests/`) after each schema tightening; a too-tight
  schema fails loudly at generation, which is the point — but verify the
  discriminated union matches everything dispatch currently accepts.

---

## Suggested order

1. **Task 1** (phraser fidelity) — unblocks the demo's breadth sweep.
2. **Task 2** (repeat suppression) — kills the "I already told you" moments.
3. **Task 4a** (checker rename/budget fix) — one-line routing fix, un-breaks the
   safety net; 4b (feedback loop) can ride with Task 1's escalation flag.
4. **Task 5** (dispatch ordering) — biggest data-quality win; no prompt changes.
5. **Task 6** (strict outputs) — makes shape errors unrepresentable; pairs with
   Task 5 (5 fixes references/races, 6 fixes shapes — different failure classes).
6. **Task 3** (non-answer hygiene) — small, isolated, do anytime.

Tasks 1, 2, 3 should each be mirrored in the operator interview path once the
director version is verified — the operator demo (live screenshare) hits the
same code shapes, and its speech is still synchronously gated on the turn-plan
call, making it *more* sensitive to these failures, not less.

---

## Parallel execution lanes (for agent-based implementation)

The six tasks cannot run as six independent agents — all touch
`otto-frontend/lib/interview/director/brain.ts`, and Tasks 1+2 share a
function, Task 4b consumes Task 1's flag, Tasks 5+6 share the claim
vocabulary. They partition into three non-conflicting lanes (disjoint brain.ts
regions + disjoint other files). Run each in its own git worktree; merge
sequentially (suggested: B → A → C), running typecheck + tests after each merge.

| Lane | Tasks | Owns | Must not touch |
|---|---|---|---|
| **A — steering & phrasing** | 1, 2, 4b (feedback loop) | brain.ts steering/phrase regions (`buildDirectorSteeringPlan`, `phraseDirectorSteeringTurn`, `deterministicTurnPlan`, controller), `probe-library.ts`, `prompts/director.voice.phrase-intent.md`, `probes/director.yaml`, respond route | normalize/dispatch/checker/schema code, llm.ts, models.ts, write-claim.ts |
| **B — extraction & dispatch data** | 3, 5 | brain.ts normalize/dispatch regions (`normalizeSlotExtractionEvidence`, `dispatchDirectorTurnPlan`, `dispatchPlanClaims`, `preflightDirectorPlanClaimSubjects`), `claim-allowlist.ts`, `slot-schema.ts`, `slot-values.ts`, `turn-transaction.ts`, `write-claim.ts` | steering/phrase/checker code, schema fn (brain.ts:1892), llm.ts, models.ts, prompts |
| **C — LLM transport & schemas** | 6, 4a (checker routing + tool conversion) | `lib/adapters/llm.ts`, `lib/ai/models.ts`, `schema-artifacts.ts`, checker call sites (director brain.ts:~1595, operator brain.ts:~583), `directorSlotExtractionAnthropicToolSchema` (brain.ts:1892), `looseSlotExtractionSchema` (brain.ts:159), non-interview structured call sites | steering/normalize/dispatch code, claim-allowlist.ts (generate schemas from `schemas/claim-subject-fields.json` directly), write-claim.ts, probes |

Cross-lane contracts (state these in each agent's prompt):
1. **Claim subject refs are name-or-id.** Lane C's schema allows `subject_id`
   to be a UUID or a plain name; Lane B resolves names against session entities
   (including same-dispatch creations) with normalized-name matching.
2. **Lane A establishes `steering_context.directive`, `anchor_phrasings`, and
   `verbatim_required`** (≥2 consecutive same-intent turns without slot fill,
   or prior-turn checker flagged ignored-steering/stale-question). Task 4b's
   feedback loop lives in Lane A; Task 4a's routing/budget/tool fix lives in
   Lane C.
3. **Director path only** — operator mirrors are a follow-up pass after the
   director versions are verified.

All lanes: commit to the worktree branch in logical commits; typecheck + unit
tests only (no dev server, no production DB); report contradictions with this
doc rather than silently deviating.

---

# Round 2 — Live demo-testing issues (post-deploy)

Source: live director-interview test runs on 2026-06-10 against prod
(https://otto-pi-sandy.vercel.app), after Round 1 (Tasks 1–6) plus the strict
gate and re-ask fixes shipped. Primary evidence session:
`83fdd5a6-7d2a-419c-adb9-a661cca21788` (started 2026-06-10 ~16:31 PT). All DB
rows below are from that session's `slot_states`, `candidate_processes`,
`agent_decision_log`, and `interview_state` in prod Neon.

Shared context: the director interview's heavy structured extraction now
**succeeds** — strict tool use was the blocker and is gated off
(`OTTO_STRICT_TOOLS`, default false; see the commit "Gate strict tool use off
by default"). With extraction working, this batch is the *quality* tier that
was previously masked by total extraction failure. The extraction planner is
`extractDirectorTurn` → `planDirectorTurnWithExtractionPlanner`
([brain.ts:352](../otto-frontend/lib/interview/director/brain.ts)); dispatch is
`dispatchDirectorTurnPlan`; the live Operations Notes panel renders from
[TranscriptChat.tsx](../otto-frontend/components/onboarding/TranscriptChat.tsx).
None of these are regressions from Round 1 — several are pre-existing and were
hidden until extraction started committing real data.

> **Already fixed this session (not a task):** the `[object Object]` rendering
> bug in Operations Notes — `summarizeSlotValue`
> ([TranscriptChat.tsx](../otto-frontend/components/onboarding/TranscriptChat.tsx))
> called `String()` on nested objects. Fixed with a recursive formatter,
> deployed (commit `f2f22b7`).

The first six tasks below were explicitly named by the user (2 residual +
4 recent). Task 13 (coverage meter) is added because it's the diagnosed cause
of the misleading "25%" and one of the two recommended demo fixes.

---

## Task 7 — Stop over-extracting and duplicating candidate processes

### Context
When the director lists their processes, the extraction creates
`candidate_processes` rows (via `recordCandidateProcessClaim` and
`materializeDirectorProcessInventory`,
[brain.ts:948](../otto-frontend/lib/interview/director/brain.ts)). These rows
feed the overview dashboard's process-card grid.

### Problem
The extractor (1) **decomposes compound process names** into atoms and (2)
**promotes sub-steps to standalone processes**, while also keeping the original
phrase — producing duplicate, fragmented candidates. There is no
normalized-name dedup or "one candidate per named process" constraint at
creation. On the dashboard this renders as ~16 process cards with obvious dupes.

### Evidence
Session 83fdd5a6 produced **16 candidates** from a six-process answer
(`candidate_processes`, two creation batches at 23:32:21 and 23:32:35):

```
order intake | Invoicing | Vendor Payments | Purchasing | Shipping |
Order Picking | purchasing and replenishment | vendor invoice processing |
inventory cycle counts | new customer onboarding and credit setup |
returns and credit memos | Replenishment | New Customer Onboarding |
Credit Setup | Returns | Credit Memos
```

The pattern: the verbatim phrase at confidence **0.74** plus split atoms at
**0.93**:
- `purchasing and replenishment` (0.74) + `Purchasing` (0.93) + `Replenishment` (0.93)
- `new customer onboarding and credit setup` (0.74) + `New Customer Onboarding` (0.93) + `Credit Setup` (0.93)
- `returns and credit memos` (0.74) + `Returns` (0.93) + `Credit Memos` (0.93)
- `order intake` + `Order Picking` + `Shipping` + `Invoicing` (the fulfillment chain split out as separate processes)

Pre-existing: the original demo session (`251a4914`) decomposed the same way
(Order Intake/Order Picking/Shipping/Invoicing); strict failure had been hiding
it by failing extraction entirely.

### Desired outcome
One candidate per process the director actually names. Compound names
("purchasing and replenishment") stay as a single candidate unless the director
clearly enumerates them as separate. Sub-steps mentioned while describing a
process do not become candidates. No near-duplicate candidates differing only by
case/granularity.

### Solution
Two layers, prompt + code:
1. **Prompt** (`prompts/director.turn.plan.md`): instruct the extractor to emit
   exactly the processes the director lists, preserve their phrasing, and never
   split a compound name or promote a sub-step/workflow stage into a separate
   candidate process.
2. **Deterministic dedup at creation** (`materializeDirectorProcessInventory` /
   the candidate write): normalize names (trim, collapse whitespace, lowercase)
   and collapse a candidate whose normalized name is a subset/superset of an
   existing one in the same session, keeping the director's phrasing and the
   higher-confidence row. This is a guard, not the primary fix — the prompt
   should prevent most of it.

### Implementation detail
- `prompts/director.turn.plan.md` — add the one-candidate-per-named-process and
  no-decomposition rules to the candidate-extraction section.
- `materializeDirectorProcessInventory`
  ([brain.ts:948](../otto-frontend/lib/interview/director/brain.ts)) and the
  `recordCandidateProcessClaim` path ([brain.ts:1075](../otto-frontend/lib/interview/director/brain.ts)):
  add normalized-name dedup before insert.
- Regression: feed the six-process utterance from session 83fdd5a6 and assert
  ≤ 7 candidates, no `Purchasing`+`purchasing and replenishment` pair, no
  `Order Picking`/`Shipping`/`Invoicing` unless separately enumerated.

---

## Task 8 — Reduce director extraction latency (~20s per turn)

### Context
The Sonnet structured extraction runs async off the speech path (steered_cascade
speaks immediately, extracts in the background), but Operations Notes only
populate after extraction commits.

### Problem
Each extraction takes ~20–22s, so the Notes panel lags the conversation by that
much. This is the structural "latency floor" documented in the project notes
(heavy synchronous structured extraction). It no longer *fails* (Task 6 / strict
gate fixed that), but it is slow.

### Evidence
Session 83fdd5a6 `agent_decision_log` (`stage_name='director.extraction'`):
turn 0 = **20350ms** (28 in / 1791 out tokens), turn 1 = **22203ms**
(374 in / 1770 out). 20 turns, 0 failed. Latency is dominated by output tokens
(~1800/turn) on Sonnet.

### Desired outcome
Notes populate within a few seconds of each answer, or at least the perceived
lag is materially reduced, without regressing extraction quality.

### Solution (options — needs a decision, not yet chosen)
- Split extraction into a fast pass (which slots/claims touched this turn, small
  output, Haiku) that updates the Notes panel immediately, and a slower full
  pass for values/evidence — mirrors the Decagon/Sierra checker-parallel pattern
  in the project notes.
- Reduce per-turn output: extract only the deltas for the current turn rather
  than re-emitting the full slot set; cap `max_output_tokens` for the extract
  template in [models.ts](../otto-frontend/lib/ai/models.ts).
- Verify prompt caching actually hits on the static schema/prompt prefix
  (`cache_read_input_tokens > 0`); the 28-input-token turn 0 suggests the cache
  is not warmed.

### Implementation detail
This is a design task, not a one-liner — start by profiling where the 20s goes
(model time vs dispatch vs round-trips) using the `latency_ms` and token columns
already in `agent_decision_log`. Cross-references the structural decouple already
captured in the project's director-latency notes.

---

## Task 9 — Don't let a non-answer clobber an already-filled slot

### Context
Slot values are written by `updateSlotState`
([tools.ts:146](../otto-frontend/lib/interview/director/tools.ts), upsert via
`onConflictDoUpdate`). Each extraction can overwrite a slot's prior value.
Non-answer detection exists in `normalizeSlotExtractionEvidence` →
`isNonAnswerSlotExtraction`
([brain.ts:1272](../otto-frontend/lib/interview/director/brain.ts)) but only
matches explicit don't-know phrasing.

### Problem
Two compounding gaps:
1. **Non-answer slips through.** `isNonAnswerSlotExtraction` keys on
   `NON_ANSWER_VALUE_PATTERN` (not sure / don't know / you'd have to ask) and the
   `dont_know`/`non_answer` utterance class. A garbled deflection that *looks*
   like a real answer is extracted as a value.
2. **No downgrade protection.** A later, lower-quality extraction overwrites an
   earlier high-quality `filled` slot. There is no "don't replace a filled,
   higher-confidence slot with a weaker value" guard in the upsert.

### Evidence
Session 83fdd5a6, `function.name`:
- 04:31 the director said *"I'm the VP of operations"* → correct.
- 04:40, asked "what part of the business do you lead overall?", the director
  said *"I lead the department. And I oversee those peep those employees I just
  mentioned."*
- Final stored value: `{"function_name":"Those Peep Those Employees I Just
  Mentioned"}`, `status: filled`, `confidence: 0.78` — the garbled deflection
  **overwrote** "VP of operations", and rendered in Operations Notes as
  *"function name: Those Peep Those Employees I Just Mentioned"*.

### Desired outcome
A garbled/low-content answer to an already-answered question does not replace a
good value. `function.name` stays "VP of operations".

### Solution
1. Add a downgrade guard at slot upsert: do not overwrite a `filled` slot with a
   new value of strictly lower confidence, or with one classified non-answer.
2. Broaden non-answer/low-content detection beyond explicit don't-know patterns:
   e.g. answers that are mostly filler/self-reference ("the employees I just
   mentioned") relative to the asked slot.

### Implementation detail
- `updateSlotState` ([tools.ts:146](../otto-frontend/lib/interview/director/tools.ts)):
  read the existing slot in the same transaction (a `lockSlotState` helper
  already exists nearby) and skip/down-rank the write when the incoming value is
  lower-confidence-than-filled or non-answer.
- `isNonAnswerSlotExtraction` / `NON_ANSWER_VALUE_PATTERN`
  ([brain.ts:1272](../otto-frontend/lib/interview/director/brain.ts)): extend
  patterns; consider a self-reference/low-information heuristic.
- Regression: replay the two `function.name` turns from session 83fdd5a6; assert
  the stored value remains "VP of operations".

---

## Task 10 — Keep the conversation and slot scoping on the chosen focus process

### Context
The director picks a focus process; `interview_state.focus_candidate_process_id`
records it, and enrich-phase slots are scoped to a candidate via
`slot_states.candidate_process_id`. Steering is built by
`buildDirectorSteeringPlan`
([brain.ts:358](../otto-frontend/lib/interview/director/brain.ts)).

### Problem
Even with the focus correctly recorded, (a) the spoken questions drift to a
*different* process, and (b) enrich slots attach to a candidate other than the
focus — so the captured data scatters across the wrong process and the focus
process stays thin.

### Evidence
Session 83fdd5a6: the director chose order intake (04:32 *"Let's focus on order
intake easily"*). `interview_state.focus_candidate_process_id` = the
`order intake` candidate (correct). But:
- At 04:33 Otto asked *"For returns and credit memos specifically, what systems
  or spreadsheets does your team actually work in day-to-day?"* — pivoting to a
  different process.
- Most enrich slots committed to candidate `2ba5964b` whose `scope.boundaries`
  value is `{"process_names":["returns and credit memos"]}`, **not** the
  order-intake focus. Two `scope.boundaries` rows exist: one on the focus
  (`order-to-cash and procure-to-pay`) and one on `2ba5964b`
  (`returns and credit memos`).

### Desired outcome
While a focus process is set, spoken probes target it, and enrich-phase slot
writes scope to the focus candidate (not whichever candidate the extractor last
touched).

### Solution
Make focus authoritative for both phrasing and slot scoping during `expand`/
`enrich`: pass the focus candidate into the steering directive and force
enrich-phase slot writes to the focus `candidate_process_id` unless the director
explicitly switches focus. Investigate why the extractor attached slots to a
non-focus candidate (likely it inferred a process from the answer content rather
than honoring the active focus).

### Implementation detail
- `buildDirectorSteeringPlan`
  ([brain.ts:358](../otto-frontend/lib/interview/director/brain.ts)): ensure the
  directive and target slots reference the focus candidate; audit how the
  systems/handoffs probes pick their target process.
- Dispatch (`dispatchDirectorTurnPlan`): default enrich-phase slot
  `candidate_process_id` to `interview_state.focus_candidate_process_id`.
- Regression: a session that selects order intake then describes it should write
  enrich slots to the order-intake candidate, and no probe should name a
  different process unless focus changed.

---

## Task 11 — Extend the re-ask guard to answered-but-not-filled questions

### Context
Round 1 added a provisional-answer guard (Task 2) and a `pending_re_extract`
guard (`provisionallyAnsweredSlotPaths` /
`pendingReExtractSlotPaths`,
[brain.ts:698](../otto-frontend/lib/interview/director/brain.ts) /
[:745](../otto-frontend/lib/interview/director/brain.ts);
`applySteeringIntentExclusions`,
[brain.ts:4459](../otto-frontend/lib/interview/director/brain.ts)). These exclude
a probe while its extraction is pending or failed.

### Problem
The guards only cover *pending* and *pending_re_extract* states. When a question
was asked and answered but the resulting slot landed as `partial` or got scoped
to a different candidate (Task 10), the slot reads unanswered and the chooser
re-asks it — even though the director clearly answered.

### Evidence
Session 83fdd5a6 transcript:
- "Which process should we focus on first?" asked at **04:32** *and* **04:34**.
  Director: *"Bro, what? We just focused on order intake."*
- 04:33 "Beyond those two, what are the other main recurring processes your team
  manages?" Director: *"What do you mean beyond those two? Beyond what?"* —
  Otto had lost track of the already-given six-process inventory.

### Desired outcome
A question the director has substantively answered this session is not re-asked,
even if its slot is `partial` or scoped to the wrong candidate. The focus-
selection and inventory questions in particular fire at most once unless the
director changes their answer.

### Solution
Broaden the exclusion signal in `applySteeringIntentExclusions` from "slot
filled/pending" to "this probe fired and got a substantive reply this session"
using `probe_firings` history (already read for cooldowns), independent of the
slot's final status. Pairs with Task 10: once focus scoping is fixed, fewer
answers will land mis-scoped, but the guard should not depend on perfect
extraction.

### Implementation detail
- `applySteeringIntentExclusions`
  ([brain.ts:4459](../otto-frontend/lib/interview/director/brain.ts)): treat a
  probe with a prior firing + substantive reply as answered for exclusion
  purposes; special-case `define_process_boundary` (focus selection) and
  `discover_processes` (inventory) to not refire once satisfied.
- Cross-task: depends on the same `probe_firings` data Task 2 uses; coordinate so
  the two guards don't double-count.
- Regression: replay the focus-selection turns; assert "Which process should we
  focus on first?" fires once.

---

## Task 12 — Resolve the recurring `claim_subject_validation_failed` degrade flag

### Context
Lane B (Task 5) added claim subject resolution (name→id, find-or-create, remap)
in dispatch. A claim that still can't be validated sets
`degraded_reasons: ["claim_subject_validation_failed"]` on the extraction
decision row.

### Problem
The degrade flag still fires on some turns even though Lane B's repair recovers
the claim (no data is dropped). It is cosmetic — but it pollutes the degraded
signal and may hide real claim failures. Either the flag should not be set when
the claim was recovered, or there is a residual subject that still isn't
resolved.

### Evidence
Session 83fdd5a6: `claim_subject_validation_failed` on turns **1 and 12**, but
**0** "Review invalid director claim subject" follow-up tasks were created — i.e.
no claim was actually dropped (Lane B's remap/find-or-create recovered them).
Cross-references Task 5 (the dispatch resolution logic) — this is the residual
edge that resolution recovers but still flags.

### Desired outcome
`claim_subject_validation_failed` is set only when a claim is genuinely dropped,
not when dispatch repaired it. The degraded signal stays meaningful.

### Solution
In dispatch, distinguish "validation failed then recovered via resolution/remap/
find-or-create" from "validation failed and dropped"; only set the degrade flag
(and follow-up) for the latter.

### Implementation detail
- `dispatchDirectorTurnPlan` / the claim-resolution path from Task 5
  ([brain.ts](../otto-frontend/lib/interview/director/brain.ts)): track per-claim
  outcome and gate the degrade reason on the final dropped set, not the initial
  validation attempt.
- Low severity — schedule after the demo-visible tasks.

---

## Task 13 — Coverage meter should credit partial slots (the misleading "25%")

### Context
Operations Notes shows `{filledSlots} of {totalSlots} slots covered ·
{coveragePercent}%` ([TranscriptChat.tsx:1022](../otto-frontend/components/onboarding/TranscriptChat.tsx)),
where `filledSlots` counts only `filled`/`asked_unknown` status and
`coveragePercent = filledSlots / totalSlots`
([TranscriptChat.tsx:314–322](../otto-frontend/components/onboarding/TranscriptChat.tsx)).

### Problem
`partial` slots — which hold real, extracted, demo-worthy data — contribute
**zero** to the headline number, so a rich interview reads as nearly empty.

### Evidence
Session 83fdd5a6: meter showed **"4 of 16 slots covered · 25%"** while the
`slot_states` were **4 filled, 11 partial, 2 empty**. The 11 partial slots held
real content: `friction.pain_points` (Marcus/Priya/Tom manual work),
`ownership.roles` (Priya purchasing lead, Tom AP clerk), `metrics.kpis` (volume,
% correct, failures, CSAT), `risk.spofs` (Tom on vendor invoices),
`systems.systems_of_record` (Gmail/Odoo/Sheets), `handoffs.dependencies`,
`frequency.volume`, `controls.compliance`. True capture was ~70%, displayed 25%.

### Desired outcome
The coverage number reflects real capture — partial slots earn partial credit so
a substantive interview reads as substantially covered.

### Solution
Give `partial` slots fractional weight (e.g. 0.5) in the coverage computation,
or show filled and partial counts separately. Keep `asked_unknown` counted as
covered (it already is). This is a small, defensible display change; it does not
touch extraction.

### Implementation detail
- `filledSlots` / `coveragePercent`
  ([TranscriptChat.tsx:314–322](../otto-frontend/components/onboarding/TranscriptChat.tsx)):
  compute a weighted coverage (filled = 1, partial = 0.5) or render
  "N filled · M partial". Frontend-only.

---

## Round 2 — suggested order

1. **Task 13** (coverage meter) — trivial frontend change, biggest perceived-
   quality win for the demo (25% → ~70%).
2. **Task 9** (non-answer clobber) — removes the most visible bad data
   (`function.name` garbage); contained to slot upsert + non-answer detection.
3. **Task 7** (candidate dedup) — fixes the duplicated dashboard cards; prompt +
   creation-dedup.
4. **Task 10** (focus scoping) then **Task 11** (re-ask guard) — related steering
   work; 10 reduces mis-scoping, 11 backstops what still slips. Riskier; do
   together, not mid-demo.
5. **Task 8** (latency) — design task, schedule deliberately.
6. **Task 12** (claim degrade flag) — low-severity cleanup, last.
