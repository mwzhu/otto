# Phase 1 Acceptance Script

Use this deterministic path for local development and release verification.

## Setup

1. Set local development env:

```bash
OTTO_DEV_AUTH_BYPASS=true
DATABASE_URL=postgres://...
```

2. Apply migrations:

```bash
npm run db:migrate
```

3. Start the app:

```bash
npm run dev
```

## Voice Intake

1. Open `http://localhost:3000/onboarding`.
2. Choose the director voice path.
3. Start the interview.
4. Confirm the live capture screen does not invent transcript rows when speech
   capture is not connected.
5. For local verification without speech capture, upload a text document with
   comparable process inventory content:

```text
We run promotion exception review every week in Commercial Operations.
Category Managers own the process, but Pricing Analysts resolve edge cases.
Salesforce is the system of record, and Google Sheets is used as a workaround.
The biggest pain point is manual spreadsheet cleanup after pricing changes.
Only Pat can resolve certain pricing exceptions, which is a single point of failure.
Documentation exists in an SOP, but it is stale and misses approval exceptions.
```

6. End the interview and confirm it routes to `/overview`.

## Document Upload

1. Open `http://localhost:3000/onboarding/upload`.
2. Upload a sample SOP or a plain text document containing process name, systems, owner roles, pain points, risks, and documentation maturity.
3. In local mode, missing parser/vector/LLM vendor env should use deterministic fallbacks and keep the upload flow usable.
4. Wait for the upload row to reach ready or processing-complete state.

## Inventory And Detail

1. Open `http://localhost:3000/overview`.
2. Verify process or candidate cards show real DB-backed names, systems, roles, frequency, complexity, and evidence counts.
3. Promote one candidate if needed.
4. Open the promoted process detail page.
5. Verify summary, accountable roles, system pills, complexity factors, risks, and evidence links render.
6. Open an evidence link and confirm source type, quote, label, and confidence are visible.

## FDE Coverage And Telemetry

1. Open `http://localhost:3000/admin/coverage`.
2. Verify the scorecard shows all director slot groups.
3. Confirm filled, partial, missing, conflicting, evidence count, confidence, and open follow-up totals reflect `slot_states`.
4. Confirm Phase 1 telemetry shows non-zero values after the verification run:
   - Decisions: at least `2` after the voice transcript plus document upload.
   - Evidence links: at least `2`.
   - p95 latency: greater than `0ms`.
   - Observed cost: `0.000c` is acceptable only when deterministic local fallbacks are active; a configured LLM/parser run should be greater than `0.000c`.
   - Cache hit rate: `0%` is acceptable in deterministic/local mode; configured Anthropic prompt caching should eventually show a non-zero rate after repeated runs.
   - Synthesis health: `completed` for the happy path, with `partial_synthesis` or `failed` only when deliberately testing failure states.
5. Open a process detail evidence link, then verify an `evidence.opened` audit row exists for that evidence ID.

## Automated Checks

```bash
npm run lint
npm run test
npx playwright test tests/visual/routes.spec.ts
```

Phase 1 acceptance passes when deterministic local fallbacks work without external vendor credentials, and the same flow works with configured LiveKit, parser, LLM, vector, and storage providers.
