import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { analyzeScreenFrame } from "@/lib/adapters/vision";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  artifacts,
  auditLog,
  evidence,
  provisionalSteps,
  screenEvents,
} from "@/lib/db/schema";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { stepCandidateFromScreenEvent } from "@/lib/interview/operator/segmenter";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

export type ProcessOperatorScreenFrameInput = {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  artifactId: string;
  screenEventId: string;
  userId?: string;
  idempotencyKey?: string;
};

export async function processOperatorScreenFrame(
  input: ProcessOperatorScreenFrameInput,
) {
  const started = new Date();
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`operator.screen_frame:${input.screenEventId}`}))
    `);
    const row = (
      await tx
        .select({
          artifact: artifacts,
          screenEvent: screenEvents,
        })
        .from(screenEvents)
        .innerJoin(artifacts, eq(artifacts.id, screenEvents.screenshotArtifactId))
        .where(
          and(
            eq(screenEvents.id, input.screenEventId),
            eq(screenEvents.orgId, input.orgId),
            eq(screenEvents.workspaceId, input.workspaceId),
            eq(screenEvents.captureSessionId, input.captureSessionId),
            isNull(screenEvents.deletedAt),
            isNull(screenEvents.redactedAt),
            eq(artifacts.id, input.artifactId),
            eq(artifacts.artifactType, "screen_frame"),
            isNull(artifacts.redactedAt),
          ),
        )
        .limit(1)
    )[0];
    if (!row) {
      return { ok: false as const, reason: "screen_frame_not_found_or_redacted" };
    }
    const metadata = metadataObject(row.screenEvent.metadataJson);
    if (metadata.vision_status === "processed") {
      return {
        ok: true as const,
        replayed: true,
        screenEventId: row.screenEvent.id,
        artifactId: row.artifact.id,
        signalTags: row.screenEvent.signalTags,
        degradedReasons: [],
      };
    }
    const vision = await analyzeScreenFrame({
      filename: row.artifact.filename,
      mimeType: row.artifact.mimeType,
      storageKey: row.artifact.storageKey,
      storageUrl: row.artifact.storageUrl,
      appName: row.screenEvent.appName,
      windowTitle: row.screenEvent.windowTitle,
      uiStateLabel: row.screenEvent.uiStateLabel,
      ocrText: row.screenEvent.ocrText,
      signalTags: row.screenEvent.signalTags,
      diffScore:
        typeof metadata.diff_score === "number" ? metadata.diff_score : null,
    });
    const signalTags = uniqueStrings([
      ...row.screenEvent.signalTags.filter(
        (tag) => tag !== "screen_keyframe_pending_vision",
      ),
      ...vision.signalTags,
      "screen_keyframe_vision_processed",
    ]);
    const updatedScreenEvent = (
      await tx
        .update(screenEvents)
        .set({
          uiStateLabel: vision.uiStateLabel,
          ocrText: vision.ocrText ?? row.screenEvent.ocrText,
          signalTags,
          metadataJson: sanitizeJsonForLogs({
            ...metadata,
            vision_status: "processed",
            vision_provider: vision.provider,
            meaningful_state_change: vision.meaningfulStateChange,
            degraded_reasons: vision.degradedReasons,
          }),
          updatedAt: new Date(),
        })
        .where(eq(screenEvents.id, row.screenEvent.id))
        .returning()
    )[0];
    const evidenceRow = (
      await tx
        .update(evidence)
        .set({
          quote: screenEventQuote(updatedScreenEvent),
          summary: updatedScreenEvent.uiStateLabel,
          confidence: vision.confidence.toFixed(3),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(evidence.orgId, input.orgId),
            eq(evidence.workspaceId, input.workspaceId),
            eq(evidence.sourceType, "screen_event"),
            eq(evidence.sourceId, row.screenEvent.id),
            isNull(evidence.redactedAt),
            isNull(evidence.tombstonedAt),
          ),
        )
        .returning()
    )[0];
    const segmentedStep =
      vision.meaningfulStateChange && evidenceRow
        ? stepCandidateFromScreenEvent({
            id: updatedScreenEvent.id,
            tsMs: updatedScreenEvent.tsMs,
            eventType: updatedScreenEvent.eventType,
            appName: updatedScreenEvent.appName,
            windowTitle: updatedScreenEvent.windowTitle,
            uiStateLabel: updatedScreenEvent.uiStateLabel,
            ocrText: updatedScreenEvent.ocrText,
            signalTags: updatedScreenEvent.signalTags,
          })
        : null;
    const provisionalStep = segmentedStep
      ? (
          await tx
            .insert(provisionalSteps)
            .values({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              captureSessionId: input.captureSessionId,
              processId: input.processId,
              tsStartMs: segmentedStep.tsStartMs,
              tsEndMs: segmentedStep.tsEndMs,
              actionVerb: segmentedStep.actionVerb,
              actionObject: segmentedStep.actionObject ?? segmentedStep.title,
              source: "screen_vision_segmenter",
              sourceEventId: updatedScreenEvent.id,
              idempotencyKey: `screen-vision:${updatedScreenEvent.id}`,
              confidence: segmentedStep.confidence.toFixed(3),
              metadataJson: sanitizeJsonForLogs({
                ...(segmentedStep.metadata ?? {}),
                title: segmentedStep.title,
                evidence_ids: [evidenceRow.id],
                process_id: input.processId,
                vision_provider: vision.provider,
              }),
            })
            .onConflictDoNothing()
            .returning()
        )[0] ?? null
      : null;

    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      eventType: "capture.operator.screen_frame_vision_processed",
      subjectType: "screen_event",
      subjectId: updatedScreenEvent.id,
      metadataJson: {
        process_id: input.processId,
        capture_session_id: input.captureSessionId,
        artifact_id: input.artifactId,
        evidence_id: evidenceRow?.id,
        provisional_step_id: provisionalStep?.id,
        signal_tags: signalTags,
        degraded_reasons: vision.degradedReasons,
        idempotency_key: input.idempotencyKey,
      },
    });

    return {
      ok: true as const,
      replayed: false,
      screenEventId: updatedScreenEvent.id,
      artifactId: row.artifact.id,
      evidenceId: evidenceRow?.id,
      provisionalStepId: provisionalStep?.id,
      signalTags,
      degradedReasons: vision.degradedReasons,
      meaningfulStateChange: vision.meaningfulStateChange,
    };
  });

  await writeAgentDecision({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    captureSessionId: input.captureSessionId,
    stageName: "operator.screen_frame_vision",
    tsStart: started,
    tsEnd: new Date(),
    promptTemplateId: "operator.screen-frame.vision",
    promptTemplateVersion: "1",
    toolCalls: {
      process_id: input.processId,
      artifact_id: input.artifactId,
      screen_event_id: input.screenEventId,
      result,
    },
    model: "deterministic-screen-vision",
    tokenCountInput: 0,
    tokenCountOutput: result.ok ? result.signalTags.length : 0,
    costCents: 0,
    latencyMs: Date.now() - started.getTime(),
    cacheHit: result.ok && result.replayed,
    degradedQuality: result.ok ? result.degradedReasons.length > 0 : true,
    degradedReasons: result.ok ? result.degradedReasons : [result.reason],
  });

  return result;
}

function screenEventQuote(event: typeof screenEvents.$inferSelect) {
  return [
    event.uiStateLabel,
    event.appName,
    event.windowTitle,
    event.ocrText,
    event.signalTags.length ? `signals: ${event.signalTags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
