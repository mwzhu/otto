import "server-only";

import { randomUUID } from "node:crypto";
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
  visualObservations,
} from "@/lib/db/schema";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";
import { analyzeScreenRecording } from "@/lib/adapters/screen-recording-analyzer";
import { analyzeScreenFrame } from "@/lib/adapters/vision";
import {
  artifactStorageKey,
  deleteArtifactObject,
  uploadArtifactObject,
} from "@/lib/adapters/storage";

export type ProcessScreenRecordingInput = {
  artifactId: string;
  orgId: string;
  userId?: string;
  captureSessionId: string;
  processId: string;
  idempotencyKey?: string;
};

type UploadedFrameObject = {
  artifactId: string;
  filename: string;
  storageKey: string;
  storageUrl: string;
  mimeType: "image/png";
  sizeBytes: number;
};

const SCREEN_RECORDING_ANALYZER_VERSION = "png-frame-extraction-v2";

export async function processScreenRecordingArtifact(
  input: ProcessScreenRecordingInput,
) {
  const artifact = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return (
      await tx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, input.artifactId),
            eq(artifacts.orgId, input.orgId),
          ),
        )
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
  let frameUploads: Array<UploadedFrameObject | null> = [];
  const uploadedFrameObjects: UploadedFrameObject[] = [];
  let frameObjectsPersisted = false;
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
    const frameDiffScores = analysis.keyframes.map((keyframe, index) =>
      keyframeDiffScore(
        analysis.keyframes[index - 1]?.perceptualHash,
        keyframe.perceptualHash,
      ),
    );
    const multimodalBudget = Number.isFinite(
      Number(process.env.OTTO_OPERATOR_VISION_MAX_FRAMES),
    )
      ? Math.max(
          0,
          Math.floor(Number(process.env.OTTO_OPERATOR_VISION_MAX_FRAMES)),
        )
      : 40;
    const multimodalIndexes = budgetedMultimodalIndexes({
      keyframes: analysis.keyframes,
      frameDiffScores,
      budget: multimodalBudget,
    });
    frameUploads = await Promise.all(
      analysis.keyframes.map(async (keyframe, index) => {
        if (!keyframe.bytes) return null;
        const artifactId = randomUUID();
        const filename = `${artifact.filename.replace(/\.[^.]+$/, "")}-frame-${String(index + 1).padStart(3, "0")}.png`;
        const storageKey = artifactStorageKey({
          orgId: artifact.orgId,
          workspaceId: artifact.workspaceId,
          artifactId,
          filename,
        });
        const uploaded = await uploadArtifactObject({
          key: storageKey,
          bytes: keyframe.bytes,
          contentType: keyframe.mimeType ?? "image/png",
        });
        const frameObject: UploadedFrameObject = {
          artifactId,
          filename,
          storageKey,
          storageUrl: uploaded.url,
          mimeType: keyframe.mimeType ?? "image/png",
          sizeBytes: uploaded.sizeBytes,
        };
        uploadedFrameObjects.push(frameObject);
        return frameObject;
      }),
    );

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
              analyzer_version: SCREEN_RECORDING_ANALYZER_VERSION,
              extraction_status: "processed",
              transcript_segment_count: analysis.transcriptSegments.length,
              keyframe_count: analysis.keyframes.length,
              provisional_step_count: analysis.provisionalSteps.length,
              degraded_reasons: analysis.degradedReasons,
            }),
          })
          .returning()
      )[0];

      const frameArtifactRows = frameUploads.some(Boolean)
        ? await tx
            .insert(artifacts)
            .values(
              frameUploads.flatMap((upload) =>
                upload
                  ? [
                      {
                        id: upload.artifactId,
                        orgId: artifact.orgId,
                        workspaceId: artifact.workspaceId,
                        captureSessionId: input.captureSessionId,
                        uploadedByUserId:
                          input.userId ?? artifact.uploadedByUserId,
                        artifactType: "screen_frame" as const,
                        status: "ready" as const,
                        storageKey: upload.storageKey,
                        storageUrl: upload.storageUrl,
                        filename: upload.filename,
                        mimeType: upload.mimeType,
                        sizeBytes: upload.sizeBytes,
                        ttlAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                      },
                    ]
                  : [],
              ),
            )
            .returning()
        : [];
      const frameArtifactByIndex = new Map(
        frameArtifactRows.map((row) => [
          frameUploads.findIndex((upload) => upload?.artifactId === row.id),
          row,
        ]),
      );

      const keyframeVision = await Promise.all(
        analysis.keyframes.map((keyframe, index) =>
          analyzeScreenFrame({
            filename: keyframe.label || artifact.filename,
            mimeType: keyframe.mimeType ?? "image/png",
            storageKey: artifact.storageKey,
            storageUrl: artifact.storageUrl,
            appName: "uploaded recording",
            windowTitle: artifact.filename,
            uiStateLabel: keyframe.label,
            ocrText: keyframe.ocrText,
            signalTags: keyframe.signalTags,
            diffScore: frameDiffScores[index],
            bytes: keyframe.bytes,
            allowMultimodal: multimodalIndexes.has(index),
            forceMultimodal: keyframe.signalTags.some((tag) =>
              tag.startsWith("transcript_trigger_"),
            ),
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
                screenshotArtifactId:
                  frameArtifactByIndex.get(index)?.id ?? undefined,
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
                  vision_model: keyframeVision[index].model,
                  ocr_provider: keyframe.ocrProvider,
                  keyframe_index: index,
                  meaningful_state_change:
                    keyframeVision[index].meaningfulStateChange,
                  degraded_reasons: keyframeVision[index].degradedReasons,
                  frame_artifact_id: frameArtifactByIndex.get(index)?.id,
                  extraction_status: keyframeVision[index].ocrText
                    ? "ocr_extracted"
                    : "vision_enriched",
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

      const uploadEvidenceRow = (
        await tx
          .insert(evidence)
          .values({
            orgId: artifact.orgId,
            workspaceId: artifact.workspaceId,
            sourceType: "screen_event",
            sourceId: uploadEvent.id,
            evidenceLabel: "observed",
            quote: `Uploaded screen recording: ${artifact.filename}`,
            summary:
              "Uploaded screen recording is available for workflow extraction.",
            observedAt: new Date(),
            confidence: "0.62",
          })
          .returning()
      )[0];
      const keyframeEvidenceRows = keyframeEvents.length
        ? await tx
            .insert(evidence)
            .values(
              keyframeEvents.map((event) => ({
                orgId: artifact.orgId,
                workspaceId: artifact.workspaceId,
                sourceType: "screen_event" as const,
                sourceId: event.id,
                evidenceLabel: "observed" as const,
                quote:
                  event.uiStateLabel ?? "Screen recording keyframe candidate",
                summary:
                  "A sampled screen recording keyframe may show a workflow state.",
                observedAt: new Date(),
                confidence: "0.58",
              })),
            )
            .returning()
        : [];
      const transcriptEvidenceRows = transcriptRows.length
        ? await tx
            .insert(evidence)
            .values(
              transcriptRows.map((segment) => ({
                orgId: artifact.orgId,
                workspaceId: artifact.workspaceId,
                sourceType: "transcript_segment" as const,
                sourceId: segment.id,
                evidenceLabel: "stated_operator" as const,
                quote: segment.text,
                summary:
                  "Narration from uploaded screen recording describes workflow behavior.",
                observedAt: new Date(),
                confidence: confidenceString(
                  Number(segment.confidence ?? 0.68),
                ),
              })),
            )
            .returning()
        : [];
      const evidenceRows = [
        uploadEvidenceRow,
        ...keyframeEvidenceRows,
        ...transcriptEvidenceRows,
      ];
      const keyframeEvidenceBySourceId = new Map(
        keyframeEvidenceRows.map((row) => [row.sourceId, row]),
      );
      const visualObservationRows = keyframeEvents.length
        ? await tx
            .insert(visualObservations)
            .values(
              keyframeEvents.map((event, index) => {
                const vision = keyframeVision[index];
                const evidenceForObservation = keyframeEvidenceBySourceId.get(
                  event.id,
                );
                if (!evidenceForObservation) {
                  throw new Error(
                    `Missing keyframe evidence for screen event ${event.id}`,
                  );
                }
                return {
                  orgId: artifact.orgId,
                  workspaceId: artifact.workspaceId,
                  captureSessionId: input.captureSessionId,
                  screenEventId: event.id,
                  artifactId:
                    frameArtifactByIndex.get(index)?.id ?? artifact.id,
                  tsMs: event.tsMs,
                  provider: vision.provider,
                  ocrText: vision.ocrText ?? null,
                  uiSummary: vision.uiStateLabel,
                  structuredJson: sanitizeJsonForLogs(vision.structuredJson),
                  confidence: confidenceString(vision.confidence),
                  degradedReasons: vision.degradedReasons,
                  model: vision.model,
                  promptTemplateId: vision.promptTemplateId,
                  promptTemplateVersion: vision.promptTemplateVersion,
                  idempotencyKey: `screen-vision:${artifact.id}:${event.id}:${vision.provider}:${vision.model}:${vision.promptTemplateVersion}`,
                  emitsEvidence: true,
                  evidenceId: evidenceForObservation.id,
                };
              }),
            )
            .onConflictDoNothing()
            .returning()
        : [];

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
          description: isSilentRecording
            ? "This uploaded walkthrough produced screen evidence but no narration transcript. Run a short operator voice pass to validate step intent, exceptions, and handoffs before final approval."
            : "Batch video analysis produced partial evidence. Review missing transcript, OCR, or low-confidence keyframe gaps before final approval.",
          targetType: "artifact",
          targetId: artifact.id,
          priority: isSilentRecording ? "0.92" : "0.85",
          status: "open",
          assignedToUserId: input.userId ?? artifact.uploadedByUserId,
          contextJson: sanitizeJsonForLogs({
            artifact_id: artifact.id,
            screen_event_ids: [
              uploadEvent.id,
              ...keyframeEvents.map((event) => event.id),
            ],
            transcript_segment_ids: transcriptRows.map((segment) => segment.id),
            evidence_ids: evidenceRows.map((row) => row.id),
            visual_observation_ids: visualObservationRows.map((row) => row.id),
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
          screen_event_ids: [
            uploadEvent.id,
            ...keyframeEvents.map((event) => event.id),
          ],
          transcript_segment_ids: transcriptRows.map((segment) => segment.id),
          evidence_ids: evidenceRows.map((row) => row.id),
          visual_observation_ids: visualObservationRows.map((row) => row.id),
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
        screen_event_ids: [
          uploadEvent.id,
          ...keyframeEvents.map((event) => event.id),
        ],
        transcript_segment_ids: transcriptRows.map((segment) => segment.id),
        evidence_ids: evidenceRows.map((row) => row.id),
        visual_observation_ids: visualObservationRows.map((row) => row.id),
        provisional_step_ids: stepRows.map((step) => step.id),
        keyframe_count: keyframeEvents.length,
        transcript_segment_count: transcriptRows.length,
      };
    });
    if (result.replayed) {
      await cleanupUploadedFrameObjects(uploadedFrameObjects);
      uploadedFrameObjects.length = 0;
    } else {
      frameObjectsPersisted = true;
    }

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
    if (!frameObjectsPersisted) {
      await cleanupUploadedFrameObjects(uploadedFrameObjects);
      uploadedFrameObjects.length = 0;
    }
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

async function cleanupUploadedFrameObjects(
  frameUploads: UploadedFrameObject[],
) {
  if (frameUploads.length === 0) return;
  const results = await Promise.allSettled(
    frameUploads.map((upload) =>
      deleteArtifactObject({ key: upload.storageKey }),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [sanitizeForLogs(errorMessage(result.reason))]
      : [],
  );
  if (failures.length > 0) {
    console.warn("Failed to clean up orphaned screen frame uploads", failures);
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
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.orgId, input.orgId),
        ),
      );
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
      AND se.metadata_json->>'analyzer_version' = ${SCREEN_RECORDING_ANALYZER_VERSION}
      AND se.event_type IN ('screen_recording_upload', 'screen_recording_keyframe')
      AND se.deleted_at IS NULL
      AND se.redacted_at IS NULL
  `);
  const row = rows.rows[0];
  if (!row || row.screen_event_ids.length === 0) return null;
  return row;
}

function budgetedMultimodalIndexes(input: {
  keyframes: Array<{
    ocrText?: string;
    signalTags: string[];
  }>;
  frameDiffScores: number[];
  budget: number;
}) {
  if (input.budget <= 0) return new Set<number>();
  const scored = input.keyframes.map((keyframe, index) => ({
    index,
    score:
      input.frameDiffScores[index] +
      (keyframe.ocrText?.trim() ? 0.15 : 0) +
      (keyframe.signalTags.some((tag) => tag.startsWith("transcript_trigger_"))
        ? 1
        : 0) +
      (keyframe.signalTags.some((tag) =>
        /error|warning|spreadsheet|export|download|copy|paste|approve|reject/i.test(
          tag,
        ),
      )
        ? 0.35
        : 0),
  }));
  return new Set(
    scored
      .sort((left, right) => right.score - left.score)
      .slice(0, input.budget)
      .map((frame) => frame.index),
  );
}

function keyframeDiffScore(
  previousHash: string | undefined,
  currentHash: string | undefined,
) {
  if (!previousHash || !currentHash) return 1;
  if (previousHash.length !== currentHash.length) {
    return previousHash === currentHash ? 0 : 1;
  }
  let distance = 0;
  for (let index = 0; index < currentHash.length; index += 1) {
    if (previousHash[index] !== currentHash[index]) distance += 1;
  }
  return distance / Math.max(1, currentHash.length);
}

function confidenceString(value: number) {
  return Math.min(1, Math.max(0, value)).toFixed(3);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
