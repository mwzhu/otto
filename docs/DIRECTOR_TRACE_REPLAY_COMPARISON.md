# Director Trace Replay Comparison

Use this workflow when we want to compare a production director-interview failure
against a fixed simulation or dogfood run.

## Goal

Every simulation should write traces into the same core tables as production:

- `transcript_segments`
- `agent_decision_log`
- `candidate_processes`
- `slot_states`
- `interview_state`
- `director_extraction_windows`

Then compare the production capture and replay capture side by side in TablePlus.

## Production Connection

Open TablePlus with the production `DATABASE_URL` from:

```text
/Users/michaelzhu/Desktop/otto/.vercel/.env.production.local
```

Original failed capture:

```text
71569919-775d-44bd-bd33-f5b6faf096f1
```

## Durable Product Replay Database

Use this as the main manual verification run. It does not inject old extractor
outputs. It replays the failed transcript through the product path:

```text
ingest director turn -> steering -> voice phrasing -> extraction -> dispatch -> DB logs
```

Run it into a named Docker container and named Docker volume:

```bash
cd /Users/michaelzhu/Desktop/otto/otto-frontend
docker rm -f otto-replay-715-product >/dev/null 2>&1 || true
OTTO_RUN_DIRECTOR_PRODUCT_REPLAY=true \
OTTO_KEEP_PHASE1_TEST_DB=true \
OTTO_PHASE1_TEST_CONTAINER=otto-replay-715-product \
OTTO_PHASE1_TEST_VOLUME=otto-replay-715-product-data \
OTTO_PHASE1_TEST_PORT=55434 \
OTTO_DIRECTOR_PRODUCT_REPLAY_CAPTURE_ID=71571571-5715-5715-8715-715715715715 \
  ../scripts/with-env.sh .env.local -- \
  npx vitest run tests/phase1/db.integration.test.ts \
  -t "replays prod director session 71569919 through split product path"
```

Each run creates a fresh replay capture id and prints it:

```text
[director-product-replay] capture_session_id=<fresh_capture_id> replay_run_id=<fresh_run_id>
```

If you intentionally need to reuse a known capture id, set
`OTTO_DIRECTOR_PRODUCT_REPLAY_CAPTURE_ID=<capture_id>` on the replay command.
If you intentionally need to reapply migrations to an existing named volume, set
`OTTO_PHASE1_TEST_REAPPLY_MIGRATIONS=true`; otherwise initialized durable
volumes keep their previous replay captures.

This creates a durable local Postgres DB:

- Container: `otto-replay-715-product`
- Volume: `otto-replay-715-product-data`
- Restart policy: `unless-stopped`

Use this TablePlus connection:

```text
Host: 127.0.0.1
Port: 55434
Database: otto_test
User: postgres
Password: postgres
```

Find recent product replay captures:

```sql
SELECT
  id,
  started_at,
  metadata_json->>'replay_run_id' AS replay_run_id
FROM capture_sessions
WHERE metadata_json->>'replay_source_capture_session_id' =
  '71569919-775d-44bd-bd33-f5b6faf096f1'
  AND metadata_json->>'replay_kind' =
    'split_product_path_no_injected_extraction'
ORDER BY started_at DESC;
```

The preserved DB includes the view. Use the capture id printed by the test:

```sql
SELECT *
FROM debug_director_trace_timeline
WHERE capture_session_id = '<fresh_capture_id>'
ORDER BY turn_index, sort_order;
```

Expected fixed replay facts:

- `transcript_segments`: 21
- `agent_decision_log`: 42
- `candidate_processes`: 6
- `director_extraction_windows`: 21
- `debug_director_trace_timeline`: 63 rows
- `current_candidates` is point-in-time: turn 0 is empty, and the six candidates
  first appear on the turn 1 extraction row.
- Candidate names are exactly the real six-process inventory.
- Turns 11-14 rotate through real candidates instead of asking the generic first-process question.
- Turns 17-20 name `Returns And Credit Memos`.

## Durable Regression Fixture Database

This is a separate guardrail fixture. It intentionally simulates the old bad
extractor output on turn 0, so you can verify the new deterministic gate blocks
the fake process rows. Do not use this as the main "actual product path" replay.

Run an integration replay into a named Docker container and named Docker volume:

```bash
cd /Users/michaelzhu/Desktop/otto/otto-frontend
OTTO_KEEP_PHASE1_TEST_DB=true \
OTTO_PHASE1_TEST_CONTAINER=otto-replay-715-fixed \
OTTO_PHASE1_TEST_VOLUME=otto-replay-715-fixed-data \
OTTO_PHASE1_TEST_PORT=55433 \
  ../scripts/with-env.sh .env.local -- \
  npx vitest run tests/phase1/db.integration.test.ts \
  -t "replays prod director session 71569919"
```

This creates a durable local Postgres DB:

- Container: `otto-replay-715-fixed`
- Volume: `otto-replay-715-fixed-data`
- Restart policy: `unless-stopped`

Use the owner connection in TablePlus so RLS does not hide debug rows:

```text
Host: 127.0.0.1
Port: 55433
Database: otto_test
User: postgres
Password: postgres
```

Confirm the mapped port with:

```bash
docker ps --filter name=otto-replay-715-fixed --format '{{.Names}} {{.Ports}}'
```

If you want a separate durable run, choose a new container name, volume name, and
unused port. Reusing an existing volume preserves its existing schema and data.

Fixed replay capture:

```text
f3f3f3f3-f3f3-5f3f-8f3f-f3f3f3f3f3f3
```

When finished, remove the preserved container:

```bash
docker stop otto-replay-715-fixed
docker start otto-replay-715-fixed
```

Delete the durable DB only when you intentionally want to remove it:

```bash
docker rm -f otto-replay-715-fixed
docker volume rm otto-replay-715-fixed-data
```

## One-Table Timeline Query

Run this in TablePlus against production. The durable product replay DB already
has `debug_director_trace_timeline`, but this query is useful when you want the
same one-table shape on a DB that does not have the view installed.
Replace `<capture_id>` with the capture id you are inspecting.

```sql
WITH director_turns AS (
  SELECT
    turn_index,
    0 AS sort_order,
    '1 Director said' AS row_type,
    text AS message,
    NULL::jsonb AS chosen_intent,
    NULL::text AS target_process,
    NULL::jsonb AS slot_updates,
    NULL::jsonb AS tool_calls,
    NULL::text AS final_focus_process,
    NULL::text[] AS candidates_after_turn,
    NULL::jsonb AS degraded_reasons
  FROM transcript_segments
  WHERE capture_session_id = '<capture_id>'
    AND speaker_role = 'director'
),
agent_turns AS (
  SELECT
    d.turn_index,
    1 AS sort_order,
    '2 Agent asked' AS row_type,
    d.sanitized_agent_utterance AS message,
    d.chosen_intent,
    d.chosen_intent->>'target_process' AS target_process,
    d.slot_updates,
    d.tool_calls,
    focus_cp.proposed_name AS final_focus_process,
    NULL::text[] AS candidates_after_turn,
    d.degraded_reasons
  FROM agent_decision_log d
  LEFT JOIN interview_state s
    ON s.capture_session_id = d.capture_session_id
  LEFT JOIN candidate_processes focus_cp
    ON focus_cp.id = s.focus_candidate_process_id
  WHERE d.capture_session_id = '<capture_id>'
    AND d.stage_name = 'director.turn'
),
agent_extractions AS (
  SELECT
    d.turn_index,
    2 AS sort_order,
    '3 Agent extracted' AS row_type,
    NULL::text AS message,
    d.chosen_intent,
    d.chosen_intent->>'target_process' AS target_process,
    d.slot_updates,
    d.tool_calls,
    focus_cp.proposed_name AS final_focus_process,
    ARRAY(
      SELECT cp.proposed_name
      FROM candidate_processes cp
      WHERE cp.capture_session_id = d.capture_session_id
        AND cp.created_at <= d.created_at
      ORDER BY cp.created_at
    ) AS candidates_after_turn,
    d.degraded_reasons
  FROM agent_decision_log d
  LEFT JOIN interview_state s
    ON s.capture_session_id = d.capture_session_id
  LEFT JOIN candidate_processes focus_cp
    ON focus_cp.id = s.focus_candidate_process_id
  WHERE d.capture_session_id = '<capture_id>'
    AND d.stage_name = 'director.extraction'
)
SELECT
  turn_index,
  row_type,
  message,
  chosen_intent,
  target_process,
  slot_updates,
  tool_calls,
  final_focus_process,
  candidates_after_turn,
  degraded_reasons
FROM (
  SELECT * FROM director_turns
  UNION ALL
  SELECT * FROM agent_turns
  UNION ALL
  SELECT * FROM agent_extractions
) timeline
ORDER BY turn_index, sort_order;
```

## Comparison Method

Open two TablePlus windows:

1. Production DB with capture `71569919-775d-44bd-bd33-f5b6faf096f1`.
2. Durable product replay DB with the fresh capture id printed by the replay
   test.

Run the one-table timeline query in production and the view query in the replay
DB.

Compare:

- Turn 0: replay should not write fake candidates from scope verbs.
- Turn 1: replay should write the six real inventory candidates.
- Turns 11-14: replay should rotate through real candidates and name each one in
  the agent message.
- Turns 17-20: replay should resolve `Returns` to `Returns And Credit Memos` and
  name that process in the agent message.
