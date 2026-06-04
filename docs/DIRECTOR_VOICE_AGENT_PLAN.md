# Director Voice Consultant Agent — Implementation Plan (v2)

A plan to build the **Director Interview Agent** from `BUILD_PLAN.md` §4 / §16.1 as a real
conversational voice consultant: it joins a live call with a VP/Director and asks targeted, adaptive
questions to map — at high level — the processes they own, the outcomes those processes drive, the
people/roles involved, frequency/volume, systems of record (and shadow systems), metrics/KPIs, how
the processes interconnect (handoffs/dependencies), pain points, single points of failure, controls,
and executive priority. Output is evidence-backed `candidate_processes` + a live slot coverage matrix
that feeds the Phase 1 synthesis subset.

> v2 changelog: folds in the conversational-brain design (utterance classification, director phase
> machine, multi-process extraction, conversational fallback, rev-ops acceptance eval) and the
> production-contract fixes from review (turn transaction contract, idempotency, identity resolution,
> controller schema, vendor/privacy policy, configurable models). The two-call latency budget and
> the realtime LiveKit transport are retained.

This plan supersedes `PHASE_1.md` §3.4's interim "TypeScript brain" decision: we commit to the
production runtime in `BUILD_PLAN.md` §3 (LiveKit Agents, Python) with full real-time audio.

## 0. Decisions locked

1. **Transport: full real-time LiveKit voice.** LiveKit room (audio + data channel) ↔ a **Python
   LiveKit Agents worker** running Deepgram Nova-3 streaming ASR, Cartesia Sonic-2 TTS, Silero VAD +
   EOU turn detection, with barge-in/interruption handling.
2. **Brain shape: two LLM calls per turn (`BUILD_PLAN.md` §4.1).**
   - **One Haiku brain call** does everything structured: classify utterance → extract facts/claims →
     update slot state → emit tool calls → choose phase → rank next intents → select next intent.
   - **One Sonnet voice call** phrases the chosen intent naturally (recent turns + style hint +
     coverage context). Brain decides *what*; voice decides *how*. (Folding classify+plan into the
     single brain call avoids a third round-trip and protects the latency budget — §8.)
3. **Claims-first tool model.** A small set of semantic tools + a **generic claim-write path** for
   the long tail (outcomes, KPIs, dependencies, handoffs, process relationships, exec priority,
   controls). No proliferation of special-purpose tools (`BUILD_PLAN.md` §6.4, §18.12).

## 1. What exists vs. what this builds

The current `otto-frontend/lib/interview/director/*` is effectively the **deterministic fallback
mode** of `BUILD_PLAN.md` §12.7, not an agent:

- `brain.ts` extraction is regex/keyword matching (`deterministicExtraction`), passed as the LLM
  `mock`, so even the "LLM" path returns regex output.
- It records only the **first** process per turn (`tool_calls.find(... "recordProcess")`,
  `brain.ts:126`) — multi-process answers are silently dropped.
- `rankProbeIntents` is pure rule-based slot-priority ordering — none of the §4.4 LLM scorer, and no
  notion of conversation *phase*. A bare "hello" returns the same `scope.boundaries` question every
  turn until that slot fills.
- `voice.ts` returns the static canned probe string — no Sonnet phrasing.
- `slot_states` (`schema.ts:583`) has `lastAskedAt`/`priority` but **no `fire_count`/`max_fires`** —
  so cooldown/escalation rules have no persistent backing.

We **keep this code as the (now conversational) fallback brain** and build the real agent around it.

## 2. Target architecture

```
Browser (LiveKit client SDK)                    Python LiveKit Agents worker
  • publish mic track            audio +        • Deepgram Nova-3 streaming ASR
  • subscribe agent TTS track ◄──data channel──►• Silero VAD + EOU turn detector
  • render live transcript +     (LiveKit Cloud) • Haiku brain → Sonnet voice
    coverage from data channel                   • Cartesia Sonic-2 TTS (streamed)
  • mute / pause / end                           • tool/claim dispatch (no direct DB)
                                                          │ HTTPS (service token)
                                                          ▼
                                          Next.js internal API (single write path)
                                            • POST /api/internal/director-turns/ingest
                                            • POST /api/internal/director-turns/dispatch
                                            • GET  /api/director-interviews/:id/coverage
                                                          │
                                                          ▼
                                              Neon Postgres (RLS, claims = truth)
```

**Write-path rule.** The Python worker owns the realtime loop + all LLM calls but performs **no
direct DB writes**. Every mutation goes through internal Next.js endpoints that reuse the existing TS
tools + `writeClaim`, so claims stay the single source of truth (`BUILD_PLAN.md` §6.4.1, §18.12).
`slot_states` / `transcript_segments` / `agent_decision_log` are Postgres-only writes behind those
endpoints, satisfying the §11.3 "never block the checkpoint" rule at internal-call latency.
*Alternative if internal-call latency shows up in turn timing: direct `asyncpg` for the three
checkpoint tables only.*

**Identity is resolved server-side, not trusted from the room.** The worker authenticates to the
internal API with a **service token** and passes only `capture_session_id`; the API resolves
`org_id` / `workspace_id` / `user_id` from that session row and sets RLS context. LiveKit room
metadata (`language`, display hints) is treated as a hint, never as an authorization source.

## 3. The two-layer brain

Per finalized user turn, inside the worker:

**3a. Brain — Haiku, structured output, ≤500 output tokens (`BUILD_PLAN.md` §14.1).**
One `tool_use` call returning a `DirectorTurnPlan`:
- `utterance_type` — see §4.1 classification taxonomy.
- `slot_updates[]` — `{ slot_path, value, status, confidence, evidence_ids, priority }`
- `claims[]` — `{ subject_type, subject_id, field, value, confidence, evidence_ids, metadata }`
- `tool_calls[]` — typed director tool invocations (may include **multiple** `recordProcess`)
- `contradiction_signals[]`
- `current_phase` + `proposed_next_phase` + `phase_transition_ready` (see §4.2)
- `ranked_intents[]` — `{ intent, target_slot|target_process, score, info_gain,
  conversational_fit, priority, recency, reason, style_hint }`
- `chosen_intent`, `focus_candidate_process_id` (a `candidate_processes.id` in Phase 1)

Evidence discipline (keep `brain.ts`'s static contract): every assertion cites this turn's
`evidence_ids`; implied-but-unsaid → `confidence ≤ 0.45`, `metadata.inferred`; never invent.

**3b. Controller — deterministic rules wrap the scorer (`BUILD_PLAN.md` §4.4, §4.9, §4.10).**
- *Phase gating:* enforce the §4.2 transition criteria (can't leave `expand` for a focus process
  until its must-fire slots are `filled`/`asked_unknown`).
- *Must-fire:* `scope.boundaries`, `ownership.roles`, `systems.systems_of_record`.
- *Forbidden:* probes inside `cooldown_seconds`; probes at `max_fires`.
- *Priority:* `base_priority × dynamic_boost` (×1.5 spontaneous topic, ×1.5 related contradiction,
  ×1.3 downstream blocked, ×0.5 near max_fires).
- *Max-fire escalation:* at `max_fires − 1`, send Voice a `last_attempt` hint; still empty →
  `asked_unknown` + `follow_up_task`, move on.

**3c. Voice — Sonnet, ≤200 output tokens (`BUILD_PLAN.md` §14.1).**
Input = chosen intent + `style_hint` + persona + last 4 turns + coverage summary. Standing rules in
§4.3. Falls back to the probe YAML's first canned phrasing on failure.

## 4. Conversational Brain Contract (the consultant behavior)

This is the section that turns a slot-filler into a consultant. All of it lives in the single Haiku
call (§3a), so it adds no round-trips.

### 4.1 Utterance classification

Every turn is first classified; the class drives handling:

| Class | Handling |
|---|---|
| `greeting` | Orient briefly, then ask remit. Do not probe a slot. |
| `meta_question` ("what are we doing?", "how long?") | Answer plainly, then continue from current phase. |
| `clarification_request` | Answer the question; re-ask the prior intent rephrased. |
| `substantive_answer` | Extract → update slots/claims → advance. |
| `partial_answer` (vague) | Extract what's there; ask a **narrowing** follow-up, not the next slot. |
| `non_answer` / filler | Do **not** repeat the prior question verbatim; rephrase once, then broaden. |
| `dont_know` | Mark target slot `asked_unknown`; pivot to an adjacent slot. |
| `correction` | Write a `corrected` evidence claim (supersedes); acknowledge. |
| `contradiction` | Mark slot `conflicting`; fire a `reconciliation` intent next (bypasses cooldown). |
| `off_topic` | Acknowledge; steer back to the current phase. |

This fixes the current "hello → same boundary question" loop.

### 4.2 Director phase machine

The planner chooses **phase + intent together** each turn. Phases, allowed intents, and exit
criteria:

| Phase | Goal | Allowed intents | Exit criteria |
|---|---|---|---|
| `orient` | Explain the session; learn the director's remit | `orient_interview`, `discover_function` | Function/remit slot ≥ `partial` |
| `inventory` | High-level list of processes they own | `discover_processes` (multi-process) | ≥1 candidate recorded AND director signals list ~complete (or N captured / diminishing returns) |
| `expand` | Drill the highest-value process's core | `select_process_to_expand`, `define_process_boundary`, `capture_outcome`, `capture_owner_roles`, `capture_systems`, `quantify_frequency_volume` | Focus process's must-fire core slots `filled`/`asked_unknown` |
| `enrich` | Relationships, metrics, friction, risk, variants | `capture_dependencies`, `capture_handoffs`, `capture_metrics`, `capture_friction`, `capture_risk_spof`, `capture_variants`, `capture_controls`, `capture_exec_priority` | Priority-1 enrich slots covered for expanded processes |
| `closeout` | Confirm + surface gaps | `playback_summary`, `open_questions_closeout` | Stopping rule met (§4.4) |

**Follow-the-energy without losing the thread:** if the director volunteers friction during
`inventory`, capture the claim and acknowledge, but return to `inventory` rather than derailing into
a full friction drill. Within `expand`/`enrich`, follow energy freely. `expand`↔`enrich` may
interleave per focus process.

### 4.3 Conversational behavior rules (Voice layer)

- Acknowledge before probing ("Got it — quote approvals are one area.").
- One question at a time.
- Anchor in a concrete instance ("think about the most recent one").
- Never repeat the same prompt after a non-answer — rephrase or broaden.
- Answer meta-questions plainly, then continue.
- Vague answer → narrowing follow-up; specific answer → follow the energy.

### 4.4 Stopping rule (`BUILD_PLAN.md` §4.7)

Normal close = priority-1 coverage ≥ threshold AND no priority-1 slot `partial`/`conflicting`.
Forced close = time budget (Director 25 min) / 3 turns with no new fills / fatigue signal. Before
either, run **open-questions surfacing**. Forced close emits one `follow_up_task` per unresolved
priority-1 slot.

### 4.5 Multi-process extraction

The brain may emit several `recordProcess` calls in one turn; dispatch creates N
`candidate_processes` (fixes `brain.ts:126`). The brain tracks `focus_candidate_process_id` for `expand`/`enrich`.

### 4.6 Conversational deterministic fallback (no LLM key / Anthropic outage)

The fallback must still feel alive — it's also the local-dev demo path. Rules keyed on §4.1 class:
greeting → orient + ask remit; meta → explain goal + ask remit; `dont_know` → `asked_unknown` +
adjacent slot; non-answer → rephrase once then broaden; first business phrase → infer function + ask
for process list; process list detected → record candidates + ask which to expand; repeated low-info
→ easier question ("What are the 3 things your team is asked to do most often?"). Tag turns
`degraded_quality=true`; `re_extract_degraded_turns` recovers them when Anthropic returns.

### 4.7 Acceptance example (eval anchor)

Director: *"I run rev ops. We own forecasting, territory planning, quote approvals, and sales comp.
Forecasting is weekly, mostly in Salesforce and Sheets. Quote approvals are painful because finance
gets pulled in late."* The agent must: record **four** candidate processes; set function = rev ops;
attach Salesforce + Sheets; capture weekly forecasting; capture finance as participant/dependency;
record quote-approval pain; and ask a targeted follow-up like *"Let's zoom into quote approvals since
you flagged pain there. Where does an approval start?"*

## 5. Knowledge artifacts (externalized, versioned — `BUILD_PLAN.md` §16.15)

- **`schemas/*.json` (source of truth):** `director-turn-plan` (the §3a structured output),
  `slot-state`, `claim`, `claim-subject-fields` (the §6 dispatch allowlist), `evidence`,
  `director-process-inventory`. Generate **Zod** (TS) and **Pydantic** (Python). `tool_use` enforces
  at the model boundary; re-validate on receive; one retry then structured error (`BUILD_PLAN.md`
  §11.1).
- **`probes/director.yaml`:** §4.3 typed shape — `type, triggers, target_slots, cooldown_seconds,
  max_fires, expected_shape, base_priority, phrasings[]`. Cover the §4.2 intent set.
- **Slot schema:** extend `slot-schema.ts` to the full `BUILD_PLAN.md` §4.2 director set (function,
  process_boundaries, upstream/downstream deps, systems_of_record vs shadow, volume, KPIs, controls,
  doc maturity, exec priority, variants) with `base_priority`/`expected_shape`.
- **`prompts/*.md`:** brain + voice system prompts with template IDs/versions logged per call.

## 6. Persistence, tools, claims, audit

- **Semantic tools (kept):** `recordProcess`, `recordSystem`, `recordPerson`, `recordPainPoint`,
  `recordSpof`, `updateSlotState`, `createFollowUpTask` (the §3.1 inventory).
- **Generic claim-write path (new):** `dispatchClaim(subject_type, field, value_json, evidence_ids,
  confidence)` for the long tail (outcomes, KPIs, dependencies, handoffs, process relationships, exec
  priority, controls). It is **not** an untyped back door: every call is validated against
  `schemas/claim-subject-fields.json` — an allowlist of legal `(subject_type, field)` pairs and their
  expected value shapes, seeded from `PHASE_1.md` §1.4 + the §4.2 slot schema. `subject_type` includes
  `candidate_process` in Phase 1 (claims attach to candidates, not canonical processes, until
  promotion).
- **`interview_state` table (new, P1-3 — external memory for the phase machine):** one row per
  `capture_session_id` holding `current_phase`, `focus_candidate_process_id`, nullable
  `focus_process_id`, `prior_intent`, `low_info_turn_count`, `last_new_slot_turn_index`,
  `phase_history[]`. Director Phase 1 sessions focus `candidate_processes` until promotion; the
  nullable canonical `focus_process_id` is reserved for resumed/promoted sessions and future operator
  handoff flows. Read at the start of every turn, written in dispatch — so phase/focus survive
  reconnects per the `BUILD_PLAN.md` §6.8 external-memory rule (never keep this only in LLM context).
  *(Alternative: `capture_sessions.metadata_json`; a dedicated table is cleaner for RLS + queries.)*
- **`probe_firings` table (new, P1-3):** use probe-level history instead of slot-level counters:
  `id`, `org_id`, `workspace_id`, `capture_session_id`, `probe_id`, `target_slot`, optional
  `target_candidate_process_id`, `turn_index`, `fired_at`, `style_hint`, `resolved_status_after`.
  Cooldown and max-fire are computed from this table because multiple probes can target the same
  slot. Keep `slot_states.priority`/`last_asked_at`; do **not** add `slot_states.fire_count` unless
  query performance later requires a denormalized counter.
- **`agent_decision_log` migration (P1-2):** add a `delivery_json` field holding
  `{ planned_utterance, delivered_utterance, delivery_status, spoken_fraction }`, where
  `delivery_status ∈ pending | completed | truncated | failed_text_fallback`. Set by the §7
  delivery-update step so §12.6 reflects what was *actually* spoken, not just planned.
- **Decision metadata every turn:** slot transitions, ranked intents *with scores*, chosen intent +
  phase, the **sanitized** planned/delivered utterance, tool calls + idempotency keys + latency,
  model/token/cost, `cache_hit`, `degraded_quality` (`BUILD_PLAN.md` §12.6).
- **Sanitizer (`PHASE_1.md` §9.4):** PII-scrub utterances/small outputs before `agent_decision_log`;
  raw transcript stays only in `transcript_segments`.

## 7. Realtime Turn Transaction Contract

Exact production sequence per finalized user turn (answers review P0-3 / P1-1 / P2-1):

1. **ASR final** → worker holds `{ utterance, start_ms, end_ms }`.
2. **Ingest:** `POST /api/internal/director-turns/ingest`, idempotency key
   `seg:{session}:{start_ms}:{end_ms}` (stable from streaming-ASR timings). Returns
   `{ transcript_segment_ids, evidence_ids, turn_index }`.
3. **Brain call** (Haiku) using the returned `evidence_ids` → the §3a `DirectorTurnPlan`.
4. **Voice call** (Sonnet) → `planned_agent_utterance`. *Voice runs **before** dispatch so the exact
   utterance exists when the decision log is written (fixes the v2 ordering bug — you can't log a
   sanitized utterance that doesn't exist yet).*
5. **Validate, then dispatch atomically:** validate the whole plan against the schemas + the
   `claim-subject-fields` allowlist **before** opening the transaction. `POST
   /api/internal/director-turns/dispatch`, idempotency key `turn:{session}:{turn_index}`, carrying
   tool calls, slot updates, claims, chosen intent/phase, the `interview_state` update, and the
   decision log with `planned_agent_utterance`. In one transaction, the **hard-commit set**
   (transcript-derived slot updates, candidate-process creation, `interview_state`, decision-log row)
   succeeds or fails together; an individual low-confidence/optional claim that fails validation is
   **dropped + logged as a `follow_up_task` and the turn marked `degraded_quality`** — it never rolls
   back the hard set (P2-1). Per-process creation is sub-keyed
   `turn:{session}:{turn_index}:proc:{ordinal}` so retries never double-create.
   Semantic tool failures are classified before execution: **hard** = candidate-process creation,
   slot-state updates, `interview_state`, decision log, and any tool output required by the chosen
   intent; **soft** = optional KPI/dependency/control/relationship claims and opportunistic
   system/person enrichments. Soft failures create follow-up tasks and mark the turn degraded; hard
   failures roll back dispatch so the worker can retry idempotently.
6. **Data-channel event** → transcript delta + slot-status deltas + new candidate ids + the agent
   utterance, so the UI hydrates live.
7. **TTS** speak (may stream concurrently with dispatch once the utterance is final, so the
   reordering in step 4 costs no latency). **Playback starts only after dispatch commits and returns
   the decision-log id.** The worker may pre-open/synthesize the TTS stream while dispatch is in
   flight, but it must buffer audio until the decision row exists. If this ever proves too slow, add
   an idempotent delivery-update queue keyed by `turn_index`; do not let barge-in events race a
   missing decision row.
8. **Delivery update:** `POST /api/internal/director-turns/{turn_index}/delivery` sets
   `delivery_status` = `completed` | `truncated` (+ `spoken_fraction` + `delivered_utterance`) |
   `failed_text_fallback`.

**Barge-in:** if the director speaks during TTS, stop playback, send the delivery update with
`truncated`, and start a new ingest turn — so §12.6 reflects what was *actually* spoken.
**Idempotency/retry:** ingest, dispatch, and delivery are all keyed and safe to retry. On worker
restart mid-turn, replay from the last committed `turn_index`; `slot_states` + `interview_state` are
the checkpoint (`BUILD_PLAN.md` §16.10).

## 8. Realtime voice pipeline (Python worker)

New service at repo root: **`agents/director/`** (Python, `uv`), deployed as a LiveKit Agents worker
dispatched per session.

- **Framework:** `livekit-agents` ≥1.0 `AgentSession` + plugins `deepgram` (Nova-3, language from
  session), `cartesia` (Sonic-2), `silero` (VAD), LiveKit **turn-detector** (EOU).
- **Custom turn pipeline:** override the LLM node / `on_user_turn_completed` to run the §7 contract;
  start TTS on the first sentence of the Sonnet stream to protect latency.
- **Degradation (`BUILD_PLAN.md` §11.5, §12.7):** ASR stall >5s → "I lost your audio — can you
  repeat?"; TTS fail → push text over data channel; Anthropic exhausted → §4.6 deterministic
  fallback; LiveKit drop → reconnect, DB state survives.

## 9. Models, cost, latency

- **Configurable model roles (P2):** `DIRECTOR_BRAIN_MODEL`, `DIRECTOR_VOICE_MODEL`,
  `SYNTHESIS_PLANNER_MODEL` as env-overridable keys with defaults in `lib/ai/models.ts` (+ Python
  mirror). Default tiers: Haiku 4.5 brain, Sonnet 4.6 voice, Opus 4.7 planner. No hardcoded release
  names in code paths beyond the defaults file (`BUILD_PLAN.md` §11).
- **Prompt caching (`BUILD_PLAN.md` §11.4):** static block (system prompt + probe YAML + slot schema
  + ontology + process metadata) first/cached; dynamic block (slot summary + last N turns + latest
  utterance) last. Target ≥60% hit; log per call.
- **Latency budget — headline risk (`BUILD_PLAN.md` §14, <1.0s p50 / <1.5s p95).** Two sequential
  LLM calls + TTS must fit: Haiku capped at 500 tokens; Sonnet capped at 200 with TTS streamed on
  first sentence and bounded by `OTTO_VOICE_PHRASE_TIMEOUT_MS` (default 2500ms) before falling back
  to deterministic consultant phrasing. Voice-timeout fallback is logged as voice degradation, not
  extraction degradation, so it does not trigger re-extraction of already-good claims. Consider
  speculative phrasing of the top-ranked intent while the brain finishes. Folding
  classify+extract+plan into one Haiku call (vs. a separate plan call) is what keeps this feasible.
  Measure and tune.
- **Cost target ≈ $2.75 / 20-min interview** (`BUILD_PLAN.md` §14); alert at 2× baseline.

## 10. Vendor data & privacy (full-production — `BUILD_PLAN.md` §12.1, §12.2, §12.5)

Realtime voice fans transcripts/audio out to four vendors; set this before any real customer call.
**Each vendor privacy control must be encoded in adapter config and covered by a test** (not left as
a dashboard-only toggle); confirm the exact provider API flags/account settings during M5 (P2-2):

- **LiveKit:** audio egress/recording **off by default** for director sessions; persist audio only
  if the workspace opts into the §12.2 retention policy (30-day default, configurable). Data channel
  contents not logged by LiveKit.
- **Deepgram:** enable no-store + model-improvement opt-out via the documented request flags (verify
  the exact param names); transcripts persist only in our `transcript_segments`.
- **Cartesia:** no-retention configuration (verify the exact account/request flag).
- **Anthropic:** API no-train; prompt caching on; raw-payload logging **off** by default (§12.5),
  only inside an explicit per-tenant debug window.
- **Consent UX (§12.1):** pre-start consent notice + always-visible recording indicator + one-click
  mute/pause/end.
- **Regionality:** EU data residency flagged as a deferred per-tenant option, not v1.
- **Audit:** log when audio retention is enabled, when raw-payload logging is enabled, and any vendor
  export (`BUILD_PLAN.md` §12.5/§12.6).

## 11. Frontend (LiveKit client)

- Add `livekit-client` + `@livekit/components-react`.
- **`VoicePreStartClient.tsx`:** keep workspace + capture-session creation; room request returns a
  real LiveKit token (`mode: "livekit"`); add mic-permission + consent gate before connect.
- **`TranscriptChat.tsx` / `live/page.tsx`:** replace browser SpeechRecognition with a LiveKit room —
  publish mic, play agent TTS, render live transcript + coverage from the data channel; keep a typed
  box as accessibility/degraded fallback. Mute/pause/end act on the room + signal the worker; End →
  `/synthesis?next=/overview`. **Rehydrate transcript from persisted `transcript_segments` on reload**
  (current live page shows only an ephemeral hardcoded intro). "Reconnecting…" toast on disconnect.
- FDE coverage scorecard (`/coverage`) already wired — leave as is.

## 12. Evals & acceptance (`BUILD_PLAN.md` §15)

- **Conversational robustness (scripted):** greeting/meta does not repeat the template; vague answer
  → narrowing follow-up; process list → multiple candidates; systems mentioned → extracted + linked;
  pain mentioned → claim created; metrics asked only after ≥1 process known; summary before close;
  repeated non-answers → graceful fallback + `asked_unknown`.
- **Phase machine:** correct transitions; no getting stuck; closeout fires per §4.4.
- **Extraction accuracy:** process recall, owner/role match, system match, observed-vs-inferred label
  accuracy on hand-labeled synthetic director transcripts under `evals/director/`.
- **Latency:** p50/p95 turn-taking from real call traces.
- **Reconstructability:** any turn answers "why ask Y not Z?" and "what exactly did it ask?".
- **Acceptance:** §4.7 rev-ops example end-to-end → live transcript + coverage fill → 4 candidates →
  End → synthesis → `/overview` shows evidence-linked cards.

## 13. Build order (de-risk the brain before the voice infra)

- **M1 — Real brain over the existing transport.** Single Haiku brain call (classify + extract +
  slots + tools + phase + rank) + Sonnet voice, the §4 conversational contract, multi-process
  extraction, conversational fallback, upgraded probe/slot artifacts, the `interview_state` table,
  the `claim-subject-fields` allowlist, the `probe_firings` table, and JSON Schema generation for
  **both** Zod and Pydantic — validated through the current `/turns` + typed/browser-STT UI.
  Highest-value increment; fully eval-able; ship-able on its own while preventing schema drift before
  the Python worker lands.
- **M2 — Audio loop.** `agents/director/` worker: LiveKit room + Deepgram + Cartesia + VAD + EOU in
  an echo loop. Prove audio, turn-taking, barge-in, reconnect.
- **M3 — Brain in the worker.** Move M1 into the worker; add internal ingest/dispatch endpoints (§7);
  stream transcript + coverage over the data channel.
- **M4 — Frontend LiveKit client.** Replace browser STT; mute/pause/end; reconnect UX; transcript
  rehydration; degradation paths.
- **M5 — Hardening.** Vendor/privacy config (§10), cost/cache/latency telemetry, evals in CI,
  sanitizer, service-token auth review.

## 14. Risks & open questions

1. **Latency of two LLM calls + TTS under 1.5s p95** — the main technical risk; mitigations in §9.
2. **Python worker deployment + LiveKit agent dispatch** — Fly/Render/Railway vs LiveKit Cloud agent
   hosting; how rooms dispatch; secrets distribution. Needs a call.
3. **Write-path split** — default API-only writes from Python; revisit `asyncpg` for the three
   checkpoint tables only if internal-call latency appears in turn timing.
4. **Streaming-ASR idempotency keys** — confirm Deepgram segment timings are stable enough for
   `seg:{session}:{start_ms}:{end_ms}`; otherwise use a monotonic per-session turn counter.
5. **Keys/config:** `LIVEKIT_URL/API_KEY/API_SECRET`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`,
   `ANTHROPIC_API_KEY`, internal service token. Local dev keeps `mode: "simulated"` + mock LLM.
6. **Persona/script** — the director-facing system prompt + opening framing need a content pass;
   lives in `prompts/` for review.
