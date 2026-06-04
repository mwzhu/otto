# Product Test Plan

This plan focuses on whether Otto works well as a product: it should turn voice, documents, and operator walkthroughs into trustworthy, evidence-backed process intelligence that users can understand, inspect, and act on.

## Desired Product Outcomes

1. Otto captures business context with low friction.
   - A user can start from `/onboarding`, choose voice or document intake, understand what will happen, give consent, and recover from permission or upload problems.
   - Language selection, consent, cancellation, and permission states are clear and do not trap the user.

2. Otto produces trustworthy process inventory.
   - Director intake and document uploads create or reuse the correct workspace.
   - Synthesis creates process cards with sensible names, summaries, complexity, documentation coverage, responsibilities, systems, risks, and evidence links.
   - Claims that lack evidence are either absent, low-confidence, or clearly flagged.

3. Otto supports deeper operator capture for an existing process.
   - A user can add voice, screenshare, screen recording, or SOP capture from a process page.
   - Capture eligibility is enforced. Ineligible process states show a helpful unavailable page.
   - Screenshare capture records voice, screen keyframes, conversation events, redactions, pause/mute state, and completion cleanly.

4. Otto turns operator captures into a useful process map.
   - The workspace canvas renders a coherent graph with ordered steps, decisions, handoffs, exceptions, waits, and end states.
   - The right-side tabs explain the process, steps, impact, insights, risks, and follow-ups without contradicting the canvas.
   - Each step that makes a factual claim links back to retained evidence.

5. Otto lets users review, refine, and approve safely.
   - Draft versions show warnings and can be approved only when appropriate.
   - Version selection preserves the active tab and loads the intended version.
   - Failed or partial synthesis is visible without destroying usable prior work.

6. Otto is operationally inspectable.
   - Admin coverage, variants, evidence, seeding, and export pages expose enough state for an FDE or operator to understand quality gaps.
   - Empty, partial, failed, and permission-denied states are explicit and actionable.

## Essential User Paths

### 1. First-Time Onboarding Choice

Steps:
- Open `/`.
- Confirm it redirects to `/onboarding`.
- Inspect the two entry choices: voice interview and document upload.
- Click each path and use Back or Cancel to return.

Expected outcome:
- The user immediately understands that Otto builds an operations overview.
- Both entry tiles navigate correctly.
- Layout is clean at desktop and mobile widths, with no clipped text or console errors.

Edge cases:
- Browser refresh on `/onboarding`.
- Keyboard tab navigation through both entry tiles.
- Narrow viewport around 375px wide.

### 2. Director Voice Intake Start

Steps:
- Open `/onboarding/voice`.
- Try starting without consent.
- Select a non-default language.
- Give consent and start the interview.
- Test both runtime modes if available: simulated and LiveKit.

Expected outcome:
- Start is disabled or blocked until consent is checked.
- Missing microphone support or denied permission produces a clear error.
- A workspace is created or reused via local storage.
- Session details are stored under `otto.directorInterview.session`.
- The user lands in `/onboarding/voice/live` with the selected language and active session.

Edge cases:
- Deny microphone permission.
- Refresh after starting.
- Clear local storage and start again.
- Backend returns `unconfigured` for LiveKit readiness.

### 3. Director Voice Interview Completion

Steps:
- In `/onboarding/voice/live`, complete a representative interview.
- Use a test narrative covering departments, KPIs, systems, handoffs, pain points, volume, frequency, roles, and exceptions.
- Complete the interview and follow the synthesis path.

Expected outcome:
- Otto asks focused, non-repetitive follow-up questions.
- It does not over-index on vague answers. It asks for missing owners, systems, cadence, exception handling, and evidence.
- Completion routes to synthesis with the correct workspace and capture session context.
- No transcript or turn is duplicated after refresh or retry.

Edge cases:
- User gives short or vague answers.
- User corrects a prior answer.
- User mentions two similar processes.
- User switches language before start.

### 4. Document Upload Intake

Steps:
- Open `/onboarding/upload`.
- Upload multiple supported files such as PDF, DOCX, PPTX, XLSX, and image files.
- Confirm progress moves through queued, extracting, ontology, and done.
- Continue to synthesis.

Expected outcome:
- Files show name, size, progress, stage, and final done state.
- Workspace creation is idempotent.
- Upload failures name the failing step: workspace setup, preparing upload, uploading file, or completing upload.
- Continue to synthesis appears only when all files are done.

Edge cases:
- Upload zero files.
- Upload a very large file over the stated 50 MB limit.
- Upload duplicate filenames.
- Drop files while another upload is still running.
- Simulate failed presign, failed storage PUT, and failed complete callback.

### 5. Synthesis Status and Routing

Steps:
- Enter `/synthesis?next=/overview&workspace_id=<workspaceId>`.
- Observe the stage list through completion.
- Test with and without `capture_session_id`.
- Test terminal success, terminal partial failure, and status timeout.

Expected outcome:
- Stage animation never claims completion before the backend is ready unless using the intended timeout fallback.
- Successful synthesis redirects to the requested next path with workspace and capture context preserved.
- A terminal synthesis run without overview readiness shows "Synthesis needs attention" and does not route to an empty overview as if it succeeded.
- Partial synthesis is visible later on overview.

Edge cases:
- Status endpoint returns 500.
- Polling never reaches terminal.
- `next` points to a process workspace rather than overview.
- Query params already exist on `next`.

### 6. Overview Inventory Review

Steps:
- Open `/overview`.
- Review metrics, process cards, empty state, overview tab, and team responsibilities tab.
- Open at least one process card.

Expected outcome:
- Empty state gives useful next actions.
- Metrics match visible inventory: process count, documentation coverage, complexity, and single points of failure.
- Processing and partial synthesis banners appear only when appropriate.
- Process cards summarize value, risk, and status accurately enough for a business user to choose where to drill in.

Edge cases:
- No processes.
- One process.
- Many processes requiring wrapping or scrolling.
- Long process names and long function names.
- Mixed promoted processes and pending candidates.

### 7. Process Detail Review

Steps:
- Open `/process/<id>`.
- Review summary, complexity breakdown, accountability, systems, risk callouts, and evidence links.
- Open evidence drawers from available evidence links.
- Click "Add Capture" and "View existing map."

Expected outcome:
- Business summary is clear and not generic.
- Complexity and risk callouts are explainable from the available evidence.
- Evidence counts are accurate and drawers show the relevant source snippets.
- Missing evidence is shown honestly.
- Navigation to capture and workspace preserves the selected process.

Edge cases:
- Process with no linked evidence.
- Evidence source expired or unavailable.
- Process not found or wrong workspace.
- Process has very high risk or many systems.

### 8. Capture Entry and Eligibility

Steps:
- Open `/process/<id>/capture` for an eligible process.
- Confirm four capture options are present: voice-only interview, screenshare + voice, upload screen recording, upload SOP document.
- Open the same route for an ineligible process state.

Expected outcome:
- Eligible processes show all capture options with clear purpose.
- Ineligible processes show a helpful unavailable state with a path back.
- Capture routes use the correct process id.

Edge cases:
- Draft, approved, processing, failed, and archived process states.
- User refreshes the capture entry page.
- Auth or workspace lookup fails.

### 9. Operator Voice-Only Capture

Steps:
- Open `/process/<id>/capture/voice`.
- Start a voice-only operator interview with consent and selected language.
- Complete a walkthrough containing normal flow, handoffs, systems, exceptions, waits, workarounds, duplicate entry, and informal rules.

Expected outcome:
- Otto asks operator-level questions, not high-level director questions.
- It captures step order, role ownership, systems, inputs, outputs, decisions, exceptions, variants, and pain points.
- Completion creates an operator capture and routes through synthesis to the process workspace.

Edge cases:
- Microphone denied.
- User says "I do not know" for several questions.
- User changes a previously described step.
- User describes a branch or variant late in the conversation.

### 10. Screenshare + Voice Capture

Steps:
- Open `/process/<id>/capture/screenshare`.
- Try starting without consent.
- Give consent, choose language, and start screen sharing.
- Share a window and narrate a realistic workflow.
- Confirm capture health indicators update.
- Use mute, pause, redact last 30 seconds, resume, and complete.

Expected outcome:
- Screen and microphone permission errors are understandable.
- A capture session is created only after permissions and consent are satisfied.
- Screen preview renders the shared stream.
- Keyframe count increases while unpaused and does not increase while paused.
- Redaction produces a success toast and actually calls the redaction path.
- Completing stops tracks, uploads fallback recording when needed, ends the session, and sends the capture to synthesis.

Edge cases:
- Deny screen permission.
- Deny microphone permission.
- Browser does not support `getDisplayMedia`.
- LiveKit unavailable, simulated fallback active.
- Redaction endpoint fails.
- Complete while paused.
- Refresh during an active session.
- Stop sharing from the browser picker instead of Otto controls.

### 11. Upload Screen Recording or SOP for a Process

Steps:
- Open `/process/<id>/capture/upload-video`.
- Upload a supported video file.
- Continue to synthesis after done.
- Repeat with `/process/<id>/capture/upload-document` and a process SOP.

Expected outcome:
- Upload creates an artifact, stores it, binds it to the process capture, and shows done.
- Video upload uses video artifact type. SOP upload uses document artifact type.
- Continue routes to synthesis with `next=/process/<id>/workspace` and the correct workspace id.

Edge cases:
- Storage upload fails.
- Unsupported file type.
- Zero-byte file.
- Two uploads with the same filename.
- User navigates away mid-upload.

### 12. Process Workspace Map Review

Steps:
- Open `/process/<id>/workspace`.
- Inspect the process canvas and each right-panel tab: Summary, Steps, Impact, Insights, Risk.
- Click step evidence from the canvas and from the Steps tab.
- Switch graph versions if multiple exist.
- Approve a draft when allowed.

Expected outcome:
- Canvas is nonblank, readable, and aligned with the steps list.
- Step count, decision count, and evidence count match the graph data.
- Step details include inputs, outputs, exceptions, workarounds, variants, confidence, and evidence counts where available.
- Evidence drawer loads the correct rows, including quote, source type, confidence, speaker or screen context, and screenshot state.
- Version selector changes to the intended version and preserves the active tab.
- Approving a draft uses an idempotency key, shows progress, handles errors, and reloads into the approved state.

Edge cases:
- Graph has no task nodes.
- Graph has warnings.
- Evidence endpoint returns empty rows.
- Evidence endpoint returns 500.
- Version list contains draft and approved versions.
- Long step titles and dense graphs.

### 13. Refinement and Follow-Ups

Steps:
- Open the refine chat from the workspace.
- Ask for a clarification or change based on new information.
- Inspect follow-up tasks in Summary, Insights, and Risk tabs.

Expected outcome:
- Refinement does not silently overwrite approved evidence-backed facts.
- Follow-ups are specific, assigned to the right uncertainty, and visible in the relevant tab.
- The UI distinguishes open gaps from confirmed process facts.

Edge cases:
- User asks for an unsupported edit.
- User provides contradictory information.
- Follow-up list is empty.
- Follow-up list has more than four items.

### 14. Transformation and Automation Workspace

Steps:
- Open `/process/<id>/workspace/transformation`.
- Open `/process/<id>/workspace/automation`.
- Review automation candidates, ROI assumptions, and transformation opportunities.

Expected outcome:
- Opportunities are tied to process evidence, pain, volume, risk, or complexity.
- ROI assumptions are editable where intended and never appear as precise facts without assumptions.
- Automation recommendations are specific to the mapped workflow rather than generic "use AI" suggestions.

Edge cases:
- Missing ROI inputs.
- Very low-volume process.
- High-risk compliance-sensitive process.
- No viable automation candidate.

### 15. Admin Quality Review

Steps:
- Open `/admin`, `/admin/coverage`, `/admin/variants`, `/admin/evidence`, `/admin/seeding`, and `/admin/exports`.
- Inspect coverage scorecards, evidence quality, variant queues, and export affordances.

Expected outcome:
- Admin pages load without console errors.
- Quality gaps are visible enough for an FDE to decide what to recapture or reseed.
- Evidence and variant queues can handle empty states and dense states.
- Export pages do not imply an export succeeded unless a real export is created.

Edge cases:
- No workspace data.
- Partial synthesis data.
- Many variants.
- Evidence rows with low confidence or expired screenshots.

## Cross-Cutting Quality Checks

Run these checks across all paths above:

- Auth and tenancy: users cannot access processes, workspaces, claims, evidence, captures, or graph versions outside their org.
- Idempotency: repeated clicks, refreshes, retries, and network replays do not create duplicate captures, claims, uploads, or approvals.
- Evidence grounding: every material claim in a process detail page or map is supported by linked evidence or clearly marked as uncertain.
- Error quality: API failures show useful messages and leave the user with a next step.
- Loading quality: loading states are visible for long operations and do not freeze controls silently.
- Accessibility: keyboard navigation works for primary controls, dialogs have close controls, buttons have labels, and focus is not trapped incorrectly.
- Responsive layout: onboarding, overview, process detail, capture, and workspace pages remain usable at 375px, 768px, 1440px, and tall/short desktop viewports.
- Browser console: no uncaught page errors or Next.js error overlays on product paths.
- Data integrity: counts in UI match backend data for processes, steps, decisions, evidence, follow-ups, and versions.
- Privacy and retention: consent is required before recording or transcription, pause stops sensitive capture, and redaction covers transcript, recording, screen events, and embeddings.

## Recommended Test Data

Use at least three realistic processes:

1. Retail promotion setup
   - Includes multiple systems, approval handoffs, spreadsheet uploads, deadline pressure, and exception paths.

2. Order deduction dispute resolution
   - Includes high volume, unclear ownership, evidence attachments, financial impact, and multiple variants.

3. New item setup
   - Includes master data, vendor forms, compliance checks, duplicate entry, and long waits.

For each process, include:
- A high-level director narrative.
- One SOP or document artifact.
- One operator walkthrough with screen actions.
- At least one contradiction between documented and actual workflow.
- At least one missing-data follow-up.

## Definition of Done

The product is ready for this testing pass when:

- All essential user paths above complete without blocking errors.
- Failures are either fixed or documented with reproduction steps and severity.
- The generated process inventory and process maps are understandable to a business user without engineer explanation.
- Important facts are evidence-backed, uncertain, or flagged as gaps.
- Capture, synthesis, workspace review, and approval form a coherent loop from raw input to reviewed process map.
