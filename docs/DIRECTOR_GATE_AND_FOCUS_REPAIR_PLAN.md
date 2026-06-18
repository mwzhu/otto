# Director Gate And Focus Repair Plan

**Status:** Implemented in working tree (2026-06-13)

**Incident:** prod director session `71569919-775d-44bd-bd33-f5b6faf096f1`
(2026-06-13, workspace `776a78f5`). The director provided a substantive remit
answer on turn 0 and then an explicit six-process inventory on turn 1. The system
minted candidates from the turn-0 scope sentence, rejected most of the real
turn-1 inventory, stayed focused on phantom `Order Management`, and later failed
to honor repeated requests to switch to `Returns`.

## Executive Summary

This is a state-machine failure that surfaced as conversation quality collapse.
The extraction model did identify the real six-process list on turn 1, but
dispatch rejected most of those `recordProcess` calls because candidate minting
was gated on mutable, already-advanced `interview_state.prior_intent`.

The fix is not to loosen process minting generally. That would reopen the
scope-sentence junk class that prior rounds closed. The durable repair is:

1. Gate candidate minting from the actual per-turn prompting context, not
   mutable advanced interview state.
2. Allow explicit director enumerations even when they arrive in response to the
   opening orient question.
3. Resolve director-named process choices to existing candidates and switch
   focus.
4. Only repair missing candidates from prior explicit enumeration evidence, not
   arbitrary mid-conversation mentions.

## Implementation Notes

The working-tree implementation follows the plan with a few extra hardening
steps discovered during regression testing:

- Extraction now passes `extraction_window_id` into dispatch and reads the
  window's persisted prompting context before authorizing candidate minting.
- Respond-window metadata persists `enumerated_process_names`, giving later
  repair logic an evidence-backed source list.
- Explicit enumeration detection distinguishes list-style inventory answers
  from scope-chain narration.
- Named process requests resolve before generic focus rotation, including bare
  target answers such as `Returns`.
- Explicit focus-switch phrasing now wins over low-information/non-answer
  phrasing, so `No. Switch right now.` still speaks the selected target instead
  of falling back to a generic orient question.
- Repeated switch requests soft-exclude recently offered targets before
  falling back, which prevents bouncing between two candidates while preserving
  a recovery path when every process has been touched.
- Candidate repair is limited to canonical names from stored inventory,
  extraction-window enumerations, or the current explicit enumeration.
- Deterministic claim tools are merged back into LLM extraction results so
  targeted metrics/dependencies survive model omissions.
- Candidate/process name matching is plural-tolerant, and candidate display
  names plus named claim values are canonicalized before durable writes.
- A DB integration replay now uses the full 21-turn director transcript from
  prod session `71569919`. It asserts the six real candidates, rejects the
  phantom candidates, runs the repeated switch/name turns through live
  deterministic steering, verifies focus ends on `Returns And Credit Memos`,
  and rejects the repeated generic prompt loop.

## Ground Truth

Director turn 0 was a broad remit/scope answer:

> "I oversee the I'm the VP of operations. I own everything from when a customer
> order comes in through getting it picked. Shipped, invoiced, plus purchasing
> and or vendor payments."

Director turn 1 was the actual explicit process inventory:

> "Six big ones, order intake. Taking customer orders into the system.
> Purchasing and replenishment. Vendor invoice processing, inventory cycle
> counts, new customer onboarding and credit setup, and returns and credit
> memos."

Correct inventory:

| # | Process |
|---|---|
| 1 | order intake |
| 2 | purchasing and replenishment |
| 3 | vendor invoice processing |
| 4 | inventory cycle counts |
| 5 | new customer onboarding and credit setup |
| 6 | returns and credit memos |

Actual stored candidates:

| Candidate | Verdict |
|---|---|
| Order Management | Phantom umbrella from turn 0 |
| Order Picking | Scope verb/sub-step from turn 0 |
| Shipping | Scope verb/sub-step from turn 0 |
| Invoicing | Scope verb/sub-step from turn 0 |
| purchasing and replenishment | Real, merged from turn 1 |
| Vendor Payments | Scope phrase from turn 0 |

Turn-1 extraction emitted `recordProcess` calls for the real names, but most were
`not_executed`: `order intake`, `vendor invoice processing`,
`inventory cycle counts`, `new customer onboarding and credit setup`, and
`returns and credit memos`. Only `purchasing and replenishment` survived because
it token-overlapped the turn-0 `Purchasing` candidate.

## Root Causes

### RC1 - Candidate Minting Uses Advanced State

Current gate in `otto-frontend/lib/interview/director/brain.ts`:

```ts
const allowCandidateMinting =
  state.currentPhase === "inventory" ||
  state.priorIntent === "discover_processes";
```

The respond path dispatches with `advanceConversationState: true` and writes
`priorIntent: chosenIntent.intent`. The extract path later dispatches with
`advanceConversationState: false`, so extraction reads a value that represents
what the agent just decided to ask next, not the prompt the director just
answered.

In this incident:

| Director turn | What user answered | Respond chose next | Gate effect |
|---|---|---|---|
| 0 | Opening orient question | `discover_processes` | Opened on scope sentence |
| 1 | Process inventory question | `define_process_boundary` | Closed on real list |

### RC2 - Earlier Runs Worked By Accident

Earlier session `667b5809` did not expose the bug because turn 0 was low-info
(`"Hello?"`). That buffer turn kept the gate aligned long enough for the real
list to arrive while minting was open. A substantive-but-non-inventory turn 0
flips the gate one turn early.

### RC3 - No Named-Process Focus Resolution

When the director later said `Returns` or `let's talk about returns and credit
memos`, the system had no deterministic path to resolve that named process and
switch focus. The current switch detector recognizes only some "other/next
process" shapes and does not handle direct target names.

### RC4 - No Guarded Repair Path

Once `returns and credit memos` was rejected from turn 1, later mentions of
`Returns` could not recover the candidate. However, arbitrary "mint missing
candidate when mentioned" would reintroduce scope-junk minting. Repair must be
limited to names grounded in prior explicit enumeration evidence.

## Design Principles

- **Prompt compliance is not the backstop.** The model violated the existing
  instruction to avoid minting scope sentence verbs. The deterministic gate must
  be correct.
- **Resolution before creation.** If the director names a process, first resolve
  it to an existing candidate and switch focus. Do not create by default.
- **Enumeration evidence is special.** Explicit list utterances can authorize
  candidate minting. Broad remit/scope narration cannot.
- **Keep speech and state together.** If the agent says it is switching, the
  stored `focus_candidate_process_id` must move in the same turn.
- **Treat repeat-question hardening as defense-in-depth.** The main fix is state
  and resolution; repeated prompts are symptoms but should still be guarded.

## Implementation Plan

### P0. Replace The Minting Gate Source

Add a durable per-turn prompting signal for extraction to consult. Prefer this
order:

1. The probe firing that produced the agent utterance the director is answering.
2. The `last_spoken_intent` / `last_spoken_objective` already present in
   `steering_context`, if it is proven durable and consistent.
3. A persisted field on the extraction window tying turn `N` to the spoken
   intent from turn `N - 1`.

Update candidate minting to use that signal:

```ts
allowCandidateMinting =
  promptingIntentForExtractionWindow === "discover_processes" ||
  directorUtteranceIsExplicitEnumeration(windowDirectorText);
```

Acceptance criteria:

- Turn 0 scope answer to the opening orient prompt does not mint `Order Picking`,
  `Shipping`, `Invoicing`, `Order Management`, or `Vendor Payments`.
- Turn 1 explicit six-process answer to `discover_processes` mints/merges the
  six real candidates.
- Extraction no longer depends on `interview_state.priorIntent` for candidate
  mint authorization.

### P0. Add Deterministic Explicit-Enumeration Detection

Implement a deterministic detector for director-owned process lists. This is
needed for users who answer the opening question with the full inventory before
the agent asks `discover_processes`.

Strong positive signals:

- Count/list phrases: `six big ones`, `the main ones are`, `we manage:`,
  `processes are`, `there are N`, `first/second/third`, semicolon/comma
  separated noun phrases.
- Two or more plausible process names in one director utterance.
- The utterance is framed as an inventory/list, not a single process narrative.

Strong negative signals:

- Scope-chain language: `from X through Y`, `when an order comes in through`,
  `picked, shipped, invoiced`, `plus purchasing/vendor payments`.
- Step narration: `first`, `then`, `after that` describing one workflow rather
  than naming owned process areas.
- Generic ownership phrases: `all of it`, `everything`, `the whole thing`.

Acceptance criteria:

- `Six big ones, order intake, purchasing and replenishment, vendor invoice
  processing...` returns true.
- `I own everything from customer order comes in through picked, shipped,
  invoiced, plus purchasing and vendor payments` returns false.
- A list-in-orient-answer fixture creates the intended inventory.

### P0/P1. Resolve Named Process Requests To Existing Candidates

Add deterministic named-process focus resolution before generic rotation.

Flow:

1. Detect whether the director utterance names a process or process fragment.
2. Fuzzy/token-match against existing candidate names and aliases.
3. If one strong match exists, force `select_process_to_expand` with that target
   and set `focus_candidate_process_id`.
4. If multiple matches exist, ask one disambiguating question.
5. If no match exists, fall through to guarded repair.

Examples:

| Utterance | Expected behavior |
|---|---|
| `Returns` | Resolve to `returns and credit memos` if present; switch focus |
| `Let's talk about returns and credit memos` | Resolve exact/compound match; switch focus |
| `What is order picking?` | If existing candidate, either clarify or switch depending on intent |
| `credit` | Ambiguous between credit setup and credit memos; ask disambiguation |

Acceptance criteria:

- In a corrected replay of session `71569919`, turn 17/18 switches to
  `returns and credit memos`, not `Order Picking` or `Order Management`.
- The agent's spoken utterance and persisted focus candidate agree.

### P1. Add Guarded Missing-Candidate Repair

If named-process resolution fails because the candidate is missing, only mint a
repair candidate when the requested name can be matched to prior explicit
enumeration evidence from the director.

Repair source rules:

- Allowed: names from a prior utterance classified by
  `directorUtteranceIsExplicitEnumeration`.
- Allowed: aliases/fragments of those names, e.g. `Returns` ->
  `returns and credit memos`.
- Not allowed: arbitrary nouns from scope sentences, step narration, system
  names, role names, or one-off mid-drilldown mentions.

Acceptance criteria:

- If turn 1 enumeration was previously blocked, later `Returns` can repair and
  switch to `returns and credit memos`.
- The turn-0 scope sentence still cannot repair/create `Order Picking`,
  `Shipping`, `Invoicing`, or `Vendor Payments`.
- Repair events are logged with source evidence id(s) and a clear reason.

### P1. Broaden Explicit Switch Detection

Expand `directorRequestedFocusSwitch` or replace it with a structured directive
classifier that covers:

- `let's switch to another process`
- `switch right now`
- `switch it out`
- `move on`
- `let's talk about X`
- bare target answers after a focus-selection prompt, e.g. `Returns`

Acceptance criteria:

- All actual switch utterances from session `71569919` are detected.
- Narration negatives still do not trigger, e.g. `it switches systems after
  approval`, `the process moves on to shipping`.

### P2. Harden Repeat And Oscillation Guards

After P0/P1, add defense-in-depth so generic rotation phrasing cannot repeat
verbatim across adjacent turns and target selection cannot oscillate between two
bad candidates.

Acceptance criteria:

- `Which process should we focus on first?` is not emitted repeatedly when it
  appears in recent `do_not_ask`.
- Focus rotation skips candidates already attempted unless the director
  explicitly asks for them.
- Closeout does not claim a named process was covered when only a rejected
  candidate mention exists.

### P2. Fix Or Explain `last_new_slot_turn_index`

In session `71569919`, `last_new_slot_turn_index` stayed `null` despite many
filled/partial slots. Investigate whether this is expected because extraction
does not advance conversation state, or whether stall detection is effectively
disabled.

Acceptance criteria:

- New meaningful slot coverage updates the stall signal or an explicit
  replacement signal is documented.
- Forced closeout and low-info counters are not the only stall protection.

## Eval Fixtures

Add fixtures that replay the boundary cases rather than only the happy path.

### Fixture A - Substantive Scope Then Explicit List

Turns:

1. Agent opening orient question.
2. Director: `I am VP of Ops. I own everything from customer order comes in
   through picked, shipped, invoiced, plus purchasing and vendor payments.`
3. Agent asks inventory / `discover_processes`.
4. Director: `Six big ones: order intake, purchasing and replenishment, vendor
   invoice processing, inventory cycle counts, new customer onboarding and
   credit setup, returns and credit memos.`

Expected:

- Exactly six real candidates.
- No `Order Management`, `Order Picking`, `Shipping`, `Invoicing`, or
  `Vendor Payments` unless reconciled into real compound names.
- Focus selection starts from a real candidate.

### Fixture B - Full List In Opening Answer

Turns:

1. Agent opening orient question.
2. Director: `I'm VP of Ops. The six big recurring processes are order intake,
   purchasing and replenishment, vendor invoice processing, inventory cycle
   counts, new customer onboarding and credit setup, and returns and credit
   memos.`

Expected:

- Explicit enumeration detector opens minting.
- Exactly six real candidates.
- Agent does not re-ask the process inventory.

### Fixture C - Named Process Switch

Start from a valid inventory with `returns and credit memos`.

Turns:

1. Agent is focused on another candidate.
2. Director: `Let's actually talk about returns and credit memos.`
3. Director: `Returns.`

Expected:

- Focus switches to `returns and credit memos`.
- No generic `Which process should we focus on first?` loop.

### Fixture D - Guarded Repair

Start from prior explicit enumeration evidence that includes
`returns and credit memos`, but simulate candidate creation failing.

Turns:

1. Director: `Returns.`

Expected:

- System repairs/mints `returns and credit memos` from prior enumeration
  evidence and switches focus.
- The repair log references the original enumeration evidence.

### Fixture E - Scope Narration Negative

Turns:

1. Director: `I own everything from an order coming in through being picked,
   shipped, and invoiced.`

Expected:

- No candidate minting from `picked`, `shipped`, or `invoiced`.
- No process inventory slot marked filled by scope narration alone.

## Suggested Test Targets

- `otto-frontend/tests/phase1/director-steering.test.ts`
  - switch detection
  - named-process resolution
  - repeat/oscillation guard
- `otto-frontend/tests/phase1/director-extraction-quality.test.ts`
  - replay fixtures for candidate inventory
  - scope-negative and explicit-enumeration-positive cases
- `otto-frontend/tests/phase1/db.integration.test.ts`
  - dispatch-level minting gate
  - guarded repair path with evidence ids
  - focus_candidate_process_id updates during named switch

## Deployment Verification

After implementation:

1. Run unit/integration tests for director steering and extraction.
2. Replay fixture A locally and verify candidate table contains exactly six real
   candidates.
3. Replay fixture C locally and verify speech target and
   `interview_state.focus_candidate_process_id` agree.
4. Run a hosted director interview with:
   - turn 0 substantive remit/scope sentence,
   - turn 1 explicit six-process inventory,
   - later switch request to `Returns`.
5. Inspect prod rows:
   - `candidate_processes`
   - `probe_firings`
   - `agent_decision_log.tool_calls.execution`
   - `interview_state.focus_candidate_process_id`

Success criteria:

- No phantom candidates from scope sentence.
- Real six-process inventory is captured.
- Named switch to `Returns` is honored immediately.
- No repeated generic focus-selection loop.

## Non-Goals

- Do not loosen general `recordProcess` minting for arbitrary process-looking
  nouns.
- Do not rely on model prompt changes as the primary fix.
- Do not treat repeated wording as the root cause; fix it after gate and
  resolution correctness.
- Do not clean historical prod rows as part of the code fix unless separately
  requested.
