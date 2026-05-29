import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  artifacts,
  auditLog,
  evidence,
  followUpTasks,
  provisionalSteps,
  screenEvents,
  transcriptSegments,
} from "@/lib/db/schema";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";
import { analyzeScreenRecording } from "@/lib/adapters/screen-recording-analyzer";
import { analyzeScreenFrame } from "@/lib/adapters/vision";

export type ProcessScreenRecordingInput = {
  artifactId: string;
  orgId: string;
  userId?: string;
  captureSessionId: string;
  processId: string;
  idempotencyKey?: string;
};

export async function processScreenRecordingArtifact(
  input: ProcessScreenRecordingInput,
) {
  const artifact = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return (
      await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.orgId, input.orgId)))
        .limit(1)
    )[0];
  });
  if (!artifact) return { ok: false as const, reason: "artifact_not_found" };
  if (artifact.captureSessionId !== input.captureSessionId) {
    return { ok: false as const, reason: "artifact_capture_mismatch" };
  }
  if (artifact.artifactType !== "video") {
    return { ok: false as const, reason: "artifact_not_video" };
  }

  const started = new Date();
  try {
    const preflight = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`screen-recording.process:${artifact.id}`}))
      `);
      const replay = await findExistingScreenRecordingExtraction(tx, {
        orgId: artifact.orgId,
        captureSessionId: input.captureSessionId,
        artifactId: artifact.id,
      });
      if (replay) return { replay };
      await tx
        .update(artifacts)
        .set({ status: "processing", updatedAt: new Date() })
        .where(eq(artifacts.id, artifact.id));
      return { replay: null };
    });
    if (preflight.replay) {
      await writeAgentDecision({
        orgId: artifact.orgId,
        workspaceId: artifact.workspaceId,
        captureSessionId: input.captureSessionId,
        stageName: "screen_recording_upload_pipeline",
        tsStart: started,
        tsEnd: new Date(),
        promptTemplateId: "process-screen-recording.extract",
        promptTemplateVersion: "1",
        toolCalls: {
          artifact_id: artifact.id,
          process_id: input.processId,
          screen_event_ids: preflight.replay.screen_event_ids,
          transcript_segment_ids: preflight.replay.transcript_segment_ids,
          evidence_ids: preflight.replay.evidence_ids,
          provisional_step_ids: preflight.replay.provisional_step_ids,
          keyframe_count: preflight.replay.keyframe_count,
          transcript_segment_count: preflight.replay.transcript_segment_count,
          replayed: true,
          extraction_status: "processed",
        },
        model: "deterministic-screen-recording-ingest",
        tokenCountInput: 0,
        tokenCountOutput: 0,
        costCents: 0,
        latencyMs: Date.now() - started.getTime(),
        cacheHit: true,
        degradedQuality: false,
        degradedReasons: [],
      });
      return {
        ok: true as const,
        artifact_id: artifact.id,
        capture_session_id: input.captureSessionId,
        process_id: input.processId,
        screen_event_ids: preflight.replay.screen_event_ids,
        transcript_segment_ids: preflight.replay.transcript_segment_ids,
        evidence_ids: preflight.replay.evidence_ids,
        provisional_step_ids: preflight.replay.provisional_step_ids,
        keyframe_count: preflight.replay.keyframe_count,
        transcript_segment_count: preflight.replay.transcript_segment_count,
        extraction_status: "processed" as const,
        replayed: true,
      };
    }

    const analysis = await analyzeScreenRecording({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      storageKey: artifact.storageKey,
      storageUrl: artifact.storageUrl,
      durationSeconds: artifact.durationSeconds,
    });

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`screen-recording.process:${artifact.id}`}))
      `);
      const replay = await findExistingScreenRecordingExtraction(tx, {
        orgId: artifact.orgId,
        captureSessionId: input.captureSessionId,
        artifactId: artifact.id,
      });
      if (replay) return { ...replay, replayed: true };

      const uploadEvent = (
        await tx
          .insert(screenEvents)
          .values({
            orgId: artifact.orgId,
            workspaceId: artifact.workspaceId,
            captureSessionId: input.captureSessionId,
            tsMs: 0,
            eventType: "screen_recording_upload",
            appName: "uploaded recording",
            windowTitle: artifact.filename,
            uiStateLabel: "Uploaded process screen recording",
            screenshotArtifactId: artifact.id,
            signalTags: ["screen_recording_upload", "batch_video_processed"],
            metadataJson: sanitizeJsonForLogs({
              artifact_id: artifact.id,
              process_id: input.processId,
              filename: artifact.filename,
              mime_type: artifact.mimeType,
              storage_key: artifact.storageKey,
              duration_seconds: artifact.durationSeconds,
              provider: analysis.provider,
              extraction_status: "processed",
              transcript_segment_count: analysis.transcriptSegments.length,
              keyframe_count: analysis.keyframes.length,
              provisional_step_count: analysis.provisionalSteps.length,
              degraded_reasons: analysis.degradedReasons,
            }),
          })
          .returning()
      )[0];

      const keyframeVision = await Promise.all(
        analysis.keyframes.map((keyframe) =>
          analyzeScreenFrame({
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            storageKey: artifact.storageKey,
            storageUrl: artifact.storageUrl,
            appName: "uploaded recording",
            windowTitle: artifact.filename,
            uiStateLabel: keyframe.label,
            ocrText: keyframe.ocrText,
            signalTags: keyframe.signalTags,
            diffScore: 1,
          }),
        ),
      );

      const keyframeEvents = analysis.keyframes.length
        ? await tx
            .insert(screenEvents)
            .values(
              analysis.keyframes.map((keyframe, index) => ({
                orgId: artifact.orgId,
                workspaceId: artifact.workspaceId,
                captureSessionId: input.captureSessionId,
                tsMs: keyframe.tsMs,
                eventType: "screen_recording_keyframe",
                appName: "uploaded recording",
                windowTitle: artifact.filename,
                ocrText: keyframeVision[index].ocrText ?? keyframe.ocrText,
                uiStateLabel: keyframeVision[index].uiStateLabel,
                signalTags: uniqueStrings([
                  ...keyframe.signalTags.filter((tag) => tag !== "ocr_pending"),
                  ...keyframeVision[index].signalTags,
                  "screen_recording_keyframe_vision_processed",
                ]),
                metadataJson: sanitizeJsonForLogs({
                  artifact_id: artifact.id,
                  process_id: input.processId,
                  filename: artifact.filename,
                  provider: analysis.provider,
                  vision_provider: keyframeVision[index].provider,
                  keyframe_index: index,
                  meaningful_state_change: keyframeVision[index].meaningfulStateChange,
                  degraded_reasons: keyframeVision[index].degradedReasons,
                  extraction_status: keyframeVision[index].ocrText ? "ocr_extracted" : "vision_enriched",
                }),
              })),
            )
            .returning()
        : [];

      const transcriptRows = analysis.transcriptSegments.length
        ? await tx
            .insert(transcriptSegments)
            .values(
              analysis.transcriptSegments.map((segment, index) => ({
                orgId: artifact.orgId,
                workspaceId: artifact.workspaceId,
                captureSessionId: input.captureSessionId,
                speaker: "operator",
                speakerRole: "operator",
                startMs: segment.startMs,
                endMs: segment.endMs,
                text: sanitizeForLogs(segment.text),
                timingSource: `screen_recording_transcript:${analysis.provider}`,
                confidence:
                  segment.confidence === undefined
                    ? undefined
                    : confidenceString(segment.confidence),
                metadataJson: sanitizeJsonForLogs({
                  artifact_id: artifact.id,
                  process_id: input.processId,
                  provider: analysis.provider,
                  segment_index: index,
                }),
              })),
            )
            .returning()
        : [];

      const stepRows = analysis.provisionalSteps.length
        ? await tx
            .insert(provisionalSteps)
            .values(
              analysis.provisionalSteps.map((step, index) => ({
                orgId: artifact.orgId,
                workspaceId: artifact.workspaceId,
                captureSessionId: input.captureSessionId,
                processId: input.processId,
                tsStartMs: step.tsStartMs,
                tsEndMs: step.tsEndMs,
                ordinalHint: index,
                actionVerb: step.actionVerb,
                actionObject: step.actionObject,
                source: "video_segmenter",
                sourceEventId: `screen-recording:${artifact.id}:${index}`,
                idempotencyKey: `screen-recording:${artifact.id}:step:${index}`,
                confidence: confidenceString(step.confidence),
                metadataJson: sanitizeJsonForLogs({
                  artifact_id: artifact.id,
                  process_id: input.processId,
                  title: step.title,
                  provider: analysis.provider,
                }),
              })),
            )
            .onConflictDoNothing()
            .returning()
        : [];

      const evidenceRows = (
        await tx
          .insert(evidence)
          .values([
            {
              orgId: artifact.orgId,
              workspaceId: artifact.workspaceId,
              sourceType: "screen_event",
              sourceId: uploadEvent.id,
              evidenceLabel: "observed",
              quote: `Uploaded screen recording: ${artifact.filename}`,
              summary: "Uploaded screen recording is available for workflow extraction.",
              observedAt: new Date(),
              confidence: "0.62",
            },
            ...keyframeEvents.map((event) => ({
              orgId: artifact.orgId,
              workspaceId: artifact.workspaceId,
              sourceType: "screen_event" as const,
              sourceId: event.id,
              evidenceLabel: "observed" as const,
              quote: event.uiStateLabel ?? "Screen recording keyframe candidate",
              summary:
                "A sampled screen recording keyframe may show a workflow state.",
              observedAt: new Date(),
              confidence: "0.58",
            })),
            ...transcriptRows.map((segment) => ({
              orgId: artifact.orgId,
              workspaceId: artifact.workspaceId,
              sourceType: "transcript_segment" as const,
              sourceId: segment.id,
              evidenceLabel: "stated_operator" as const,
              quote: segment.text,
              summary:
                "Narration from uploaded screen recording describes workflow behavior.",
              observedAt: new Date(),
              confidence: confidenceString(Number(segment.confidence ?? 0.68)),
            })),
          ])
          .returning()
      );

      if (analysis.degradedReasons.length > 0) {
        const isSilentRecording = analysis.transcriptSegments.length === 0;
        await tx.insert(followUpTasks).values({
          orgId: artifact.orgId,
          workspaceId: artifact.workspaceId,
          processId: input.processId,
          captureSessionId: input.captureSessionId,
          taskType: "open_question",
          title: isSilentRecording
            ? "Schedule follow-up voice pass for silent screen recording"
            : "Review uploaded screen recording extraction gaps",
          description:
            isSilentRecording
              ? "This uploaded walkthrough produced screen evidence but no narration transcript. Run a short operator voice pass to validate step intent, exceptions, and handoffs before final approval."
              : "Batch video analysis produced partial evidence. Review missing transcript, OCR, or low-confidence keyframe gaps before final approval.",
          targetType: "artifact",
          targetId: artifact.id,
          priority: isSilentRecording ? "0.92" : "0.85",
          status: "open",
          assignedToUserId: input.userId ?? artifact.uploadedByUserId,
          contextJson: sanitizeJsonForLogs({
            artifact_id: artifact.id,
            screen_event_ids: [uploadEvent.id, ...keyframeEvents.map((event) => event.id)],
            transcript_segment_ids: transcriptRows.map((segment) => segment.id),
            evidence_ids: evidenceRows.map((row) => row.id),
            provisional_step_ids: stepRows.map((step) => step.id),
            process_id: input.processId,
            provider: analysis.provider,
            degraded_reasons: analysis.degradedReasons,
            provider_errors: analysis.providerErrors,
            transcript_segment_count: transcriptRows.length,
            keyframe_count: keyframeEvents.length,
            provisional_step_count: stepRows.length,
            reason: isSilentRecording
              ? "silent_screen_recording_requires_voice_follow_up"
              : "screen_recording_upload_extraction_gap",
          }),
        });
      }
      await tx.insert(auditLog).values({
        orgId: artifact.orgId,
        workspaceId: artifact.workspaceId,
        userId: input.userId ?? artifact.uploadedByUserId,
        eventType: "process.screen_recording.processed",
        subjectType: "artifact",
        subjectId: artifact.id,
        metadataJson: {
          process_id: input.processId,
          capture_session_id: input.captureSessionId,
          screen_event_ids: [uploadEvent.id, ...keyframeEvents.map((event) => event.id)],
          transcript_segment_ids: transcriptRows.map((segment) => segment.id),
          evidence_ids: evidenceRows.map((row) => row.id),
          provisional_step_ids: stepRows.map((step) => step.id),
          provider: analysis.provider,
          degraded_reasons: analysis.degradedReasons,
          idempotency_key: input.idempotencyKey,
          extraction_status: "processed",
        },
      });
      await tx
        .update(artifacts)
        .set({ status: "ready", updatedAt: new Date() })
        .where(eq(artifacts.id, artifact.id));
      return {
        replayed: false,
        screen_event_ids: [uploadEvent.id, ...keyframeEvents.map((event) => event.id)],
        transcript_segment_ids: transcriptRows.map((segment) => segment.id),
        evidence_ids: evidenceRows.map((row) => row.id),
        provisional_step_ids: stepRows.map((step) => step.id),
        keyframe_count: keyframeEvents.length,
        transcript_segment_count: transcriptRows.length,
      };
    });

    await writeAgentDecision({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      captureSessionId: input.captureSessionId,
      stageName: "screen_recording_upload_pipeline",
      tsStart: started,
      tsEnd: new Date(),
      promptTemplateId: "process-screen-recording.extract",
      promptTemplateVersion: "1",
      toolCalls: {
        artifact_id: artifact.id,
        process_id: input.processId,
        screen_event_ids: result.screen_event_ids,
        transcript_segment_ids: result.transcript_segment_ids,
        evidence_ids: result.evidence_ids,
        provisional_step_ids: result.provisional_step_ids,
        keyframe_count: result.keyframe_count,
        transcript_segment_count: result.transcript_segment_count,
        replayed: result.replayed,
        provider: analysis.provider,
        provider_errors: analysis.providerErrors,
        extraction_status: "processed",
      },
      model: analysis.provider,
      tokenCountInput: 0,
      tokenCountOutput:
        analysis.transcriptSegments.length +
        analysis.keyframes.length +
        analysis.provisionalSteps.length,
      costCents: 0,
      latencyMs: Date.now() - started.getTime(),
      cacheHit: result.replayed,
      degradedQuality: analysis.degradedReasons.length > 0,
      degradedReasons: analysis.degradedReasons,
    });

    return {
      ok: true as const,
      artifact_id: artifact.id,
      capture_session_id: input.captureSessionId,
      process_id: input.processId,
      screen_event_ids: result.screen_event_ids,
      transcript_segment_ids: result.transcript_segment_ids,
      evidence_ids: result.evidence_ids,
      provisional_step_ids: result.provisional_step_ids,
      keyframe_count: result.keyframe_count,
      transcript_segment_count: result.transcript_segment_count,
      extraction_status: "processed" as const,
      replayed: result.replayed,
    };
  } catch (error) {
    await markArtifactFailed({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      artifactId: artifact.id,
      userId: input.userId ?? artifact.uploadedByUserId ?? undefined,
      idempotencyKey: input.idempotencyKey,
      error,
    });
    throw error;
  }
}

async function markArtifactFailed(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  artifactId: string;
  userId?: string;
  idempotencyKey?: string;
  error: unknown;
}) {
  const message = sanitizeForLogs(
    input.error instanceof Error ? input.error.message : "Unknown video error",
  );
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .update(artifacts)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.orgId, input.orgId)));
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      eventType: "process.screen_recording.failed",
      subjectType: "artifact",
      subjectId: input.artifactId,
      metadataJson: {
        message,
        idempotency_key: input.idempotencyKey,
      },
    });
    await tx.insert(followUpTasks).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      taskType: "open_question",
      title: "Review failed screen recording upload",
      description:
        "The uploaded screen recording could not be processed into operator evidence. Re-upload the recording or run a voice/screenshare capture to fill the workflow gaps.",
      targetType: "artifact",
      targetId: input.artifactId,
      priority: "0.9",
      status: "open",
      assignedToUserId: input.userId,
      contextJson: sanitizeJsonForLogs({
        artifact_id: input.artifactId,
        reason: "screen_recording_upload_failed",
        message,
        idempotency_key: input.idempotencyKey,
      }),
    });
  });
}

async function findExistingScreenRecordingExtraction(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: { orgId: string; captureSessionId: string; artifactId: string },
) {
  const rows = await tx.execute<{
    screen_event_ids: string[];
    transcript_segment_ids: string[];
    evidence_ids: string[];
    provisional_step_ids: string[];
    keyframe_count: number;
    transcript_segment_count: number;
  }>(sql`
    SELECT
      COALESCE(array_agg(DISTINCT se.id::text)
        FILTER (WHERE se.id IS NOT NULL), ARRAY[]::text[]) AS screen_event_ids,
      COALESCE(array_agg(DISTINCT ts.id::text)
        FILTER (WHERE ts.id IS NOT NULL), ARRAY[]::text[]) AS transcript_segment_ids,
      COALESCE(array_agg(DISTINCT e.id::text)
        FILTER (WHERE e.id IS NOT NULL), ARRAY[]::text[]) AS evidence_ids,
      COALESCE(array_agg(DISTINCT ps.id::text)
        FILTER (WHERE ps.id IS NOT NULL), ARRAY[]::text[]) AS provisional_step_ids,
      COUNT(DISTINCT se.id)
        FILTER (WHERE se.event_type = 'screen_recording_keyframe')::integer AS keyframe_count,
      COUNT(DISTINCT ts.id)::integer AS transcript_segment_count
    FROM screen_events se
    LEFT JOIN transcript_segments ts ON ts.org_id = se.org_id
      AND ts.capture_session_id = se.capture_session_id
      AND ts.metadata_json->>'artifact_id' = ${input.artifactId}
      AND ts.redacted_at IS NULL
    LEFT JOIN provisional_steps ps ON ps.org_id = se.org_id
      AND ps.capture_session_id = se.capture_session_id
      AND ps.metadata_json->>'artifact_id' = ${input.artifactId}
    LEFT JOIN evidence e ON e.org_id = se.org_id
      AND (
        (e.source_type = 'screen_event' AND e.source_id = se.id)
        OR (e.source_type = 'transcript_segment' AND e.source_id = ts.id)
      )
      AND e.tombstoned_at IS NULL
    WHERE se.org_id = ${input.orgId}
      AND se.capture_session_id = ${input.captureSessionId}
      AND se.metadata_json->>'artifact_id' = ${input.artifactId}
      AND se.event_type IN ('screen_recording_upload', 'screen_recording_keyframe')
      AND se.deleted_at IS NULL
      AND se.redacted_at IS NULL
  `);
  const row = rows.rows[0];
  if (!row || row.screen_event_ids.length === 0) return null;
  return row;
}

function confidenceString(value: number) {
  return Math.min(1, Math.max(0, value)).toFixed(3);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
