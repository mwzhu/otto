# Voice Runtime Cleanup & Operator Decoupling Plan

**Status:** v2.3 implemented and locally verified
**Scope:** three related changes to the live voice interview path:
- **A.** Make the "fast speaker" actually fast (it is currently Sonnet).
- **B.** Remove the legacy single-Sonnet `planned_cascade` path now that `steered_cascade` is the production runtime.
- **C.** Decouple the **operator** interview the same way the director already is.

### Revision log — v1 → v2 (per Codex review)
- **P1 — recovery job blocks deletion:** `planDirectorTurn` is also used by `reExtractDegradedTurns` (`functions.ts:33,571`). Added **B.0**: migrate recovery to `extractDirectorTurn` *before* any deletion, then persist through `dispatchDirectorTurnPlan`, with a recovery test + CI grep gate (§B.0, B.3, F, G).
- **P1 — operator extractor must be phrase-free and must persist:** `planOperatorTurn` can phrase (`brain.ts:220`) and does not persist (persistence is in `dispatchOperatorTurnPlan`, `:268`). Replaced "reuse `planOperatorTurn`" with an explicit extraction-only path (phrasing disabled) that persists in its own transaction (§C.1, G).
- **P2 — operator extraction needs status/completion plumbing:** added §C.2.1 mirroring the director's `delivery_json.extraction_status` updates (`extract route:162`) and dual completion check (`completion.ts:147`).
- **P2 — operator model routing was stale:** `operator.voice.` already routes to `OPERATOR_BRAIN_MODEL` (`models.ts:56`); `OPERATOR_VOICE_MODEL` is missing from env (`env.ts:81`) and the prompt frontmatter still says `OPERATOR_BRAIN_MODEL` (`operator.voice.phrase-intent.md:4`). Corrected §A.2.
- **P2 — `cache_hit` verification invalid:** phraser static prompts are below the 4096-char cache floor (`llm.ts:45,448`; `voice.ts:77`, `brain.ts:904`). §A.4 now verifies model id + latency only; cacheable prefix is an optional later optimization.
- **Open Qs resolved:** typed operator route stays synchronous; `OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM` retained until operator legacy removal (§H.5, H.6).

### Revision log — v2 → v2.1 (second Codex review)
- Clarified that `extractDirectorTurn` returns an extraction plan but does **not** persist; recovery must persist through `dispatchDirectorTurnPlan` with `advanceConversationState: false`.
- Corrected operator extraction status values to match director (`complete`/`failed`, not `completed`/`failed`).
- Clarified that operator v1 ports the extraction-window/background-extraction pieces, not the director spoken-output checker task, unless a dedicated `/operator-turns/check` route is added.
- Added missing env-example coverage for `DIRECTOR_VOICE_MODEL` and `OPERATOR_VOICE_MODEL`, and removed the misleading "config-only" rollout label for Part A.

### Revision log — v2.1 → v2.2 (implementation pass)
- Added `otto-frontend/scripts/verify-voice-phrase-telemetry.cjs` and `npm run verify:voice-telemetry` as the rollout gate for §A.4/§D.4. The verifier reads `.env.local`, queries `agent_decision_log`, fails when no recent voice phraser rows exist, and verifies `*.voice.phrase-intent` rows use the expected Haiku model while printing latency aggregates.
- Initial local DB verification on this branch connected successfully but found no recent `director.voice.phrase-intent` / `operator.voice.phrase-intent` rows, so the live latency proof required a real voice run (completed in v2.3).

### Revision log — v2.2 → v2.3 (telemetry proof)
- Ran the real local internal `/ingest` + `/respond` paths for one director turn and one operator turn, then closed both extraction windows through `/extract`.
- `VOICE_TELEMETRY_HOURS=1 VOICE_TELEMETRY_MAX_AVG_MS=4000 npm run verify:voice-telemetry` passed against persisted `agent_decision_log.delivery_json.voice_metadata`: `director.voice.phrase-intent` used `claude-haiku-4-5-20251001` at 2178ms, and `operator.voice.phrase-intent` used `claude-haiku-4-5-20251001` at 2535ms.

---

## 0. Current state (grounded)

The director voice agent has **two** runtimes, selected by `OTTO_DIRECTOR_VOICE_RUNTIME`:

- `planned_cascade` (code default, `agents/director/director_agent/config.py:30`): one streamed Sonnet `structured` call does extraction **and** emits `planned_agent_utterance` early. Path: `agent.py:_run_user_turn_completed` (the body after the `steered_cascade` branch) → `otto_api.plan_turn` → `_stream_plan_turn` → `/api/internal/director-turns/plan` → `planDirectorTurnStreamed` → `planDirectorTurnWithPlanner`. Dispatch is a separate `/dispatch` call.
- `steered_cascade` (**what is actually deployed** — `agents/director/.env:22`, `otto-frontend/.env.local:17`): `agent.py:_run_decoupled_user_turn` → `/respond` → `buildDirectorSteeringPlan` (deterministic, no LLM) + `phraseDirectorSteeringTurn` (one small voice call) speaks immediately; extraction runs in the background (`_queue_background_extraction` → `extract_turn` → `/extract` → `extractDirectorTurn`) as an eventually-consistent checker.

Two problems remain:

1. **The "fast" speaker is Sonnet.** `phraseDirectorSteeringTurn` uses prompt `director.voice.phrase-intent`, which routes through `anthropicModelForPrompt` → `DIRECTOR_VOICE_MODEL ?? ANTHROPIC_MODEL ?? "claude-sonnet-4-6"` (`lib/ai/models.ts:50`). `DIRECTOR_VOICE_MODEL` is unset in env; the Python default is also Sonnet (`agents/director/director_agent/models.py:7 DEFAULT_DIRECTOR_VOICE_MODEL = "claude-sonnet-4-6"`). So the latency-critical call runs on Sonnet.
2. **`planned_cascade` is dead weight.** It is not deployed, but it doubles the surface area of the hottest code path (an extra route, planner methods, agent branch, and the only consumer of `/dispatch`). Keeping it invites drift and bugs.
3. **The operator interview is still coupled.** `agents/operator/operator_agent/agent.py:143` calls the one-call streamed `plan_turn`; there is no `/operator-turns/respond` or `/extract` route, no `_run_decoupled_user_turn`, no steering/phrase/extract split in `lib/interview/operator/brain.ts`. Live operator voice gates speech on the heavy combined call — the exact problem the director already solved.

---

## Part A — Make the fast speaker actually fast

Lowest-risk, highest-immediate-payoff. Do this first and independently.

### A.1 Director
- Set `DIRECTOR_VOICE_MODEL="claude-haiku-4-5-20251001"` in deployed/local runtime envs and examples: `agents/director/.env`, `otto-frontend/.env.local`, `agents/director/.env.example`, and `otto-frontend/.env.example`.
- Change `DEFAULT_DIRECTOR_VOICE_MODEL` in `agents/director/director_agent/models.py:7` to the Haiku id so the worker preflight reports/forces the fast model by default (update the matching assertions in `agents/director/tests/test_worker_contract.py:115`).
- Optionally bump the TS fallback in `lib/ai/models.ts:50-52` from `"claude-sonnet-4-6"` to Haiku for the `director.voice.` branch, so an unset env still gets a fast speaker.

### A.2 Operator (lands with Part C; env keys added now)
Per Codex P2 — the routing description was stale. `operator.voice.` already **has** a branch, but it routes to `OPERATOR_BRAIN_MODEL` (`lib/ai/models.ts:56`), and `OPERATOR_VOICE_MODEL` does not exist yet. Concretely:
- Add `OPERATOR_VOICE_MODEL` to the env schema **and the `Pick<>`** in `lib/ai/models.ts` (mirror `DIRECTOR_VOICE_MODEL`) and to `lib/env.ts` (it is absent at `env.ts:81`).
- Change the existing `operator.voice.` branch (`lib/ai/models.ts:56`) from `OPERATOR_BRAIN_MODEL` to `OPERATOR_VOICE_MODEL ?? "claude-haiku-4-5-20251001"` (intentionally do **not** fall back to `ANTHROPIC_MODEL`, since a shared Sonnet/Opus default would silently make the fast voice path slow again).
- Update the prompt frontmatter `model_role:` in `prompts/operator.voice.phrase-intent.md:4` (still says `OPERATOR_BRAIN_MODEL`) to `OPERATOR_VOICE_MODEL`.
- Add `OPERATOR_VOICE_MODEL="claude-haiku-4-5-20251001"` to `otto-frontend/.env.example` and `agents/operator/.env.example` so the new key is discoverable before Part C flips the live runtime.

### A.3 Guardrail
- The phraser is capped at 200 output tokens (`anthropicMaxTokensForPrompt`, `lib/ai/models.ts:77`) and validated/limited to a single question (`limitToSingleQuestion`), so a smaller model is safe. Keep the existing `voiceMetadataDegrades` fallback to `deterministicPhrase` for empty/failed phrasings.

### A.4 Verify
Per Codex P2 — `cache_hit` is **not** a valid success metric for the phraser today. Prompt caching only engages when `static_input` ≥ 4096 chars (`PROMPT_CACHE_MIN_STATIC_CHARS`, `lib/adapters/llm.ts:45,448`), but the director/operator phrasers use **short inline static prompts** (`lib/interview/director/voice.ts:77`, operator `brain.ts:904`), so the cache never engages on this path.
- **Primary verification = model id + latency.** Confirm `director.voice.phrase-intent` generations in `agent_decision_log` show the Haiku model id and a reduced `latency_ms` / time-to-first-token. Do **not** assert `cache_hit` here.
- **Executable gate:** after a real voice run, run `npm run verify:voice-telemetry` from `otto-frontend` (optionally with `VOICE_TELEMETRY_PROMPTS=director.voice.phrase-intent`, `VOICE_TELEMETRY_SINCE=<iso timestamp>`, and/or `VOICE_TELEMETRY_MAX_AVG_MS=<milliseconds>`). This fails if no recent telemetry exists or if the rows use the wrong model.
- **Optional follow-up (only if the phraser prompt is later enlarged):** move the phraser's static contract (system + rules + style) into a ≥4096-char `static_input` prefix so it becomes cacheable, then add `cache_hit` to verification. Caching the spoken-turn prompt is a separate optimization, not part of Part A's latency win (which comes from the model swap).

---

## Part B — Remove the legacy `planned_cascade` path (director)

Do **after** A is verified and **after** confirming `steered_cascade` is the only runtime in every deployed env.

### B.1 Python worker (`agents/director/`)
- `agent.py`: delete the `planned_cascade` body of `_run_user_turn_completed` (everything after the `voice_runtime == "steered_cascade"` branch at `agent.py:432-450`). Make `on_user_turn_completed` always call `_run_decoupled_user_turn`. Remove the `early_utterance`/`plan_task`/`dispatch_task` machinery used only by the legacy path.
- `config.py`: collapse `voice_runtime` — remove `planned_cascade` (and `steered_realtime` unless implemented; see §D.2). Either drop the field entirely or keep a single `steered_cascade` constant for telemetry. Update `voice_runtime()` validator (`config.py:188`), `preflight.py:280`, and `smoke.py:53,136`.
- `otto_api.py`: remove `plan_turn`, `_stream_plan_turn`, and `dispatch_turn` (the decoupled path uses `respond_turn` + `extract_turn`; `/respond` dispatches internally). Keep `ingest_turn`, `respond_turn`, `extract_turn`.
- `planner.py`: remove `plan_turn` and the `/plan`-specific helpers it fronts.

### B.2 Next API routes (`otto-frontend/app/api/internal/director-turns/`)
- Delete `plan/route.ts` and `dispatch/route.ts` (only `planned_cascade` calls them). Keep `ingest`, `respond`, `extract`, `complete`, `coverage`, `context`, `opening`, `notice`, `[turnIndex]/delivery`, `check`, `verify`.

### B.0 Migrate the degraded-turn recovery job FIRST (per Codex P1 — blocker)
`planDirectorTurn` is **not** only used by the live legacy path: the Inngest recovery job
`reExtractDegradedTurns` imports it (`lib/inngest/functions.ts:33`) and calls it (`functions.ts:571`)
to re-run extraction on degraded turns. Deleting `planDirectorTurn` in B.3 without this step breaks
recovery.
- Repoint the recovery job from `planDirectorTurn` to **`extractDirectorTurn`** (the extraction-only
  planner). Recovery wants slots/claims re-extracted, not a spoken utterance, so the extractor is the
  correct planning target and is already the function we are keeping.
- Important: `extractDirectorTurn` itself returns a plan/result; it does **not** persist slot/claim
  writes. Keep the existing persistence shape by passing the extracted plan into
  `dispatchDirectorTurnPlan` with `decisionStageName: "re_extract_degraded_turns.applied"` and
  `advanceConversationState: false`. Adjust the call site's handling of the returned plan
  accordingly. Add/keep a recovery test so this is covered before any deletion.
- This makes B.3's deletion safe: after migration, `planDirectorTurn` truly has no remaining callers.

### B.3 Brain (`lib/interview/director/brain.ts`)
- After B.0, remove `planDirectorTurn` (`:301`), `planDirectorTurnStreamed` (`:313`), and the private `planDirectorTurnWithPlanner` (`:452`) **iff** no retained function shares them. **Keep** `extractDirectorTurn` (`:307`) and `planDirectorTurnWithExtractionPlanner` (`:581`) — these are the background extractor **and now the recovery planning path**. **Keep** `buildDirectorSteeringPlan`, `phraseDirectorSteeringTurn`, `nonAuthoritativeDirectorSteeringPlan`, `dispatchDirectorTurnPlan` (used by `/respond`, `/extract`, and recovery persistence).
- Audit shared helpers (prompt-cache block builders, validators) before deleting so the extractor path keeps what it needs.
- Verify no remaining importers with a grep gate in CI: `planDirectorTurn(` and `planDirectorTurnStreamed(` should return zero non-test hits before deletion.

### B.4 Tests
- Remove/replace `planned_cascade` and `plan_turn` cases in `agents/director/tests/test_worker_contract.py` (e.g. `:4769`, `:4940`, `:5059`, the `plan_turn` mocks). Keep and expand the `steered_cascade` cases (`:6131 test_steered_cascade_speaks_before_async_extract_and_check_finish`, `:6311` coalesce test).

### B.5 Net effect
One voice runtime, one speak path, one extract path. ~2 routes, 3 planner/otto_api methods, and 2–3 brain functions deleted.

---

## Part C — Decouple the operator interview

Mirror the director's `steered_cascade` design for operator. This is the largest piece.

### C.1 Brain (`lib/interview/operator/brain.ts`)
Add, mirroring the director equivalents:
- `buildOperatorSteeringPlan(input)` — **deterministic** steering context (next objective, target slots, `do_not_ask`, required style) from `deterministicOperatorTurnPlan` (`:1474`) + current slot/coverage state. No LLM.
- `phraseOperatorSteeringTurn(steering)` — one fast voice call using the existing `prompts/operator.voice.phrase-intent.md`, `forceSeparateVoiceLlm: true`, routed to `OPERATOR_VOICE_MODEL` (Part A.2).
- `nonAuthoritativeOperatorSteeringPlan(plan)` — strip `claims`/`slot_updates`/`tool_calls` for the immediate response.
- `extractOperatorTurn(input)` — the background structured extractor. **Per Codex P1, do NOT reuse `planOperatorTurn` (`:104`) as-is.** Two problems: (1) `planOperatorTurn` can invoke separate voice phrasing when `shouldUseSeparateOperatorVoiceLlm()` is true (`brain.ts:220`), so a background extractor built on it would do voice work it should never do; (2) `planOperatorTurn` does **not** persist — persistence happens later in `dispatchOperatorTurnPlan` (`brain.ts:268`), so an extractor that just calls `planOperatorTurn` would compute and then drop the slots/claims/provisional steps. Instead add an **extraction-only path with no phraser** that (a) runs the structured planner with phrasing disabled (factor the structured-plan core out of `planOperatorTurn`, or call it with a `phrase: false` flag), and (b) persists slots/claims/provisional steps in its own transaction via `parseOperatorToolCall` + `insertOperatorProvisionalStep` + `upsertOperatorSlotState`. Mirror the director split: `extractDirectorTurn` is phrase-free and returns the extraction plan; the `/extract` route persists it through `dispatchDirectorTurnPlan`.
- `dispatchOperatorSteeringTurn(...)` — persist the spoken turn + delivery state for the fast path (reuse/extend `dispatchOperatorTurnPlan` `:268`), writing a `non_authoritative` plan with `extraction_status: "pending"` (the spoken path must not write claims/slots; only `extractOperatorTurn` does).

### C.2 Extraction window storage (decision)
The director uses the `director_extraction_windows` table (`lib/db/schema.ts:614`) to coalesce quick-split finals and track pending extraction. Operator needs an equivalent. **Recommended:** add `operator_extraction_windows` (same shape) rather than overloading the director table; alternatively generalize to a single `extraction_windows` table with an `agent` discriminator. (Open decision §D.1.)

### C.2.1 Extraction status + completion plumbing (per Codex P2 — not just a table)
A table and two routes are insufficient; the director path has real status/completion plumbing that
the operator path must replicate:
- **Per-turn status:** the director extract route updates `delivery_json.extraction_status` and marks
  failures (`director-turns/extract/route.ts:162`). Add the operator equivalent: `extractOperatorTurn`
  must set `extraction_status` to `complete`/`failed` on the turn's delivery row and record degraded
  reasons on failure (so a failed extraction is visible and recoverable, not silently lost).
- **Completion gate:** director completion checks **both** decision-log status **and**
  `director_extraction_windows` (`lib/interview/director/completion.ts:147`) before declaring the
  interview done. Add an operator completion helper that waits on open `operator_extraction_windows`
  + pending extraction decision logs, so the synthesis-triggering completion does not fire while
  extractions are still pending.
- **Helpers to port:** `upsert…ExtractionWindow`, `update…ExtractionStatus`, and the completion
  predicate, all operator-scoped.

### C.3 New API routes (`app/api/internal/operator-turns/`)
- `respond/route.ts` — mirror `director-turns/respond/route.ts`: `buildOperatorSteeringPlan` → `phraseOperatorSteeringTurn` → SSE `planned_agent_utterance` → dispatch (`pending`) + open extraction window. Returns a `non_authoritative` plan with `extraction_status: "pending"`.
- `extract/route.ts` — mirror `director-turns/extract/route.ts`: `extractOperatorTurn` → persist slots/claims/provisional steps → close window → **update `delivery_json.extraction_status` (`complete`/`failed`)** (C.2.1). Idempotent, org-scoped.
- Reuse existing `ingest`, `notice`, `[turnIndex]/delivery`. `plan` and `dispatch` operator routes can remain until C is verified, then be removed (Part B-style) for the operator side too.

### C.4 Python worker (`agents/operator/operator_agent/`)
- `otto_api.py`: add `respond_turn` and `extract_turn` (copy from director `otto_api.py:175,443`).
- `agent.py`: add `_run_decoupled_user_turn` + `_queue_background_extraction` + a background extraction task (port the extraction-window/coalescing pieces from director `agent.py:684,1002`). Branch `on_user_turn_completed` on `voice_runtime == "steered_cascade"`; default operator to `steered_cascade` once landed. Do **not** copy the director spoken-output checker task unless this part also adds `/api/internal/operator-turns/check` and an operator checker brain function; operator v1 can ship without that separate checker.
- `config.py`: add `voice_runtime` (+ `OTTO_OPERATOR_VOICE_RUNTIME`) mirroring director.
- `worker.py`: align turn detection/endpointing with the director's tuned values (operator currently hardcodes `min_delay: 1.0, max_delay: 6.0` at `worker.py:61`); consider the same coalesce backstop the director uses for mid-list pauses.

### C.5 Screen-share nuance
The operator agent also consumes screen evidence (vision pipeline). The steering plan should incorporate the latest `screen_events`/`visual_observations` already available to the deterministic planner, so the fast spoken turn can react to what's on screen without waiting on the heavy extractor. Keep vision processing on its own async path (`processOperatorScreenFrame`), unchanged.

---

## D — Cross-cutting

### D.1 Extraction-window table — generalize vs. duplicate (open decision)
Duplicate (`operator_extraction_windows`) is faster and lower-risk; generalize (`extraction_windows` + `agent`) is cleaner long-term. Recommend duplicate for v1, note the seam.

### D.2 `steered_realtime`
Currently in the allowlist but not branched in `agent.py` (falls through to `planned_cascade`). After Part B that fall-through disappears. Either implement it or remove it from the validator/allowlist in `config.py:190` and `preflight.py:282`. Recommend remove for now.

### D.3 Env & docs
- Add/justify: `DIRECTOR_VOICE_MODEL`, `OPERATOR_VOICE_MODEL`, `OTTO_OPERATOR_VOICE_RUNTIME`.
- Update `.env.example` files (director currently ships `planned_cascade` + Sonnet voice — both misleading) and `agents/*/README.md`.

### D.4 Observability
- Confirm `agent_decision_log` rows for `*.voice.phrase-intent` show the Haiku model id and reduced `latency_ms`.
- Add a metric for `steering_lag_turns` (already emitted by the director decoupled path) on the operator side.

---

## E — File-by-file change list

**Part A**
- `agents/director/.env`, `otto-frontend/.env.local`, `agents/director/.env.example`, `otto-frontend/.env.example` — `DIRECTOR_VOICE_MODEL` → Haiku
- `agents/director/director_agent/models.py` — default voice model → Haiku (+ test `test_worker_contract.py`)
- `lib/ai/models.ts` — Haiku fallback for `director.voice.`; add `operator.voice.` → `OPERATOR_VOICE_MODEL`
- `lib/env.ts`, `otto-frontend/.env.example`, `agents/operator/.env.example` — add `OPERATOR_VOICE_MODEL`

**Part B (delete)**
- `app/api/internal/director-turns/plan/route.ts`, `app/api/internal/director-turns/dispatch/route.ts`
- `agents/director/director_agent/agent.py` (legacy branch), `planner.py` (`plan_turn`), `otto_api.py` (`plan_turn`, `_stream_plan_turn`, `dispatch_turn`)
- `lib/interview/director/brain.ts` — `planDirectorTurn`, `planDirectorTurnStreamed`, `planDirectorTurnWithPlanner` (if unshared)
- `config.py`, `preflight.py`, `smoke.py` — collapse `voice_runtime`
- `agents/director/tests/test_worker_contract.py` — drop legacy cases

**Part C (add)**
- `lib/interview/operator/brain.ts` — steering/phrase/extract/dispatch functions
- `app/api/internal/operator-turns/respond/route.ts`, `.../extract/route.ts`
- `agents/operator/operator_agent/{otto_api,agent,config,worker}.py`
- `lib/db/schema.ts` + migration — `operator_extraction_windows`
- operator tests mirroring the director steered-cascade tests

---

## F — Sequencing & rollout

1. **Part A** (low-risk, reversible model-routing/defaults change) → verify latency drop in telemetry (model id + latency, not `cache_hit` — A.4).
2. **Part C** behind `OTTO_OPERATOR_VOICE_RUNTIME=steered_cascade` (default `planned`-style until verified), validate operator latency + extraction correctness.
3. **Part B** last — and **B.0 (recovery migration to `extractDirectorTurn`) must land before any deletion** (Codex P1). Remove director legacy only once A is proven, recovery is migrated, and no env references `planned_cascade`. Then remove operator legacy routes symmetrically (which also retires `OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM`, §H.6).

Each part is independently shippable and independently revertible.

---

## G — Testing

- **A:** unit assert voice prompts route to Haiku (`director.voice.` and `operator.voice.`); integration assert `*.voice.phrase-intent` decision-log model id + lower latency (assert model id + latency, **not** `cache_hit` — Codex P2); phrasing-failure still falls back to `deterministicPhrase`.
- **B.0 (recovery):** `reExtractDegradedTurns` re-extracts a degraded turn via `extractDirectorTurn` and persists slots/claims through `dispatchDirectorTurnPlan` with `advanceConversationState: false`; this test must pass before `planDirectorTurn` is deleted. CI grep gate: zero non-test callers of `planDirectorTurn(` / `planDirectorTurnStreamed(`.
- **B:** the deployed `steered_cascade` suite stays green with `/plan` + `/dispatch` deleted.
- **C (extractor isolation, Codex P1):** `extractOperatorTurn` performs **no** voice phrasing (even with `OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM=true`) and **does** persist slots/claims/provisional steps; the fast `/respond` path writes a `non_authoritative` plan with no claim/slot writes.
- **C (status/completion, Codex P2):** a failed `extractOperatorTurn` sets `delivery_json.extraction_status="failed"` and is recoverable; operator completion does not fire while an `operator_extraction_windows` row or extraction decision log is still pending.
- **C:** operator port of `test_steered_cascade_speaks_before_async_extract_and_check_finish` and the coalesce test; integration: operator speaks before extraction completes, slots/claims/provisional steps land via the background extractor, screen evidence still flows.
- **Typed route (H.5):** `operator-captures/[captureSessionId]/turns` stays synchronous and unaffected.
- **Regression:** director behavior unchanged end-to-end after legacy removal.

---

## H — Open decisions for review
1. Extraction-window table: duplicate `operator_extraction_windows` vs. generalize to `extraction_windows` + `agent`. (Recommend duplicate v1.)
2. `steered_realtime`: implement or remove from allowlist. (Recommend remove now.)
3. Keep a one-value `voice_runtime` flag for telemetry, or hard-wire the single path. (Recommend keep the flag, single valid value.)
4. Operator default runtime flip: same release as Part C, or a release later behind the flag. (Recommend one release later.)

### Resolved from Codex open questions
5. **Public typed operator route (`runOperatorTurn`, `operator-captures/[captureSessionId]/turns/route.ts:216`) — stays synchronous.** It serves typed/non-voice clients where there is no TTS critical path, so the coupled plan+dispatch path is fine and simpler there. The decoupling applies only to the **live voice** path (the LiveKit worker → `/respond` + `/extract`). Document that the typed route is intentionally synchronous and is not part of `steered_cascade`. (If a typed client later needs the async-extraction semantics, it can call `/respond` + `/extract` directly; not in scope here.)
6. **`OTTO_OPERATOR_USE_SEPARATE_VOICE_LLM` — retained while the legacy `/plan` path exists, deprecated when it is removed.** It still gates phrasing inside `planOperatorTurn` (`brain.ts:880`), which the legacy synchronous path and the typed route use. Once the operator legacy `/plan` + `/dispatch` routes are deleted (the operator analogue of Part B, after Part C is verified), `planOperatorTurn`'s inline phrasing is no longer reachable on the live path and the flag can be removed. Until then, keep it; `steered_cascade` ignores it because the fast path uses `phraseOperatorSteeringTurn` directly, not `planOperatorTurn`.
