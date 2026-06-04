# Opportunity Agent Plan — Hybrid LLM + Deterministic ROI

**Status:** v3 (remaining Codex review findings incorporated)
**Owner:** opportunity identification ("highest-ROI automation opportunities" — the product headline)
**Scope:** Replace the render-time heuristic stub with a persisted hybrid agent: an Opus reasoner proposes opportunities (pattern, current→target, which steps, evidence) and a deterministic engine grounds the dollars.

### Revision log — v1 → v2 (per Codex review)
- **P1 — flag must gate the read path:** `getProcessOpportunities` now ignores persisted sets entirely when `OPPORTUNITY_AGENT_ENABLED` is off, so stale/staging/backfill rows can't leak; the flag is a true kill switch (§8 step 1, §13, §10).
- **P1 — idempotency enforced in schema:** added `uniqueIndex(versionId, evidencePackHash)` to `automation_opportunity_sets` + immutable insert/fetch, mirroring `workflow_semantic_models` (schema.ts:1321); resolves duplicate-set/ambiguous-latest race (§4.1, §15).
- **P1 — model id not hardcoded to a guessed family:** removed the literal `claude-opus-4-8`; model ids now come from provider/gateway config, with a real preflight probe against the configured Anthropic endpoint (or an explicit gateway allowlist) rather than an imaginary in-process allowlist (§5.4).
- **P2 — price ownership conflict:** the three price fields are removed from `ROIAssumptionEditor`; per-opportunity overrides accept operational quantities only; prices live solely in the workspace finance panel, rejected server-side in the override route (§4.2, §9, §14).
- **P2 — `.strict()` is mandatory:** all output Zod objects are `.strict()` (Zod strips unknown keys by default, which would make the "reject leaked dollars" test vacuous) + a post-parse `assertNoForbiddenKeys` denylist scan + `additionalProperties:false` in the JSON/tool schema (§5.2, §10, §12, §15).

### Revision log — v2 → v3 (remaining Codex review)
- **P1 — model validation grounded in the adapter:** removed the claim that the local adapter "recognizes" model ids by name; preflight now calls the configured provider/gateway with a tiny request or validates against a gateway-owned allowlist, and docs must not rely on public Anthropic strings unless the app uses Anthropic direct (§5.4, §15).
- **P2 — immutable artifacts:** `automation_opportunity_sets` are write-once; idempotency uses `onConflictDoNothing` + fetch existing, never `onConflictDoUpdate` (§4.1, §7, §15).
- **P2 — completed-stage eligibility:** persist set + audit + decision log + completed `synthesis_stage_outputs` row in one transaction; reads only use sets referenced by a completed stage row, so a failed stage cannot leak an agent set (§7, §8, §10, §15).
- **P2 — override scope:** assumption overrides are scoped to the exact `opportunity_set_key` + `opportunity_id`, not just `(version, opportunity)`, so regenerated sets do not inherit stale edits by accident (§4.2, §8, §9).
- **P3 — evidence-basis enforcement:** `basis="evidence"` requires at least one valid evidence id via schema refinement and grounding downgrade; invalid evidence-backed quantities become inferred with confidence capped at 0.45 (§5.2, §6, §15).

---

## 1. Problem & current state (grounded)

Today opportunity identification is a **deterministic heuristic computed at page-render time** and never persisted:

- `lib/processes/opportunity-heuristics.ts` — `buildTransformationOpportunities(graph)` walks graph nodes and emits an opportunity per `workaround` / `exception` / `wait|sla` / low-confidence node, with hard-coded `assumptionsForImpact()` tiers (`high/med/low` → fixed volume/minutes/rates).
- `lib/roi.ts` — `computeROI(assumptions)` is the deterministic dollar math (`annual_time_value`, `annual_error_value`, `annual_delay_value`, `gross_value`, `net_score`). **This is good and stays.**
- `app/process/[id]/workspace/automation/page.tsx` — calls `buildTransformationOpportunities(graph)` then `computeROI(...)` **on every render**. Nothing is stored.
- `components/workspace/ROIAssumptionEditor.tsx` — lets a user edit assumptions, but edits live in `useState` only (**not persisted**).
- Other consumers: `components/workspace/tabs/ImpactTab.tsx`, `app/admin/exports/page.tsx`, `app/synthesis/SynthesisClient.tsx` — all flow through the same heuristic + `computeROI`.

**Weaknesses:**
1. The reasoning is `if (node.data.workarounds) push(...)` — it cannot reason about *why* a step is automatable, combine signals across steps, or rank by genuine business judgment.
2. ROI assumptions are fixed tiers unrelated to the actual evidence (volume/minutes are constants).
3. Opportunities are recomputed per render → not auditable, not diff-able across versions, no eval target, HITL edits evaporate.

**What's already right and reused:**
- The synthesis pipeline (`lib/synthesis/operator-process.ts`) is a checkpointed, versioned, idempotent DAG with `synthesis_stage_outputs` rows per stage and `operatorProcessStageVersions` version map. We add a stage here.
- `lib/workflow/semantic-llm-extractor.ts` is the canonical pattern for a persisted, validated, evidence-grounded LLM stage (structured tool-call, model routing via `anthropicModelForPrompt`, evidence-pack hashing, quote validation, request/response hashing, compact-retry on truncation). The opportunity agent mirrors it.
- `workflow_semantic_models` table is the template for a per-version LLM artifact table.
- `lib/adapters/llm.ts` `structured()` (tool-call + Zod schema + prompt caching + retry) and per-role model routing in `lib/ai/models.ts`.

---

## 2. Design principles

1. **LLM reasons; code does arithmetic.** The model proposes the *pattern*, *which steps*, *current→target narrative*, *evidence citations*, and **operational quantities** (volume, minutes-saved, error/exception rates) — each tagged with a basis and confidence. The model **never** emits a dollar figure, a `net_score`, or a price.
2. **Prices are config, not model output.** `loaded_hourly_cost`, `cost_per_error`, `delay_cost` are org/workspace constants injected by code. The LLM cannot see or set them.
3. **Deterministic grounding is the guardrail.** After the LLM responds, code validates evidence, clamps every operational quantity to bounds, fills omissions from the existing `assumptionsForImpact()` tier defaults, injects price constants, then runs the unchanged `computeROI()`. Ranking is `net_score` desc — same as today.
4. **Never regress.** The deterministic heuristic (`buildTransformationOpportunities`) stays as the fallback. If the agent stage is disabled, fails, or produces zero valid opportunities, the read path falls back to heuristics. The agent is strictly additive.
5. **Persisted, versioned, auditable.** Opportunities become a synthesis artifact attached to a `process_version`, generated once at synthesis, replayable, eval-able, and diff-able. Render reads; it does not call the LLM.
6. **HITL edits persist.** Assumption overrides are stored per exact opportunity set + opportunity, then re-applied at read time before `computeROI`.

---

## 3. Architecture overview

```
runOperatorProcessSynthesis (existing)
  …stage-7-narrative → writeOperatorGraphDraft → publishOperatorGraphDraft…
  + stage-9-opportunity-synthesis   ← NEW, runs after draft graph exists, NON-FATAL
        │
        ├─ build OpportunityEvidencePack (graph nodes + node evidence + complexity + narrative)
        ├─ Opus structured tool-call  →  raw proposals (NO dollars)
        ├─ deterministic grounding:
        │     validate evidence_ids & source_node_ids
        │     clamp operational quantities, fill tier defaults
        │     inject price constants
        │     computeROI() → net_score
        │     dedupe + rank
        └─ persist automation_opportunity_sets row (immutable artifact) + audit + stage row

Read path (automation page / Impact tab / exports):
  getProcessOpportunities(version)
     → load latest completed opportunity set for version
     → apply assumption overrides scoped to that set (HITL)
     → computeROI + sort
     → if no set / stage failed: fall back to buildTransformationOpportunities()
```

**Why a synthesis stage, not a render-time call:** LLM calls must not run on page render (latency, cost, non-determinism, no idempotency). Generating at synthesis gives us the evidence pack, checkpointing, idempotency, and audit for free, exactly like `workflow_semantic_models`.

**Why non-fatal:** opportunities are downstream of an already-valid published graph. A failed opportunity stage must not fail the synthesis run or block the map; it degrades to the heuristic fallback.

---

## 4. Data model changes

### 4.1 New table `automation_opportunity_sets` (the agent artifact)

Mirror `workflow_semantic_models` (`lib/db/schema.ts:1283`). One row per generation; immutable/write-once.

```ts
export const automationOpportunitySets = pgTable("automation_opportunity_sets", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").references(() => organizations.id).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
  processId: uuid("process_id").references(() => processes.id).notNull(),
  versionId: uuid("version_id").references(() => processVersions.id).notNull(),
  synthesisRunId: uuid("synthesis_run_id").references(() => synthesisRuns.id),
  evidencePackHash: text("evidence_pack_hash").notNull(),
  opportunitySetHash: text("opportunity_set_hash").notNull(),
  promptTemplateId: text("prompt_template_id").notNull(),
  promptTemplateVersion: text("prompt_template_version").notNull(),
  model: text("model").notNull(),
  llmRequestHash: text("llm_request_hash"),
  llmResponseHash: text("llm_response_hash"),
  generator: text("generator").notNull(),            // "agent" | "heuristic_fallback"
  generatorVersion: integer("generator_version").notNull().default(1),
  opportunitiesJson: jsonb("opportunities_json").default(sql`'[]'::jsonb`).notNull(),
  diagnosticsJson: jsonb("diagnostics_json").default(sql`'[]'::jsonb`).notNull(),
  ...timestamps,
}, (table) => ({
  orgIdx: index("automation_opportunity_sets_org_id_idx").on(table.orgId),
  versionIdx: index("automation_opportunity_sets_version_idx").on(table.versionId),
  // per Codex P1: enforce idempotency at the DB level, mirroring workflow_semantic_models'
  // unique hash index (schema.ts:1321). Without this, concurrent reruns create duplicate
  // sets and "latest for version" is ambiguous.
  uniqHash: uniqueIndex("automation_opportunity_sets_version_pack_idx").on(
    table.versionId,
    table.evidencePackHash,
  ),
}));
```

`opportunitiesJson` stores the **grounded** opportunity objects (LLM proposal + filled assumptions + computed ROI snapshot), shaped to a superset of `lib/types/opportunity.ts:Opportunity`.

**Idempotency and immutability (per Codex P1/P2).** `evidencePackHash` includes prompt id+version+model, so `uniq(versionId, evidencePackHash)` is the dedupe key. The persist step uses `onConflictDoNothing` on that index, then fetches the existing row when there is a conflict. It must never use `onConflictDoUpdate`, because that would rewrite an immutable audit artifact. "Latest for version" is resolved deterministically by `created_at desc` among distinct hashes, but the read path only considers rows referenced by a completed `stage-9-opportunity-synthesis` stage (§8).

### 4.2 New table `opportunity_assumption_overrides` (HITL edits)

```ts
export const opportunityAssumptionOverrides = pgTable("opportunity_assumption_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").references(() => organizations.id).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
  versionId: uuid("version_id").references(() => processVersions.id).notNull(),
  opportunitySetKey: text("opportunity_set_key").notNull(), // agent:<set_id> or heuristic:<version_id>:<heuristic_version>
  opportunityId: text("opportunity_id").notNull(),   // stable id from the set
  assumptionsJson: jsonb("assumptions_json").notNull(), // partial ROIAssumptions patch
  editedByUserId: uuid("edited_by_user_id").references(() => users.id),
  ...timestamps,
}, (table) => ({
  uniq: uniqueIndex("opportunity_override_set_opp_idx").on(
    table.versionId,
    table.opportunitySetKey,
    table.opportunityId,
  ),
}));
```

Override is a **partial** assumptions patch applied over the grounded assumptions at read time, then re-clamped and re-`computeROI`'d. Override patches may set **operational** quantities only; **price** fields (`loaded_hourly_cost`, `cost_per_error`, `delay_cost`) are governed by workspace finance config (§4.3), not per-opportunity overrides.

**Override scope (per Codex P2).** Overrides attach to the exact set the user edited via `opportunitySetKey`, not only `(versionId, opportunityId)`. Agent sets use `agent:${automationOpportunitySet.id}`. Heuristic fallback uses `heuristic:${versionId}:${HEURISTIC_OPPORTUNITY_VERSION}`. A regenerated agent set starts without inherited overrides unless a future explicit carry-forward flow maps old opportunities to new ones and audits that mapping.

**Per Codex P2 — editor conflict.** Today `components/workspace/ROIAssumptionEditor.tsx` exposes the price fields directly in its `FIELDS` list (`loaded_hourly_cost` at line 15, `cost_per_error` at 17, `delay_cost` at 19). Those three fields **must be removed from the per-opportunity editor** and replaced with a read-only display of the resolved workspace price + a link to the workspace finance panel (§9). The override `POST` route also rejects price keys server-side (defense in depth), so a stale client cannot write a price into `opportunity_assumption_overrides`.

### 4.3 New table `workspace_roi_prices` (finance config — v1)

Price constants are **workspace-level finance config**, not a code constant. One row per workspace; editable by finance/admin.

```ts
export const workspaceRoiPrices = pgTable("workspace_roi_prices", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").references(() => organizations.id).notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
  loadedHourlyCost: numeric("loaded_hourly_cost", { precision: 10, scale: 2 }).notNull(),
  costPerError: numeric("cost_per_error", { precision: 10, scale: 2 }).notNull(),
  delayCost: numeric("delay_cost", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  editedByUserId: uuid("edited_by_user_id").references(() => users.id),
  ...timestamps,
}, (table) => ({
  uniq: uniqueIndex("workspace_roi_prices_workspace_idx").on(table.workspaceId),
}));
```

Loader `getWorkspaceRoiPrices(orgId, workspaceId)` returns the row, falling back to `ROI_PRICE_DEFAULTS` (`{ loaded_hourly_cost: 65, cost_per_error: 90, delay_cost: 35 }`, extracted from today's `assumptionsForImpact`) when unset. The LLM never sees or sets these — they are injected by code at grounding time (§6).

### 4.4 Migration

Drizzle migration adding the three new tables + RLS/org-scoping consistent with neighbors. Seed each existing workspace's `workspace_roi_prices` with `ROI_PRICE_DEFAULTS` (so behavior is unchanged until finance edits them). No opportunity backfill needed (read path falls back to heuristics for old versions).

---

## 5. The LLM agent

### 5.1 Inputs — `OpportunityEvidencePack`

New builder `lib/processes/opportunity-evidence.ts: buildOpportunityEvidencePack(...)`. Assembled from already-available synthesis data (no new captures):

- **Graph**: the validated `ProcessGraph` (`draft.graph`) — nodes with `title`, `type`, `systems`, `sla_seconds`, `est_minutes`, `exceptions`, `workarounds`, `variants`, `confidence`, `evidence_ids`, `claim_ids`.
- **Node evidence excerpts**: for each node's `evidence_ids`, the evidence text/quote (from `evidence` table), capped per node — so the LLM can cite and quote, exactly like `buildSemanticPromptContext`.
- **Complexity** (`complexity` from stage-6) and **narrative** (stage-7) for business framing.
- **Pattern catalog**: the allowed `AutomationType` + `pattern_id/pattern_label` set (from `lib/types/opportunity.ts` + heuristic labels), passed in the prompt so the model classifies into a closed vocabulary.
- **Tier defaults table**: the `assumptionsForImpact` numbers, shown read-only so the model understands the scale it's estimating in (but it returns quantities, not dollars).

Context is built with the same budgeting discipline as `buildSemanticPromptContext` (per-source caps, compact-retry on truncation via `isStructuredTruncationError`).

### 5.2 Output schema (Zod) — `lib/processes/opportunity-schema.ts`

**No dollar fields. No `net_score`. No prices.**

> **Per Codex P2 — `.strict()` is mandatory, not optional.** Zod **strips** unknown keys by default, so a model that leaks `net_score`, `gross_value`, `loaded_hourly_cost`, etc. would be *silently accepted* (keys dropped), and the "reject leaked dollar fields" test in §12 would pass vacuously. Every object below is `.strict()` so unknown keys throw. We additionally run a post-parse `assertNoForbiddenKeys()` guard (deep scan for a denylist: `net_score`, `gross_value`, `annual_*_value`, `*_cost`, `price`, `usd`, `dollars`) before grounding — defense in depth, since `.strict()` only checks the top level of each object and the tool-call/JSON-schema path may differ from the Zod path.

```ts
const operationalAssumptionInput = z.object({
  value: z.number().nonnegative(),
  basis: z.enum(["evidence", "inferred"]),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()).default([]),  // required when basis="evidence"
}).strict().superRefine((value, ctx) => {
  if (value.basis === "evidence" && value.evidence_ids.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_ids"],
      message: 'evidence_ids is required when basis is "evidence"',
    });
  }
}).optional();

const opportunityProposal = z.object({
  source_node_ids: z.array(z.string()).min(1),     // must exist in graph
  title: z.string().min(3),
  problem: z.string().min(3),
  proposed_solution: z.string().min(3),
  current_state: z.string().min(3),
  target_state: z.string().min(3),
  automation_type: z.enum([...AUTOMATION_TYPES]),  // closed set
  pattern_id: z.string(),                          // validated against catalog
  pattern_label: z.string(),
  impact_band: z.enum(["high", "med", "low"]),     // drives default tier, NOT dollars
  effort_band: z.enum(["low", "med", "high"]),
  assumption_confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()).default([]),   // validated against allowed set
  rationale: z.string().min(3),
  // operational quantities ONLY — code converts to dollars
  assumptions: z.object({
    annual_volume: operationalAssumptionInput,
    minutes_saved_per_case: operationalAssumptionInput,
    error_rate: operationalAssumptionInput,        // 0..1
    exception_rate: operationalAssumptionInput,    // 0..1
  }).strict().default({}),
}).strict();

export const opportunitySetSchema = z.object({
  opportunities: z.array(opportunityProposal).max(12),
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() }).strict()).default([]),
}).strict();
```

JSON-schema sibling in `schemas/automation-opportunities.schema.json` + an Anthropic `input_schema` for the tool, consistent with `schemas/` convention. The JSON-schema/tool variant sets `"additionalProperties": false` on every object to match `.strict()` and steer the model away from emitting forbidden keys in the first place.

**Evidence-basis enforcement (per Codex P3).** The schema rejects `basis: "evidence"` with an empty `evidence_ids` array. Grounding then filters those ids against `allowedEvidenceIds`; if none survive, that quantity is downgraded to `basis: "inferred"` and its confidence is capped at `0.45`. This avoids treating a syntactically valid but non-resolving citation as evidence-backed.

### 5.3 Prompt — `prompts/synthesis.opportunities.md`

Frontmatter: `template_id: synthesis.opportunities`, `template_version: "1"`, `model_role: OPPORTUNITY_MODEL`, `max_output_tokens: ~4000`.

Contract (mirrors the evidence discipline already enforced in `prompts/director.turn.plan.md`):

- You are Otto's automation strategist. Read the validated current-state process graph + evidence and return the highest-ROI automation opportunities as structured JSON.
- **Classify** each opportunity into the closed pattern catalog (`automation_type` + `pattern_id`).
- **Pick the specific steps** (`source_node_ids` must be real node ids from the graph).
- **Write `current_state` → `target_state`** grounded in what the evidence shows.
- **Cite evidence**: every claim ties to `evidence_ids` present in the pack. Quote only text that appears in the evidence.
- **Estimate operational quantities only** (volume, minutes saved, error/exception rates), each with `basis` (`evidence` if grounded in a cited quote, else `inferred`) and `confidence`. **If inferred, confidence ≤ 0.45.** Omit a quantity you cannot reasonably estimate (code fills the default).
- **Never** output dollars, savings, net scores, hourly costs, or prices. **Never** invent systems, steps, volumes, or evidence ids.
- Prefer fewer high-confidence opportunities over broad weak ones. Max 12.

The static prefix (system + pattern catalog + schema + tier table) goes in the cached block (`static_input`), only the evidence pack varies — so prompt caching hits (`PROMPT_CACHE_MIN_STATIC_CHARS`).

### 5.4 Model routing

- Add `OPPORTUNITY_MODEL` to `ServerEnv` and to `anthropicModelForPrompt` in `lib/ai/models.ts`:
  ```ts
  if (promptTemplateId.startsWith("synthesis.opportunities")) {
    return env.OPPORTUNITY_MODEL ?? env.SYNTHESIS_PLANNER_MODEL ?? env.ANTHROPIC_MODEL ?? providerDefaultOpusModel(env);
  }
  ```
- **Model id (per Codex P1 — validate against the real provider path).** The app's direct Anthropic adapter posts `model` straight to `/v1/messages`; it does not maintain a meaningful local allowlist. Therefore the default must come from provider/gateway configuration, not a guessed string in the plan. `providerDefaultOpusModel(env)` reads a deployment-owned provider config or throws with a setup error if no verified default is configured. For direct Anthropic, use the current direct-API model id documented for the org; for an internal LLM gateway, use the gateway alias and document that it is a gateway alias.
- Add a startup/preflight check that actually exercises the configured path: either (a) sends a tiny `max_tokens: 1` request to the configured Anthropic endpoint with the resolved opportunity model, or (b) validates the resolved id against an explicit gateway-owned allowlist/config endpoint. A local regex or "contains opus" check is not sufficient.
- Add `anthropicMaxTokensForPrompt` case for `synthesis.opportunities` → ~4000.
- `.env` / `.env.example`: `OPPORTUNITY_MODEL=""` (empty ⇒ inherit `SYNTHESIS_PLANNER_MODEL` / `ANTHROPIC_MODEL` / provider default), documented with the currently valid provider/gateway id and the preflight behavior.

### 5.5 Extractor — `lib/processes/opportunity-extractor.ts`

`extractAutomationOpportunities({ pack }): Promise<OpportunityExtraction>` — structurally identical to `extractWorkflowSemanticModel`:
- `structured({ prompt_template_id: "synthesis.opportunities", schema: opportunitySetSchema, anthropic_tool, static_input, input, ... })`
- compact-retry on truncation
- returns `{ proposals, diagnostics, metadata, promptTemplateId, promptTemplateVersion, modelId, llmRequestHash, llmResponseHash, evidencePackHash }`

---

## 6. Deterministic grounding engine — `lib/processes/opportunity-grounding.ts`

`groundOpportunities(proposals, { graph, allowedEvidenceIds, priceConstants }): GroundedOpportunity[]`

Pure, no I/O, fully unit-testable. Steps per proposal:

1. **Evidence validation.** Keep only `evidence_ids` ∈ `allowedEvidenceIds` (graph node evidence ∪ version evidence). If, after filtering, an opportunity has **zero** valid evidence → set `grounding = "assumption"` and cap `assumption_confidence ≤ 0.45` (mirrors the director "inferred ⇒ ≤0.45" rule).
2. **Node validation.** Keep only `source_node_ids` ∈ `graph.nodes`. If none valid → **drop** the opportunity (record diagnostic).
3. **Pattern validation.** `automation_type` must be in the `AutomationType` enum; `pattern_id` in the known catalog; else map to nearest or drop.
4. **Quantity evidence validation.** For each operational quantity with `basis: "evidence"`, filter its `evidence_ids` to `allowedEvidenceIds`. If none remain, downgrade that quantity to `basis: "inferred"` and cap that quantity confidence at `0.45`; record a diagnostic. This is separate from proposal-level evidence validation because a proposal may be evidence-grounded while one quantity is inferred.
5. **Assumption assembly** → full `ROIAssumptions`:
   - For each operational quantity the LLM provided: clamp to `[min,max]` bounds (table below).
   - For each omitted quantity: fill from `assumptionsForImpact(impact_band, derivedConfidence)` (reuse existing function).
   - **Inject prices** (`loaded_hourly_cost`, `cost_per_error`, `delay_cost`) from `priceConstants` (the resolved `workspace_roi_prices` row, §4.3) — overriding anything the model might have leaked.
   - `confidence` = aggregate of per-quantity confidences (min, or evidence-weighted).
   - `effort_penalty` from `effort_band` (low→1.1, med→1.35, high→1.7, matching current tiers).
6. **Compute ROI.** `computeROI(assumptions)` (unchanged) → attach `annual_*`, `gross_value`, `net_score`.
7. **Dedupe** by `(primary source_node_id, pattern_id)`; keep highest `net_score`.
8. **Rank** by `net_score` desc (identical to current page behavior).

**Bounds table** (clamp; rejects absurd LLM values):

| quantity | min | max |
|---|---|---|
| annual_volume | 1 | 5,000,000 |
| minutes_saved_per_case | 0.5 | 480 |
| error_rate | 0 | 1 |
| exception_rate | 0 | 1 |
| confidence | 0 | 1 |
| effort_penalty | 1 | 5 |

**Price source:** the resolved `workspace_roi_prices` row (§4.3), falling back to `ROI_PRICE_DEFAULTS` when a workspace hasn't set finance config. Prices are passed into `groundOpportunities` as `priceConstants`; the function stays pure (no I/O — the caller resolves prices). The LLM never sees or sets these.

---

## 7. Pipeline integration

In `lib/synthesis/operator-process.ts`:

1. Add `"stage-9-opportunity-synthesis": 1` to `operatorProcessStageVersions`.
2. After `stage-7-narrative` and the draft write (we have `draft.versionId` and `draft.graph`), and after/around publish, run the opportunity stage inside a **try/catch that never throws** to the run:

```ts
try {
  const oppPack = await buildOpportunityEvidencePack({ ...input, versionId: draft.versionId, graph: draft.graph, complexity, narrative });
  const extraction = await extractAutomationOpportunities({ pack: oppPack });
  const priceConstants = await getWorkspaceRoiPrices(input.orgId, input.workspaceId);
  const grounded = groundOpportunities(extraction.proposals, {
    graph: draft.graph,
    allowedEvidenceIds: oppPack.allowedEvidenceIds,
    priceConstants,
  });
  await persistCompletedAutomationOpportunityStage({
    ...ids,
    versionId: draft.versionId,
    extraction,
    grounded,
    generator: "agent",
    inputRowRefs: [{ table: "process_versions", id: draft.versionId }],
  });
} catch (error) {
  await recordOperatorStage({ ...ids, stageName: "stage-9-opportunity-synthesis", status: "failed",
    errorJson: { message: String(error) } });
  // NON-FATAL: synthesis run still completes; read path falls back to heuristics.
}
```

3. **Atomic completion (per Codex P2).** `persistCompletedAutomationOpportunityStage` opens one DB transaction and writes the immutable set row, `audit_log`, `agent_decision_log`, and completed `synthesis_stage_outputs` row together. If any write fails, the transaction rolls back so no readable set remains. The failed catch records a failed stage separately.
4. **Idempotency / replay:** keyed by `evidencePackHash` (which includes prompt id+version+model). Re-running synthesis with an unchanged graph + same template skips the LLM call when a completed set already exists. If a race inserts the same hash, `onConflictDoNothing` preserves the original immutable row and the caller fetches it; it does not update the artifact.
5. **Checkpointing:** the stage is its own `synthesis_stage_outputs` row, so partial reruns and observability work like every other stage. Read eligibility requires this stage row to be `completed` and reference the set.
6. **Audit:** write an `audit_log` row (`event_type: "synthesis.opportunities.generated"`) and an `agent_decision_log` row capturing model, token/cost (`metadata` from `structured()`), counts, and diagnostics — same audit spine as the interview agents (`writeAgentDecisionInTransaction`).

---

## 8. Read path & persistence

New `lib/processes/opportunity-queries.ts`:

- `getProcessOpportunities(orgId, workspaceId, processId, version)`:
  1. **Read-path flag gate (per Codex P1).** If `OPPORTUNITY_AGENT_ENABLED` is **off**, **do not look at `automation_opportunity_sets` at all** — go straight to the heuristic and return `{ source: "heuristic" }`. The flag gates *both* generation (stage-9) *and* read. This is the critical fix: persisted rows from staging, a backfill, or a partial rollout must not leak into a prod where the agent is disabled. Disabling the flag must restore exact heuristic behavior regardless of what rows exist.
  2. Resolve `priceConstants = getWorkspaceRoiPrices(orgId, workspaceId)` (falls back to `ROI_PRICE_DEFAULTS`).
  3. (Flag on) Load latest **eligible** `automation_opportunity_sets` for `version.version_id`: join/filter through `synthesis_stage_outputs` where `stage_name = "stage-9-opportunity-synthesis"`, `status = "completed"`, and `output_row_refs` references the set id. Rows not backed by a completed stage are ignored.
  4. If found (`generator: "agent"`): load `opportunity_assumption_overrides` for `opportunitySetKey = agent:${set.id}`, apply patches over grounded operational assumptions, inject resolved prices, re-clamp, `computeROI`, re-sort. Return `{ source: "agent", opportunitySetKey, opportunities }`.
  5. If not found or empty: `buildTransformationOpportunities(graph)` with prices injected + `computeROI` (today's behavior). Return `{ source: "heuristic" }`.

  Because prices are applied at read time, editing workspace finance config instantly re-prices every opportunity (agent and heuristic) without re-running the LLM.

  **Flag scope note:** the gate should be resolvable per-org/workspace (not just a global env), so the same code can support a per-tenant rollout — but the default-off semantics above hold at every scope.

Refactor consumers to use this query instead of calling the heuristic directly:
- `app/process/[id]/workspace/automation/page.tsx`
- `components/workspace/tabs/ImpactTab.tsx`
- `app/process/[id]/workspace/transformation/page.tsx` (if it surfaces opportunities)
- `app/admin/exports/page.tsx` + `lib/admin/export-queries.ts`
- `app/synthesis/SynthesisClient.tsx`

UI gets a small "Generated by Otto · Opus" vs "Heuristic estimate" provenance badge driven by `source`, plus per-opportunity grounding/confidence (the `ConfidenceBadge`/`EvidenceLink` components already exist).

---

## 9. Human-in-the-loop

Persist `ROIAssumptionEditor` edits (today they vanish):

- New route `POST /api/processes/[processId]/opportunities/[opportunityId]/assumptions` → upsert `opportunity_assumption_overrides` (org-scoped, idempotent), audit the edit. The request includes the `opportunitySetKey` returned by `getProcessOpportunities`; the server verifies that key is currently readable for the version before accepting the override.
- `ROIAssumptionEditor` gains an `onSave` that posts the patch; reads reflect it via §8.
- The grounded agent numbers are the *starting point*; the human's override is authoritative for that opportunity and survives reloads. Never auto-commit an automation recommendation — approval stays human (consistent with the `versions/[versionId]/approve` gate).

**Workspace finance config (v1, in scope):** prices (`loaded_hourly_cost`, `cost_per_error`, `delay_cost`) are set once per workspace via a finance/admin settings surface backed by `workspace_roi_prices` (§4.3). This is the *one place* that turns every opportunity's ROI from a default estimate into a customer-defensible number — the highest-leverage HITL input. Route `PUT /api/workspaces/[workspaceId]/roi-prices` (org-scoped, admin-gated, audited) + a small settings panel. Re-reads recompute all opportunities' `net_score` against the new prices; the persisted agent set is unchanged (prices are applied at read time, like overrides).

---

## 10. Guardrails & safety (summary)

| Risk | Control |
|---|---|
| LLM invents dollars / inflates ROI | Schema has no dollar fields **and is `.strict()`** so leaked keys throw (not silently stripped — Codex P2); post-parse `assertNoForbiddenKeys` denylist scan; prices injected by code; ROI computed deterministically. |
| Stale rows leak when agent disabled | Read path is flag-gated (Codex P1): flag off ⇒ persisted sets ignored, heuristic returned. |
| Duplicate/ambiguous sets under concurrency | `uniq(versionId, evidencePackHash)` + immutable insert/fetch (Codex P1/P2). |
| Stage runs on an invalid model id | Model id comes from provider/gateway config; preflight exercises the configured provider path or checks a gateway-owned allowlist. |
| Partial/failed stage leaves a persisted set | Set, audit, decision log, and completed stage row are written in one transaction; reads only use sets referenced by a completed stage row. |
| Regenerated set inherits stale human edits | Overrides are scoped by `opportunitySetKey` + opportunity id; carry-forward requires an explicit audited mapping flow. |
| Quantity claims evidence basis without evidence | Schema requires `evidence_ids` for `basis="evidence"`; grounding filters ids and downgrades invalid evidence-backed quantities to inferred with confidence ≤ 0.45. |
| LLM cites non-existent evidence | `evidence_ids` filtered to allowed set; zero-evidence ⇒ confidence ≤ 0.45, grounding "assumption". |
| LLM references non-existent steps | `source_node_ids` filtered to graph; opportunity dropped if none valid. |
| Absurd operational estimates | Clamp to bounds table; omissions fall back to existing tier defaults. |
| Out-of-vocab pattern | `automation_type`/`pattern_id` validated against closed catalog. |
| Stage failure breaks the product | Non-fatal stage; read path falls back to deterministic heuristics. |
| Cost blowup | Generated once per version at synthesis (not per render); skip when `evidencePackHash` unchanged; cached static prompt prefix. |
| Non-reproducibility | Persisted artifact with request/response hashes, model, prompt version. |

---

## 11. Observability

- `agent_decision_log` row per generation: model, prompt id/version, input/output tokens, `cost_cents`, `cache_hit`, opportunity count, diagnostics, `evidencePackHash`.
- `audit_log` `synthesis.opportunities.generated`.
- `synthesis_stage_outputs` `stage-9-opportunity-synthesis` row (completed/failed/skipped) with input/output refs.
- Metrics to monitor: stage failure rate, % runs falling back to heuristics, mean opportunities/version, mean confidence, cache-hit rate, cost/run.

---

## 12. Evals

New `evals/opportunity/` (mirrors `evals/operator/graph-fixtures.json`):

- **Fixtures**: `{ graph + evidence → expected_opportunities (FDE-labeled), expected_ranking }`.
- **Scorers**:
  1. **Ranking correlation** (Spearman) between agent order and FDE order.
  2. **Evidence validity** = 100% of cited `evidence_ids` resolve (hard gate; hallucination must be 0).
  3. **Pattern accuracy** vs. labeled pattern.
  4. **ROI sanity**: grounded `net_score` within tolerance of a labeled band; no opportunity exceeds bounds.
  5. **Coverage/precision** of opportunities vs. labeled set.
  6. **Forbidden-key rejection (per Codex P2)**: feed a fixture model response containing `net_score`/`loaded_hourly_cost` and assert the parse **throws** (proves `.strict()` + `assertNoForbiddenKeys` actually reject, not silently strip).
  7. **Flag kill-switch (per Codex P1)**: with `OPPORTUNITY_AGENT_ENABLED` off and an agent set present in the table, assert `getProcessOpportunities` returns `source: "heuristic"`.
  8. **Completed-stage eligibility (per Codex P2)**: set row present but no completed stage row → read path returns heuristic; set + completed stage row → read path returns agent.
  9. **Override scoping (per Codex P2)**: override for `agent:setA` does not apply to `agent:setB` even if `opportunity_id` is identical.
  10. **Evidence-basis enforcement (per Codex P3)**: `basis="evidence"` with empty ids fails schema; ids filtered to zero during grounding downgrade the quantity to inferred and cap confidence.
- Wire into the existing eval harness; gate prompt/template-version bumps on score.

---

## 13. Rollout & backward compatibility

- **Feature flag** `OPPORTUNITY_AGENT_ENABLED` (default off in prod first). When off, stage-9 is skipped **and the read path ignores any persisted `automation_opportunity_sets` rows** (per Codex P1, §8 step 1) and uses heuristics — zero behavior change *even if rows exist*. This makes the flag a true kill switch: flipping it off fully restores heuristic behavior regardless of staging/backfill/partial-rollout rows in the table.
- Phase 1: ship tables + stage + read path behind flag; verify on a few synthesis runs.
- Phase 2: enable in staging, run evals, compare agent vs heuristic on real graphs.
- Phase 3: enable in prod; keep heuristic fallback permanently.
- Old versions (no set) keep working via fallback — no backfill required; optional backfill job can regenerate sets for existing published versions.

---

## 14. File-by-file change list

**New**
- `lib/processes/opportunity-evidence.ts` — `buildOpportunityEvidencePack`
- `lib/processes/opportunity-schema.ts` — Zod + types (`OpportunityProposal`, `GroundedOpportunity`)
- `schemas/automation-opportunities.schema.json` — JSON schema + Anthropic tool schema
- `prompts/synthesis.opportunities.md` — the prompt
- `lib/processes/opportunity-extractor.ts` — `extractAutomationOpportunities`
- `lib/processes/opportunity-grounding.ts` — `groundOpportunities`, `ROI_PRICE_DEFAULTS`, bounds
- `lib/processes/opportunity-persistence.ts` — `persistCompletedAutomationOpportunityStage`
- `lib/processes/opportunity-queries.ts` — `getProcessOpportunities`
- `lib/workspaces/roi-prices.ts` — `getWorkspaceRoiPrices`, `ROI_PRICE_DEFAULTS`
- `app/api/processes/[processId]/opportunities/[opportunityId]/assumptions/route.ts` — HITL per-opportunity overrides scoped by `opportunitySetKey`
- `app/api/workspaces/[workspaceId]/roi-prices/route.ts` — `PUT` workspace finance config (admin-gated, audited)
- `components/workspace/RoiPricesSettings.tsx` (+ entry point) — finance config panel
- `evals/opportunity/opportunity-fixtures.json`
- Drizzle migration for the three new tables (+ seed `workspace_roi_prices` with defaults)

**Modified**
- `lib/db/schema.ts` — **three** tables + enums/indexes, incl. the `uniq(versionId, evidencePackHash)` index on `automation_opportunity_sets` (Codex P1)
- `lib/ai/models.ts` — `OPPORTUNITY_MODEL` routing + max tokens; provider/gateway-backed model preflight for the resolved opportunity model (Codex P1)
- `lib/env.ts` — `OPPORTUNITY_MODEL`, `OPPORTUNITY_AGENT_ENABLED`
- `lib/synthesis/operator-process.ts` — stage-9 (non-fatal), stage-version map
- `lib/processes/opportunity-heuristics.ts` — keep; export tier constants for reuse by grounding
- `app/process/[id]/workspace/automation/page.tsx`, `components/workspace/tabs/ImpactTab.tsx`, `app/process/[id]/workspace/transformation/page.tsx`, `app/admin/exports/page.tsx`, `lib/admin/export-queries.ts`, `app/synthesis/SynthesisClient.tsx` — read via `getProcessOpportunities` (flag-gated, Codex P1)
- `components/workspace/ROIAssumptionEditor.tsx` — `onSave` → persist overrides + provenance badge; **remove the three price fields from `FIELDS` (lines 15/17/19)** and show resolved workspace price read-only + link to finance panel (Codex P2)
- `app/api/processes/[processId]/opportunities/[opportunityId]/assumptions/route.ts` — **reject price keys server-side** and verify `opportunitySetKey` is readable for the current version (Codex P2)
- `.env` / `.env.example`

**Unchanged (deliberately)**
- `lib/roi.ts:computeROI` — the dollar math stays the single source of truth.

---

## 15. Testing plan

- **Unit (pure):** `groundOpportunities` — evidence filtering, quantity evidence-basis downgrade, node filtering, clamping, default-fill, price injection, dedupe, ranking; zero-evidence ⇒ confidence cap; absurd values clamped; LLM-leaked dollars ignored.
- **Schema (Codex P2/P3):** a response with `net_score`/`loaded_hourly_cost`/any denylist key **throws** (proves `.strict()` + `assertNoForbiddenKeys` reject rather than silently strip); `basis="evidence"` with empty `evidence_ids` throws; closed enums enforced.
- **Extractor:** mocked `structured()` returning fixtures; compact-retry on truncation; model preflight uses provider/gateway config and fails fast on bad ids.
- **Persistence (Codex P1/P2):** two concurrent runs with the same `evidencePackHash` produce exactly one immutable row (`onConflictDoNothing`, no update); changed hash produces a second row; "latest" is deterministic.
- **Integration:** synthesis run produces a set row + completed stage row + audit row in one transaction; forced write failure rolls back the set; forced LLM failure → stage `failed`, run still completes, read path falls back to heuristic.
- **Read path (Codex P1/P2):** flag on + completed-stage-backed agent set present → agent opportunities; set without completed stage → heuristic; **flag off + agent set present → heuristic** (kill-switch); absent → heuristic; override for matching `opportunitySetKey` changes `net_score`.
- **HITL route:** assumption-override upsert + idempotency + org scoping + `opportunitySetKey` verification + audit; override for a previous set does not apply to a regenerated set.
- **Workspace prices:** `PUT roi-prices` admin-gated + audited; editing prices re-computes `net_score` at read time for both agent and heuristic sources without re-running the LLM; unset workspace falls back to `ROI_PRICE_DEFAULTS`.
- **Visual smoke (Playwright):** automation page renders agent opportunities with provenance + evidence links (per `feedback_plan_review_codex`: add a visual smoke test).
- **Evals:** run `evals/opportunity` and record baseline.

---

## 16. Open decisions for review

1. **Price constants**: ~~const vs. workspace config~~ — **decided: workspace finance config in v1** (`workspace_roi_prices`, §4.3), applied at read time, seeded with defaults.
2. **Stage placement**: before or after `publishOperatorGraphDraft`? (Recommend after — opportunities reference the published version; failure can't block publish.)
3. **Regeneration policy**: skip LLM when a completed set with the same `evidencePackHash` exists (cost) vs. always regenerate on resynthesis? (Recommend skip-on-completed-unchanged — now backed by the `uniq(versionId, evidencePackHash)` index + immutable insert/fetch from Codex P1/P2, so "skip" is enforced, not best-effort.)
4. **Heuristic retirement**: keep heuristic permanently as fallback (recommended) vs. eventually delete once agent is trusted.
5. **Per-opportunity vs. process-level**: should the agent also emit a process-level "automation thesis" summarizing the top 3, or only per-opportunity items? (Lean: add a short `thesis` field to the set — cheap, high exec value.)
