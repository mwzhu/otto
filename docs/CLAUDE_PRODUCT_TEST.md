# CLAUDE_PRODUCT_TEST.md

Product test plan for **Otto / Duvo** — a process-mapping agent that replaces the
discovery half of a forward-deployed engineer: it discovers how a business actually
operates, maps each process visually at L4 granularity, and surfaces the
highest-ROI automation opportunities.

This file is the source of truth for the computer-use testing run:

> `/goal Use computer use agent to act as a user. Test the user paths described in CLAUDE_PRODUCT_TEST.md, and fix any errors you encounter. Test until all user paths match the desired product outcome.`

**How to read this file.** Each path has: **Steps** (what the user does),
**Desired outcome** (the bar that defines "working well"), and **Edge cases**
(must also hold). A path passes only when the desired outcome is met at quality —
not merely when the page returns HTTP 200.

---

## Core quality principles (apply to EVERY path)

These are the cross-cutting standards. A path that violates any of these fails,
even if its happy-path UI looks fine.

1. **No fabrication.** Every fact shown to the user (process, step, owner, system,
   risk, metric) must trace to a real capture/evidence row. The graph validator
   already flags `unevidenced_high_confidence_node` — treat any such issue as a
   hard fail. Spot-check that displayed claims have backing evidence.
2. **Determinism / reproducibility.** Re-running synthesis on the same captures
   must not produce wildly different maps or complexity scores. Scores must be
   explainable (see complexity factors in §C).
3. **No silent failure.** Every async pipeline (extract, plan, synthesis, video,
   redaction, inngest jobs) must surface a clear error/terminal state — never an
   infinite spinner, a 0% coverage stall, or partial garbage presented as
   complete.
4. **Workspace isolation.** A user in workspace A can never see, query, or export
   workspace B's data. Roles are `director`, `operator`, `viewer` — enforce them.
5. **Resumability.** Interrupting an interview or refreshing mid-flow must not lose
   captured data; the user can resume where they left off.
6. **Privacy.** Sensitive on-screen / in-transcript data must be redactable, and
   redacted regions must not leak into synthesis output, exports, or logs.

---

## A. Director layer — high-level discovery (breadth / prioritization)

Goal of this layer: produce a complete **process inventory** for the org — every
process, who owns it, who touches it, which systems, how often, and where friction
sits. This is the prioritization view that feeds the Overview dashboard.

### A1. Director voice interview
**Route:** `/onboarding/voice` → `/onboarding/voice/live`
**Backend:** LiveKit director worker (`agents/director/`), planning brain
(`otto-frontend/lib/interview/director/brain.ts`), SSE via
`/api/internal/director-turns/*`.

**Steps**
1. Open `/onboarding/voice`. Try to start WITHOUT giving consent.
2. Select a non-default language; give consent; start.
3. Land in `/onboarding/voice/live`; agent delivers an opening turn.
4. Conduct a multi-turn conversation describing 3–5 business processes — cover
   departments, KPIs, systems, handoffs, pain points, volume, frequency, roles,
   and exceptions.
5. Watch coverage fill as topics are covered.
6. End / complete the interview → follow the synthesis path.

**Desired outcome**
- **Consent gates start.** The start control is disabled/blocked until consent is
  checked. Missing microphone support or denied permission produces a clear,
  recoverable error.
- A workspace is created or reused; session is persisted under the
  `otto.directorInterview.session` localStorage key; selected language carries
  into `/live`.
- Runtime modes resolve from readiness: **LiveKit** when `mode === "livekit"`, and a
  **simulated** fallback when `mode === "simulated"` (explicit, not a silent dead
  session). **`mode === "unconfigured"` is a blocking error**, not a fallback — it
  must show a clear "LiveKit voice is not fully configured" message and not start.
- Latency feels conversational. The agent begins speaking promptly after the user
  stops; no multi-second dead air on every turn.
- **Turn detection does not fragment a single thought.** Saying a list with natural
  pauses — *"we handle payroll management, cost optimization, and closing the
  books"* — is treated as ONE turn. The agent does not answer a mid-list fragment.
  (This is a known failure mode — verify it is fixed.)
- **Extraction never hard-fails.** No turn persists `model:
  structured-extraction-failed` / `degraded_reasons:[structured_extraction_failed]`
  / 0 tokens / 0% coverage. If extraction is slow, it must not block speech.
- Questions are focused and non-redundant; each materially advances coverage. The
  agent **does not over-index on vague answers** — it asks for missing owners,
  systems, cadence, exception handling, and evidence rather than looping.
- On completion, a process inventory exists with, per process: name, owner,
  touching roles, systems, frequency, and friction/pain points. Completion routes to
  synthesis with the correct workspace + capture-session context.

**Edge cases**
- Start blocked until consent; deny microphone permission → clear error.
- Mid-list pauses (above) — single turn.
- Long monologue (60s+) — captured without truncation or timeout.
- Silence / no response — agent re-prompts gracefully, doesn't hang.
- Barge-in / interruption while agent is speaking — agent yields.
- Non-English speech / switching language before start — handled (multi-language).
- Network drop mid-call / refresh after starting — session recoverable; partial
  transcript preserved; **no transcript or turn is duplicated** after refresh/retry.
- Clear localStorage and start again → clean new session.
- One-word / "I don't know" answers — agent adapts, doesn't loop.
- User corrects a prior answer → correction reflected, not double-counted.
- User mentions two similar processes → not collapsed incorrectly nor duplicated.

### A2. Director document upload
**Route:** `/onboarding/upload`

**Steps** (the full path — upload alone does NOT prove inventory quality):
1. Upload multiple supported files (PDF, DOCX, PPTX, XLSX, image).
2. Watch each file move through the stages: `queued → extracting → ontology → done`.
3. Complete the upload → **continue to synthesis** → land on **overview inventory**.
4. Judge quality at the overview/inventory step (A3), not at the upload step.

**Desired outcome**
- Each file shows name, size, progress, current stage, and a final `done` state.
- Workspace creation is **idempotent** (re-running doesn't create a second workspace).
- Extracted inventory matches what a human would pull from the document.
- No hallucinated processes or owners; every extracted item is grounded in the doc.
- **Failures name the failing step** — workspace setup, preparing upload, uploading
  file, or completing upload — not a generic error.
- "Continue to synthesis" appears **only when all files are done**.

**Edge cases**
- Upload zero files. Large file over the stated 50 MB limit. Scanned / image-only
  PDF (OCR path). Irrelevant document (e.g., a marketing PDF) → yields
  little/nothing, not invented processes. Duplicate filenames. Drop new files while
  another upload is still running. Corrupt / empty / 0-byte file. Unsupported format
  → clear rejection. Simulate failed presign, failed storage PUT, and failed
  complete callback → each surfaces the correct failing step.

### A3. Overview dashboard
**Route:** `/overview`
**Backend:** `lib/overview/queries.ts`, `/api/synthesis/status`.

**Desired outcome**
- Metrics are **correct** and recompute as captures arrive: process count, doc
  coverage %, complexity score, SPOF (single-point-of-failure) count.
- Process cards are sorted by **`complexity_score` descending (NULLS last), then
  `name` ascending`** — the actual query order (`lib/overview/queries.ts:306`).
  Verify against a fixture: given known scores, the highest-complexity process
  appears first; ties break alphabetically. Complexity buckets render as
  `high` (score ≥ 65), `med` (≥ 35), `low` (otherwise).
- `ready_for_overview` / `terminal` flags from synthesis-status drive the UI
  correctly (no "ready" shown while a run is still pending).
- Empty state (zero processes) is coherent and guides the user to start a capture.

---

## B. Operator layer — per-process L4 depth (ground truth)

Goal of this layer: for a chosen process, capture the real workflow at L4
granularity — every step, handoff, exception, workaround, and financial impact —
from the people who actually do the work.

### B0. Capture entry & eligibility
**Route:** `/process/[id]/capture`

**Desired outcome**
- An **eligible** process shows all four capture options with clear purpose:
  voice-only interview, screenshare + voice, upload screen recording, upload SOP.
- An **ineligible** process state shows a helpful "unavailable" page with a path
  back — never a broken page.
- All capture routes use the correct process id.

**Edge cases**
- Each process state behaves correctly: draft, approved, processing, failed,
  archived. Refresh the entry page. Auth / workspace lookup failure → clear state.

### B1. Live screen-share interview  ← newest & riskiest
**Route:** `/process/[id]/capture/screenshare`
**Backend:** operator worker (`agents/operator/`),
`/api/internal/operator-screen-events`, `/api/internal/operator-turns/*`,
vision (`lib/vision/`), redaction (`lib/redactions/operator-redaction.ts`).

**Steps**
1. Open screen-share capture. Try to start WITHOUT consent.
2. Give consent, choose language, start screen sharing, share a window.
3. Walk through the process on screen while the agent asks questions; confirm
   capture health indicators update.
4. Exercise the controls: mute, pause, **redact last 30 seconds**, resume.
5. Complete the session → triggers synthesis.

**Desired outcome**
- A capture session is created **only after permissions AND consent are satisfied**
  (session persisted under `otto.operatorScreenshare.session`; note operator *voice*
  uses `otto.operatorInterview.session`).
- The screen preview renders the shared stream.
- **Agent questions are grounded in what's actually on screen** (visual
  comprehension), not generic prompts. If the operator is in Salesforce, the agent
  references what it sees, not a canned script.
- Screen events align in time with transcript turns; no frames silently dropped.
- **Keyframe count increases while unpaused and does NOT increase while paused.**
- **Redaction works:** "redact last 30 seconds" shows a success toast AND actually
  calls the redaction path (status machine: running → complete/failed); redacted
  spans never appear in synthesis, exports, or logs — across transcript, recording,
  screen events, and embeddings.
- **Completing** stops all tracks, uploads a fallback recording when needed, ends
  the session, and sends the capture to synthesis.
- On completion, an L4 process map is produced (see §C).

**Edge cases**
- Start blocked until consent. Screen permission denied / microphone denied →
  understandable errors. Browser without `getDisplayMedia` support → clear message.
- LiveKit unavailable → simulated fallback active (explicit).
- Share stops mid-session; **stop sharing from the browser picker** (not Otto
  controls) → handled gracefully, partial capture preserved.
- Redaction endpoint fails → surfaces a **blocking remediation state** (retry /
  re-redact) and the span is **never presented as successfully redacted**. (Don't
  assert "data not left exposed" absolutely — assert the failure is visible and not
  silently treated as complete.)
- Complete **while paused**. Refresh during an active session.
- Multi-monitor / window switching / rapid app switching.
- Sensitive data appears on screen → redactable; verify it does not persist
  unredacted.
- Agent talking over operator (barge-in). Frames arriving faster/slower than turns.

### B2. Operator voice interview
**Route:** `/process/[id]/capture/voice` → `/voice/live`
Same latency / turn-detection / extraction-failure / consent bar as **A1**, scoped
to a single process. **Key difference — altitude:** the agent must ask
*operator-level* questions, NOT high-level director questions.

**Own acceptance bar — the resulting capture must yield:** step order; systems
observed/mentioned; inputs; outputs; decisions; handoffs; exceptions; waits;
variants; workarounds; duplicate entry; informal/unwritten rules; a **confidence**
per claim; **evidence IDs** linking each claim to the transcript; and explicit
**follow-up gaps** where information was missing. Then it routes through synthesis to
the process workspace.
**Edge cases:** mic denied; "I don't know" repeatedly; user changes a previously
described step; user describes a branch/variant late in the conversation.

### B3. Video upload
**Route:** `/process/[id]/capture/upload-video`

**Desired outcome:** upload creates a **video-type** artifact, stores it, **binds it
to the correct process + capture session**, shows `done`, and "Continue" routes to
synthesis with `next=/process/<id>/workspace` and the correct workspace id. Steps
extracted from the video match the actually demonstrated workflow, in order, at L4
granularity, with **each step linked to evidence** from the recording. Where the
video is ambiguous, Otto emits **low-confidence gaps/follow-ups rather than invented
steps**. Wrong-process content is detected/flagged, not silently mapped.
**Edge cases:** storage upload fails; unsupported file type; zero-byte file; long
video; **no audio track** (visual-only extraction degrades gracefully); low
resolution; **wrong-process video** (flagged); two uploads with the same filename;
navigate away mid-upload.

### B4. Document / SOP upload (per process)
**Route:** `/process/[id]/capture/upload-document`
Same bar as **A2**, scoped to one process; creates a **document-type** artifact,
**binds it to the correct process + capture session**, and contributes
steps/evidence to that process's map. Verify artifact type differs from B3 (document
vs video), each contributed claim links to evidence, ambiguity becomes a
low-confidence gap rather than an invented step, and routing targets the process
workspace.

---

## C. Synthesis — the deliverable (highest-value to get right)

This is the product. If the map is wrong, incomplete, or fabricated, nothing else
matters.

### C0. Synthesis status & routing
**Route:** `/synthesis?next=<path>&workspace_id=<id>` (optionally `&capture_session_id=<id>`)
**Backend:** `app/synthesis/SynthesisClient.tsx`, `/api/synthesis/status`
(`ready_for_overview`, `terminal`, `latest_run`).

**Steps**
1. Enter synthesis after a director intake (`next=/overview`) and after an operator
   capture (`next=/process/<id>/workspace`).
2. Observe the stage list animate through to completion.
3. Test with and without `capture_session_id`.
4. Test terminal success, terminal partial failure, and status timeout.

**Desired outcome**
- The stage animation **never claims completion before the backend is ready**,
  except via the intended timeout fallback.
- On success, it redirects to the requested `next` path with workspace (and capture)
  context preserved — even if `next` already carries query params.
- **A terminal run without `ready_for_overview` shows "needs attention"** and does
  NOT route the user to an empty overview as if synthesis succeeded.
- Partial synthesis remains visible later on the overview / workspace.

**Edge cases**
- `/api/synthesis/status` returns 500. Polling never reaches a terminal state
  (timeout fallback engages, clearly). `next` points to a process workspace rather
  than overview. Query params already present on `next`. Missing `capture_session_id`.

### C1. Process map generation
**Routes:** `/synthesis`, `/process/[id]/workspace`
**Backend:** `lib/synthesis/operator.ts`, `operator-process.ts`,
`operator-graph-validation.ts`, `operator-layout.ts`, `narrative.ts`,
`complexity.ts`.

**Desired outcome — the graph is VALID.** Run `validateOperatorGraph`; zero issues
of these kinds:
- `missing_node`, `duplicate_node_id`, `duplicate_edge_id`
- `dangling_edge` (edge pointing at a non-existent node)
- `invalid_start_count` / `invalid_end_count` (validator requires **exactly one
  start AND exactly one end** — `ends.length !== 1` fails; not "≥1")
- `unreachable_node` / `unreachable_end` (every node reachable; an end is reachable)
- `missing_outgoing_edge` (non-end node with no way forward)
- `unevidenced_high_confidence_node` ← **fabrication guard; must be zero**

**Desired outcome — the graph is READABLE.** Layout (`operator-layout.ts`) produces
no overlapping nodes; canvas is nonblank and legible as a BPMN-style diagram, and is
**aligned with the Steps list** (canvas and steps don't disagree).

**Desired outcome — L4 granularity is actually achieved.** The map expresses ordered
steps, decisions, handoffs, exceptions, waits, and end states — each tied to
evidence. Step details include inputs, outputs, exceptions, workarounds, variants,
confidence, and evidence counts where available.

**Desired outcome — counts are truthful.** Step count, decision count, and evidence
count shown in the UI match the underlying graph data exactly.

**Desired outcome — evidence drawer is complete.** Clicking a step's evidence (from
canvas and from the Steps tab) loads the correct rows: quote, source type,
confidence, speaker or screen context, and screenshot state.

**Desired outcome — narrative tabs are populated and internally consistent:**
Summary, Steps (L4), Impact, Insights, Risk & Vulnerabilities. No tab contradicts
another (e.g., a risk referencing a step that isn't in the Steps tab).

**Edge cases**
- A process with a single linear path (no branches).
- A process with multiple exception branches, waits, and loops.
- Graph with **no task nodes** → honest empty/low-coverage state, not a blank crash.
- Graph **with warnings** → warnings surfaced, not hidden.
- Evidence endpoint returns empty rows / returns 500 → drawer degrades gracefully.
- Sparse capture (one short interview) → map is honest about low coverage rather
  than inventing detail.
- Conflicting captures (two operators describe the step differently) → reconciled
  or surfaced, not silently dropped.
- Long step titles and dense graphs remain readable.

### C2. Complexity score
**Backend:** `lib/synthesis/complexity.ts`

**Desired outcome:** total score decomposes into the six factors —
`system_sprawl`, `handoff_count`, `frequency_pressure`, `friction_severity`,
`spof_risk`, `documentation_gap` — each with a value, a max, **evidence IDs**, and
stated assumptions. The score is reproducible and every factor is explainable from
its inputs.

**Note — assumption-based penalties are allowed, not banned.** The scorer
intentionally applies penalty values for *missing* data (e.g. `documentation_gap`
scores the full 15 when no documentation evidence is attached; `frequency_pressure`
when frequency wasn't captured). That is correct behavior. The requirement is that
any such factor **labels itself as an assumption** (e.g. "No documented evidence is
attached yet.") rather than presenting an unevidenced penalty as an evidenced fact.
Fail only if a non-trivial value has neither evidence IDs nor an assumption label.

### C3. Transformation proposal
**Routes:** `/process/[id]/workspace/transformation`, `/process/[id]/workspace/automation`

**Desired outcome:** automation opportunities are ranked by real ROI/impact,
reference the specific friction surfaced during capture, and are concrete (not
generic "use AI here" boilerplate). The "Current Process" vs "Transformation
Proposal" comparison is coherent.

### C4. Versioning, approval & refinement
**Routes/APIs:** `/process/[id]/workspace`, version approve
(`/api/processes/[id]/versions/[versionId]/approve`), refine chat.

**Desired outcome**
- The **version selector** switches to the intended version and **preserves the
  active tab**; draft and approved versions are distinguishable.
- A draft can be **approved only when appropriate** (warnings shown for drafts).
  Approval uses an idempotency key, shows progress, handles errors, and reloads into
  the approved state.
- **Refinement does not silently overwrite approved, evidence-backed facts.**
  Follow-up tasks are specific, tied to the right uncertainty, and visible in the
  relevant tab (Summary / Insights / Risk).
- The UI distinguishes **open gaps** from **confirmed process facts**.

**Edge cases**
- Version list mixes draft + approved. Approve fails mid-flow → recoverable, not a
  half-approved state. User asks for an unsupported edit. User provides contradictory
  information → surfaced, not blindly applied. Follow-up list empty / more than four
  items.

### C5. Candidate process management
**Routes/APIs:** `/api/candidate-processes/[id]/promote|merge|discard`

**Steps:** promote a candidate to a tracked process; merge two overlapping
candidates; discard one.
**Desired outcome:** merges preserve all evidence from both sides; the same
real-world process is not split into duplicates; discard is reversible enough that
re-discovery works. No orphaned evidence after any operation.

---

## D. Cross-cutting paths (gate everything)

### D1. Auth & workspace bootstrap
**Routes/APIs:** `/api/auth/login`, `/api/auth/callback`,
`/api/workspaces/[id]/bootstrap`.
- Login → callback → land in a workspace with the correct role.
- New workspace bootstraps cleanly to an empty, coherent state.
- **Isolation:** attempting to read/export another workspace's data is denied.

### D2. Live coverage & resume
- Coverage updates live during interviews and **survives a page refresh**.
- An interrupted interview (closed tab, dropped network) can be **resumed** with
  prior turns intact.
- Idempotency: completing/submitting twice (same idempotency key) does not double
  up data.

### D3. Evidence & claims integrity
**APIs:** `/api/workspaces/[id]/claims`, `/api/workspaces/[id]/evidence`,
`/api/processes/[id]/evidence`.
- Every displayed claim has a backing evidence row; no dangling claims.
- Evidence presign/upload completes and is retrievable.

### D4. Redaction / privacy
- PII / sensitive content is never persisted unredacted across screen frames,
  transcripts, and uploads.
- A failed redaction surfaces `redaction_failed` rather than silently leaving data
  exposed.

### D5. Admin tooling
**Routes:** `/admin`, `/admin/coverage`, `/admin/evidence`, `/admin/exports`,
`/admin/seeding`, `/admin/variants`.
- Each page renders real data (not stub/empty when data exists).
- Exports are complete and valid (open/parse the exported artifact; confirm it
  contains the process map + evidence, scoped to the right workspace).

### D6. Failure-state handling (explicit negative tests)
For each async pipeline, force or simulate a failure and confirm a clear terminal
state — never an infinite spinner or partial-garbage-as-complete:
- Director/operator extraction failure.
- Synthesis run failure (`synthesisRuns` terminal state surfaced in
  `/api/synthesis/status`).
- Video processing failure.
- Inngest job failure (`/api/inngest`).

---

## Recommended test data

Use at least three realistic processes so synthesis has something meaty to map:

1. **Retail promotion setup** — multiple systems, approval handoffs, spreadsheet
   uploads, deadline pressure, exception paths.
2. **Order deduction dispute resolution** — high volume, unclear ownership, evidence
   attachments, financial impact, multiple variants.
3. **New item setup** — master data, vendor forms, compliance checks, duplicate
   entry, long waits.

For each process, feed Otto a full bundle so the cross-cutting principles get
exercised:
- A high-level director narrative (A1 or A2).
- One SOP/document artifact (B4).
- One operator walkthrough with screen actions (B1 or B2).
- **At least one contradiction** between the documented and the actual workflow →
  verify §C reconciles or flags it (tests no-fabrication + conflict handling).
- **At least one missing-data follow-up** → verify it surfaces as an open gap (C4),
  not invented detail.

## Priority order for the test run

**P0 — the core loop. The test run must complete this before anything else:**
director inventory → operator capture → synthesized **validated** map →
evidence-backed narrative + complexity. Test in this order, fixing as you go:

1. **C1 — Process map fidelity & validity.** It's the deliverable; a wrong or
   fabricated map invalidates everything downstream.
2. **A1 / B2 — Voice latency, turn-splitting, and the extraction-failure bug.**
   The known unacceptable-UX area.
3. **B1 — Screen-share visual grounding + redaction.** Newest and riskiest path.
4. **D3 / Core Principle #1 — Evidence integrity & no hallucination.** Underpins
   the product's credibility.
5. **C0 / C2 — Synthesis routing & explainable complexity.** Closes the loop from
   capture to a trustworthy, navigable result.

**P1 — secondary, test after P0 is green:** A2, A3, B3/B4, D1–D2, D4–D6, and the
post-map surfaces **C3 (transformation), C4 (versioning/approval/refinement), and
C5 (candidate management)**. These matter, but a broken P0 makes them moot.

## Exit criteria

The product passes its P0 run when, for a realistic end-to-end flow (director
interview/upload → overview inventory → operator deep-dive on a process →
synthesized **validated** map → evidence-backed narrative + complexity):
- All §C graph-validation issues are zero across generated maps (incl. exactly one
  start and exactly one end, and zero `unevidenced_high_confidence_node`).
- No path hits a silent failure or fabrication.
- Voice paths feel conversational with no turn-fragmentation or extraction stalls.
- Every metric and claim shown is correct and either evidence-backed or explicitly
  labeled as an assumption / open gap (never an unevidenced fact).

(Transformation/automation export and candidate management are validated in the P1
pass, not required for the P0 sign-off.)

---

## Live test run log

Keep this section updated during the computer-use/browser test pass. A row marked
`verified` means the current worktree has direct command or browser evidence. A row
marked `partial` means only part of the path has been exercised.

| Status | Area | Evidence | Notes / fixes |
| --- | --- | --- | --- |
| verified | C1 operator graph validation + operator semantic/capture contracts | `npx vitest run tests/phase2/operator-graph-validation.test.ts tests/phase2/operator-semantic-workflow.test.ts tests/phase2/operator-capture.test.ts` → 42 tests passed; later focused suite with director/synthesis → 106 tests passed | Confirms graph validator issue codes, no high-confidence unevidenced nodes in fixtures, capture-mode contracts, semantic workflow, and operator synthesis contracts. |
| verified | B2/C1 operator L4 quality evals | `npx vitest run tests/phase2/operator-semantic-workflow-eval.test.ts tests/phase2/operator-conversation-quality.test.ts tests/phase2/operator-workflow-eval.test.ts tests/phase2/operator-graph-validation.test.ts tests/phase2/operator-semantic-workflow.test.ts tests/phase2/operator-capture.test.ts` → 60 tests passed | Adds fixture-based checks for conversation quality, workflow recall/precision, semantic graph conversion, and operator capture contracts. |
| verified | A1/A2/C0/D2 director + document + synthesis integration | `set -a; source .env.local; set +a; npx vitest run tests/phase1/db.integration.test.ts` → 49 tests passed | Fixed integration harness to apply migrations `0005`-`0011`, matching the current app schema. Updated stale-evidence assertion to verify no factual slot write, while allowing an empty asked-slot tracking row. Updated completion replay assertion to require idempotent no-duplicate event sending. Fixed Week 5 regressions so document uploads prefer explicit owner teams over incidental role mentions, director/document slot values stay in canonical `process_names`/`roles` shapes, deterministic director facts are merged into real LLM turns, candidate process names are title-normalized, and targeted candidate-process `kpi`/`upstream_dependency` claims are no longer dropped by tool-call de-duping. |
| verified | A1/A2/C2 focused director/document/synthesis unit coverage | `npx vitest run tests/phase1/director-evals.test.ts tests/phase1/week3-director-document.test.ts tests/phase1/week4-synthesis-ui.test.ts ...` → 106 tests passed with operator suites | Covers director eval fixtures, document intake expectations, and complexity factor decomposition. |
| verified | P0 route rendering for onboarding, voice, upload, overview, synthesis, admin/settings | `set -a; source .env.local; set +a; /Users/michaelzhu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/@playwright/test/cli.js test tests/visual/routes.spec.ts tests/visual/director-synthesis.spec.ts tests/visual/operator-process.spec.ts tests/visual/upload-flows.spec.ts --workers=1` → 28 tests passed | Basic route render/hydration/console-error gate passed for `/onboarding`, `/onboarding/voice`, `/onboarding/voice/live`, `/onboarding/upload`, `/overview`, `/synthesis`, admin/settings pages, seeded operator process routes, director pre-start flows, slow-turn director/operator fallback recovery, upload validation/binding, synthesis routing, screenshare controls, C3/C4 transformation/automation/versioning surfaces, parseable admin JSON export, C5 candidate queue actions, screenshare microphone-permission stall recovery, fake-video screenshare keyframe save/count/pause behavior, and workspace follow-up sanitization for redaction failures. A prior non-escalated broad run failed before app code with Chromium macOS Mach port sandbox denial; the latest env-loaded bundled-Node serial rerun cleared all failures. |
| verified | A1/C0 director pre-start + synthesis terminal routing | `set -a; source .env.local; set +a; npx playwright test tests/visual/director-synthesis.spec.ts` → 5 tests passed | Added browser-level checks that consent gates director start; `mode: "unconfigured"` blocks with a clear LiveKit configuration message and no session; simulated voice persists workspace/session/language; slow typed-turn responses keep the user's message visible and surface an explicit notes-updating state; terminal synthesis without `ready_for_overview` stays on "Synthesis needs attention"; ready synthesis preserves existing overview query params plus workspace/capture context. |
| verified | A1 hosted dev director simulated start + slow-turn recovery | Computer Use/Playwright against `https://otto-dev.flowlabshq.com/onboarding/voice`: consent-gated start routed to `/onboarding/voice/live`, showed simulated transcript mode and clear `CARTESIA_API_KEY` fallback; hosted `/turns` POST returned in ~24.1s with coverage moving to 2/16. Fix verified locally with `set -a; source .env.local; set +a; npx playwright test tests/visual/director-synthesis.spec.ts` → 5 tests passed; broader visual suite → 28 tests passed. | Found hosted typed fallback looked stuck during slow director turn response: initial transcript refresh could erase the optimistic user message, leaving only dots while input was disabled. Fixed `TranscriptChat` to merge refreshed transcript history with optimistic messages and show an explicit "Structured notes are still updating" state after 6s. Added regression for a slow turn response. |
| verified | B0/B1/B2/B3/B4/C1 workspace UI shell, evidence drawer, and screenshare controls | Env-loaded bundled Node Playwright operator suite → 9 tests passed; bundled Node Vitest `tests/phase2/operator-capture.test.ts` → 12 tests passed; broader env-loaded bundled Node visual suite with `--workers=1` → 28 tests passed; latest focused retest after follow-up sanitization: TypeScript passed, operator-capture contract 12 passed, focused SQL-sanitization visual regression passed, operator visual suite → 9 tests passed | Fixed ambiguous visual-test locators for `Current Process`, `draft`, and duplicate evidence drawers. Verified four capture modes, voice consent gate, simulated live typed fallback, slow operator fallback pending state, screenshare consent gate, upload shells, process upload validation, process document/video artifact binding, empty workspace state, populated steps tab, approval affordance, open evidence drawer contents, C3 transformation/automation pages, D5 admin JSON export, C5 candidate queue actions, and screenshare start after consent/permissions with session persistence, language carryover, simulated runtime visibility, pause/resume, redaction request body, generic redaction server-error remediation, microphone-permission stall recovery, fake video stream keyframe persistence with `Screen keyframes captured 1`, no keyframe-count/request growth while paused, resumed keyframe growth, active-session warning visibility, and completion routing to synthesis. Fixed screenshare startup so stalled screen/microphone permission prompts and startup API calls time out with retryable errors instead of leaving the Start button stuck on `Starting`. Fixed `CaptureControls` so pause/mute callbacks do not update parent state during render. Fixed screen-frame persistence so a saved keyframe can still count when the background vision-analysis enqueue fails; the client now surfaces that as a warning instead of a generic server error. Fixed redaction enqueue failure so it marks the redaction failed, opens a `redaction_failure` follow-up task, and stores the retryable 503 idempotent response instead of replaying false success. Fixed redaction failure follow-up presentation so raw SQL/database details are stored only as internal diagnostic context while workspace summary/risk tabs show safe reviewer copy for both future and existing redaction failures; added seeded browser regression that asserts `Failed query` / `UPDATE agent_decision_log` are absent from workspace follow-ups. Found closed evidence/refine drawers were still present in page/accessibility text; fixed drawers to unmount while closed and added a regression that placeholder evidence text is absent until the user opens evidence. |
| verified | Hosted A3/B0/B1/B2/C1 seeded workspace path | Computer Use in Safari against `https://otto-dev.flowlabshq.com`: `/overview` rendered seeded metrics and process cards; process detail for `Visual Test Returns` rendered; `/workspace` showed the current draft map summary, React Flow nodes (`Return received`, `Check return authorization`, `Credit queued`) and the `Steps` tab with one 94% confidence operator step; `View evidence` loaded hosted API evidence `observed · ERP · Return authorization`; `/capture` rendered all four capture choices with the correct process id; hosted Chromium probes confirmed operator voice and screenshare starts are disabled before consent and enabled after consent; fake-mic hosted operator voice created capture sessions, routed to `/voice/live`, showed simulated runtime, and a typed operator turn returned a grounded follow-up after about 18s; latest Safari/Computer Use voice pass accepted the Safari microphone sheet, routed to `/capture/voice/live`, showed `Voice runtime: simulated` with the explicit `CARTESIA_API_KEY missing` explanation, kept the typed operator step visible during the slow turn, showed `Operator notes are still updating`, returned the grounded follow-up `What decides which path you take at that point?`, completed to `/synthesis`, and returned to `/workspace`; hosted workspace Summary and Risk tabs now show safe copy for `Operator capture redaction failed` follow-ups (`Redaction could not complete...`) with no raw SQL query text exposed; hosted fake-media screenshare created capture session `c9c0763b-82b6-49bc-acbb-d3165e76bc02`, showed simulated runtime, exposed pause/resume, surfaced `redacting the last 30 seconds`, and completed to `/synthesis?next=/process/.../workspace&workspace_id=43c044b9-4719-5af8-aa80-65d9ea1ce80d&capture_session_id=...`. | Safari/Computer Use supplied manual hosted path checks for overview, detail, workspace, and capture entry. Playwright supplied precise hosted DOM/API evidence where Safari accessibility was stale. Found hosted operator typed fallback showed only `Sending` during a long turn; fixed `OperatorVoiceLiveClient` to show an explicit "Operator notes are still updating" status after 6s and added a slow-turn regression. Latest hosted retest confirms the slow-turn status is deployed. Hosted voice still cannot prove real LiveKit/Cartesia voice quality because the environment reports simulated runtime due missing `CARTESIA_API_KEY`; the permission/session/fallback path is usable. The hosted raw-SQL redaction follow-up display issue is now fixed on dev as well as locally; future worker-created descriptions and existing database-backed follow-up descriptions render as safe reviewer copy in workspace tabs. Fake-media screenshare uses an empty stream, so it verifies deployed controls/routing/redaction status but not real screen-frame sampling or visual grounding. |
| verified | A2/B3/B4 upload validation and binding | Hosted probes against `https://otto-dev.flowlabshq.com` plus local Playwright: director upload rejected `malware.exe` without workspace/presign calls; process SOP upload rejected `.mp4`, accepted `.docx`, presigned `artifact_type: "document"`, and bound `upload_kind: "document"`; process video upload rejected `.pdf`, accepted `.webm`, presigned `artifact_type: "video"`, and bound `upload_kind: "screen_recording"`. `set -a; source .env.local; set +a; npx playwright test tests/visual/upload-flows.spec.ts` → 1 passed; operator visual suite → 7 passed. | Added explicit client-side validation for unsupported and empty files; enforced the advertised 50 MB limit on director/document uploads; added named process-upload failure stages (`Preparing upload`, `Uploading file`, `Creating capture`). Continue buttons stay hidden until a clean upload reaches `done`/`Ready`. This verifies upload UX and binding contracts, not the full OCR/video extraction quality after background processing. |
| verified | C3/C4 hosted transformation, automation, versioning, and refinement surfaces | Hosted Playwright probes against `https://otto-dev.flowlabshq.com/process/69e1d6b8-b6eb-56a6-98fc-d53920a83f34`: `/workspace/transformation` showed `Current process vs target state`, the `Check return authorization` workaround, `Connect ERP...`, and `1 linked evidence source`; `/workspace/automation` showed `Ranked automation opportunities`, `Rank #1`, `$27,652` net score, `Agent assistant`, editable assumptions, and `ERP`; `/workspace?tab=steps` showed the server-backed `Approve Draft` only in the current-process panel while the top nav showed `Review Draft`; refinement chat staged a local draft correction and explicitly said it was not a retained evidence row yet. Local regression: `set -a; source .env.local; set +a; npx playwright test tests/visual/operator-process.spec.ts` → 6 passed. | Fixed transformation and automation dead-end placeholders by deriving graph-grounded opportunities from systems, workarounds, exceptions, waits, confidence gaps, and evidence IDs. Removed the top-nav local fake approval store so approval state is server-derived and the real API-backed approval control remains in the workspace panel. Updated refinement copy so it no longer claims to create persisted evidence rows before regeneration. |
| verified | D5 admin JSON export | Hosted Playwright against `https://otto-dev.flowlabshq.com/admin/exports`: page listed `Visual Test Returns`, `3 graph nodes`, `1 evidence rows`, and `Download JSON`; export route returned `200` with `content-disposition: attachment; filename="visual-test-returns-v1.json"`; parsed payload contained `export_type: "process_json"`, workspace `43c044b9-4719-5af8-aa80-65d9ea1ce80d`, process `Visual Test Returns`, graph nodes `Return received`, `Check return authorization`, `Credit queued`, and evidence quote `Operator checked the return authorization screen before approving the credit.` Local regression: `set -a; source .env.local; set +a; npx playwright test tests/visual/operator-process.spec.ts` → 6 passed. | Replaced the dead static export controls with a real workspace-scoped JSON export for versioned process maps. Export includes graph + linked evidence rows and omits quote text for redacted/tombstoned evidence. PDF, BPMN, and PPTX are labeled as planned rather than exposed as nonfunctional Generate buttons. |
| verified | C5 candidate process management | Hosted Playwright against `https://otto-dev.flowlabshq.com/admin/variants` with API requests intercepted to avoid mutating shared dev data: page listed `Candidate Promote Returns Follow-up`, `Candidate Merge Duplicate Returns`, and `Candidate Discard Noise`; Promote sent `POST /api/candidate-processes/<id>/promote` with `workspace_id: 43c044b9-4719-5af8-aa80-65d9ea1ce80d` and `idempotency-key: admin-variant-promote-...`; Merge sent `target_process_id: 69e1d6b8-b6eb-56a6-98fc-d53920a83f34`; Discard sent the discard endpoint and idempotency key. Local browser regression: `set -a; source .env.local; set +a; npx playwright test tests/visual/operator-process.spec.ts` → 7 passed. Backend evidence invariant: `set -a; source .env.local; set +a; npx vitest run tests/phase1/db.integration.test.ts -t "candidate merge preserves"` → 1 passed. | Fixed `VariantQueue` so FDE actions call the real promote/merge/discard APIs instead of changing local state only. Added merge target selection, progress/error states, and idempotency keys. Updated merge backend to preserve candidate evidence by copying/linking active candidate claims and candidate column evidence onto the target process, while preserving existing target facts rather than blindly overwriting them. |
| verified | Lint/code health for touched P0 files | `node node_modules/eslint/bin/eslint.js` → 0 errors, 13 pre-existing warnings; `node node_modules/typescript/bin/tsc --noEmit --pretty false` → passed | Fixed React hook-rule errors in operator voice live session hydration and step evidence loading by deferring state updates out of synchronous effect bodies. Removed the adjacent unused ROI formatter import while adding the C3/C4 pages. Latest sweep also covers the director/document normalization fixes, C5 queue/backend changes, screenshare permission timeout handling, generic redaction/keyframe failure remediation, redaction enqueue failure follow-up/idempotency handling, redaction follow-up display sanitization, and screen-frame background enqueue warning behavior. |
| verified | Default DB regression suite | `set -a; source .env.local; set +a; npx vitest run tests/phase1/db.integration.test.ts` → 49 tests passed | Confirms phase1 database foundations, director/document integration, synthesis behavior, auth/service behavior, candidate merge evidence preservation, and targeted director candidate-claim dispatch after the Week 5 regression fixes. |
| partial | Hosted Computer Use manual interaction | Computer Use in Safari against `https://otto-dev.flowlabshq.com` exercised `/onboarding/voice`, `/overview`, `/process/...`, `/workspace`, `/capture`, `/capture/voice`, `/capture/screenshare`, `/workspace/transformation`, `/workspace/automation`, `/admin/exports`, and `/admin/variants`. Latest Safari pass verified transformation proposal text, automation score `$27,652`, evidence grounding, editable assumptions, JSON export availability with planned PDF/BPMN/PPTX labels, and the variant queue candidates plus merge selectors and Discard/Merge/Promote controls. Real hosted screenshare previously progressed after the user manually clicked the macOS picker: LiveKit connected, mic publishing, screen track publishing, agent joined, browser recording buffer active, preview showed the shared Safari window, and mute/pause/resume controls toggled correctly. Latest hosted retest without manual native-picker help confirmed the new timeout is deployed for both Safari permission variants: after Computer Use clicked `Allow to Share Window` and, separately, `Allow to Share Screen`, but could not operate the final native macOS picker, the app returned to start with `Screen sharing permission did not finish. Choose a window or try again.` instead of staying stuck on `Starting`. | Manual hosted Safari checks were used where safe; mutating C5 actions were verified with hosted Playwright interception instead of live shared-dev clicks. Computer Use can see/click the first Safari screen-share permission sheet, but the final macOS window/share picker is not reliably exposed to accessibility. The latest deployed behavior now fails recoverably when that native picker is not completed. The prior manually-approved hosted live screenshare still showed `Screen keyframes captured 0` with a live preview and surfaced a generic `Unexpected server error.` after redaction/frame-save activity; real screen-frame sampling/redaction after the deployed keyframe/redaction fixes still needs a manual native-picker completion retest. Chrome Computer Use still targets the user's existing X compose draft, so Chrome manual actions were avoided. True microphone voice/LiveKit quality remains partially unverified because hosted reports simulated runtime due missing `CARTESIA_API_KEY`. |

Current remaining P0 gaps:
- Full live microphone/LiveKit voice latency, barge-in, and natural turn-fragmentation behavior still needs hosted voice-provider configuration (`CARTESIA_API_KEY`) plus a true audio run. Latest hosted evidence confirms Safari microphone permission and session routing work, but the app explicitly falls back to simulated transcript mode.
- Real hosted screenshare permission can start when the user manually completes the macOS picker, but Computer Use cannot reliably operate that final native picker layer. Latest hosted evidence confirms both Safari share-window and share-screen attempts now return the retryable `Screen sharing permission did not finish` error instead of an infinite `Starting` state when the native picker is not completed. Real screen-frame sampling/redaction after the deployed keyframe/redaction fixes still needs a manual native-picker completion retest.
- End-to-end real LLM synthesis from fresh director interview → overview → operator capture → validated map is not yet fully exercised in one continuous hosted manual run; current evidence is from hosted director fallback probing plus local integration/unit/seeded browser tests.
