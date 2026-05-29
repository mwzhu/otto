import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, captureSessions, processes } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  ApiError,
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";
import { isOperatorCaptureEligibleStatus } from "@/lib/processes/capture-eligibility";

export const runtime = "nodejs";

const bodySchema = z
  .object({
    workspace_id: z.string().uuid(),
    mode: z.enum(["voice", "screenshare"]),
    language: z.string().min(2).max(16).default("en"),
    consent_acknowledged: z.literal(true),
    consent_text_version: z.string().min(1).max(64),
  })
  .strict();

export async function POST(
  request: Request,
  ctx: { params: Promise<{ processId: string }> },
) {
  try {
    const { processId } = await ctx.params;
    const auth = await requireAuth(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    await ensureWorkspaceRole(auth, body.workspace_id, ["director", "operator"]);
    const route = "POST /api/processes/:processId/operator-captures";

    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.capture.start:${processId}:${idempotencyKey}`}))
      `);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }

      const process = (
        await tx
          .select({ id: processes.id, status: processes.status })
          .from(processes)
          .where(
            and(
              eq(processes.id, processId),
              eq(processes.orgId, auth.orgId),
              eq(processes.workspaceId, body.workspace_id),
            ),
          )
          .limit(1)
      )[0];
      if (!process) {
        throw new ApiError(404, "not_found", "Process not found.");
      }
      if (!isOperatorCaptureEligibleStatus(process.status)) {
        throw new ApiError(
          409,
          "conflict",
          "Operator capture requires a draft or approved process.",
        );
      }

      const captureSession = (
        await tx
          .insert(captureSessions)
          .values({
            orgId: auth.orgId,
            workspaceId: body.workspace_id,
            processId,
            captureType: "operator_interview",
            captureMode:
              body.mode === "screenshare"
                ? "operator_screenshare"
                : "operator_voice",
            metadataJson: {
              mode: body.mode,
              language: body.language,
              participant_user_id: auth.userId,
              consent_acknowledged: body.consent_acknowledged,
              consent_text_version: body.consent_text_version,
              consent_acknowledged_at: new Date().toISOString(),
            },
            startedAt: new Date(),
          })
          .returning()
      )[0];

      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId: body.workspace_id,
        userId: auth.userId,
        eventType: "capture.operator.started",
        subjectType: "capture_session",
        subjectId: captureSession.id,
        metadataJson: {
          process_id: processId,
          mode: body.mode,
          capture_mode: captureSession.captureMode,
          idempotency_key: idempotencyKey,
        },
      });

      const response = { capture_session: captureSession };
      await storeIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
        responseJson: response,
        statusCode: 201,
      });
      return { body: response, statusCode: 201 };
    });

    return apiJson(result.body, { status: result.statusCode });
  } catch (error) {
    return apiError(error);
  }
}
