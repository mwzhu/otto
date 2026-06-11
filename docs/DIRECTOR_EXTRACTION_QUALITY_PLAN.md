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
