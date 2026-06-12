# Director Extraction Quality Plan: Transcript → High Level Overview

**Status:** v3, IMPLEMENTED (2026-06-11) — diagnosis from prod session `e919bb61-0b32-43ba-813a-9548fcf470eb` (2026-06-11, 20:04–20:09 UTC, workspace `776a78f5`). v2 incorporated external review: race-safe reconciliation locking (A3), write-side person→candidate links (C1), metadata merge precedence for collapsed candidates (A1), schema-realistic gating signals (B1). v3 (review round 2): dispatch must honor materialized per-call evidenceIds (A1), and the B1 gate must depend only on pre-existing conversation state, not the plan's own slot updates.

**Implementation notes:** A1–A3, B1–B3, C1–C4, D1–D2, E1–E2 are implemented.
Post-implementation review (round 3) hardened three spots: (1) the B1 gate
also drops `process.inventory` slot updates on gated turns, so a scope answer
cannot mark the inventory slot filled with junk names behind no candidates;
(2) `recordPerson` receives a candidate id only when the tool arguments
explicitly reference a process (`explicitCandidateProcessIdForTool`, no
focus-candidate fallback) so passing mentions don't inflate per-card people
counts; (3) `recordProcess`'s write-time guard uses the full shared
`isPlausibleCandidateProcessName` predicate (junk + narration + system names),
not just the junk subset, so direct callers like the document pipeline cannot
insert names the brain would reject.
Shared name rules live in `otto-frontend/lib/candidate-processes/name-quality.ts`;
the prod replay fixture in `evals/director/extraction-quality-prod-e919bb61.json`
(consumed by `tests/phase1/director-extraction-quality.test.ts`); reconciliation,
session-lock race, and works_on people-count integration tests in
`tests/phase1/db.integration.test.ts`. `works_on` was added to
`multiValueClaimFields` in write-claim.ts so one person can link to several
candidates. D2 script: `scripts/cleanup-stale-candidates.mjs` (dry-run verified
against prod: 72 stale candidates; run with `--apply` to archive, or let D1
supersede them on the next completed interview). Remaining ops (E3): deploy,
re-run the interview script in prod, verify 6 cards / SPOF ≥ 1 / scoped
complexity / per-candidate people counts.

## Symptom

A ~5 minute director interview where the director explicitly enumerated **6 processes**
produced an overview showing **18 Processes Captured, 0% Documentation Coverage,
Complexity 26/100, 0 Single Points of Failure**, with duplicate cards (Purchasing /
Purchasing And Replenishment / Replenishment) and junk cards (Six Big Ones, All Of It),
plus People = 6 on every single card.

## Ground truth (prod transcript)

The director said, verbatim (transcript_segments for the session):

- **Turn 0** (role/scope answer): "I own everything from when a customer order comes in
  through getting it **picked, shipped, and invoiced** plus **purchasing** in our
  **vendor payments**."
- **Turn 1** (the inventory enumeration): "we manage **six big ones**: **order intake**,
  **purchasing and replenishment**, **vendor invoice processing** (our AP),
  **inventory cycle counts**, **new customer onboarding and credit setup**, and
  **returns and credit memos**."
- **Turn 2**: "No. We manage **all of it**." (answer to a cross-department-ownership probe)
- Turns 3–9: order intake drilldown (Gmail, Odoo, Marcus's Google Sheet as real price
  list, Priya, Tom, 40–60 orders/day).

Correct candidate inventory: **exactly 6**. Marcus's sheet is a real SPOF signal.

## What was actually created (candidate_processes for the session)

| # | proposed_name | Source utterance | Verdict |
|---|---|---|---|
| 1 | Order Intake | turns 0+1+3 (evidence merged, ev=3) | ✅ real |
| 2 | Purchasing And Replenishment | turn 1 | ✅ real |
| 3 | Vendor Invoice Processing | turn 1 | ✅ real |
| 4 | Inventory Cycle Counts | turn 1 | ✅ real |
| 5 | New Customer Onboarding And Credit Setup | turn 1 | ✅ real |
| 6 | Returns And Credit Memos | turn 1 | ✅ real |
| 7 | Order Picking | turn 0 "picked" | ❌ sub-step of scope sentence |
| 8 | Shipping | turn 0 "shipped" | ❌ sub-step |
| 9 | Invoicing | turn 0 "invoiced" | ❌ sub-step |
| 10 | Purchasing | turn 0 / turn 1 split | ❌ atom of #2 |
| 11 | Vendor Payments | turn 0 | ❌ scope phrase (≈ #3) |
| 12 | Replenishment | turn 1 split | ❌ atom of #2 |
| 13 | New Customer Onboarding | turn 1 split | ❌ atom of #5 |
| 14 | Credit Setup | turn 1 split | ❌ atom of #5 |
| 15 | Returns | turn 1 split | ❌ atom of #6 |
| 16 | Credit Memos | turn 1 split | ❌ atom of #6 |
| 17 | Six Big Ones | turn 1 "we manage six big ones" | ❌ quantifier phrase |
| 18 | All Of It | turn 2 "we manage all of it" | ❌ pronoun answer |

Notable: the junk/split candidates carry confidence **0.78–0.95** while the real compound
names carry **0.74** — confidence does not discriminate junk from signal, so a
confidence-threshold "fix" would actively make things worse. Earlier sessions in the same
workspace show the same failure classes plus ASR-driven junk: "RAP" (= "our AP"),
"Out Of Stock", "Not Very Proactive", "It's Very Reactive", "Pick", "Ship",
"Pick And Ship", "Invoiced".

## Root causes

### RC1 — Direct `recordProcess` tool calls bypass every deterministic guard

The Task 7 dedup (`collapseRelatedCandidateProcesses`, token-subset collapse so
"Purchasing"/"Replenishment" fold into "purchasing and replenishment") and the
plausibility filter (`isPlausibleDirectorProcessName`) only run on names sourced from
`process.inventory` slot updates and `recordCandidateProcessClaim(proposed_name)` tools —
see `directorProcessCandidatesFromPlan` (otto-frontend/lib/interview/director/brain.ts:1139-1178)
and `isProposedNameCandidateTool` (brain.ts:1313-1318).

When the extractor emits **direct `recordProcess` tool calls** (which it did for all 18),
`materializeDirectorProcessInventory` retains them untouched: the
`retainedToolCalls` filter (brain.ts:1102-1106) keeps every non-claim tool, and
`seenRecordProcesses` (brain.ts:1107-1112) only suppresses *exact-normalized-name*
re-emission. Result: compound+atoms+junk all land in the DB in one turn even though the
collapse logic that handles exactly this case already exists three functions away.

### RC2 — No cross-turn / cross-name reconciliation in `recordProcess`

`recordProcess` (otto-frontend/lib/interview/director/tools.ts:296-395) dedups by
`lower(proposed_name) =` **exact match** within the session. Turn 0's "Purchasing"
survives turn 1's "Purchasing And Replenishment" because the strings differ. Nothing ever
revisits earlier candidates as later turns refine the inventory.

### RC3 — Scope/ownership answers mined as process enumerations

Turn 0 was an answer about the director's *role scope*, not a process list, but the
extractor minted 6 candidates from its verbs ("picked, shipped, invoiced…"). The prompt
(prompts/director.turn.plan.md:87-108) forbids sub-step promotion, but nothing
deterministic enforces it, and extraction is not gated on the interview phase/probe
(inventory enumeration happens at turn 1 in response to the inventory probe).

### RC4 — Junk-name filtering is a tiny hardcoded list applied only at read time

`genericCandidateProcessNames` (otto-frontend/lib/synthesis/inventory.ts:42-51) and the
copy in overview queries (otto-frontend/lib/overview/queries.ts:67-76, 233-242) only block
8 "things"-style strings. "Six Big Ones", "All Of It", "It's Very Reactive", "RAP" all
pass. Junk rows are written to the DB and scored by synthesis (Six Big Ones got a
complexity score of 23).

### RC5 — Overview metric queries are wrong independently of extraction

All in otto-frontend/lib/overview/queries.ts:

- **People = 6 on every card**: the `person_claim` join (queries.ts:202-208) has **no
  condition linking the person to the candidate** — it joins every active person-role
  claim in the workspace to every card. The workspace has 6 distinct persons with role
  claims (4 real + stale dupes), so every card shows 6.
- **Doc coverage 0% tile vs 100% on cards**: the tile counts only
  `evidence_label = 'documented'` (queries.ts:106-111) — correct for "documentation",
  and 0 is honest for a voice-only interview — while the card field is
  `evidence_count > 0 ? 1 : 0` (queries.ts:330), i.e. *any* stated evidence. Two
  contradictory definitions of "doc coverage" on one screen.
- **Complexity 26/100 is workspace-wide, not session-scoped**: the `complexity` CTE
  (queries.ts:79-93) ignores both the inventory CTE and `captureSessionId` — it averages
  all 39 active complexity claims in the workspace (incl. older test sessions and junk
  candidates). Verified: workspace-wide avg = 26, matching the tile.
- **SPOF = 0 despite Marcus**: the tile counts `field='risk' AND value ILIKE
  '%single_point_of_failure%'` (queries.ts:113-122) — the shape `recordSpof`
  (tools.ts:530-549) writes. But the brain never called `recordSpof`; it recorded the
  Marcus signal as a generic person claim `field='single_point_of_failure', value=true`
  (confidence 0.45). Vocabulary mismatch → 0.

### RC6 — Cross-session accumulation

The workspace has **90 pending candidates** across 6+ interview sessions (every re-test
re-mints the inventory; nothing supersedes prior pending candidates). The cards view
happens to be scoped by the `capture_session_id` query param (app/overview/page.tsx:22-33),
but tile metrics (complexity, SPOF, doc-coverage joins) and the unscoped default view mix
all sessions. Synthesis (`runInventorySynthesis`) also scores per session, leaving stale
scored claims behind.

## Fix plan

### Phase A — deterministic guards (no LLM changes; highest leverage)

**A1. Funnel direct `recordProcess` tool calls through the materializer.**
In `directorProcessCandidatesFromPlan` (brain.ts:1139), also collect names from
`tool_calls` with `name === 'recordProcess'`, and drop the originals from
`retainedToolCalls` so the only `recordProcess` calls that dispatch are the
materialized, collapsed, plausibility-checked ones. This alone removes the turn-1 atoms
(#10, #12–16) and applies the name filter to everything.

The materialized candidate model (brain.ts:1140) today carries only `name`,
`confidence`, `proposedFunction`, and the emitted calls (brain.ts:1120) only those
fields — but direct `recordProcess` calls can carry `frequency`, `complexityHint`, and
`evidenceIds`. Extend the model with those as optionals and define merge precedence when
the collapse folds several calls into one survivor:
- the survivor's own non-null field always wins;
- otherwise inherit from collapsed members in descending confidence order, first
  non-null wins (so an atom's `frequency` survives onto the compound — matching prod,
  where "purchasing and replenishment" only had frequency because the "Purchasing" atom
  carried it);
- `evidenceIds` are unioned across survivor + collapsed members.
This is consistent with `recordProcess`'s update path, which already merges with `??`
semantics (tools.ts:330-340).

**Dispatch must honor the materialized `evidenceIds`.** Today the recordProcess dispatch
loop ignores `tool.arguments.evidenceIds` entirely and always passes the turn's full
`input.evidenceIds` (brain.ts:1765-1774). Without changing that, the union above is dead
code: per-call evidence attribution is overwritten by the blanket turn set. Update the
dispatch to use the materialized call's `evidenceIds` when present — filtered against
`input.evidenceIds`, matching the existing evidence-preflight discipline — and fall back
to `input.evidenceIds` only when the tool carries none.
*Acceptance:* unit tests — (1) a plan whose tool_calls contain recordProcess("Purchasing
And Replenishment"), recordProcess("Purchasing"), recordProcess("Replenishment")
dispatches exactly one recordProcess with the compound name; (2) when only the
"Purchasing" atom carries `frequency`, the surviving compound call carries that
frequency and the union of all three calls' evidenceIds.

**A2. Junk-name rejection at write time.**
Extend `isPlausibleDirectorProcessName` (brain.ts:5819) with the observed failure
classes, and enforce the same predicate inside `recordProcess` (tools.ts) as
defense-in-depth (a junk name returns without inserting; log to tool execution log):
- quantifier/pronoun phrases: `^(all|some|most|everything|it|that|those|six|seven|\d+)\b.*\b(it|ones?|things?|them)$`-style patterns, plus literal "all of it", "the big ones", "N big ones";
- sentence fragments / sentiment: starts with "it's", "not very", "very", contains no noun ("Not Very Proactive", "It's Very Reactive");
- bare verbs from scope descriptions: "pick", "ship", "invoiced", "pick and ship" (≤1 significant token that is a common verb);
- single ALL-CAPS tokens ≤4 chars that aren't in the known-systems list ("RAP") — likely ASR artifacts.
Keep the list data-driven: move it next to `genericCandidateProcessNames` and share one
module between brain, tools, synthesis, and overview queries (today there are two copies).
*Acceptance:* table-driven test over every junk name observed in prod sessions; all
rejected; the 6 real names all pass.

**A3. Cross-turn token-subset reconciliation in `recordProcess`.**
After the exact-name lookup misses (tools.ts:316), fetch the session's pending candidate
names and run the same token-subset logic as `collapseRelatedCandidateProcesses`:
- incoming ⊂ existing ("Purchasing" arrives after "Purchasing And Replenishment") → merge
  evidence into the existing row, do not insert;
- incoming ⊃ existing ("Purchasing And Replenishment" arrives after turn-0 "Purchasing")
  → rename the existing row to the fuller phrase, merge evidence, supersede the old
  `proposed_name` claim.

**Locking:** the existing advisory lock is keyed per normalized name —
`${captureSessionId}:candidate_process:${normalized}` (tools.ts:300) — so related names
like "Purchasing" and "Purchasing And Replenishment" hash to *different* locks, and two
concurrent extractions could each pass the related-candidate scan and insert both rows.
Reconciliation must serialize on a **session-wide** lock instead: acquire
`pg_advisory_xact_lock(hashtextextended('${captureSessionId}:candidate_process_reconcile', 13))`
before the scan/merge/rename, replacing the per-name lock (it becomes redundant — all
candidate writes for a session serialize on the one key). Per-turn dispatch already
serializes most writes via the dispatch lock, but extract retries and the async extract
path can overlap, so the session lock is load-bearing, not belt-and-braces.
Audit-log merges so they're traceable.
*Acceptance:* integration test replaying turn 0 then turn 1 recordProcess sequences ends
with exactly one "Purchasing And Replenishment" row whose evidence spans both turns; a
concurrency test firing recordProcess("Purchasing") and recordProcess("Purchasing And
Replenishment") in parallel transactions ends with exactly one row.

**Explicit non-fix:** do **not** add a confidence floor — prod data shows junk at
0.78–0.95 vs real compounds at 0.74.

### Phase B — extraction steering (prompt + gating)

**B1. Gate candidate minting on inventory-enumeration turns.**
Only materialize new candidates when the turn is an inventory enumeration. Note the
structured contract's `utterance_type` enum is generic (`substantive_answer`,
`partial_answer`, … — brain.ts:2963) and has **no** process-list value, so the gate must
use signals that exist today — and only signals from **pre-existing conversation state**,
never from the current plan's own output (a bad scope answer can self-authorize by
emitting a bad `process.inventory` slot_update, and the materializer already treats those
slot updates as candidate sources at brain.ts:1165):
- the probe asked in the *previous* agent turn targeted `process.inventory` (from
  interview state / the prior turn's chosen intent), or
- the interview phase *as recorded before this extraction ran* is `inventory`.
On turns that fail the gate, suppress candidate minting from **both** sources —
direct/materialized `recordProcess` calls *and* `process.inventory` slot-update-derived
names — while still applying evidence merges to existing candidates.
(Alternative, if these prove too coarse: add an explicit boolean field such as
`is_process_enumeration` to the extraction contract + schema — a schema change to
schemas/director-turn-plan.schema.json, weigh against eval results first. Note that field
would also be self-reported by the extractor, so it should tighten the gate, not replace
the state-based check.)
For other turns (scope answers, ownership answers, drilldowns), allow evidence merges
into *existing* candidates but require strong signals (explicit "we have a process
called X") to mint new ones. This kills the turn-0 sub-step candidates (#7–9, #11) and
"All Of It" (turn 2 was an ownership answer to a cross-department probe).

**B2. Prompt tightening with these prod failures as negative examples.**
Add to prompts/director.turn.plan.md candidate rules: quantifier/pronoun phrases are never
process names ("six big ones", "all of it"); when the director's sentence describes the
*span* of their responsibility ("from order intake through invoicing"), that is scope, not
an enumeration; when a compound and its atoms appear in one sentence, emit only the
compound. Mirror to the operator prompt (per repo convention of mirroring director fixes).

**B3. SPOF vocabulary.** Steer the brain to call `recordSpof` for person-dependency
signals (add a positive example: "the real price list lives in Marcus's sheet" →
recordSpof on the order-intake candidate).

### Phase C — overview metrics correctness (otto-frontend/lib/overview/queries.ts)

**C1. Fix `people_count` — needs a write-side link, not just a query fix.**
There is currently **nothing to scope the person join by**: `recordPerson` writes
`person.role` claims with a *scalar* value (the role name, tools.ts:489-497), and
dispatch invokes it without any candidate id (brain.ts:1866-1882). So "scope by
`value->>'candidate_process_id'`" has no data to match — a query-only fix can drop the
bogus workspace-wide count but can never produce per-candidate people counts.

Two parts:
- *Write side:* add optional `candidateProcessId` to `recordPerson` input; dispatch
  passes the focus/created candidate id (same-turn entity tracking already exists,
  cf. Task 5 tracking in dispatch). Write an explicit linking claim — subject
  `person`, field `works_on`, value `{"candidate_process_id": "<uuid>"}` — and add the
  `(person, works_on)` pair to schemas/claim-subject-fields.json. Prompt nudge so the
  extractor passes the candidate when the person is mentioned in a process context.
- *Read side:* `people_count` = distinct persons with a `works_on` claim pointing at the
  candidate, plus candidate-scoped `role_claim`s (queries.ts:209-216 pattern) and the
  proposed-owner role. Never join unscoped person claims.

Old sessions have no links, so their cards will show people from owner-role only (0–1) —
acceptable; the D2 cleanup archives them anyway. Per-card People=4 is *not* the
expectation: e.g. Order Intake should count only the persons evidenced on it
(VP + Marcus → 2 once links exist).

**C2. Scope tile metrics to the same inventory as the cards:** complexity CTE and SPOF
count join against the `inventory` CTE ids and respect `captureSessionId`. The tile
average must exclude junk-filtered candidates by construction (it averages over inventory
members, not over all claims).

**C3. One definition of doc coverage:** keep the tile's "documented evidence" definition;
rename the card field to "Evidence" (it already shows evidence_count) or compute the card
percentage the same documented-only way. The 0%/100% contradiction must be impossible.

**C4. SPOF tile counts both shapes:** `field='risk' AND value ILIKE '%single_point_of_failure%'`
OR `subject_type='person' AND field='single_point_of_failure' AND value='true'`, scoped
per C2. (B3 reduces the second shape over time; the tile should still count it.)

### Phase D — session hygiene

**D1. Supersede prior pending candidates per workspace+function:** when a director
session completes synthesis, mark earlier sessions' still-`pending` candidates for the
same workspace as `superseded` (new status) or auto-archive them. Alternative if status
surgery is too invasive: make the overview default to the latest completed session instead
of unscoped workspace view. Decide one; the current half-and-half (cards scoped by query
param, tiles unscoped) is the worst of both.

**D2. One-time cleanup:** archive/discard the ~72 stale pending candidates from pre-fix
sessions in the prod workspace so the next demo starts clean.

### Phase E — verification

**E1. Eval fixture from this prod transcript.** Add the 10-turn transcript to
evals/director/ with expected output: exactly the 6 candidates, Marcus SPOF ≥1, systems
Gmail/Google Sheet/Odoo on Order Intake, no candidate named in the junk table above.

**E2. Unit/integration tests** per acceptance criteria in A1–A3, C1–C4 (queries tests can
run against the existing phase1 db integration harness, cf.
otto-frontend/tests/phase1/db.integration.test.ts).

**E3. Prod re-run:** redeploy, run the same interview script, confirm overview shows
6 cards, SPOF=1, complexity averaged over the 6 only, and per-card People counts only
persons evidenced on that candidate (e.g. Order Intake → VP + Marcus = 2, not 6).

## Suggested sequencing

A1+A2 (one PR, kills 10 of 12 bad cards deterministically) → A3 (kills the remaining
cross-turn dupes) → C1–C4 (metrics honesty, independent of extraction) → B1–B3 (prompt
steering, needs eval from E1 first to measure) → D1–D2.

---

# Round 2: E3 verification results (prod session 667b5809, 2026-06-11 22:27–22:34 UTC)

## What got fixed (verified in prod)

The re-run produced **exactly 6 candidates, zero junk, zero duplicates** ("Six Big
Ones"/"All Of It" gone, no compound/atom splits). The complexity tile is now
session-scoped: 31 = avg(57 for order intake, 26 × 5) ✓. D1's supersede archived the
72-candidate backlog automatically when synthesis completed. Round 1 is confirmed
working end-to-end.

## New findings

### F1 (P0) — the interviewer never moves past the first process

The director asked to switch four times (turns 12, 15, 16, 17: "Can you start asking
me about the other five processes now?", "Yo. Start asking me about the other
processes now.", "No. Move on.", "Remember those other ones...?"). The planner chose
`open_questions_closeout`, `capture_priority`, then `clarify_previous_question` twice
— every one targeting "Order intake". The other five candidates ended the interview
with zero slots probed. Turn 3 also re-asked the full inventory after turn 1 had
answered it (director: "I already told you that, bro").

Root causes, all confirmed in the decision log + code:
- `probes/director.yaml` has 12 probes; **none for `select_process_to_expand`** — it
  exists only as a phase-gate repair intent (brain.ts:4864).
- The exhausted-probe fallback (brain.ts:4823-4830) hardcodes
  `clarify_previous_question` targeting `blockedIntent?.target_process ??
  candidateSummaries[0]` — the same focus process, forever. Decision-log reason on
  turns 16/17: "All matching probes are in cooldown or exhausted; broaden instead of
  repeating the prior question."
- No directive recognition: "ask me about the other processes" is treated as a
  normal answer. The voice layer says "let's shift gears" while the chosen intent
  stays on order intake — acknowledgment and plan come from different places.

Fix plan:
- **F1a — directive handling (deterministic):** classify focus-switch requests
  ("other processes", "move on", "next process") in the turn plan (new
  utterance-level signal or deterministic regex guard at dispatch) and force
  `select_process_to_expand` targeting the next pending candidate with unfilled core
  slots. The forced intent must drive both the plan AND the spoken utterance.
- **F1b — coverage rotation:** when the focus candidate's probes are exhausted, the
  fallback rotates to the next pending candidate with empty core slots
  (`select_process_to_expand` against that target) instead of clarifying the same
  process. Closeout only when every candidate's core slots are filled or exhausted.
- **F1c — repeat-question guard:** the turn-3 inventory re-ask suggests the phase
  gate fired `discover_processes` (score 1300) although the inventory slot was
  already filled — verify slot-state staleness in the phase-repair path while
  implementing F1b.

### F2 (P1) — SPOF tile still 0: the brain writes free-text risks, never recordSpof

Order intake's risk claims: "Single-person dependency: Marcus is the only one who
keys orders; absence halts the process." (×2 phrasings) — free text, no literal
`single_point_of_failure`, so the tile's ILIKE match finds nothing. The B3 prompt
nudge was not enough. Fix: deterministic normalization at dispatch — when a risk
claim's text matches single-person-dependency patterns, rewrite the value to the
`recordSpof` shape (`{type: "single_point_of_failure", text}`); keep the prompt
steering as a secondary signal.

### F3 (P1) — model writes `works_on` claims in an uncontracted shape; People = 0

The session's one works_on claim is `{"process": "Order intake", "activity": "keys
all orders"}` — written by the extractor through the generic claims channel (the
allowlist permits `(person, works_on)` with type object). The card query needs
`value->>'candidate_process_id'`, so People = 0 everywhere. Fix: normalize works_on
claims at dispatch — resolve the process name to a candidate id (same-turn map +
session lookup, as `explicitCandidateProcessIdForTool` does), rewrite the value to
`{"candidate_process_id"}`; queue unresolvable ones as retry tasks. This also
covers recordPerson prompt noncompliance.

### F4 (P1) — duplicate risk rows + raw JSON in the detail page

The same Marcus fact arrived via two channels in one turn (`claims[]` and
`recordCandidateProcessClaim`) and `risk` is multi-value, so both persist and render
as separate callouts ("Operational risk" + "Single point of failure"). A third risk
has an object value `{"description": "Source of truth gap..."}` rendered as raw JSON
by RiskCallouts. Fixes: (a) near-duplicate text dedup for multi-value claims at
write time (token-overlap within same subject+field, reuse name-quality helpers);
(b) the detail mapper extracts `description`/`text` from object claim values before
display.

### F5 (P2) — system names don't canonicalize

systems table now holds: "Google Sheet", "Google Sheets", "Google Sheet (Marcus)",
"reorder Google Sheet", "Google Sheet (reorder)". The order intake card lists 4
systems including both Sheet variants, so system sprawl scores 16/20 and inflates
complexity to 57. Fix: canonicalize in `upsertNamedSystem` (strip parentheticals,
fold plural, alias map for common SaaS) and merge existing rows; sprawl then counts
3 systems.

### F6 (P2) — evidence links section is an unreadable wall

`app/process/[id]/page.tsx:102` renders one tile per claim — 20+ rows each saying
"1 evidence source", including three separate "downstream dependency" tiles. Fix:
group by field (claim count + unioned evidence count per field), render as a
compact collapsible list with the raw per-claim view behind "view all".

### F7 (P3) — Documentation Coverage 0% reads as failure, but is by design

The tile counts uploaded-document evidence only; a voice-only interview is honestly
0%. The interview DID capture documentation reality ("supposed to live in Odoo...
practically Google Sheets and Marcus's head"). Improvements: an empty state ("No
documents uploaded yet — upload SOPs to corroborate this map") instead of a bare 0%,
and optionally a documentation-maturity chip on cards sourced from the
`documentation.maturity` slot.

## Suggested sequencing (round 2)

F1 (the interview is the product; a/b together, c verified during) → F3 + F2 (both
are dispatch-side claim normalization, one PR) → F4 + F5 (write-side hygiene) →
F6 + F7 (presentation).

---

# Round 2 addendum: metrics redesign (G) — separating "what Otto knows" from "what the business is"

The three tiles conflate knowledge-completeness with process attributes. Decision:

## G1 — Documentation Coverage becomes slot-fill capture coverage

Per-process coverage = weighted fill of the core director slots for that candidate
(slot_states already stores per-candidate rows with empty/partial/filled/
asked_unknown — prod session 667b5809 has ~13 scoped rows for order intake and zero
for the other five, which is exactly the right signal). Scoring: filled = 1,
partial = 0.5, asked_unknown = 1 (the question was asked and resolved — the org not
knowing is a maturity finding, not a capture gap), empty/conflicting = 0. Core slot
set = the expand-phase core list (scope.boundaries, outcomes, ownership.roles,
systems, frequency.volume, friction, risk) — reuse the existing list in brain.ts
rather than a new one. Department tile = average across inventory processes.
Uploaded documents raise coverage the honest way: the document pipeline fills
slots. (Upload corroboration stays available per-claim via evidence labels; it is
no longer the tile.)

## G2 — Complexity stops borrowing ignorance signals

Two factors currently reward not-knowing: `documentation_gap` (flat 15 when no
uploaded docs — 26% of a typical score is "no docs") and the unknown-frequency
default (8). Remove both from the rubric; rescale remaining factors (sprawl 20,
handoffs 15, frequency 15 with unknown = 0, friction 20, SPOF 15) to /100.
Re-calibrate the recommended threshold and complexity bands after rescale.

**F8 (P1, found during this review):** pain_point claims arrive as
`{"items": [...]}` or plain strings, but `normalizeSignals`
(lib/synthesis/inventory.ts:599) only reads `.text` — friction scored 0/20 on
order intake despite two captured pain points. Normalize claim value shapes
(string, {text}, {items: []}, {description}) into signal text before scoring;
same normalizer fixes the raw-JSON risk display (F4b).

## G3 — Low-coverage processes get an action, not a fake score

A process below a coverage threshold (e.g. <40% core slots) shows no complexity
score at all. The card swaps the score badge for "More info needed" with the
missing slots ("no boundaries, no systems, no frequency") and a capture CTA
(continue director interview / process deep-dive). Synthesis still computes the
score internally but tags it `metadata.coverage`; display gates on it. The tile
average only averages scored processes and says so: "42 avg · 1 of 6 scored".
This also reframes the F1 outcome: when the interviewer fails to rotate, the
overview now SAYS five processes are under-captured instead of calling them
"low complexity".

## G4 — Tile semantics after the change

- Processes Captured: unchanged.
- Documentation Coverage: slot-fill % (G1) — answers "how well is the department
  documented in Otto".
- Complexity: avg of scored processes only + scored/total count (G2+G3).
- Single Points of Failure: unchanged concept; F2 fixes the plumbing; relabel
  subtitle to "one-person dependencies found".

Sequencing: F8+G2 together (one scoring PR), then G1 (coverage query + tile),
then G3 (card gating + CTA), G4 copy rides along. F1 remains the top priority —
G3 makes under-capture visible, F1 makes it rare.

---

# Round 2 + addendum: IMPLEMENTED (2026-06-11)

All of F1–F8 and G1–G4 are implemented and tested (426 unit/integration tests
passing; the only failures are the two pre-existing operator-capture contract
tests that fail on clean HEAD).

- **F1** — `directorRequestedFocusSwitch` (deterministic directive detection,
  tested against all four prod move-on utterances and narration negatives),
  rotation in `deterministicTurnPlan` returning `select_process_to_expand` to
  the next untouched candidate with `proposed_next_phase: expand`, the
  exhausted-probe bridge in `applySteeringIntentExclusions` rotating instead of
  clarifying, and `withFocusSwitchCandidate` carrying the target's candidate id
  so dispatch actually moves `focus_candidate_process_id`. Both the steering
  and extract paths compute identical rotation inputs (probe-firing targets +
  authoritative focus) so speech and dispatch cannot diverge. F1c: the
  inventory-satisfied check now also scans recent director transcript lines
  (`extractProcessNames ≥ 2`) so async-extraction lag no longer re-asks the
  process list.
- **F2/F3** — `lib/claims/value-text.ts`: `normalizeRiskClaimValue` rewrites
  single-person-dependency risk text to the recordSpof shape at both claim
  channels; `resolveWorksOnClaimValue` resolves `{process: name}` works_on
  values to `{candidate_process_id}` (same-turn map, then session lookup),
  dropping unresolvable ones to retry tasks.
- **F4** — near-duplicate suppression for text-bearing multi-value claims in
  `writeClaimInTransaction` (token containment ≥ 0.6, plus same-person SPOF
  matching for the prod Marcus pair); `riskBody` renders object values via
  `claimValueText` instead of raw JSON.
- **F5** — `lib/systems/canonicalize.ts` + `upsertNamedSystem` lookup by
  canonical key: the five prod Sheet variants fold to "Google Sheets" (+ the
  intentionally-distinct leading-qualifier name).
- **F6** — process detail evidence links grouped one row per field with
  claim/evidence counts, expandable to per-claim links.
- **F8/G2** — `normalizeSignals` reads all claim value shapes (the prod
  friction-0 bug); complexity drops `documentation_gap` and the
  unknown-frequency default, rescales to /100.
- **G1/G3/G4** — `directorCoreCoverageSlotPaths` (7 core slots) in
  slot-schema; coverage CTE in overview queries (candidates own, promoted
  processes inherit via `promoted_process_id`); Documentation Coverage tile =
  average slot-fill; complexity tile averages only processes above the 40%
  coverage gate and says "Average of N scored — M need more capture"; cards
  below the gate show "More info needed" + missing slot labels + capture CTA;
  synthesis tags `metadata.coverage` on complexity claims; SPOF subtitle is
  now "One-person dependencies found".

**Migration required before/with deploy:** `migrations/0016_works_on_multivalue_claims.sql`
rebuilds `claims_active_subject_field_idx` to exclude `works_on` (and
`business_outcome`, which was already multi-value in the app layer but missing
from the index). Without it, a person's second works_on link violates the
unique index and aborts the dispatch transaction. Idempotent
(DROP IF EXISTS + CREATE); apply with `npm run db:migrate` against prod.

**E3 (round 2):** re-run the interview; expect the agent to rotate to the
other five processes on request (and on probe exhaustion), SPOF tile ≥ 1,
coverage tile reflecting slot fill, one Marcus risk callout, one Google Sheets
system, grouped evidence links.

**Round 2 review fixes (round 3):** (1) rotation exclusion now keys on core-slot
coverage (`readCoreCoveredCandidateNames`: boundaries/ownership/systems all
filled or asked_unknown), not probe-touched-once — rotation keeps cycling until
every candidate is filled or exhausted, per the plan; (2) promoted process cards
inherit `covered_slot_paths` from their best source candidate so a low-coverage
promoted process lists its missing slots; (3) promoted-process coverage joins
use LATERAL ... LIMIT 1 so multiple candidates promoted/merged into one process
cannot duplicate inventory rows in the coverage/scored-count/complexity
averages.
