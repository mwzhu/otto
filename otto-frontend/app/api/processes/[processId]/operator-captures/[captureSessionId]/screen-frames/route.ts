import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { ensureWorkspaceRole, requireAuth } from "@/lib/auth/session";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  artifacts,
  auditLog,
  captureSessions,
  evidence,
  provisionalSteps,
  screenEvents,
} from "@/lib/db/schema";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import {
  inngest,
  operatorScreenFrameCapturedEventName,
} from "@/lib/inngest/client";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { stepCandidateFromScreenEvent } from "@/lib/interview/operator/segmenter";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    artifact_id: z.string().uuid(),
    ts_ms: z.number().int().min(0),
    frame_index: z.number().int().min(0),
    perceptual_hash: z.string().min(1).optional(),
    diff_score: z.number().min(0).max(1).optional(),
    app_name: z.string().optional(),
    window_title: z.string().optional(),
    ui_state_label: z.string().optional(),
    ocr_text: z.string().optional(),
    signal_tags: z.array(z.string().min(1)).default([]),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string; captureSessionId: string }> },
) {
  try {
    const { processId, captureSessionId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route =
      "POST /api/processes/:processId/operator-captures/:captureSessionId/screen-frames";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.screen_frame.capture:${captureSessionId}:${idempotencyKey}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return {
          body: cached.responseJson,
          statusCode: cached.statusCode,
          shouldSendEvent: false,
        };
      }

      const capture = (
        await tx
          .select()
          .from(captureSessions)
          .where(
            and(
              eq(captureSessions.id, captureSessionId),
              eq(captureSessions.orgId, auth.orgId),
              eq(captureSessions.workspaceId, body.workspace_id),
              eq(captureSessions.processId, processId),
              eq(captureSessions.captureType, "operator_interview"),
              eq(captureSessions.captureMode, "operator_screenshare"),
            ),
          )
          .limit(1)
      )[0];
      if (!capture) {
        throw new ApiError(404, "not_found", "Operator screenshare capture not found.");
      }
      if (capture.completedAt) {
        throw new ApiError(
          409,
          "conflict",
          "Operator screenshare capture is already completed.",
        );
      }

      const artifact = (
        await tx
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, body.artifact_id),
              eq(artifacts.orgId, auth.orgId),
              eq(artifacts.workspaceId, body.workspace_id),
              eq(artifacts.artifactType, "screen_frame"),
            ),
          )
          .limit(1)
      )[0];
      if (!artifact) {
        throw new ApiError(404, "not_found", "Screen frame artifact not found.");
      }
      if (artifact.captureSessionId && artifact.captureSessionId !== captureSessionId) {
        throw new ApiError(
          409,
          "conflict",
          "Screen frame artifact is linked to another capture session.",
        );
      }

      const frameTtl = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const updatedArtifact = (
        await tx
          .update(artifacts)
          .set({
            status: "ready",
            captureSessionId,
            ttlAt: artifact.ttlAt ?? frameTtl,
            updatedAt: new Date(),
          })
          .where(eq(artifacts.id, artifact.id))
          .returning()
      )[0];

      const signalTags = uniqueStrings([
        "screen_frame_keyframe",
        "screen_keyframe_pending_vision",
        "live_preview",
        ...body.signal_tags,
      ]);
      console.info("operator screen frame received", {
        process_id: processId,
        capture_session_id: captureSessionId,
        frame_index: body.frame_index,
        ts_ms: body.ts_ms,
      });
      const screenEvent = (
        await tx
          .insert(screenEvents)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            captureSessionId,
            tsMs: body.ts_ms,
            eventType: "screen_frame_keyframe",
            appName: body.app_name,
            windowTitle: body.window_title,
            ocrText: body.ocr_text,
            uiStateLabel: body.ui_state_label ?? "Captured screenshare keyframe",
            screenshotArtifactId: artifact.id,
            signalTags,
            metadataJson: sanitizeJsonForLogs({
              ...(body.metadata_json ?? {}),
              source: "live_preview",
              artifact_id: artifact.id,
              process_id: processId,
              frame_index: body.frame_index,
              perceptual_hash: body.perceptual_hash,
              diff_score: body.diff_score,
              extraction_status: body.ocr_text
                ? "browser_supplied_text"
                : "pending_vision",
            }),
          })
          .returning()
      )[0];
      const evidenceRow = (
        await tx
          .insert(evidence)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            sourceType: "screen_event",
            sourceId: screenEvent.id,
            evidenceLabel: "preview",
            quote: screenEventQuote(body, signalTags),
            summary: screenEvent.uiStateLabel ?? "Captured screenshare keyframe",
            observedAt: new Date(),
            confidence: body.ocr_text ? "0.74" : "0.62",
          })
          .returning()
      )[0];

      const segmentedStep = stepCandidateFromScreenEvent({
        id: screenEvent.id,
        tsMs: screenEvent.tsMs,
        eventType: screenEvent.eventType,
        appName: screenEvent.appName,
        windowTitle: screenEvent.windowTitle,
        uiStateLabel: screenEvent.uiStateLabel,
        ocrText: screenEvent.ocrText,
        signalTags: screenEvent.signalTags,
      });
      const provisionalStep = segmentedStep
        ? (
            await tx
              .insert(provisionalSteps)
              .values({
                orgId: auth.orgId,
                workspaceId: body.workspace_id,
                captureSessionId,
                processId,
                tsStartMs: segmentedStep.tsStartMs,
                tsEndMs: segmentedStep.tsEndMs,
                actionVerb: segmentedStep.actionVerb,
                actionObject: segmentedStep.actionObject ?? segmentedStep.title,
                source: "live_screen_segmenter",
                sourceEventId: screenEvent.id,
                idempotencyKey: `live-screen:${screenEvent.id}`,
                confidence: segmentedStep.confidence.toFixed(3),
                metadataJson: sanitizeJsonForLogs({
                  ...(segmentedStep.metadata ?? {}),
                  title: segmentedStep.title,
                  evidence_ids: [evidenceRow.id],
                  process_id: processId,
                }),
              })
              .onConflictDoNothing()
              .returning()
          )[0] ?? null
        : null;

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.operator.screen_frame_captured",
        subjectType: "screen_event",
        subjectId: screenEvent.id,
        metadataJson: {
          process_id: processId,
          capture_session_id: captureSessionId,
          artifact_id: artifact.id,
          evidence_id: evidenceRow.id,
          provisional_step_id: provisionalStep?.id,
          idempotency_key: idempotencyKey,
        },
      });

      const response = {
        artifact: updatedArtifact,
        screen_event: screenEvent,
        evidence: evidenceRow,
        provisional_step: provisionalStep,
      };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201, shouldSendEvent: true };
    });

    let backgroundWarning: { message: string } | null = null;
    if (result.shouldSendEvent) {
      const screenEventId =
        typeof result.body === "object" &&
        result.body &&
        "screen_event" in result.body &&
        typeof result.body.screen_event === "object" &&
        result.body.screen_event &&
        "id" in result.body.screen_event &&
        typeof result.body.screen_event.id === "string"
          ? result.body.screen_event.id
          : null;
      if (screenEventId) {
        try {
          await inngest.send({
            name: operatorScreenFrameCapturedEventName,
            data: {
              orgId: auth.orgId,
              workspaceId: body.workspace_id,
              processId,
              captureSessionId,
              artifactId: body.artifact_id,
              screenEventId,
              userId: auth.userId,
              idempotencyKey,
            },
          });
        } catch {
          backgroundWarning = {
            message:
              "Screen keyframe was saved, but vision analysis did not queue. Keep recording and retry the interview if visual grounding does not update.",
          };
        }
      }
    }

    return apiJson(
      backgroundWarning
        ? { ...(result.body as Record<string, unknown>), warning: backgroundWarning }
        : result.body,
      { status: result.statusCode },
    );
  } catch (error) {
    return apiError(error);
  }
}

function screenEventQuote(input: z.infer<typeof bodySchema>, signalTags: string[]) {
  const parts = [
    input.ui_state_label,
    input.app_name,
    input.window_title,
    input.ocr_text,
    signalTags.length ? `signals: ${signalTags.join(", ")}` : null,
  ].filter(Boolean);
  return parts.join(" | ") || "Captured screenshare keyframe";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
