import { z } from "zod";
import { requireLiveKitAgentService } from "@/lib/auth/service";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  getIdempotentResponse,
  reserveIdempotentRequest,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { evidence, provisionalSteps, screenEvents } from "@/lib/db/schema";
import { stepCandidateFromScreenEvent } from "@/lib/interview/operator/segmenter";
import {
  assertOperatorCaptureAcceptsTurns,
  resolveOperatorSessionContext,
} from "@/lib/interview/operator/turn-transaction";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import { sanitizeJsonForLogs } from "@/lib/security/sanitize";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    capture_session_id: z.string().uuid(),
    ts_ms: z.number().int().min(0),
    event_type: z.string().min(1),
    app_name: z.string().optional(),
    window_title: z.string().optional(),
    url: z.string().optional(),
    ocr_text: z.string().optional(),
    ui_state_label: z.string().optional(),
    screenshot_artifact_id: z.string().uuid().optional(),
    signal_tags: z.array(z.string().min(1)).default([]),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(request: Request) {
  try {
    requireLiveKitAgentService(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const context = await resolveOperatorSessionContext(body.capture_session_id);
    const route = "POST /api/internal/operator-screen-events";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, context.orgId);
      const replay = await getIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (replay.hit) {
        return { response: replay.responseJson, statusCode: replay.statusCode };
      }
      await assertOperatorCaptureAcceptsTurns(context, tx);
      const cached = await reserveIdempotentRequest(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { response: cached.responseJson, statusCode: cached.statusCode };
      }

      const screenEvent = (
        await tx
          .insert(screenEvents)
          .values({
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            captureSessionId: context.captureSessionId,
            tsMs: body.ts_ms,
            eventType: body.event_type,
            appName: body.app_name,
            windowTitle: body.window_title,
            url: body.url,
            ocrText: body.ocr_text,
            uiStateLabel: body.ui_state_label,
            screenshotArtifactId: body.screenshot_artifact_id,
            signalTags: body.signal_tags,
            metadataJson: sanitizeJsonForLogs({
              ...(body.metadata_json ?? {}),
              process_id: context.processId,
            }),
          })
          .returning()
      )[0];
      const quote = screenEventQuote(body);
      const evidenceRow = (
        await tx
          .insert(evidence)
          .values({
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            sourceType: "screen_event",
            sourceId: screenEvent.id,
            evidenceLabel: "observed",
            quote,
            summary: body.ui_state_label ?? body.window_title ?? body.event_type,
            observedAt: new Date(),
            confidence: "0.74",
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
                orgId: context.orgId,
                workspaceId: context.workspaceId,
                captureSessionId: context.captureSessionId,
                processId: context.processId,
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
                  process_id: context.processId,
                }),
              })
              .onConflictDoNothing()
              .returning()
          )[0] ?? null
        : null;
      const response = {
        screen_event: screenEvent,
        evidence: evidenceRow,
        provisional_step: provisionalStep,
      };
      await storeIdempotentResponse(tx, {
        orgId: context.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { response, statusCode: 201 };
    });
    return apiJson(result.response, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}

function screenEventQuote(input: z.infer<typeof bodySchema>) {
  const parts = [
    input.ui_state_label,
    input.app_name,
    input.window_title,
    input.url,
    input.ocr_text,
    input.signal_tags.length ? `signals: ${input.signal_tags.join(", ")}` : null,
  ].filter(Boolean);
  return parts.join(" | ") || input.event_type;
}
