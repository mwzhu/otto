# Evals

Living document for production-quality evals of Otto agents. Start here when we
turn a production bug, dogfood failure, or product-quality concern into a
standing eval.

## Operating Principles

Use the same four fields for every eval:

| Field | Meaning |
|---|---|
| Success criteria | What must be true for the agent to pass. This should be specific and measurable. |
| Task | The input scenario we run. For production-quality director evals, prefer replaying a real transcript through the real product path with the LLM on. |
| Outcome | The persisted state, tool trajectory, transcript, or final artifact we inspect after the run. |
| Grader | The code, LLM judge, or human review that scores the outcome. Use code graders for objective facts and LLM judges for conversational quality. |

General rules:

- Keep regression evals near-100% pass. They protect bugs we already fixed.
- Keep capability evals harder. They measure whether the agent is getting better.
- Always save the full transcript/trace for failed trials.
- Prefer production-path evals when measuring product quality: live LLM, real
  steering, real voice phrasing, real dispatch, real DB logs.
- Use deterministic/unit evals for narrow invariants, but do not confuse them
  with production agent quality.
- Use multiple graders when needed: state checks, tool-call checks, transcript
  checks, and LLM-as-judge rubrics can all score different parts of the same
  task.

References:

- Anthropic, "Define success criteria and build evaluations":
  https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
- Anthropic, "Demystifying evals for AI agents":
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

## Current Director Eval Gap

Current director evals are strong for deterministic regression checks, but weak
for actual production agent quality.

| Current suite | What it proves | Gap |
|---|---|---|
| Conversational smoke | Deterministic `DirectorTurnPlan` and fallback phrasing match expected exact checks with the model disabled. | Does not score live LLM behavior or natural conversation quality. |
| Extraction regression | Inventory materialization and junk filtering behave correctly on narrow fixtures. | Does not run full production interview behavior. |
| Session verify | A completed voice session has acceptable persisted coverage, latency, cost, and state checks. | Mostly proves the system ran; does not judge whether the live agent asked good questions. |

The new direction: production director evals should replay realistic
multi-turn director interviews through the same path users experience, then
grade extraction, tool actions, and question quality from the resulting traces.

## Production Director Eval Suite

Suite name: `director.production-regression`

Purpose: prevent regressions from real production/dogfood bugs. Each task should
run the actual director agent with live model behavior unless explicitly marked
as deterministic.

Minimum trace artifacts per trial:

- `transcript_segments`
- `agent_decision_log`
- `candidate_processes`
- `slot_states`
- `interview_state`
- `director_extraction_windows`
- full agent utterances
- tool calls and execution status
- model, token, latency, and cost metadata

## Incident 71569919 Eval Set

Source production failure:

```text
71569919-775d-44bd-bd33-f5b6faf096f1
```

Fixed durable replay:

```text
71571571-5715-5715-8715-715715715715
```

This incident becomes a standing regression suite because it exposed four
user-visible failures:

- incorrect processes were created
- the agent asked repeated/generic questions
- the agent asked for things already answered
- the agent would not switch to the requested process

### Eval 1: Process Inventory Extraction Accuracy

Bucket: Extraction accuracy

Success criteria:

- The final candidate process list is exactly:
  - `Order Intake`
  - `Purchasing And Replenishment`
  - `Vendor Invoice Processing`
  - `Inventory Cycle Counts`
  - `New Customer Onboarding And Credit Setup`
  - `Returns And Credit Memos`
- No scope verbs or umbrella phrases become candidates:
  - `Order Management`
  - `Order Picking`
  - `Shipping`
  - `Invoicing`
  - `Purchasing`
  - `Vendor Payments`
- Turn 0 must not create process candidates from the broad remit/scope answer.
- Turn 1 must create the six real processes from the explicit inventory answer.

Task:

- Replay the original failed 21-turn director transcript through the production
  director path.
- Keep the original split shape:
  - turn 0: substantive scope/remit answer
  - turn 1: explicit six-process inventory
- Run with the LLM enabled and persist all traces to the replay DB.

Outcome:

- `candidate_processes` has exactly six rows for the capture.
- The six row names match the expected inventory after canonicalization.
- `debug_director_trace_timeline` shows no candidates after turn 0 and all six
  real candidates after turn 1 extraction.
- Extraction/tool logs may show rejected attempts, but no rejected process name
  is persisted as a candidate.

Grader:

- Code grader.
- Query final `candidate_processes` and compare normalized set equality.
- Query point-in-time trace rows for turn 0 and turn 1.
- Hard fail on any extra candidate, missing candidate, or turn-0 persisted
  candidate.

### Eval 2: No Repetitive Process Tool Calls

Bucket: Agent actions/tool calling

Success criteria:

- On the inventory turn, the agent executes one successful `recordProcess` call
  per real process.
- Compound names stay intact:
  - `Purchasing And Replenishment` must not also produce separate successful
    process writes for `Purchasing` or `Replenishment`.
  - `New Customer Onboarding And Credit Setup` must not also produce separate
    successful process writes for `New Customer Onboarding` or `Credit Setup`.
- The production tool trajectory should be understandable: no duplicate
  successful process write for the same canonical candidate in the same turn.

Task:

- Replay the same failed transcript through the production director path.
- Inspect turn 1 extraction and dispatch traces.

Outcome:

- Turn 1 successful `recordProcess` executions are exactly six.
- The successful names equal the expected inventory set.
- Any repeated or split process attempts are either absent or explicitly marked
  `not_executed` with a clear degraded/rejection reason.

Grader:

- Code grader for executed tool calls.
- Count successful `recordProcess` executions in `agent_decision_log.tool_calls`
  / execution metadata.
- Normalize names and assert no canonical duplicate.
- Hard fail if extra successful writes occur.
- Report-only metric: number of rejected duplicate/split attempts, so we can
  track prompt/tool-call cleanliness even when persistence is protected.

### Eval 3: Can Switch To A Named Process

Bucket: Agent actions/tool calling

Success criteria:

- When the director asks to discuss `Returns`, the agent switches focus to
  `Returns And Credit Memos`.
- The agent uses the explicit `switchFocusCandidate` action for the focus
  change.
- The persisted `interview_state.focus_candidate_process_id` points to the
  `Returns And Credit Memos` candidate.
- The next agent utterance names the selected process rather than asking a
  generic "which process" question.

Task:

- Replay the same failed transcript through the production director path.
- Use the real turns where the director says variants of:
  - `Returns`
  - `No. Switch right now.`
  - `Let's talk about returns and credit memos.`

Outcome:

- On the relevant turns, `delivery_json.steering_context.user_intent_signal`
  classifies the director request as a focus switch.
- `tool_calls` contains `switchFocusCandidate`.
- The `switchFocusCandidate` execution succeeds.
- `chosen_intent.target_process` and the spoken utterance both refer to
  `Returns And Credit Memos`.

Grader:

- Code grader for state and tool-call facts.
- Optional LLM judge for utterance helpfulness:
  - pass if the response acknowledges or naturally follows the requested
    process switch
  - fail if it ignores the switch or asks the director to choose again
- Hard fail if focus does not persist to `Returns And Credit Memos`.

### Eval 4: Can Move To The Next Process

Bucket: Agent actions/tool calling

Success criteria:

- When the director asks to move on, the agent switches to another real
  candidate process.
- The agent does not bounce between phantoms or already rejected names.
- The next target process is one of the six real inventory candidates.
- The agent names the process it is moving to.

Task:

- Replay the same failed transcript through the production director path.
- Inspect the turns where the director indicates they want to move on or cover
  another process.

Outcome:

- `user_intent_signal.action` is `switch_focus_next` when appropriate.
- `switchFocusCandidate` succeeds.
- `chosen_intent.target_process` is a real candidate.
- Agent utterance names the next process.

Grader:

- Code grader for intent signal, tool action, focus state, and target candidate
  validity.
- LLM judge report-only for conversational naturalness:
  - score whether the transition felt responsive and non-confusing.

### Eval 5: Do Not Repeat Questions Already Answered

Bucket: Question quality

Success criteria:

- The agent should not ask for the process list again after the director has
  already provided the six-process inventory.
- The agent should not ask generic "which process should we focus on" questions
  when the director has already named a process or requested the next one.
- The agent should ask a useful next question about the current focused process.
- Repeated questions are allowed only when the director gave a non-answer,
  contradiction, or explicit request to repeat/clarify.

Task:

- Replay the same failed transcript through the production director path.
- Inspect agent utterances after turn 1, especially turns 11-20.

Outcome:

- No post-inventory agent utterance asks for the already-known full process
  inventory.
- No turn with a known target process uses a generic process-selection prompt.
- The utterance either asks about the selected process boundary, people,
  systems, pain, metrics, exception handling, or another missing slot.

Grader:

- Hybrid grader.
- Code checks:
  - reject known bad strings such as `Which process should we focus on first?`
    after inventory is known
  - reject generic process-selection intent when `target_process` is already
    known
  - assert `chosen_intent.target_process` is present when the agent is drilling
    into a process
- LLM judge:
  - judge whether the question is redundant given the transcript so far
  - output `pass` or `fail` plus a short reason
- Human calibration:
  - periodically review a sample of LLM-judge failures to make sure the rubric
    matches product expectations.

### Eval 6: Question Quality After Correct Switch

Bucket: Question quality

Success criteria:

- After switching to the requested process, the agent asks a question that moves
  the interview forward.
- The question should be specific enough that the director knows which process
  is being discussed.
- The question should not imply the conversation is still at the initial
  process-selection stage.

Task:

- Replay the same failed transcript through the production director path.
- Focus on turns after the director asks for `Returns`.

Outcome:

- Agent utterance includes or clearly refers to `Returns And Credit Memos`.
- The selected probe intent targets a missing/partial slot for that process.
- The question is not a duplicate of an earlier answered question.

Grader:

- LLM-as-judge primary grader with a strict rubric:
  - `2`: specific, non-redundant, process-aware, moves interview forward
  - `1`: acceptable but generic or slightly repetitive
  - `0`: ignores switch, repeats answered material, or asks the user to choose
    a process again
- Code support checks:
  - target process exists
  - focus state matches target process
  - no known bad generic phrases
- Gate initially at average score `>= 1.5`; promote to hard regression once
  stable.

### Eval 7: Core Slot Prioritization Before Enrichment

Bucket: Question quality

Success criteria:

- The agent completes the director core slots for the current real process
  before asking non-core enrichment questions.
- Core slots are:
  - `scope.boundaries`
  - `outcomes.business_outcomes`
  - `ownership.roles`
  - `systems.systems_of_record`
  - `frequency.volume`
  - `friction.pain_points`
  - `risk.spofs`
- Before every real candidate has core coverage, the agent should rotate to the
  next under-covered process instead of asking enrichment questions about an
  already-covered process.
- Non-core enrichment questions, especially `capture_controls` and
  `capture_documentation`, must not appear while any real candidate still lacks
  core coverage unless the director explicitly asks about those topics.
- If the current process has core coverage but another real candidate does not,
  the next question should name the next real candidate and ask for its missing
  core information.

Task:

- Replay the same failed transcript through the production director path.
- Inspect turns after the initial six-process inventory, especially the section
  where the historical agent asked controls/compliance and documentation
  maturity before covering the other processes.

Outcome:

- For every `director.turn` decision before full core coverage, the
  `chosen_intent.target_slot` is one of the core slots or the intent is
  `select_process_to_expand` for a real under-covered candidate.
- No `capture_controls`, `capture_documentation`, or other non-core enrichment
  intent is chosen before all real candidates have core coverage.
- The agent utterance names the target process when rotating between
  candidates.
- The trace shows progress through the six real candidates rather than staying
  on one process for enrichment.

Grader:

- Code grader primary.
- Compute projected core coverage from `slot_states`, `slot_updates`, and
  candidate focus state in `agent_decision_log`.
- Hard fail when a non-core enrichment intent appears before full core coverage
  and the director did not explicitly request that topic.
- Hard fail when the agent stays on an already core-covered process while
  another real candidate lacks core coverage.
- Report-only LLM judge:
  - score whether the sequence feels like a coherent interview plan
  - flag abrupt jumps into compliance, controls, documentation, or maturity
    before the foundational process facts are captured.

## Scorecard For This Bug Fix Session

| Bucket | Eval | Primary grader | Gate |
|---|---|---|---|
| Extraction accuracy | Process Inventory Extraction Accuracy | Code | Hard fail |
| Agent actions/tool calling | No Repetitive Process Tool Calls | Code | Hard fail for successful duplicate writes; report rejected duplicate attempts |
| Agent actions/tool calling | Can Switch To A Named Process | Code + optional LLM judge | Hard fail for state/tool failure |
| Agent actions/tool calling | Can Move To The Next Process | Code + report-only LLM judge | Hard fail for invalid target |
| Question quality | Do Not Repeat Questions Already Answered | Hybrid | Hard fail for known bad patterns; LLM judge initially report-only |
| Question quality | Question Quality After Correct Switch | LLM judge + code support | Report-only until calibrated |
| Question quality | Core Slot Prioritization Before Enrichment | Code + report-only LLM judge | Hard fail for non-core enrichment before full core coverage |

## Implementation Backlog

1. Create a `director.production-regression` runner that replays saved
   production transcripts through the production director path with the LLM on.
2. Store every eval run in a durable replay DB and tag it with:
   - source production capture id
   - eval suite
   - git SHA
   - model
   - run id
3. Add code graders for the objective checks in this document.
4. Add an LLM judge for director question quality with a small human-calibrated
   seed set.
5. Produce a markdown report per run:
   - pass/fail by eval
   - failed turns with transcript excerpts
   - DB capture id for manual TablePlus review
   - diff against the previous baseline
6. Promote the incident `71569919` replay to a permanent regression task.

## Manual Verification Query

Use this query for the fixed replay while the automated report is being built:

```sql
SELECT
  turn_index,
  sanitized_agent_utterance,
  chosen_intent->>'intent' AS intent,
  chosen_intent->>'target_process' AS target_process,
  delivery_json->'steering_context'->'user_intent_signal' AS user_intent_signal,
  jsonb_path_query_array(tool_calls, '$[*] ? (@.name == "recordProcess")') AS process_tools,
  jsonb_path_query_array(tool_calls, '$[*] ? (@.name == "switchFocusCandidate")') AS switch_tools
FROM agent_decision_log
WHERE capture_session_id = '71571571-5715-5715-8715-715715715715'
  AND stage_name = 'director.turn'
ORDER BY turn_index;
```

## Change Log

- 2026-06-17: Created initial living eval doc from the director gate/focus
  incident. Added extraction accuracy, tool-calling, focus switching, and
  question-quality evals.
- 2026-06-18: Added core-slot prioritization eval to catch controls,
  compliance, and documentation questions before foundational process coverage
  is complete.
