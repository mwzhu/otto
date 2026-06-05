# Director Voice Decoupling Plan

## Goal

Otto should speak from a fast conversational path while structured extraction runs asynchronously. A slow or failed extraction can delay notes, coverage, and review state, but it must never delay the spoken reply.

The goal is not simply to "use realtime." The goal is to remove structured extraction from the speech critical path while preserving director steering, evidence quality, and authoritative DB state.

## Core Principle

Speech and extraction become separate systems:

- The fast path decides what Otto should pursue next and phrases a natural response.
- The extraction path reads transcript windows and updates slots, claims, coverage, and evidence.
- The DB remains authoritative for Operations Notes.
- The actually spoken utterance is preserved as spoken.
- Sonnet extraction can advise future steering, but it does not rewrite history.

## Hard Constraints

- `director.turn.plan` max tokens stays `8000`.
- No deterministic utterances in the golden path.
- Deterministic utterances are fallback-only.
- Fast model phrases naturally but is not authoritative for Operations Notes.
- DB slot/evidence state remains authoritative.
- Sonnet extraction must never overwrite the actually spoken utterance.
- Steering intent/goal control is enough; verbatim wording control is not required.
- `DIRECTOR_VOICE_MODEL` remains configurable. The architecture must not hardcode Haiku.

## Runtime Modes

Use one runtime flag rather than a boolean:

```env
OTTO_DIRECTOR_VOICE_RUNTIME="planned_cascade"
```

Allowed values:

```text
planned_cascade   = current coupled path
steered_cascade   = fast speech + async extraction
steered_realtime  = future realtime talking layer
```

Ship `steered_cascade` first. It proves the decoupled spine without taking on the realtime model risk at the same time. Only evaluate `steered_realtime` after `steered_cascade` is working in live sessions.

## Target Flow

Current flow:

```text
user final transcript
-> ingest
-> Sonnet plan/extract
-> dispatch DB writes
-> speak
```

New `steered_cascade` flow:

```text
user final transcript/window
-> ingest
-> build steering context
-> fast phrase
-> speak
-> async extract transcript window
-> async output check
-> update coverage/review state
```

Speech latency is now bounded by ingest plus steering reads plus fast model time, not by Sonnet extraction.

## Step 1: Runtime Configuration

Add `OTTO_DIRECTOR_VOICE_RUNTIME` to:

- director agent config
- frontend env parsing
- preflight checks
- `.env.example`

Default to `planned_cascade` until live validation passes.

The worker chooses the turn flow from this runtime. Keep the existing coupled path intact until `steered_cascade` is proven.

## Step 2: Separate Speech Status From Extraction Status

Model speech delivery and structured extraction independently.

Required fields or equivalent delivery JSON:

```ts
speech_delivery_status: "pending" | "delivered" | "failed"
extraction_status: "pending" | "complete" | "failed"
agent_utterance_source: "fast_phrase" | "fallback"
steering_intent: object
spoken_agent_utterance: string
extraction_advisory_utterance?: string
extraction_window_id: string
output_check_status?: "pending" | "passed" | "failed"
```

`Review queued` should not mean "voice was slow." In the new model, speech can be delivered while notes are still updating.

## Step 3: Transcript Windows

Stop treating one LiveKit final transcript as one authoritative extraction unit.

Create transcript windows so quick split finals like this can be extracted together:

```text
"We're responsible for payroll management,"
"cost optimization,"
"and also closing books."
```

Window shape:

```ts
{
  extraction_window_id: string
  transcript_segment_ids: string[]
  turn_indexes: number[]
  opened_at: string
  closed_at?: string
  closed_by: "assistant_spoke" | "silence" | "manual_end" | "superseded"
}
```

Extraction idempotency should use the window id or stable transcript segment set, not only a single `turn_index`.

This is important because turn fragmentation should not fragment the Operations Notes.

## Step 4: Fast Respond Endpoint

Add:

```text
POST /api/internal/director-turns/respond
```

This is an SSE endpoint. It does not run Sonnet extraction.

Responsibilities:

- read interview state, current slots, recent turns, candidate summaries, and pending extraction state
- parallelize independent DB reads with `Promise.all`
- build steering context from authoritative state and in-flight extraction windows
- call the configured `DIRECTOR_VOICE_MODEL`
- stream `planned_agent_utterance` early for TTS
- persist the actually spoken turn with steering metadata

Steering context should be concrete:

```ts
{
  next_objective: string
  target_slots: string[]
  current_focus: string
  known_facts_summary: string
  do_not_ask: string[]
  forbidden_claims: string[]
  required_style: {
    max_questions: number
    max_sentences: number
    tone: string
  }
  pending_transcript_windows: string[]
  pending_slot_paths: string[]
  last_spoken_objective?: string
}
```

`deterministicTurnPlan` can be reused as steering/control input. It must not produce the golden-path spoken utterance.

## Step 5: Async Extract Endpoint

Add:

```text
POST /api/internal/director-turns/extract
```

This endpoint runs the existing heavy Sonnet extraction with `director.turn.plan` at `8000` max tokens.

Responsibilities:

- consume a transcript window
- run the current structured planner/extractor logic
- dispatch slots, claims, coverage, evidence, and candidate process updates
- mark extraction complete or failed
- record Sonnet's planned utterance only as advisory

Critical rule:

```text
Extraction must not overwrite spoken_agent_utterance.
```

The spoken turn belongs to the fast response path. The extraction path owns Operations Notes.

## Step 6: Worker Flow

In `steered_cascade` mode, worker turn handling becomes:

```text
on user transcript final
-> ingest transcript
-> open or extend extraction window
-> call /respond
-> start TTS from streamed utterance
-> mark speech delivered or failed
-> debounce/close extraction window
-> fire /extract in background
-> fire /check in background after speech
```

Do not await extraction before speaking.

Cancellation behavior:

- cancel background work for abandoned pre-speech turns
- preserve extraction for delivered or partially delivered speech
- cancel stale response tasks on supersede
- track background extraction/check tasks for graceful shutdown

## Step 7: Pending Extraction Steering

Because coverage becomes eventually consistent, the next response may be built before extraction has landed.

Mitigate stale steering by passing these into `/respond`:

```ts
pending_extraction_turns
pending_transcript_windows
pending_slot_paths
last_spoken_intent
last_spoken_objective
```

The fast model should avoid obvious repeats when a pending window likely contains the answer.

This will not eliminate every redundant question, but the failure mode becomes a slightly stale question, not a 15-second silent turn.

## Step 8: Async Output Checker

After Otto speaks, run a cheap non-blocking checker over the assistant transcript and steering context.

Check for:

- asking a `do_not_ask` item
- making an unsupported factual claim
- ignoring `next_objective`
- asking too many questions
- being too verbose
- contradicting steering

The checker does not block speech. It updates review state and feeds corrections into future steering.

## Step 9: UI States

Update the transcript UI so speech and notes have separate status.

Useful states:

```text
Transcribing
Otto speaking
Notes updating
Extraction failed
Steering stale
Review queued
```

`Notes updating` is normal. `Review queued` should be reserved for async extraction/checker failures or human-review-worthy violations.

## Step 10: Telemetry

`pre_tts_total_ms` is no longer the main metric.

Track:

```ts
ttfa_ms
speech_latency_ms
extraction_latency_ms
steering_lag_ms
steering_lag_turns
pending_extraction_count
stale_question_count
checker_violation_count
slot_update_latency_ms
```

Keep prompt-cache telemetry on the Sonnet path and verify:

```ts
cache_read_input_tokens > 0
```

This matters because extraction still runs often; it just no longer blocks speech.

## Step 11: Evals And Tests

Run existing director evals against the async extractor before trusting the new path.

Validate:

- extraction quality does not regress
- evidence ids remain correct
- slot coverage still fills
- duplicate writes are prevented
- transcript-window input does not degrade Sonnet behavior
- Sonnet advisory utterance does not overwrite spoken utterance
- forced extraction failure does not delay or break speech

Add focused tests for:

- `/respond` streams a fast utterance without extraction
- `/extract` updates structured state asynchronously
- split transcript finals coalesce into one extraction window
- output checker records violations without blocking speech
- worker speaks before extraction/check tasks complete
- superseded response tasks are cancelled correctly

## Step 12: Acceptance Script

Live test this exact script:

```text
Hello? I own the finance department. We're responsible for payroll management,
cost optimization, and also closing books.
```

Expected behavior in `steered_cascade`:

- Otto does not wait for Sonnet extraction before speaking.
- Speech starts in fast-model latency, not 15 seconds.
- The split transcript finals are extracted as one window.
- Notes update asynchronously.
- Extraction failure does not block speech.
- The spoken utterance is preserved exactly as spoken.
- Coverage eventually reflects finance, payroll management, cost optimization, and closing books.

## Step 13: Rollout

Roll out in this order:

```text
planned_cascade default
steered_cascade behind flag
steered_cascade live test
steered_cascade default
steered_realtime spike
```

Do not delete the coupled path until `steered_cascade` has passed live validation.

## Later: Realtime Spike

Only after `steered_cascade` works, evaluate `steered_realtime`.

The realtime spike is a separate talking-layer swap, not the first decoupling milestone.

Gates:

- mid-session steering updates work
- barge-in/yield behavior is better than cascade
- transcripts are reliable enough for async extraction
- assistant output checker still works
- cost is acceptable for a 10-minute director interview
- fallback to text/cascade path is clear

## Non-Goals For This Plan

- Do not replace the extraction brain with the fast voice model.
- Do not reduce `director.turn.plan` max tokens below `8000`.
- Do not introduce deterministic canned speech as the golden path.
- Do not make realtime a prerequisite for decoupling.
- Do not block speech on review, notes, or coverage writes.

