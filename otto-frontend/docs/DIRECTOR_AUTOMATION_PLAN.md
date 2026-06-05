# Director Automation Plan — Technical Implementation Plan

Status: proposed (v2.2, post-Codex review round 3)
Last updated: 2026-06-04

### Changelog
- **v2.2** — incorporated Codex round-3 review: added `effort_band` to the
  per-process schema (mapped deterministically to an effort penalty); changed the
  reuse/cache key to a **prompt/model-aware `plan_input_hash`** so a prompt v2 /
  model change can't reuse a v1 plan; made the overview read + status lookup
  **capture-aware** (`captureSessionId` flows into `getDepartmentAutomationPlan`);
  specified **stale-plan precedence** (show latest completed matching plan + a
  "refresh in progress / failed" banner); and added explicit **`RangeAssumption`
  invariants** (`0 ≤ low ≤ base ≤ high`, rates clamped `0..1`, evidence_ids
  required when `basis === "evidence"`).
- **v2.1** — incorporated Codex round-2 review: added the `synthesis_run_type`
  enum migration; made `director_automation_plans` an **immutable completed-only
  artifact** with pending/running/failed state tracked on `synthesis_runs`;
  split ROI into **gross range** vs **confidence/effort-adjusted net range** to
  match existing `computeROI`; preserved the `capture_session_id` filter when
  isolating the gate; declared director plans **capture-time snapshots**; and
  changed the generation flag to **default false** (read path always safe).
- **v2** — director-first architecture (post-Codex round 1).

## 1. Background & current state

The `/overview` Automation tab is currently **operator-graph-first**. Its data comes
from `getDepartmentAutomationPlan` ([lib/overview/automation.ts](../lib/overview/automation.ts)),
which:

1. Filters process cards to `source === "process"` (operator-captured, published).
2. For each, loads the current `ProcessGraph` and calls `getProcessOpportunities`
   ([lib/processes/opportunity-queries.ts](../lib/processes/opportunity-queries.ts)).
3. Uses the agent-generated `automation_opportunity_sets` row when present
   (produced by `stage-9-opportunity-synthesis` inside operator synthesis), else
   falls back to deterministic heuristics (`buildTransformationOpportunities`).

ROI dollars are always computed deterministically by `computeROI(assumptions)`
([lib/roi](../lib/roi.ts)) from workspace price constants — the LLM never emits dollars.

### Why this is the wrong shape for the product

- `automation_opportunity_sets` is hard-keyed to `process_id` + `version_id`
  ([lib/db/schema.ts](../lib/db/schema.ts) `automationOpportunitySets`). It
  **cannot exist without a published operator process graph.**
- The product expectation is now **director-first**: after a director interview,
  the department should immediately get an executive automation plan from the
  candidate inventory — *before* any operator capture exists.
- The heuristic fallback was designed as a graph-node fallback, not an executive
  plan, so it reads generic.

Codex review confirmed: the operator path's "dropped `implementation_plan` /
`expected_result`" bug is already fixed for operator-derived opportunities. The
remaining work is the **architectural** director-first path, not bending the
operator pipeline.

### How the overview is gated today (critical for §8)

- Onboarding routes the user to `/synthesis` ([app/synthesis/SynthesisClient.tsx](../app/synthesis/SynthesisClient.tsx)),
  which polls `/api/synthesis/status` ([app/api/synthesis/status/route.ts](../app/api/synthesis/status/route.ts)).
- The redirect to `/overview` is gated on `ready_for_overview` =
  latest run `completed` **and** candidate processes exist.
- `latestSynthesisRun` selects the single most-recent `synthesis_runs` row
  (`ORDER BY updated_at DESC LIMIT 1`), regardless of `run_type`.

**The process-inventory overview map is intentionally blocked on the inventory
run. The new automation-plan run must NOT extend that block.**

## 2. Goals

1. Add a **director automation-plan synthesis** path sourced from candidate
   processes (the director inventory), independent of operator graphs.
2. Surface, per process: an **implementation plan** (how the automation
   agent(s) work) and an **expected result** (business metrics / ROI).
3. Surface a department **audit**: a core problem + ≥3 systemic patterns, each
   grounded in a business metric where possible.
4. ROI shown as **ranges** (low/base/high) with **department/process-specific
   value drivers**, methodology tied to the process, and **visible assumption
   numbers** — all computed deterministically in code.
5. **Non-blocking:** the automation-plan run must never delay the process
   overview map. If the Automation tab is opened before the plan finishes, show
   a small "still running / almost done" note instead of blocking or showing an
   empty state.

## 3. Architecture decision

Add a dedicated director-first synthesis path and a dedicated artifact table.
Do **not** reuse `automation_opportunity_sets`. The overview read path **prefers**
the director plan and falls back to **agent-generated** operator opportunities
only when no director plan exists. The deterministic graph heuristic fallback
(`buildTransformationOpportunities`) is not surfaced in the executive
Automation tab; if no director plan and no operator agent set exist, the tab
shows the no-plan / pending state instead of heuristic prose.

```
Director interview ──▶ runInventorySynthesis (existing, blocking gate)
                          │  stage-1..stage-10  → candidate_processes + claims
                          ▼
                       [overview map unblocks here]  ◀── unchanged gate
                          │
                          ▼ (async, non-blocking)
              runDirectorAutomationPlan (NEW)
                 input: candidate inventory + director transcript/claims/evidence
                 LLM: audit + per-process implementation_plan/expected_result
                      + operational assumption RANGES (no dollars)
                 code: deterministic low/base/high ROI from price constants
                 persist: director_automation_plans (NEW table)
                          │
                          ▼
              /overview Automation tab
                 prefer director_automation_plans; else operator-derived
                 if run pending/running → inline "generating" note (polled)
```

## 4. Data model

New table `director_automation_plans` (migration
`0015_director_automation_plan_table.sql` after the enum-only
`0014_director_automation_plan.sql`, plus Drizzle in `lib/db/schema.ts`, with
org RLS policies mirroring `automation_opportunity_sets`).

**This table holds immutable, completed artifacts only.** Pending / running /
failed state is **not** stored here — it lives on the `synthesis_runs` row that
produced the plan (§8). A row is inserted only when generation succeeds. This
resolves the status-vs-uniqueness conflict Codex flagged: because only completed
rows are ever written, the unique `(workspace_id, plan_input_hash)` index never
blocks a retry of an in-flight run.

Department-level key (no `process_id` / `version_id`):

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `org_id` | uuid fk | RLS |
| `workspace_id` | uuid fk | |
| `synthesis_run_id` | uuid fk | the run that produced it (see §8) |
| `source_capture_session_ids` | uuid[] | director sessions used (queried for capture-scoped reads, §7) |
| `inventory_hash` | text | hash of the candidate-inventory business input (debug/lineage) |
| `plan_input_hash` | text | **reuse key** = hash(prompt_template_id, prompt_template_version, model, inventory) |
| `plan_hash` | text | hash of `plan_json` (output) |
| `prompt_template_id` / `prompt_template_version` / `model` | text | provenance |
| `llm_request_hash` / `llm_response_hash` | text | provenance |
| `generator` | text | `"director-agent"` |
| `generator_version` | integer | default 1 |
| `plan_json` | jsonb | audit + processes (shape below) |
| `diagnostics_json` | jsonb | |
| timestamps | | `created_at`, `updated_at` |

No `status` column (see note above). Indexes: `(org_id)`,
`(workspace_id, created_at desc)`, unique `(workspace_id, plan_input_hash)` for
idempotent reuse (same pattern as `automation_opportunity_sets_version_pack_idx`).
Since every row is `completed`, the unique index needs no `WHERE` predicate.

**Reuse key — prompt/model aware (Codex P1 #2).** The operator path folds prompt
id/version + model into its evidence-pack hash so a prompt/model change forces
regeneration. We do the same:
`plan_input_hash = hash(prompt_template_id, prompt_template_version, model, inventory)`.
`inventory_hash` is retained separately for lineage/debugging but is **not** the
reuse key. This prevents a future `synthesis.director_automation` v2, model swap,
or schema change from incorrectly reusing a v1 plan.

**Retry / idempotency model:** generation reuses an existing completed row when
`plan_input_hash` matches (skip LLM). A failed run leaves **no** plan row — the
`synthesis_runs` row carries `failed`, and a retry re-runs cleanly because the
hash never got a row. On success, insert with `ON CONFLICT (workspace_id,
plan_input_hash) DO NOTHING` to tolerate concurrent runs.

`plan_json` shape (LLM output, dollar-free; validated by zod):

```ts
{
  department_name: string;
  audit: {
    problem: string;                 // core department problem
    patterns: Array<{                // >= 3
      text: string;                  // uses a business metric where possible
      metric_basis: string;          // what metric/quantity it leans on
      evidence_ids: string[];
    }>;
  };
  processes: Array<{
    candidate_process_id: string;
    process_name: string;
    implementation_plan: string;     // agent architecture: triggers, inputs,
                                     // systems, controls, exceptions, human review
    expected_result: string;         // cycle-time/hours/error/SLA/capacity/working-capital
    automation_type: AutomationType;
    pattern_id: string;
    pattern_label: string;
    affected_roles: string[];
    affected_systems: string[];
    evidence_gaps: string[];
    confidence: number;              // 0..1, realization confidence
    effort_band: "low" | "med" | "high"; // delivery effort (Codex P1) → penalty in code
    assumptions: {                   // RANGES, operational only, no dollars
      annual_volume:        RangeAssumption;
      minutes_saved_per_case: RangeAssumption;
      error_rate:           RangeAssumption;
      exception_rate:       RangeAssumption;
    };
  }>;
}

type RangeAssumption = {
  low: number; base: number; high: number;
  basis: "evidence" | "inferred";
  confidence: number;                // 0..1
  evidence_ids: string[];            // required when basis === "evidence"
};
```

`effort_band` matches the operator opportunity schema's
(`effort_band` → penalty). Map it deterministically in code using a shared
exported constant, e.g.
`EFFORT_PENALTY_BY_BAND = { low: 1.1, med: 1.35, high: 1.7 }`, and update the
operator path to use the same constant. The LLM never emits a numeric penalty.

**`RangeAssumption` validation invariants (Codex P2 #5).** The zod schema must
enforce, not just shape:
- `0 ≤ low ≤ base ≤ high` (reject inverted ranges; single-point ranges are
  allowed when evidence is precise).
- `error_rate` / `exception_rate` low/base/high each clamped to `0..1`.
- `confidence` in `0..1`; `confidence ≤ 0.45` when `basis === "inferred"`
  (mirrors the operator extractor rule).
- `evidence_ids` non-empty when `basis === "evidence"` (reuse
  `operationalAssumptionInput`'s refine in
  [lib/processes/opportunity-schema.ts](../lib/processes/opportunity-schema.ts)).

These run **before** the §11 "range realism" clamp, so a malformed range is
rejected outright rather than producing inverted or exploding ROI.

Reuse `assertNoForbiddenOpportunityKeys` ([lib/processes/opportunity-schema.ts](../lib/processes/opportunity-schema.ts))
to guarantee the LLM never emits dollars / net_score / gross_value.

## 5. Director automation-plan synthesis stage

New module `lib/synthesis/director-automation.ts`:

- `runDirectorAutomationPlan({ orgId, workspaceId, captureSessionIds, synthesisRunId?, userId })`
  1. Load candidate inventory — reuse the query in
     [lib/synthesis/inventory.ts](../lib/synthesis/inventory.ts) `loadCandidateInventory`
     (name, function, frequency, complexity hint, systems, roles, pain points +
     evidence, risks + evidence, evidence counts). Extract this query into a
     shared helper so both modules use it. The shared helper must also apply the
     generic-name exclusion already used by overview cards (`"a couple different
     things"`, `"different things"`, `"some things"`, etc.) so junk candidate
     names never become automation-plan rows.

     **Snapshot policy (Codex P2 #5):** `loadCandidateInventory` filters
     `candidate_processes.status = 'pending'` and is scoped to the director
     `capture_session_id`s, with generic placeholder names excluded. We
     therefore define the director automation plan as a **capture-time snapshot**
     of the director intake — it reflects the pending, automation-eligible
     inventory produced by that interview, captured in `plan_input_hash` (which
     folds in those candidates plus prompt/model). It is **not** a live
     re-computation of the current workspace inventory. Consequence: candidates
     later merged/promoted/discarded do not retroactively change a generated
     plan; a materially new director interview produces a new snapshot (new hash
     → new plan row). This is intentional and called out in §11.
  2. Compute `plan_input_hash = hash(prompt_template_id, prompt_template_version,
     model, inventory)` (and `inventory_hash` for lineage); if a completed
     `director_automation_plans` row with that `plan_input_hash` exists, reuse
     (skip LLM).
  3. Build evidence pack + prompt (`synthesis.director_automation` v1). Static
     instructions mirror the operator extractor's discipline
     ([lib/processes/opportunity-extractor.ts](../lib/processes/opportunity-extractor.ts)):
     - `implementation_plan` = concrete automation-agent architecture for this
       process (triggers, inputs, systems, controls, exception handling, human
       review).
     - `expected_result` = process-specific business impact via operational
       metrics.
     - Estimate operational quantities only, as `{low, base, high}` ranges.
     - Evidence-based quantities must cite `evidence_ids`; inferred ⇒ confidence
       ≤ 0.45.
     - Never emit dollars.
  4. Validate with zod; run `assertNoForbiddenOpportunityKeys`.
  5. Persist row; record a synthesis stage output (`stage-11-director-automation-plan`)
     and an agent decision for observability.

New LLM prompt template `synthesis.director_automation` registered wherever
`synthesis.opportunities` is (model selection via `anthropicModelForPrompt`).

**Feature flags — split generation from read (Codex P2 #6).** A new async LLM
path with a migration and status polling is risky to enable on deploy, so:

- `DIRECTOR_AUTOMATION_PLAN_GENERATION_ENABLED` — **default false.** Gates whether
  the new stage runs at all. Flip on deliberately after the migration is applied
  and verified.
- The **read path is always safe**: `getDepartmentAutomationPlan` falls back to
  the operator-derived path / empty state when no plan row exists, so no separate
  read flag is needed. (If we ever want to hide a generated plan, add a read flag
  later — not required for rollout.)

## 6. Deterministic ROI with ranges

Extend [lib/roi.ts](../lib/roi.ts). **Preserve the existing `computeROI`
semantics** — do not relabel gross as net (Codex P1 #3). Today `computeROI`
treats `time + error + delay` as **gross_value**, then derives **net_score** by
applying `confidence` and the `effort_penalty`. The director path must keep both
concepts so its numbers don't overstate vs the operator path.

- `computeRoiRange(rangeAssumptions, priceConstants, { confidence, effortPenalty })`
  → for each driver (time, error, delay) produce a `{low, base, high}` dollar
  range by running the existing point formula at the low/base/high ends of each
  operational range.
  - **Gross value range** = sum of driver ranges (time + error + delay).
  - **Net / realized value range** = gross range with the **same deterministic
    confidence + effort-penalty discount `computeROI` already applies** (this is
    the "70–90% realization" idea from the inspiration, but using the existing
    math rather than a new ad-hoc discount). `confidence` comes from the
    per-process `confidence`; `effortPenalty` is derived in code from the
    per-process `effort_band` (§4) via the operator path's band→penalty mapping —
    the LLM never emits a numeric penalty.
  - Report **both** gross and net ranges; the headline metric is the **net**
    range, matching operator ROI.
- Value drivers are **per process** and labeled specifically (the process name,
  its systems). Methodology strings composed in code from the process's own
  numbers, e.g. `"{volume_low}–{volume_high} cases/yr × {min} min × loaded cost"`.
- Assumption numbers (volume, minutes, error %, exception %) are surfaced in the
  ROI section, with `evidence` vs `inferred` basis badges.

> **UI note:** an earlier iteration set the tab's "Net annual value" row to
> `time + error + delay` (i.e. gross). When this lands, that row must switch to
> the **net/realized** range so the label matches the math.

The LLM contributes only operational ranges + confidence/effort bands; **all
dollars stay in code**, preserving auditability.

## 7. Overview read path

Update `getDepartmentAutomationPlan` ([lib/overview/automation.ts](../lib/overview/automation.ts)).
**It must become capture-aware (Codex P1 #3).** Today `/overview` can be scoped
by `capture_session_id`, but [app/overview/page.tsx](../app/overview/page.tsx)
does not pass it into `getDepartmentAutomationPlan`. Thread `captureSessionId`
through so a freshly finished director interview never renders a *stale*
workspace-level plan from a prior interview.

1. **Select the matching completed plan:**
   - If `captureSessionId` is present, load the latest **completed** plan whose
     `source_capture_session_ids` **contains** that capture. Otherwise load the
     latest completed plan for the workspace.
2. **Select the relevant run for status** (§8): the latest
   `director_automation_plan` `synthesis_runs` row scoped the same way
   (capture-filtered when `captureSessionId` is present, preserving the existing
   `captureSessionIds @>` predicate). This is what produces `planState`.
3. If a matching plan exists, map it into the existing `DepartmentAutomationPlan`
   shape the UI already consumes:
   - `audit` ← plan audit (problem + patterns).
   - `topOpportunities[]` ← `processes[]`, carrying `implementationPlan`,
     `expectedResult`, and the ROI ranges.
   - `metrics` ← aggregated base-case totals plus low/high for both the **gross**
     and **net/realized** ranges (§6). Headline = net range.
   - ROI rows ← per-driver gross ranges + the net/realized range + assumption
     numbers.
4. If no matching director plan exists, fall back only to completed
   **agent-generated** operator opportunities. Do not surface deterministic
   heuristic opportunities in the executive Automation tab; if the operator path
   would return `source: "heuristic"`, treat that as no automation plan content
   and render the no-plan / pending state.
5. Add a `planState` field: `"ready" | "pending" | "running" | "failed" | "none"`
   so the tab renders the right UI (§8).

### Precedence: stale completed plan vs newer in-flight run (Codex P2 #4)

Status (latest run) and content (latest completed matching plan) can disagree —
e.g. an old completed plan exists while a newer run for the same capture is
running or failed. Resolution:

- **Always render the latest completed matching plan if one exists**, and overlay
  a banner reflecting the newer run:
  - newer run `running`/`pending` → "Refreshing this plan…" banner + poll.
  - newer run `failed` → "Couldn't refresh — showing the last completed plan"
    banner + retry.
- Only show a pure pending/running state (no content) when **no** completed
  matching plan exists yet (`planState` = `pending`/`running` with empty content).
- This means `planState` carries both the run state **and** whether displayable
  content exists, so the tab can choose "content + refresh banner" vs
  "pending-only".

Extend the `DepartmentAutomationPlan` type for `implementationPlan` /
`expectedResult` (already surfaced in the operator path per Codex) and the ROI
range fields.

## 8. Non-blocking behavior + "still running" UI  ← key requirement

### Principle

- The **process-inventory overview map stays gated on the inventory run** (no
  change). This is the "first run."
- The **director automation-plan run is fully decoupled**. It never gates the
  overview redirect, and the Automation tab degrades gracefully while it runs.

### Run typing & gate isolation (correctness)

The director automation plan gets its own `synthesis_runs` row with
`run_type = "director_automation_plan"`. **This requires extending the
`synthesis_run_type` Postgres enum** — see §10 (the current enum only allows
`document_inventory`, `director_inventory`, `combined_inventory`, `process_graph`,
so the first insert would otherwise fail; Codex P1 #1).

Because `/api/synthesis/status` `latestSynthesisRun` currently takes the single
latest run **regardless of type**, we must isolate it:

- Update `latestSynthesisRun` / `ready_for_overview` to consider **inventory run
  types only** (`director_inventory`, `combined_inventory`, `document_inventory`).
  This guarantees a still-running automation plan can never flip
  `ready_for_overview` back to false or change the `/synthesis` gate.
- **Preserve the existing `capture_session_id` filter** when adding the run-type
  predicate (Codex P2 #4). The current query at
  [app/api/synthesis/status/route.ts](../app/api/synthesis/status/route.ts)
  scopes to the active capture session via
  `captureSessionIds @> ARRAY[...]`; dropping it would let one completed
  inventory run elsewhere in the workspace make a *different* active director
  session look ready. The fix is `run_type IN (...inventory...) AND <existing
  capture filter>`, not a replacement of the capture filter.

### Trigger timing

The automation plan is kicked off **after** inventory synthesis completes
(fire-and-forget via the existing Inngest path in [lib/inngest/functions.ts](../lib/inngest/functions.ts)),
so the user reaches the overview map without waiting for it.

### Status surface for the tab

Add `/api/automation-plan/status` (or extend `/api/synthesis/status` with an
`automation_plan` block). It is **capture-aware** — accepts `workspace_id` and
optional `capture_session_id` and scopes both the run lookup and the
"has-content" check to that capture (preserving the `captureSessionIds @>`
predicate), mirroring §7. Returns:

```ts
{ run_state: "none" | "pending" | "running" | "completed" | "failed",
  has_completed_plan: boolean,   // a matching completed plan row exists
  updated_at: string | null }
```

`run_state` is derived from the **latest matching `director_automation_plan`
`synthesis_runs` row** (its `status`/`stage`) — **not** from a column on
`director_automation_plans` (that table is completed-only, §4).
`has_completed_plan` drives the precedence rule in §7 (show stale content +
refresh banner vs pending-only). `none` means no director automation run has been
started for this scope yet.

### Tab UX

`OverviewClient` / `AutomationTab` ([components/overview/AutomationTab.tsx](../components/overview/AutomationTab.tsx)):

- Server render passes `planState` from `getDepartmentAutomationPlan`, which
  encodes both the run state and whether displayable content exists (§7
  precedence).
- **No completed plan yet + run `pending`/`running`:** render the tab chrome
  (header card) plus an inline notice — *"Otto is still building this
  department's automation plan — almost done. This usually takes under a
  minute."* — and **client-side poll** `/api/automation-plan/status` every ~3s;
  when `run_state` flips to `completed`, `router.refresh()` to pull the plan.
- **Completed plan exists + a newer run is `pending`/`running`:** render the
  existing completed plan **plus** a subtle "Refreshing this plan…" banner; poll
  and refresh on completion.
- **Completed plan exists + newer run `failed`:** render the completed plan plus
  a "Couldn't refresh — showing the last completed plan" banner + retry.
- **No completed plan + run `failed`:** short error note + retry (re-trigger the
  stage).
- **`none`** (no director run yet, e.g. operator-only workspace): keep current
  operator-derived behavior / empty state.
- The **process map / Overview tab renders fully regardless** of `planState`.

## 9. UI changes (mostly already done)

Prior turns already restructured the tab (numbered cards, two-column
implementation/expected-result pill cards, audit as Problem + patterns, ROI
table with assumptions intro). Remaining:

- Wire `implementationPlan` / `expectedResult` from the director mapping into the
  two-column cards (replace the ROI-reconstructed expected-result text).
- Convert the ROI table to **ranges** + per-process value drivers + visible
  assumption numbers (§6).
- Add the pending/running/failed + refresh-banner states (§8).
- Thread `captureSessionId` from [app/overview/page.tsx](../app/overview/page.tsx)
  into `getDepartmentAutomationPlan` (§7) — it is currently dropped.
- Ensure the director inventory helper excludes generic placeholder process
  names before prompt construction (§5).

## 10. Migration & rollout

1. `migrations/0014_director_automation_plan.sql`:
   - **`ALTER TYPE synthesis_run_type ADD VALUE 'director_automation_plan';`**
     (Codex P1 #1 — the enum at [lib/db/schema.ts](../lib/db/schema.ts) currently
     allows only `document_inventory`, `director_inventory`, `combined_inventory`,
     `process_graph`; without this the first run insert fails). Note: Postgres
     requires `ADD VALUE` to run **outside** a transaction block, or in its own
     migration step separate from statements that use the new value.
2. `migrations/0015_director_automation_plan_table.sql`:
   - `CREATE TABLE director_automation_plans` + indexes + RLS org policies
     (mirror `automation_opportunity_sets`).
3. `lib/db/schema.ts` — extend the `synthesis_run_type` enum + add
   `directorAutomationPlans` table + relations.
4. Flag `DIRECTOR_AUTOMATION_PLAN_GENERATION_ENABLED` **default false**; read path
   is always safe and falls back with zero UI breakage. Flip generation on after
   the migration is verified in the target environment.
5. Backfill: none required — plans generate on the next director synthesis;
   existing workspaces show operator-derived/empty until re-run.
6. Sequencing: enum + table migration and the `latestSynthesisRun` run-type
   isolation (§8) must ship **together** so a `director_automation_plan` run can
   never transiently affect the `/synthesis` gate (§11).

## 11. Risks & open questions

- **Candidate ↔ process identity:** director plans reference
  `candidate_process_id`; once a candidate is promoted/operator-captured, decide
  whether the operator-derived opportunity supersedes or augments the director
  card. Proposed: director plan is the department default; operator captures
  refine an individual card later.
- **Snapshot vs live (resolved, §5):** director plans are **capture-time
  snapshots** of the pending director inventory, not live workspace
  recomputations. Merges/promotions/deletions after generation don't mutate an
  existing plan; a new interview yields a new snapshot. Accept this tradeoff for
  determinism/auditability.
- **Cost/latency:** one extra LLM call per director synthesis. Idempotent reuse
  via `plan_input_hash` avoids regeneration on unchanged input.
- **Range realism:** low/base/high come from the LLM's operational estimates;
  consider clamping ranges (reuse `clampOperationalAssumptions` pattern) so a
  wide inferred range can't produce absurd dollar spreads.
- **Status race:** ensure the gate isolation in §8 lands in the same change as
  the new run type + enum migration, or a fast automation run could transiently
  affect `/synthesis`.
- **Enum migration ordering:** `ALTER TYPE ... ADD VALUE` cannot run in the same
  transaction that uses the value; keep it as its own step (§10).

## 12. File touch list

New:
- `migrations/0014_director_automation_plan.sql` (enum value only)
- `migrations/0015_director_automation_plan_table.sql`
- `lib/synthesis/director-automation.ts`
- `lib/processes/director-automation-schema.ts` (zod + tool schema + types)
- `app/api/automation-plan/status/route.ts`
- `../prompts/synthesis.director_automation.md`

Changed:
- `lib/db/schema.ts` (extend `synthesis_run_type` enum + new table + RLS)
- `lib/env.ts` (`DIRECTOR_AUTOMATION_PLAN_GENERATION_ENABLED`, default false)
- `lib/synthesis/inventory.ts` (extract shared `loadCandidateInventory`; trigger plan after completion)
- `lib/inngest/functions.ts` (enqueue director automation plan post-inventory)
- `lib/overview/automation.ts` (prefer director plan; add `planState`; ROI ranges mapping)
- `lib/roi.ts` (`computeRoiRange`)
- `lib/processes/opportunity-grounding.ts` / `lib/processes/opportunity-queries.ts`
  (share `EFFORT_PENALTY_BY_BAND` with director ROI mapping)
- `app/api/synthesis/status/route.ts` (isolate gate to inventory run types)
- `app/overview/page.tsx` + `OverviewClient.tsx` (thread `captureSessionId` into
  `getDepartmentAutomationPlan`; pass `planState`)
- `components/overview/AutomationTab.tsx` (implementation/expected wiring, ROI ranges, pending notice)
```
