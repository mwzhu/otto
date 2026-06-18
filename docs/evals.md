# Evals

Living document for production-quality evals of Otto agents. Start here when a
production bug, dogfood failure, or product-quality concern becomes a standing
eval.

## Eval Shape

Use the same fields for every eval:

| Field | Meaning |
|---|---|
| Success criteria | What must be true for the agent to pass. Specific and measurable. |
| Task | The scenario we run, and how the counterparty is constructed (see Replay Fidelity Modes). |
| Outcome | The persisted state, tool trajectory, transcript, trace, or artifact we inspect after the run. State an **outcome contract** (user-visible facts), not internal enum values. |
| Grader | The code, LLM judge, or human review that scores the outcome. Split every grader into **gate checks** (what fails the eval) and **diagnostics** (report-only signal). |
| Mode | Replay fidelity mode the task runs in (state replay / pinned single-turn / simulated user). |
| Gate | Statistic and cadence (see Run Cadence & Statistical Gates). |

General rules:

- Keep regression evals near-100% pass. They protect bugs we already fixed.
- Keep capability evals harder. They measure whether the agent is getting better.
- Always save full transcript and trace artifacts for failed trials.
- Prefer production-path evals for product quality: live LLM, real steering,
  real voice phrasing, real dispatch, real DB logs.
- Use deterministic/unit evals for narrow invariants, but do not confuse them
  with production agent quality. Authored micro-scenarios are capability checks,
  not evidence the live agent handles real messy interviews.
- Grade durable, user-visible outcomes. Treat internal trace enums as
  diagnostics, never as the primary gate (see Grading Philosophy).

References:

- Anthropic, "Define success criteria and build evaluations":
  https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
- Anthropic, "Demystifying evals for AI agents":
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

## Replay Fidelity Modes

A multi-turn agent cannot be graded the same way in every scenario. The user
turns in a replayed transcript were answers to the *original* agent; if a fixed
agent asks a different question on turn 8, the frozen director response from the
failed run may no longer make sense. Past the first divergent turn we are no
longer evaluating a live conversation — we are evaluating the agent against a
counterparty answering an older version of the agent. Each eval must declare one
of these modes.

1. **State replay** — replay a real frozen transcript through the live
   production path; grade **only** persisted state, tool calls, extraction, and
   reconciliation. These depend on the *director's* utterances, not the agent's
   phrasing, so they survive replay. **Never** grade conversational quality in
   this mode.

2. **Pinned single-turn branch** — fix the transcript and interview state to a
   canonical prefix (the original prefix up to the turn under test, or a
   corrected canonical prefix), run the live agent for exactly one turn, and
   grade that single response (utterance + intent + tool calls + state delta).
   Use for question-quality and focus-switch evals on replayed incidents, where
   a full replay would drift.

3. **Simulated user** — a persona model answers the live agent dynamically
   across turns. Most realistic, noisiest, most expensive. Use for end-to-end
   flow and anti-loop evals. Report-only until the simulator persona is itself
   calibrated against real director behavior.

Task construction is a separate axis from mode:

- **Production replay** tasks use a real captured transcript (e.g. incident
  `71569919`).
- **Authored scenario** tasks use a short hand-built transcript targeting one
  behavior. Authored scenarios are typically state-graded and are
  capability/regression checks — a green authored-scenario eval is **not**
  evidence the live agent handles real conversations.

## Run Cadence & Statistical Gates

One live LLM run cannot be a hard gate; tool-call sampling alone makes the
production path non-deterministic. Every live gate is defined as a statistic
over multiple trials, not a single run.

| Tier | When | What runs | Gate statistic |
|---|---|---|---|
| Deterministic fast gate | Every PR | Existing deterministic suites (conversational smoke, extraction regression, schema contract, data-model invariants). LLM disabled. | Single run, must pass. |
| Live nightly | Nightly + on demand | `director.production-regression` with the LLM on. | Hard regression evals: **pass^3** (all 3 trials pass). Capability evals: **pass@k** or averaged score, report-only or soft threshold. |
| Live pre-release | Before a model/prompt promotion | Same suite, more trials. | Hard regression evals: **pass^5**. |

Rules:

- **Hard regression** (a bug we already fixed): gate on `pass^k` — every trial
  must pass. Default k=3 nightly, k=5 pre-release.
- **Capability** (is the agent getting better): gate on `pass@k` or an averaged
  judge score; keep these report-only or soft until stable, then promote.
- Run live trials at the production sampling config. Do not assume temperature 0
  makes tool use deterministic.
- A live eval has no gate until its trial count and statistic are filled in the
  scorecard. "Hard fail" with no `k` is a flake, not a gate.

## LLM Judge Discipline

LLM-as-judge graders score conversational quality. They are disciplined or they
are noise.

- **Different model.** The judge must be a configured judge model from a
  different family/version than the director under test. Never self-judge.
- **Escape hatch.** Every judge rubric offers `unknown` so the judge abstains
  instead of hallucinating a verdict.
- **One rubric scale.** All judges score `0 / 1 / 2`:
  - `2` — good: specific, non-redundant, process-aware, moves the interview
    forward.
  - `1` — acceptable but generic or slightly repetitive.
  - `0` — wrong: ignores the user, repeats answered material, or asks the user
    to choose again.
  - `unknown` — judge cannot tell; routed to human review.
- **Calibrate before gating.** A judge starts report-only. Build a human-labeled
  seed set (~20-30 labels per rubric). The judge may only become a soft gate
  after it reaches **≥90% agreement** with human labels on that seed set.
  Periodically re-review a sample of judge failures so the rubric keeps matching
  product expectations.

## Grading Philosophy: Outcome Contracts Over Trace Enums

Reconciliation graders are easy to write tautologically — assert the exact enum
the code emits and the eval only proves the code calls itself. Avoid this.

- **Gate on the outcome contract**: durable, user-visible facts. "Exactly one
  durable candidate named `Purchasing And Replenishment`." "Current
  `frequency.volume` is daily; the prior weekly value is still queryable." These
  hold no matter how the reconciler is implemented.
- **Diagnostics only**: internal trace enums (`merge_candidate`,
  `changeKind = correction`, `demote_to_candidate_detail`). Report them so we can
  track reconciler cleanliness, but never let an enum string be the thing that
  passes or fails the eval. If the enum vocabulary changes, the gate must not.

Bootstrapping order for reconciliation evals (the plan is in flight, not
shipped — see `docs/DIRECTOR_CONTINUOUS_RECONCILIATION_PLAN.md` and
`otto-frontend/lib/interview/director/reconciliation.ts`):

1. Freeze the **outcome contracts** for Evals 10-17 (durable-state assertions).
2. Implement reconciliation per the plan.
3. Wire graders to the contracts; add trace-enum assertions as report-only
   diagnostics.
4. Promote a reconciliation eval to a hard gate only after its contract is
   stable across at least k consecutive nightly runs.

## Current Director Eval Gap

Current director evals are useful but not sufficient to measure the live agent.

| Current suite | What it proves | Gap |
|---|---|---|
| Conversational smoke | Deterministic `DirectorTurnPlan` and fallback phrasing match expected checks with the model disabled. | Does not score live LLM behavior or natural conversation quality. |
| Extraction regression | Inventory materialization and junk filtering behave correctly on narrow fixtures. | Does not run full production interview behavior. |
| Session verify | A completed voice session has acceptable persisted coverage, latency, cost, and state checks. | Mostly proves the system ran; does not judge whether the live agent asked good questions. |

The production director eval suite replays realistic multi-turn director
interviews through the same path users experience, then grades extraction,
reconciliation, tool actions, and question quality from the resulting traces.

## Production Director Eval Suite

Suite name: `director.production-regression`

Purpose: prevent regressions from real production/dogfood bugs.

This suite is **incident-seeded**. Incident `71569919` is **incident #1**, not a
proxy for "director quality." Seven evals from one transcript are highly
correlated; passing them proves this transcript stays fixed, not that the agent
improved. The suite measures product quality only once it holds several
independent dogfood incidents with different inventories and failure modes.
Adding the next real incident is higher priority than adding an eighth eval to
this one.

Minimum trace artifacts per trial:

- `transcript_segments`
- `agent_decision_log`
- `candidate_processes`
- `slot_states`
- `claims` and `claim_evidence`
- `interview_state`
- `director_extraction_windows`
- full agent utterances
- tool calls and execution status
- reconciliation trace, once implemented
- model, token, latency, and cost metadata

## Incident 71569919 Eval Set

Source production failure:

```text
71569919-775d-44bd-bd33-f5b6faf096f1
```

This incident is a standing regression because it exposed five user-visible
failures:

- incorrect processes were created
- the agent asked repeated/generic questions
- the agent asked for things already answered
- the agent would not switch to the requested process
- the agent asked controls/compliance/documentation questions before
  foundational process coverage was complete

**Cross-link.** The same dogfood inventory is also covered deterministically by
`evals/director/extraction-quality-prod-e919bb61.json` (the `Six Big Ones` /
`All Of It` junk fixture). That fixture is the fast per-PR tripwire on the
materializer; Eval 1 below is the live-LLM superset over the full path. They
share an inventory and must be kept in sync — update both when the expected set
changes, or they will drift into two definitions of "correct extraction."

### Eval 1: Process Inventory Extraction And Reconciliation

Bucket: Extraction accuracy / reconciliation · Mode: state replay · Gate:
pass^3 hard, nightly.

Success criteria:

- The final durable candidate process list is exactly:
  - `Order Intake`
  - `Purchasing And Replenishment`
  - `Vendor Invoice Processing`
  - `Inventory Cycle Counts`
  - `New Customer Onboarding And Credit Setup`
  - `Returns And Credit Memos`
- Turn-0 scope phrases must not become durable focus candidates:
  - `Order Management`, `Order Picking`, `Shipping`, `Invoicing`, `Purchasing`,
    `Vendor Payments`
- Under continuous reconciliation, turn-0 process-like phrases may be extracted
  as hypotheses or retained as non-promoted evidence/details, but must not be
  written as `candidate_processes`, drive focus rotation, or be reachable as
  named focus targets unless later reconciliation promotes them.
- Turn 1 must create the six real processes from the explicit inventory answer.

Task:

- Replay the original failed 21-turn director transcript through the production
  director path with the LLM enabled; persist all traces to the replay DB.
- Preserve the original split shape: turn 0 = substantive scope/remit answer;
  turn 1 = explicit six-process inventory.

Outcome contract:

- `candidate_processes` has exactly six durable rows for the capture, matching
  the expected inventory after canonicalization.
- No durable candidate exists after turn 0; all six exist after turn 1.
- Only reconciled candidates drive focus, switching, and coverage.

Grader:

- **Gate (code):** normalized set equality on final `candidate_processes`;
  point-in-time check that turn 0 produced zero durable candidates; hard fail on
  any extra durable candidate, missing candidate, or turn-0 phrase promoted to
  focus.
- **Diagnostic (code):** if reconciliation traces exist, report whether turn-0
  scope mentions carry non-promoting actions vs `create_candidate`.

### Eval 2: No Repetitive Process Tool Calls

Bucket: Agent actions/tool calling · Mode: state replay · Gate: pass^3 hard,
nightly.

Success criteria:

- On the inventory turn, the agent executes one successful `recordProcess` per
  real process.
- Compound names stay intact: `Purchasing And Replenishment` must not also
  produce separate writes for `Purchasing` or `Replenishment`; likewise
  `New Customer Onboarding And Credit Setup`.
- No duplicate successful write for the same canonical candidate in one turn.

Task:

- Replay the same failed transcript through the production path; inspect turn 1
  extraction, reconciliation, and dispatch traces.

Outcome contract:

- Turn 1 successful `recordProcess` executions are exactly six and equal the
  expected inventory set.
- Repeated/split attempts are absent or explicitly marked not-executed.

Grader:

- **Gate (code):** count successful executions; normalize names; hard fail on
  any canonical duplicate or extra successful write.
- **Diagnostic (code):** number of rejected duplicate/split attempts (tracks
  prompt/tool cleanliness even when persistence is protected).

### Eval 3: Can Switch To A Named Process

Bucket: Agent actions/tool calling · Mode: pinned single-turn · Gate: pass^3
hard on state, judge report-only on utterance, nightly.

Success criteria:

- When the director asks to discuss `Returns`, the agent switches focus to
  `Returns And Credit Memos` via the explicit `switchFocusCandidate` action.
- `interview_state.focus_candidate_process_id` points to that candidate.
- The next agent utterance names the selected process rather than asking a
  generic "which process" question.

Task:

- Pin the canonical prefix up to the director's switch request, then run one
  live turn for each variant: `Returns`, `No. Switch right now.`,
  `Let's talk about returns and credit memos.` (Pinned, not full replay, because
  the frozen director responses past this point assume the buggy agent.)

Outcome contract:

- `switchFocusCandidate` succeeds; focus persists to `Returns And Credit
  Memos`; `chosen_intent.target_process` and the utterance both refer to it.

Grader:

- **Gate (code):** focus state + tool-call facts; hard fail if focus does not
  persist to `Returns And Credit Memos`.
- **Diagnostic (code):** `user_intent_signal` focus-switch classification
  (steering trace — reported, not gated).
- **Judge (report-only until calibrated):** does the utterance acknowledge the
  switch naturally? `0/1/2/unknown`.

### Eval 4: Can Move To The Next Process

Bucket: Agent actions/tool calling · Mode: pinned single-turn · Gate: pass^3
hard on state, judge report-only, nightly.

Success criteria:

- When the director asks to move on, the agent switches to another real
  candidate, does not bounce between phantoms or rejected names, and names the
  process it is moving to.

Task:

- Pin the canonical prefix to a point where one process is covered, then run one
  live turn on a "let's move on / cover another one" director utterance.

Outcome contract:

- `switchFocusCandidate` succeeds; `chosen_intent.target_process` is one of the
  six real candidates; the utterance names it.

Grader:

- **Gate (code):** tool action, focus state, and target-candidate validity
  (must be a real candidate, never a rejected/phantom name).
- **Diagnostic (code):** `user_intent_signal.action` classification (steering
  trace — reported, not gated).
- **Judge (report-only):** was the transition responsive and non-confusing?

### Eval 5: Do Not Repeat Questions Already Answered

Bucket: Question quality · Mode: pinned single-turn · Gate: pass^3 hard on
known-bad code patterns; judge report-only until calibrated; nightly.

Success criteria:

- After the director has given the six-process inventory, the agent does not ask
  for the process list again.
- The agent does not ask generic process-selection questions when a process is
  already named or requested.
- The agent asks a useful next question about the current focused process.

Task:

- Pin prefixes drawn from the post-inventory section (especially turns 11-20),
  run one live turn each.

Outcome contract:

- No utterance re-requests the already-known inventory; no generic
  process-selection prompt fires when `target_process` is known; the utterance
  targets a missing/unresolved slot for the focused process.

Grader:

- **Gate (code):** reject a maintained list of known-bad generic phrases after
  inventory is known; require `chosen_intent.target_process` present when
  drilling in. Treat the phrase list as a cheap tripwire, not the real grader —
  it will miss paraphrases.
- **Judge (primary signal, report-only until calibrated):** is this question
  redundant given the transcript so far? `0/1/2/unknown`.

### Eval 6: Question Quality After Correct Switch

Bucket: Question quality · Mode: pinned single-turn · Gate: judge soft
(avg ≥ 1.5 over k=5) once calibrated; report-only until then; nightly.

Success criteria:

- After switching to the requested process, the agent asks a question that moves
  the interview forward, is specific enough that the director knows which
  process is being discussed, and does not imply the conversation is still at
  process selection.

Task:

- Pin the prefix to immediately after a correct switch to `Returns And Credit
  Memos`; run one live turn.

Outcome contract:

- The utterance refers to `Returns And Credit Memos`; the chosen probe intent
  targets a missing/partial slot for that process; the question is not a
  duplicate of an earlier answered question.

Grader:

- **Judge (primary):** `0/1/2/unknown` per the standard rubric.
- **Support (code):** target process exists, focus matches target, no known-bad
  generic phrase.

### Eval 7: Core Slot Prioritization Before Enrichment

Bucket: Question quality · Mode: state replay (trajectory) + pinned single-turn ·
Gate: pass^3 hard, nightly.

(Restored — this maps to the fifth named failure and was dropped in a prior
rewrite.)

Success criteria:

- The agent completes core slots for the current real process before asking
  non-core enrichment questions. Core slots: `scope.boundaries`,
  `outcomes.business_outcomes`, `ownership.roles`, `systems.systems_of_record`,
  `frequency.volume`, `friction.pain_points`, `risk.spofs`. (These are exactly
  `directorCoreCoverageSlotPaths`, exported from
  `lib/interview/director/slot-schema.ts` — derive the list from that export, do
  not hand-maintain this prose copy. This is distinct from the priority-1
  acceptance slots that session verify uses.)
- Before every real candidate has core coverage, the agent rotates to the next
  under-covered process instead of enriching an already-covered one.
- Non-core enrichment intents (especially `capture_controls`,
  `capture_documentation`) must not fire while any real candidate lacks core
  coverage, unless the director explicitly raised that topic.

Task:

- State-replay the post-inventory section to grade the chosen-intent trajectory
  against computed coverage; additionally pin single turns at the points where
  the historical agent jumped to controls/documentation early.

Outcome contract:

- For every `director.turn` decision before full core coverage,
  `chosen_intent.target_slot` is a core slot or the intent is
  `select_process_to_expand` for a real under-covered candidate.
- No non-core enrichment intent before full core coverage absent an explicit
  director request.

Grader:

- **Gate (code):** compute projected core coverage from `slot_states`,
  `slot_updates`, and focus state; hard fail on non-core enrichment before full
  core coverage (without explicit request), or on staying on an already-covered
  process while another real candidate lacks core coverage.
- **Diagnostic (judge, report-only):** does the sequence feel like a coherent
  interview plan?

## Negative / Balance Cases

Every eval above asserts the agent *should* do something. Without the
complements, an agent that switches too eagerly and never re-asks would pass the
whole set while being wrong in the mirror scenario. These guard the boundary.

### Eval 8: Do Not Switch Focus Without A Request

Bucket: Agent actions/tool calling · Mode: authored scenario, pinned
single-turn · Gate: pass^3 hard, nightly. (Negative twin of Eval 3.)

Success criteria:

- When the director gives a substantive answer about the current process and
  does **not** request a switch, the agent does not call `switchFocusCandidate`
  and keeps focus on the current process.

Task:

- Pin a prefix focused on `Quote Approvals`; run one live turn on a director
  utterance that adds detail about quote approvals without asking to switch.

Outcome contract:

- No `switchFocusCandidate` execution; `focus_candidate_process_id` unchanged.

Grader:

- **Gate (code):** assert focus unchanged and no switch tool call.
- **Diagnostic (code):** `user_intent_signal.action` classification (steering
  trace — reported, not gated).

### Eval 9: Re-Ask Is Allowed After A Genuine Non-Answer

Bucket: Question quality · Mode: authored scenario, pinned single-turn · Gate:
judge soft once calibrated; report-only until then; nightly. (Negative twin of
Eval 5 — guards against an over-correction that never re-asks.)

Success criteria:

- When the director gives a non-answer, contradiction, or explicit
  repeat/clarify request, re-asking or rephrasing the same question is correct
  and must not be penalized.

Task:

- Pin a prefix where the agent asked about systems of record; the director
  replies "I don't follow" / "say that again"; run one live turn.

Outcome contract:

- The agent re-asks or rephrases the same slot's question rather than abandoning
  the slot or jumping ahead.

Grader:

- **Judge (primary):** is the re-ask appropriate given the non-answer?
  `0/1/2/unknown`.
- **Support (code):** the targeted slot is unchanged and still unresolved.

## Continuous Reconciliation Eval Set

These evals become required once
`docs/DIRECTOR_CONTINUOUS_RECONCILIATION_PLAN.md` is implemented. They are
**authored scenarios** (short hand-built transcripts), not incident replays, and
are state-graded. They are capability/regression checks on the reconciliation
lifecycle — not evidence of production conversation quality. Follow the
Grading Philosophy: gate on durable outcome contracts, keep trace enums as
diagnostics.

Lifecycle under test:

```text
raw mention -> extracted hypothesis -> reconciled decision -> durable state
```

### Eval 10: Scope Mention Demotion

Bucket: Reconciliation · Mode: authored scenario, state-graded · Gate: pass^3
hard after reconciliation ships, nightly.

Success criteria:

- Broad scope narration can produce process-like hypotheses, but scope/substep
  mentions do not become durable `candidate_processes`.
- Demoted mentions are retained as queryable non-candidate evidence (candidate
  detail on a parent, or session-scoped scope evidence in `process.inventory`
  `slot_states.candidates`) and do not drive focus rotation.

Task:

- Director: `I own order intake through picking, shipping, invoicing, and vendor
  payments.` Later: a cleaner process inventory.

Outcome contract:

- No durable candidate for `Shipping`, `Invoicing`, etc. unless later promoted.
- Those mentions remain queryable as non-candidate evidence.

Grader:

- **Gate (code):** assert no durable candidate for the scope mentions; assert
  the mentions are retrievable as non-promoted evidence.
- **Diagnostic (code):** reconciliation action per mention.

### Eval 11: Do Not Over-Promote Weak Scope Narration

Bucket: Reconciliation · Mode: authored scenario, state-graded · Gate: pass^3
hard after reconciliation ships, nightly. (Negative twin of Eval 13 — guards
against an agent that promotes on weak signal.)

Success criteria:

- A scope phrase that is merely repeated or mentioned in passing — without the
  director clearly identifying it as its own top-level process — must **not** be
  promoted to a durable candidate.

Task:

- Early turn: `shipping` appears in broad scope narration. Later turn: director
  mentions shipping again only in passing (`...and then it ships out`), with no
  statement that it is a separate process.

Outcome contract:

- `Shipping` is still **not** a durable candidate after the second mention.

Grader:

- **Gate (code):** assert no durable `Shipping` candidate.
- **Diagnostic (code):** confidence/score the reconciler assigned the mention.

### Eval 12: Mid-Interview New Process Creation

Bucket: Reconciliation / agent actions · Mode: authored scenario, state-graded ·
Gate: pass^3 hard after reconciliation ships, nightly.

Success criteria:

- The agent can add a new valid process after the initial inventory, only when
  the safe-creation floor plus additive reconciler is satisfied (high-confidence
  new top-level process with corroborating evidence). Once created, it can be
  switched to or reached by rotation.

Task:

- After several turns: `Actually, we also have a separate warranty claims
  process.`

Outcome contract:

- `Warranty Claims` becomes a durable candidate and is reachable by focus/switch.

Grader:

- **Gate (code):** durable candidate exists and is focusable.
- **Diagnostic (code):** creation went through the additive reconciler, not a
  loosened scope-narration gate.
- **Judge (report-only):** does the agent acknowledge the new process naturally?

### Eval 13: Process Demotion Then Promotion

Bucket: Reconciliation · Mode: authored scenario, state-graded · Gate: pass^3
hard after reconciliation ships, nightly. (Positive twin of Eval 11.)

Success criteria:

- A phrase initially demoted as a scope detail is promoted **only** when the
  director clearly identifies it as its own top-level process.
- Retained non-promoted evidence stays queryable and is linked after promotion.

Task:

- Early turn: `shipping` in broad scope narration. Later turn: `Shipping is
  actually its own separate process for us.`

Outcome contract:

- Early `Shipping` is not durable; later `Shipping` is durable; the durable
  candidate references the earlier retained evidence.

Grader:

- **Gate (code):** point-in-time candidate state (absent early, present late) +
  evidence linkage.
- **Diagnostic (code):** promotion came from retained/new evidence, not a blind
  duplicate create.
- **Judge (report-only):** "clearly identifies it as its own process" is a
  semantic call — flag borderline promotions for human review.

### Eval 14: Process Refinement / Rename

Bucket: Reconciliation · Mode: authored scenario, state-graded · Gate: pass^3
hard, nightly.

Success criteria:

- A narrower earlier name is renamed/merged into a fuller later name; evidence
  from both mentions is preserved; only one durable candidate remains.

Task:

- Director first says `Purchasing`; later says `Purchasing and replenishment`.

Outcome contract:

- One durable candidate: `Purchasing And Replenishment`, whose evidence includes
  both turns.

Grader:

- **Gate (code):** single candidate with the merged name; evidence union covers
  both turns.
- **Diagnostic (code):** reconciliation decision (`merge_candidate` /
  `rename_candidate`).

### Eval 15: Scalar Correction

Bucket: Slot reconciliation · Mode: authored scenario, state-graded · Gate:
pass^3 hard after reconciliation ships, nightly.

Success criteria:

- Clear correction wording updates a scalar slot; the prior value is preserved
  as history; the current durable value reflects the correction.

Task:

- Director says frequency is weekly; later: `Actually, it is daily.`

Outcome contract:

- `frequency.volume` current value is daily; the prior weekly value remains
  visible as a prior candidate/evidence.

Grader:

- **Gate (code):** current value == daily; prior weekly still queryable.
- **Diagnostic (code):** `changeKind = correction`.

### Eval 16: Scalar Scope Split

Bucket: Slot reconciliation / ambiguity · Mode: authored scenario, state-graded
+ judge · Gate: report-only until calibrated.

Success criteria:

- Scoped additions are not blindly overwritten or collapsed; the system
  preserves both scoped facts or asks a targeted clarification.

Task:

- Director says frequency is weekly; later: `During month-end it is daily.`

Outcome contract:

- Durable state preserves the weekly baseline and the daily month-end scope, or
  marks the slot unresolved with both candidates.

Grader:

- **Gate (code):** both scoped facts present, or slot marked unresolved with
  both candidates.
- **Judge (report-only):** if the agent asks a clarification, is it useful?
- **Diagnostic (code):** `changeKind = scope_split | needs_clarification`.

### Eval 17: Ambiguity Clarification Escape Hatch

Bucket: Question quality / flow control · Mode: simulated user (anti-loop needs
a dynamic counterparty) · Gate: judge primary — avg ≥ 1.5 over k=5 plus code
support checks pass, once calibrated; report-only until then; nightly.

Success criteria:

- The agent asks at most a small number of targeted clarifications for the same
  unresolved conflict and then stops — it does not loop on the same `mustFire`
  slot.
- If the director stays ambiguous, the conflict becomes acknowledged-but-
  unresolved, counts as covered for rotation/completion, and emits a follow-up
  task.

Task:

- Existing value `Salesforce`; new value `NetSuite`. The simulated director
  stays ambiguous about whether this is a replacement, addition, or scope split
  across two clarification attempts.

Outcome contract:

- Slot is unresolved/conflicting with both values preserved; `follow_up_tasks`
  has a human-resolution task; coverage/rotation treats the slot as covered; the
  next agent question moves forward.

Grader:

- **Judge (primary):** "did the agent loop on the same conflict?" is semantic —
  the judge decides whether two utterances are the same clarification reworded,
  not an exact-string counter. `0/1/2/unknown`.
- **Support (code):** slot state, follow-up task presence, and that a forward
  question eventually fires. Do **not** hard-gate on an exact clarification
  count of one — two clarifications on a genuinely thorny conflict can be
  correct. Gate on "does not loop indefinitely," not on "exactly one."

## Data-Model Invariants (not agent quality)

These test the persistence layer, not the agent's intelligence. They run in the
deterministic/integration suite on every PR, not in
`director.production-regression`, so a failure points at storage drift rather
than a worse director.

### Eval D1: Claim-Backed Slot Storage

Bucket: Data-model invariant · Mode: deterministic/integration · Gate: hard,
every PR. (Formerly listed as a reconciliation agent eval; it is an architecture
invariant.)

Success criteria:

- Claim-backed slots accumulate durable truth in `claims` / entity tables, not
  as independent merged JSON lists in `slot_states.value`.
- `slot_states` remains a coverage/probe summary for claim-backed slots and does
  not become a divergent second source of truth.

Task:

- A fixture interview that mentions multiple systems, roles, pain points, KPIs,
  and dependencies across turns.

Outcome contract:

- Durable facts live in `claims`, `claim_evidence`, and the relevant entity
  tables; `slot_states.value` is not a second source of truth.

Grader:

- **Gate (code):** assert claim/entity rows exist; assert `slot_states.value`
  does not diverge from the claim-backed truth.

## Scorecard

| Eval | Bucket | Task / Mode | Primary grader | Statistic & gate | Cadence |
|---|---|---|---|---|---|
| 1 Process Inventory Extraction & Reconciliation | Extraction/reconciliation | Replay / state | Code | pass^3, hard | Nightly |
| 2 No Repetitive Process Tool Calls | Tool calling | Replay / state | Code | pass^3, hard | Nightly |
| 3 Can Switch To A Named Process | Tool calling | Replay / pinned | Code (+judge report-only) | pass^3 hard on state | Nightly |
| 4 Can Move To The Next Process | Tool calling | Replay / pinned | Code (+judge report-only) | pass^3 hard on state | Nightly |
| 5 Do Not Repeat Questions Already Answered | Question quality | Replay / pinned | Hybrid | pass^3 hard on known-bad; judge report-only | Nightly |
| 6 Question Quality After Correct Switch | Question quality | Replay / pinned | Judge + code support | avg ≥ 1.5 over k=5 once calibrated | Nightly |
| 7 Core Slot Prioritization Before Enrichment | Question quality | Replay / state + pinned | Code (+judge diag) | pass^3, hard | Nightly |
| 8 Do Not Switch Without A Request | Tool calling (neg) | Authored / pinned | Code | pass^3, hard | Nightly |
| 9 Re-Ask After Genuine Non-Answer | Question quality (neg) | Authored / pinned | Judge + code support | judge soft once calibrated | Nightly |
| 10 Scope Mention Demotion | Reconciliation | Authored / state | Code | pass^3 hard after recon ships | Nightly |
| 11 Do Not Over-Promote Weak Scope | Reconciliation (neg) | Authored / state | Code | pass^3 hard after recon ships | Nightly |
| 12 Mid-Interview New Process Creation | Reconciliation | Authored / state | Code (+judge report-only) | pass^3 hard after recon ships | Nightly |
| 13 Process Demotion Then Promotion | Reconciliation | Authored / state | Code (+judge report-only) | pass^3 hard after recon ships | Nightly |
| 14 Process Refinement / Rename | Reconciliation | Authored / state | Code | pass^3, hard | Nightly |
| 15 Scalar Correction | Slot reconciliation | Authored / state | Code | pass^3 hard after recon ships | Nightly |
| 16 Scalar Scope Split | Slot reconciliation | Authored / state + judge | Code + judge | report-only until calibrated | Nightly |
| 17 Ambiguity Clarification Escape Hatch | Flow control | Simulated user | Judge + code support | avg ≥ 1.5 over k=5 + code support, once calibrated | Nightly |
| D1 Claim-Backed Slot Storage | Data-model invariant | Deterministic | Code | hard | Every PR |

## Implementation Backlog

1. Build a `director.production-regression` runner that replays saved production
   transcripts and runs authored scenarios through the production director path
   with the LLM on, in the three fidelity modes (state replay, pinned
   single-turn, simulated user).
2. Implement the three modes:
   - state replay: feed frozen transcript, grade persisted state only.
   - pinned single-turn: load a canonical prefix + state, run one live turn.
   - simulated user: drive turns with a calibrated persona model.
3. Implement the statistics layer: run each eval k times, compute pass^k /
   pass@k / averaged judge score per the scorecard.
4. Store every run in the durable replay DB, tagged with: source production
   capture id, eval suite, fidelity mode, git SHA, model, trial index, run id.
5. Add code graders for the objective outcome contracts; keep trace-enum
   assertions report-only.
6. Stand up the LLM judge with a different judge model, the `unknown` hatch, and
   a small human-labeled seed set per rubric; keep judges report-only until
   ≥90% human agreement.
7. Produce a markdown report per run: pass/fail by eval, failed turns with
   transcript excerpts, capture id for manual TablePlus review, and a diff
   against the previous baseline.
8. Freeze reconciliation outcome contracts (Evals 10-17) before wiring their
   graders; promote each to hard gate only after k stable nightly runs.
9. Add the next independent dogfood incident as incident #2 — breadth beats more
   graders on incident #1.

## Manual Verification Query

Use this while automated reporting is being built (replace `<capture_id>`):

```sql
SELECT
  turn_index,
  sanitized_agent_utterance,
  chosen_intent->>'intent' AS intent,
  chosen_intent->>'target_process' AS target_process,
  delivery_json->'steering_context'->'user_intent_signal' AS user_intent_signal,
  delivery_json->'reconciliation' AS reconciliation,
  jsonb_path_query_array(tool_calls, '$[*] ? (@.name == "recordProcess")') AS process_tools,
  jsonb_path_query_array(tool_calls, '$[*] ? (@.name == "switchFocusCandidate")') AS switch_tools
FROM agent_decision_log
WHERE capture_session_id = '<capture_id>'
  AND stage_name = 'director.turn'
ORDER BY turn_index;
```

## Change Log

- 2026-06-17: Recreated living eval doc and updated incident `71569919` evals
  for the continuous reconciliation model.
- 2026-06-17: Restructured for production fidelity. Added Replay Fidelity Modes,
  Run Cadence & Statistical Gates, LLM Judge Discipline, and Grading Philosophy
  (outcome contracts over trace enums). Restored the Core Slot Prioritization,
  Can Move To The Next Process, and Question Quality After Correct Switch evals
  dropped in the prior rewrite. Added negative twins (Do Not Switch Without A
  Request, Re-Ask After Genuine Non-Answer, Do Not Over-Promote Weak Scope).
  Recategorized Claim-Backed Slot storage as a data-model invariant. Moved the
  ambiguity escape-hatch to simulated-user mode with judge-primary grading and
  relaxed the rigid one-clarification gate. Added trials/statistic/cadence
  columns to the scorecard and cross-linked the deterministic extraction
  fixture.