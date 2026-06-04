import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { auditLog, evidence } from "@/lib/db/schema";
import { requireAuth, ensureWorkspaceRole } from "@/lib/auth/session";
import {
  apiError,
  apiJson,
  readJsonWithHash,
  requireIdempotencyKey,
} from "@/lib/http/json";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "@/lib/db/idempotency";

export const runtime = "nodejs";

const bodySchema = z.object({
  source_type: z.enum([
    "transcript_segment",
    "screen_event",
    "document_chunk",
    "user_correction",
    "agent_inference",
  ]),
  source_id: z.string().uuid().optional(),
  evidence_label: z.enum([
    "observed",
    "stated_operator",
    "stated_director",
    "documented",
    "inferred",
    "confirmed",
    "corrected",
  ]),
  span_start: z.number().int().nonnegative().optional(),
  span_end: z.number().int().nonnegative().optional(),
  quote: z.string().optional(),
  summary: z.string().optional(),
  observed_at: z.string().datetime().optional(),
  confidence: z.number().min(0).max(1).default(1),
  correction_eval: z
    .object({
      target_agent: z.enum(["director", "operator", "synthesis", "opportunity"]),
      target_metric: z.string().min(1).max(120),
      expected_behavior: z.string().min(1).max(2000),
      fixture_id: z.string().min(1).max(160).optional(),
      prompt_template_id: z.string().min(1).max(160).optional(),
      prompt_template_version: z.string().min(1).max(64).optional(),
      affected_subject_type: z.string().min(1).max(80).optional(),
      affected_subject_id: z.string().uuid().optional(),
    })
    .strict()
    .optional(),
});

const querySchema = z.object({
  evidence_id: z.string().uuid(),
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const auth = await requireAuth(request);
    await ensureWorkspaceRole(auth, workspaceId, ["director", "operator", "viewer"]);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );

    const row = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const evidenceRow = (
        await tx
          .select()
          .from(evidence)
          .where(
            and(
              eq(evidence.id, query.evidence_id),
              eq(evidence.orgId, auth.orgId),
              eq(evidence.workspaceId, workspaceId),
            ),
          )
          .limit(1)
      )[0];
      if (!evidenceRow) return null;
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId,
        userId: auth.userId,
        eventType: "evidence.opened",
        subjectType: "evidence",
        subjectId: evidenceRow.id,
        metadataJson: {
          source_type: evidenceRow.sourceType,
          evidence_label: evidenceRow.evidenceLabel,
        },
      });
      return evidenceRow;
    });

    if (!row) {
      return apiJson(
        { error: { code: "not_found", message: "Evidence not found." } },
        { status: 404 },
      );
    }
    return apiJson({ evidence: row });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await ctx.params;
    const auth = await requireAuth(request);
    await ensureWorkspaceRole(auth, workspaceId, ["director", "operator"]);
    const idempotencyKey = requireIdempotencyKey(request);
    const { json, hash } = await readJsonWithHash(request);
    const body = bodySchema.parse(json);
    const route = "POST /api/workspaces/:workspaceId/evidence";
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      await setOrgContext(tx, auth.orgId);
      const cached = await getIdempotentResponse(tx, {
        orgId: auth.orgId,
        key: idempotencyKey,
        route,
        requestHash: hash,
      });
      if (cached.hit) {
        return { body: cached.responseJson, statusCode: cached.statusCode };
      }
      const row = (
        await tx
          .insert(evidence)
          .values({
            orgId: auth.orgId,
            workspaceId,
            sourceType: body.source_type,
            sourceId: body.source_id,
            evidenceLabel: body.evidence_label,
            spanStart: body.span_start,
            spanEnd: body.span_end,
            quote: body.quote,
            summary: body.summary,
            observedAt: body.observed_at ? new Date(body.observed_at) : undefined,
            confidence: String(body.confidence),
          })
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: auth.orgId,
        workspaceId,
        userId: auth.userId,
        eventType: "evidence.create",
        subjectType: "evidence",
        subjectId: row.id,
        metadataJson: { idempotency_key: idempotencyKey },
      });
      if (body.source_type === "user_correction" && body.correction_eval) {
        await tx.insert(auditLog).values({
          orgId: auth.orgId,
          workspaceId,
          userId: auth.userId,
          eventType: "eval.correction_example.created",
          subjectType: "evidence",
          subjectId: row.id,
          metadataJson: {
            idempotency_key: idempotencyKey,
            evidence_id: row.id,
            source_type: body.source_type,
            evidence_label: body.evidence_label,
            quote: body.quote ?? null,
            summary: body.summary ?? null,
            correction_eval: body.correction_eval,
          },
        });
      }
      const response = { evidence: row };
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
