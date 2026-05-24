# Director Agent Eval Plan (v1)

The director agent's job is to extract a director-layer process inventory from a voice or document interview. This plan defines what "good" means, how we measure it, and what we are intentionally not testing yet.

The eval suite is an instrument that surfaces where the implementation diverges from the contract. Some tasks are expected to fail today on purpose — see §7. The goal is visible gaps, not a green dashboard.

---

## 0. Four-concern separation

Read this before writing any code. These four concerns each test something different. If a grader could fail because of "the LLM did the wrong thing" *or* "the route didn't persist properly," it is in the wrong place.

| Concern | Surface | Verifies | Where it lives |
|---|---|---|---|
| **Agent eval** | `runDirectorTurn()` direct call | extraction quality, slot recall, hallucination, probe targeting, multi-turn state | `otto-frontend/evals/director/` |
| **Route integration test** | `POST /api/director-interviews/:id/turns` | auth, idempotency, evidence/transcript persistence, API shape | `otto-frontend/tests/phase1/` (existing) |
| **Dry-run harness** | `runDirectorTurn()` + `structured({ mock })` | harness boots, schemas parse, no API key required | `npm run eval:director:dry-run` |
| **Real-LLM quality eval** | `runDirectorTurn()` + `ANTHROPIC_API_KEY` | actual model behavior; the thing that blocks CI | `npm run eval:director:smoke` |

Out of agent-eval scope: auth, idempotency, route schema validation, request hashing, transcript/evidence persistence semantics.

Out of route-test scope: extraction accuracy, slot recall, hallucination, probe relevance, multi-process recall, calibration.

---

## 1. Agent capabilities and how we evaluate them

Twelve capabilities. Ten are gating in v1; two are tracked/report-only until the implementation catches up to the contract.

Each row references the code path it tests and the grader that scores it. Code paths are in [`lib/interview/director/`](../../lib/interview/director/) unless noted.

### 1.1 Gating in v1 (smoke + regression block CI on hard fail)

#### Extraction Accuracy
**What:** Per-utterance, the LLM extraction at [brain.ts:92](../../lib/interview/director/brain.ts) produces correct `slot_updates` against the 13 slots in [slot-schema.ts:16](../../lib/interview/director/slot-schema.ts).
**Observation:** `runDirectorTurn` return value's `slot_updates`; `slot_states` rows after the turn.
**Grader:** `graders/extraction.ts` — three sub-scores:
- Status correctness: per-task `expected.slots: { path → status }`.
- Value correctness: per-task `expected.slotValues`, matched against `JSON.stringify(slot_states.value)` case-insensitively and with per-slot aliases.
- Slot precision: slots expected to remain empty were not filled. Any slot listed in `expected.slots` as `"empty"` is an implicit precision assertion; `expected.forbiddenSlotFills` is the explicit version.

Aggregate extraction accuracy is a weighted mean: status 0.4, value 0.4, precision 0.2. Tune after the first 30 trials if one sub-score proves much noisier than the others.
**Example task:** *happy-path* — "We run promotion management every Monday. Salesforce is our system of record, but we keep pricing in a Google Sheet." Expect `scope.boundaries=filled`, `frequency.volume=filled`, `systems.systems_of_record=filled`.

#### Entity Recall
**What:** By end-of-interview, `candidate_processes`, `systems`, `people`/`roles`, pain-point claims, and SPOF claims contain the expected entities. Alias-aware (e.g. "SFDC" satisfies an expected "Salesforce").
**Observation:** Final-state queries over `candidate_processes`, `systems`, `people`, `roles`, `claims`.
**Grader:** `graders/entity-recall.ts` — fuzzy match (Levenshtein ≤2 or embedding sim ≥0.85) against `expected.candidates`, `expected.systems`, etc. Aliases from `expected.aliases` forgive equivalent terms on the grader side.
**Multi-process note:** This includes tasks where one utterance names multiple processes. **Expected to fail today** — see §7.1.

#### Evidence Discipline
**What:** Every claim and candidate row carries evidence linkage. The contract is at [brain.ts:329](../../lib/interview/director/brain.ts) ("Every extracted assertion must cite evidence_ids from the current turn").
**Observation:** Two queries — `candidate_processes.evidence_ids` (array column) and `claim_evidence` (join table for claims).
**Grader:** `graders/evidence-discipline.ts` — for every candidate row, assert `evidence_ids.length ≥ 1`; for every claim, assert ≥1 row in `claim_evidence`. Hard-fail on any zero.

#### Hallucination Control
**What:** Extracted values must be grounded in the transcript. Three-way verdict per value:
- `span_supported` — substring match (case-insensitive) against concatenated turn text
- `alias_normalized` — value matches an entry in `task.expected.aliases`
- `inferred` — `metadata.inferred === true` AND `confidence < 0.45`

**Observation:** Every tool-call argument and every claim `value`.
**Grader:** `graders/hallucination.ts` — any value matching none of the three is a hallucination event. Hard-fail if confidence ≥ 0.5 with no span/alias support.
**V1 determinism note:** Do not use embedding similarity for gating hallucination checks in v1. Provider-backed embeddings and lexical fallback can disagree. If semantic matching is added later, record provider metadata in the trace and keep it report-only until calibrated.

#### Overtrigger Prevention
**What:** Generic context ("we mostly use Salesforce") must not create a candidate process.
**Observation:** `candidate_processes` rows after the turn.
**Grader:** `graders/overtrigger.ts` — `expected.forbiddenCandidates: string[]` must not appear as `proposed_name` on any candidate row. `expected.maxCandidateCount` bounds runaway extraction.
**Example task:** *overtrigger-system-only* — "We mostly use Salesforce." Expect `systems=["Salesforce"]`, `forbiddenCandidates=["Salesforce"]`.

#### Probe Targeting
**What:** `rankProbeIntents` at [brain.ts:395](../../lib/interview/director/brain.ts) is deterministic today (must-fire base 1000 + status boost + priority). Given the current slot state, the chosen probe should target an empty/partial/conflicting priority slot.
**Observation:** `chosen_intent.targetSlot` from the turn result.
**Grader:** `graders/probe-target.ts` — code grader. If any must-fire slot is `empty` or `conflicting`, the chosen probe's target must be one of them. Otherwise, the highest-priority remaining unfilled slot.
**No LLM judge yet:** The ranker is rule-based; an LLM judge would measure rules-against-rules. Promote to LLM-judged once the hybrid scorer from BUILD_PLAN §4.4 ships.

#### Decision Reconstructability
**What:** Every turn writes an `agent_decision_log` row at [brain.ts:215](../../lib/interview/director/brain.ts) containing slot updates, ranked probe intents, chosen intent, sanitized utterance, prompt template id/version, tool calls, model, token counts, cost, latency, cache hit, and degraded-quality flag.
**Observation:** `agent_decision_log` row keyed by `(capture_session_id, turn_index)`.
**Grader:** `graders/decision-log.ts` — per turn, assert row exists; `prompt_template_id` non-empty; `sanitized_agent_utterance` non-empty; `transcript_segment_ids.length ≥ 1`; `ranked_probe_intents` and `chosen_intent` JSON-parseable; `slot_updates` JSON-parseable.

#### Degraded-Mode Handling
**What:** When `structured()` throws inside [brain.ts:103](../../lib/interview/director/brain.ts), the catch branch:
1. Sets `degradedQuality = true`
2. Writes a single slot update for `scope.boundaries` with status `pending_re_extract` and confidence 0
3. Creates a `follow_up_tasks` row with `task_type='low_confidence_claim'`

It does **not** fall back to regex extraction — the regex path at [brain.ts:425](../../lib/interview/director/brain.ts) is only the *mock value* passed to `structured()` when no API key is present.

**Observation:** Return value's `degraded_quality`; `slot_states.scope.boundaries.status`; `follow_up_tasks` rows.
**Grader:** `graders/degraded-mode.ts` — edge task uses `OTTO_LLM_FORCE_INVALID=true` (supported in `lib/adapters/llm.ts`). Assert `degraded_quality === true`, slot status `pending_re_extract`, follow-up task exists with correct `task_type`, transcript segment still persisted.

#### Cost And Latency Discipline
**What:** Per-turn cost and latency stay within budget. BUILD_PLAN §14.1 sets ~$0.30/director-interview for the brain. Prompt-cache hit-rate should stay high after the first turn.
**Observation:** `agent_decision_log.cost_cents`, `latency_ms`, `token_count_input/output`, `cache_hit`.
**Grader:** `graders/cost-latency.ts` — task-level `maxLatencyMsPerTurn` and `maxCostCentsTotal`. Flag breaches in the report; block CI only on extreme regressions (>3× baseline aggregate).

#### State Accumulation Across Turns
**What:** Multi-turn behavior: prior slot fills and recent transcript segments are correctly retrieved by [`buildPromptCacheBlocks`](../../lib/interview/director/brain.ts) (`readCurrentSlots` + `readRecentTurns`) and influence later turns' extraction and probe choice.
**Observation:** Final `slot_states` after a scripted multi-turn task; per-turn `chosen_intent` sequence.
**Grader:** `graders/state-accumulation.ts` — assert that filled slots stay filled across turns (no silent regression), and that probe choices respect previously-filled slots. If the grader needs to inspect prompt assembly directly, the harness should call `buildPromptCacheBlocks(...)` before each turn and store the resulting static/dynamic block hashes plus the dynamic block text in the trace JSON. Do not rely on `agent_decision_log` for prompt-block inspection; it does not store a generic metadata field or raw prompt blocks.
**Why this is a separate dimension:** Single-turn graders test extraction *given* slot context. Bugs in the read path only manifest across turns.

### 1.2 Tracked / report-only in v1

These are real capabilities. The contract exists in the prompts and schemas. The current implementation does not yet honor the contract reliably enough to gate CI. Each appears as a task category that reports score and trend but does not block merges until the implementation catches up.

#### Contradiction Detection
**Contract:** [brain.ts:334](../../lib/interview/director/brain.ts) — "If a turn contradicts prior slot state, mark the slot conflicting and include `contradiction_signals`." Per BUILD_PLAN §4.8, both candidate values must be preserved in `candidates[]`.
**Why report-only:** The upsert at [tools.ts:156-167](../../lib/interview/director/tools.ts) overwrites `candidates` on conflict rather than merging. Even if the LLM emits `status: "conflicting"` with both values, the prior candidate is lost on the next write.
**Grader:** `graders/contradiction.ts` — edge task with Turn 1 "this runs weekly" / Turn 3 "actually daily." Assert `slot_states.frequency.volume.status === "conflicting"` and `candidates.length === 2`. Report-only; do not block CI.
**Promotion condition:** When tools.ts upsert merges candidates, promote to gating.

#### Confidence Calibration
**Contract:** [brain.ts:331](../../lib/interview/director/brain.ts) — "If a statement is implied but not directly said, set confidence ≤ 0.45 and mark `metadata.inferred = true`." Stated claims should be ≥0.7.
**Why report-only:** `runDirectorTurn` does not iterate `extraction.claims` — only `extraction.tool_calls` and `extraction.slot_updates`. Tool helpers in [tools.ts](../../lib/interview/director/tools.ts) write claims with fixed confidence values (e.g. `recordPainPoint` uses 0.78 regardless of LLM signal). Calibration is partially observable on `slot_updates.confidence` only.
**Grader:** `graders/calibration.ts` — operate on `slot_updates` only. For each expected `(slot, stated|inferred)`, assert the confidence band and `metadata.inferred` flag. Report-only.
**Promotion condition:** When tool helpers propagate `metadata.inferred` and use LLM-supplied confidence, promote to gating.

### 1.3 Explicit non-goals for v1

Do not build graders for any of these. They will fail noisily and reduce signal.

- Audio quality, ASR latency, TTS naturalness
- Adaptive LLM-simulated users / persona-driven multi-turn dialogue
- Conversational naturalness, fatigue handling, energy-following
- Full stopping behavior — `runDirectorTurn` has no close action; cannot honestly evaluate
- ROI / synthesis quality (different agent, different DAG)
- Operator-layer process maps (different agent)
- LLM-judged probe quality (ranker is deterministic; nothing to judge)

When the implementation gains a close action (per BUILD_PLAN §4.7), add an oracle stopping grader.

---

## 2. Task schema

```ts
export type DirectorEvalTask = {
  id: string;
  suite: "smoke" | "regression" | "edge" | "capability";
  description: string;

  // Scripted director utterances, played one per turn.
  turns: string[];

  expected: {
    // Entity-level expectations
    candidates?: string[];
    forbiddenCandidates?: string[];
    maxCandidateCount?: number;
    systems?: string[];
    peopleOrRoles?: string[];
    painPointContains?: string[];
    spofContains?: string[];

    // Slot-level status expectations
    slots?: Record<string, "filled" | "partial" | "empty" | "asked_unknown" | "conflicting" | "pending_re_extract">;

    // Slot-level value expectations. `mustContain` and `mustNotContain` are
    // matched case-insensitively against JSON.stringify(slot_states.value).
    // Aliases are per-slot, not global.
    slotValues?: Record<
      string,
      {
        mustContain?: string[];
        mustNotContain?: string[];
        aliases?: Record<string, string[]>;
      }
    >;

    // Optional explicit slot-precision assertions. Any slot listed above with
    // status "empty" is also treated as forbidden to fill.
    forbiddenSlotFills?: string[];

    minEvidenceLinks?: number;

    // Probe targeting
    nextProbeTarget?: string;

    // Alias-aware forgiveness (e.g. {"Salesforce": ["SFDC", "our CRM"]})
    aliases?: Record<string, string[]>;

    // Calibration (report-only in v1)
    calibration?: Record<string, "stated" | "inferred">;
  };

  // Budgets
  maxTurns?: number;
  maxLatencyMsPerTurn?: number;
  maxCostCentsTotal?: number;

  // Test state: pass = should pass today; expected_fail = known gap with tracking
  expectedState: "pass" | "expected_fail";
  trackingIssue?: string; // Required when expectedState === "expected_fail"
};
```

A previously-passing task that fails = CI block. An `expected_fail` task that flips to passing = auto-promote candidate (the implementation got fixed; the eval should now gate it).

---

## 3. Suite structure

| Suite | Size (v1) | Trials | When | Blocks CI? |
|---|---|---|---|---|
| `smoke` | 10 tasks | 1 | every PR touching director surfaces | yes, on hard-fail set |
| `regression` | 5 tasks | 1 | every PR touching director surfaces | yes, all must pass ≥0.9 |
| `edge` | 3-5 tasks | 1 | every PR touching director surfaces | report-only, alert on >15% regression |
| `capability` | 5+ tasks | 1 | nightly | report-only, tracks long-term progress |

PR-triggering surfaces:
- `lib/interview/director/**`
- `lib/schemas/phase1.ts`
- `lib/adapters/llm.ts`
- `lib/db/write-claim.ts`
- `lib/db/write-agent-decision.ts`
- `app/api/director-interviews/**`
- `evals/director/tasks/**`

Hard-fail set (blocks smoke regardless of score):
- Harness crash / task throw
- Unexpected degraded extraction on a non-degraded task. In current code, `slotExtractionSchema` validation failures are caught by `runDirectorTurn` and converted into `degraded_quality=true`, `pending_re_extract`, and a follow-up task; raw schema errors usually will not escape the brain.
- Candidate created from a transcript with no process-naming utterance
- Degraded path swallowed an error without writing a `follow_up_task`
- Any claim row with no `claim_evidence` linkage, any candidate row with empty `evidence_ids`

---

## 4. Harness design

### 4.1 Direct harness (v1 default)

```
evals/director/harness/direct.ts
```

Calls `runDirectorTurn` against a fresh `(orgId, workspaceId, captureSessionId)` per task. No HTTP, no auth, no idempotency. This is the agent-eval surface.

Per-task loop:
1. Provision fresh org / workspace / capture session (reuse the Postgres setup from [`tests/phase1/db.integration.test.ts`](../../tests/phase1/db.integration.test.ts); `setOrgContext` RLS handles isolation, so no per-trial schema is needed).
2. For each turn:
   - Insert a `transcript_segments` row (mirror the route's pre-brain setup at [route.ts:92-129](../../app/api/director-interviews/%5BcaptureSessionId%5D/turns/route.ts)).
   - Call `createTranscriptEvidence` to get the evidence row.
   - Call `runDirectorTurn` with the segment id, evidence id, and turn index.
3. After the last turn, dump final state: `candidate_processes`, `slot_states`, `claims`, `claim_evidence`, `follow_up_tasks`, `agent_decision_log`.
4. Write trace JSON to `test-results/evals/director/<run-id>/<task-id>.json`.

**Critical:** the direct harness must create transcript_segments and evidence rows itself. `runDirectorTurn` reads `transcript_segments` (for `readRecentTurns` at [brain.ts:362](../../lib/interview/director/brain.ts)). Skipping this leaves recent-turn context empty and silently degrades extraction.

### 4.2 HTTP harness (added in Week 2)

```
evals/director/harness/http.ts
```

Same task driver, but POSTs to `/api/director-interviews/:id/turns`. Used to catch route-level regressions (idempotency, auth, request hashing, evidence/transcript wiring). Smaller subset of tasks; not the v1 quality bar.

### 4.3 Modes

- `--mock` / `eval:director:dry-run` — no API key required. `structured()` returns the deterministic regex extraction. Used for local harness debugging only; does NOT measure agent quality.
- Default mode — requires `ANTHROPIC_API_KEY`. This is the v1 quality bar.

---

## 5. Graders

Each grader is one file under `evals/director/graders/`. All deterministic, no LLM judges in v1.

| Grader | Capability | Hard-fail trigger |
|---|---|---|
| `extraction.ts` | Extraction Accuracy | none in v1 (partial credit) |
| `entity-recall.ts` | Entity Recall | none in v1 |
| `evidence-discipline.ts` | Evidence Discipline | any candidate or claim with no evidence linkage |
| `hallucination.ts` | Hallucination Control | value with conf ≥0.5 and no span/alias/inferred support |
| `overtrigger.ts` | Overtrigger Prevention | any `forbiddenCandidates` row created |
| `probe-target.ts` | Probe Targeting | none in v1 (partial credit) |
| `decision-log.ts` | Decision Reconstructability | any turn without a row, or row with missing required fields |
| `degraded-mode.ts` | Degraded-Mode Handling | degraded path did not write follow-up task |
| `cost-latency.ts` | Cost And Latency Discipline | aggregate cost > 3× baseline |
| `state-accumulation.ts` | State Accumulation Across Turns | none in v1 (partial credit) |
| `contradiction.ts` | Contradiction Detection | report-only |
| `calibration.ts` | Confidence Calibration | report-only |

---

## 6. Reporting and CI

### 6.1 Outputs per run

- `test-results/evals/director/<run-id>/<task-id>.json` — full trace: turns, agent return values, final DB dump, per-grader scores.
- `test-results/evals/director/<run-id>/report.md` — human-readable markdown:
  - Per-task pass/fail/expected-fail status
  - Per-grader aggregate scores
  - Cost/latency table
  - Δ vs `eval-baselines/main.json`
  - Surfaced transcripts for every failed or regressed task (the blog's "always read the transcripts")

### 6.2 Baseline

`eval-baselines/main.json` is committed and updated only by merges to `main` via a dedicated workflow. PR runs diff against this baseline. The PR comment shows per-grader Δ.

### 6.3 Promotion / demotion

- `expected_fail` → `pass`: when a task flips to passing for five consecutive main-branch runs, surface it in the report as a promotion candidate. A human must review the trace before removing `expectedState: "expected_fail"` and the `trackingIssue` field. Do not auto-promote based on a lucky real-LLM pass.
- `capability` → `regression`: when a capability task passes for 10 consecutive nightly runs at ≥0.95, propose promotion.
- `pass` → `regression`: when a smoke task has been passing for 30 days, propose promotion (regression suite must stay ≥0.9).

---

## 7. Known implementation gaps (this is the load-bearing list)

These are real divergences between the contract and the code. The eval suite will expose each one. Each has a task in the relevant suite marked `expectedState: "expected_fail"` with a tracking issue. When the gap is closed, the eval flips to passing automatically.

| # | Gap | Code location | Eval task | Suite | Fix |
|---|---|---|---|---|---|
| 7.1 | Only first `recordProcess` tool call is wired | [brain.ts:122-134](../../lib/interview/director/brain.ts) uses `.find()` not `.filter()` | `multi-process-1.json`, `multi-process-2.json` | smoke (expected-fail) | Replace `.find` with a `for` loop over all `recordProcess` calls |
| 7.2 | LLM-failure catch branch does not fall back to extraction | [brain.ts:103-119](../../lib/interview/director/brain.ts) writes only `pending_re_extract` on `scope.boundaries` | `degraded-llm.json` already grades for this — passes today | edge (pass) | None — current behavior is the contract |
| 7.3 | `claims.evidence_ids` is not a column; linkage lives in `claim_evidence` | [`lib/db/write-claim.ts`](../../lib/db/write-claim.ts) writes the join table | Evidence-discipline grader must check both tables | smoke (pass once grader is correct) | Grader implementation detail, not a code fix |
| 7.4 | Direct harness must pre-populate transcript_segments + evidence | Mirrors [route.ts:92-129](../../app/api/director-interviews/%5BcaptureSessionId%5D/turns/route.ts) | Harness responsibility | n/a | Harness implementation detail |
| 7.5 | `canonicalKey()` does not recognize aliases like SFDC↔Salesforce | [tools.ts:549](../../lib/interview/director/tools.ts) is a slugger, not an ontology | `alias-canonicalization.json` | capability (expected-fail) | Add an alias table or LLM-driven canonicalization step |
| 7.6 | Calibration is partially observable: tool-helper writes use fixed confidence | [tools.ts](../../lib/interview/director/tools.ts) `recordPainPoint`/`recordSpof` etc. ignore LLM confidence | `calibration-*.json` | tracked / report-only | Propagate `confidence` + `metadata.inferred` from `extraction.claims` through tool helpers |
| 7.7 | Contradiction detection: candidates overwritten on upsert | [tools.ts:156-167](../../lib/interview/director/tools.ts) `onConflictDoUpdate` does not merge `candidates` | `contradiction-frequency.json` | edge / report-only | Merge prior `candidates[]` with new value on conflict status |

This list is the source of truth for "what does the director agent not do yet." Mirror it into `docs/evals/director/KNOWN_GAPS.md` and keep the two in sync until v1 ships.

---

## 8. Step-by-step build plan

### Week 1 — deterministic core

| Day | Deliverable |
|---|---|
| 1 | This `PLAN.md` reviewed + locked. Create `evals/director/README.md` as a 1-pager for engineers landing on the directory. |
| 2 | `task-schema.ts` + `thresholds.json` + `harness/db-fixture.ts` (reuse [tests/phase1/db.integration.test.ts](../../tests/phase1/db.integration.test.ts) pattern). |
| 3 | `harness/direct.ts` — driver that creates segments, evidence, calls `runDirectorTurn`, dumps state. Drive one hand-written task end-to-end. |
| 4 | Graders: `extraction.ts`, `entity-recall.ts`, `evidence-discipline.ts`. Wire to one task. Verify trace JSON is reviewable. |
| 5 | Graders: `hallucination.ts`, `overtrigger.ts`, `probe-target.ts`, `decision-log.ts`, `degraded-mode.ts`, `cost-latency.ts`, `state-accumulation.ts`. |
| 6 | Task fixtures: 10 smoke + 5 regression + 3 edge. Two smoke tasks marked `expected_fail` for multi-process (gap 7.1). One edge task each for gaps 7.6 and 7.7 (report-only). |
| 7 | `run.ts` CLI + `harness/report.ts` markdown reporter. `npm run eval:director:dry-run` runs without keys; `npm run eval:director:smoke` runs against real Anthropic. |
| 8 | First baseline run on `main`. Write `eval-baselines/main.json`. Manually review every failed and expected-failed trace; tune graders for unfair failures. |

End of Week 1: `npm run eval:director:smoke` runs in <5 minutes, costs <$3, produces a markdown report with per-grader Δ vs baseline.

### Week 2 — integration + capability

| Day | Deliverable |
|---|---|
| 9 | `harness/http.ts` — POSTs to the route. Drive 5 representative tasks through HTTP. |
| 10 | Expand task fixtures to 25-30. Add 5 capability tasks (allowed to fail, tracked). |
| 11 | CI workflow `.github/workflows/eval-director.yml` — smoke on PR triggers, nightly full. PR comment shows per-grader Δ. |
| 12 | `KNOWN_GAPS.md` published; link from PR comment. |
| 13 | Spot-check: invite an FDE to review 5 transcripts and rate graders. Adjust unfair failures. |
| 14 | First main-branch nightly run; full suite × 3 trials; report on `pass^3` reliability per task. |

End of Week 2: gating CI on every director-touching PR; nightly capability tracking; gaps from §7 visibly expected-failing.

### Later (v2 candidates, do not build in v1)

- LLM probe-relevance judge with held-out FDE calibration set + Cohen's κ threshold — only after the hybrid LLM scorer from BUILD_PLAN §4.4 ships in `rankProbeIntents`.
- Oracle stopping grader — when `runDirectorTurn` gains an `action: "ask" | "close" | "surface_open_questions"` return field.
- LLM persona simulator suite (capability only, nightly, report-only) for testing multi-turn conversational dynamics: follow-up after vague answer, fatigue handling, contradiction recovery.
- Anonymized real-customer-session fixtures, gated by the §12.5 redaction-cascade compliance from BUILD_PLAN.

---

## 9. Definition of Done for v1

- [ ] `npm run eval:director:dry-run` runs locally without an API key.
- [ ] `npm run eval:director:smoke` runs in CI with `ANTHROPIC_API_KEY` set, completes in <5 minutes, costs <$3 per run.
- [ ] At least 20 task fixtures exist across `smoke`, `regression`, `edge`.
- [ ] Every gap in §7 has a corresponding task marked `expected_fail` with a `trackingIssue` link.
- [ ] Every task records a trace JSON; reporter generates a reviewable markdown report.
- [ ] All ten gating graders are wired and produce numeric scores per task.
- [ ] `eval-baselines/main.json` is committed; PR runs diff against it.
- [ ] At least 5 failed traces have been manually reviewed and graders adjusted for unfair failures (per the blog's "always read the transcripts" directive).
- [ ] CI blocks PRs to director surfaces on the hard-fail set (§3) and on >10% smoke-aggregate regression vs main baseline.
- [ ] `README.md` documents v1 scope limits explicitly: no stopping behavior, no LLM persona simulator, no conversational naturalness, no probe LLM judge.

---

## 10. Open questions

1. Should `eval-baselines/main.json` be committed to the main repo or to a sibling `eval-baselines` branch to avoid noise in code-review diffs?
2. What is the cost ceiling per PR run before we move to nightly-only? ($3 estimate is rough; verify after first 10 runs.)
3. Does the alias forgiveness mechanism (`task.expected.aliases`) need its own audit log so reviewers can tell when a grader passed only because of alias forgiveness rather than agent-side canonicalization?
4. When the hybrid LLM probe scorer (BUILD_PLAN §4.4) ships, what does the calibration set for the LLM judge look like? Sketch this now so the judge isn't designed in a vacuum later.

---

*This plan is the canonical contract for the director agent eval suite. Updates require a PR + Codex review per the standard cadence.*
