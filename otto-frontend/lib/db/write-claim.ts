import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getIdempotentResponse, storeIdempotentResponse } from "@/lib/db/idempotency";
import { getDb, setOrgContext } from "@/lib/db/client";
import { ApiError } from "@/lib/http/json";

export type ClaimSubject =
  | { type: "process"; id: string }
  | { type: "process_version"; id: string }
  | { type: "candidate_process"; id: string }
  | { type: "system"; id: string }
  | { type: "role"; id: string }
  | { type: "person"; id: string };

export type WriteClaimInput = {
  orgId: string;
  workspaceId: string;
  userId: string;
  subject: ClaimSubject;
  field: string;
  value: unknown;
  evidenceIds: string[];
  confidence?: number;
  idempotencyKey: string;
  requestHash: string;
  route: string;
  metadata?: Record<string, unknown>;
};

export type WriteClaimResult = {
  claim: {
    id: string;
    subject_type: string;
    subject_id: string;
    field: string;
    value: unknown;
    status: "active";
    superseded_by_claim_id: null;
  };
  superseded_claim_id: string | null;
};

export async function writeClaim(
  input: WriteClaimInput,
): Promise<{ body: WriteClaimResult; statusCode: number; idempotent: boolean }> {
  const db = getDb();
  return db.transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const cached = await getIdempotentResponse(tx, {
      orgId: input.orgId,
      key: input.idempotencyKey,
      route: input.route,
      requestHash: input.requestHash,
    });
    if (cached.hit) {
      return {
        body: cached.responseJson as WriteClaimResult,
        statusCode: cached.statusCode,
        idempotent: true,
      };
    }

    await lockParentRow(tx, input);
    const shouldSupersede = !multiValueClaimFields.has(input.field);
    const priorRows = shouldSupersede
      ? await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM claims
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND subject_type = ${input.subject.type}
        AND subject_id = ${input.subject.id}
        AND field = ${input.field}
        AND status = 'active'
        AND superseded_by_claim_id IS NULL
      FOR UPDATE
    `)
      : { rows: [] as { id: string }[] };
    const priorClaimId = priorRows.rows[0]?.id ?? null;
    const newClaimId = randomUUID();

    if (priorClaimId) {
      await tx.execute(sql`
        UPDATE claims
        SET status = 'superseded',
            superseded_by_claim_id = ${newClaimId},
            updated_at = now()
        WHERE id = ${priorClaimId}
      `);
    }

    const insertedRows = await tx.execute<{
      id: string;
      subject_type: string;
      subject_id: string;
      field: string;
      value: unknown;
    }>(sql`
      INSERT INTO claims (
        id,
        org_id,
        workspace_id,
        subject_type,
        subject_id,
        field,
        value,
        confidence,
        status,
        metadata_json
      )
      VALUES (
        ${newClaimId},
        ${input.orgId},
        ${input.workspaceId},
        ${input.subject.type},
        ${input.subject.id},
        ${input.field},
        ${JSON.stringify(input.value)}::jsonb,
        ${String(input.confidence ?? 1)},
        'active',
        ${JSON.stringify(input.metadata ?? {})}::jsonb
      )
      RETURNING id, subject_type, subject_id, field, value
    `);
    const inserted = insertedRows.rows[0];

    await updateProjection(tx, input);

    for (const evidenceId of input.evidenceIds) {
      await tx.execute(sql`
        INSERT INTO claim_evidence (claim_id, evidence_id)
        SELECT ${inserted.id}, id
        FROM evidence
        WHERE id = ${evidenceId}
          AND org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
        ON CONFLICT DO NOTHING
      `);
    }

    await tx.execute(sql`
      INSERT INTO audit_log (
        org_id,
        workspace_id,
        user_id,
        event_type,
        subject_type,
        subject_id,
        metadata_json
      )
      VALUES (
        ${input.orgId},
        ${input.workspaceId},
        ${input.userId},
        'claim.write',
        ${input.subject.type},
        ${input.subject.id},
        ${JSON.stringify({
          ...input.metadata,
          claim_id: inserted.id,
          field: input.field,
          idempotency_key: input.idempotencyKey,
        })}::jsonb
      )
    `);

    const body: WriteClaimResult = {
      claim: {
        id: inserted.id,
        subject_type: inserted.subject_type,
        subject_id: inserted.subject_id,
        field: inserted.field,
        value: inserted.value,
        status: "active",
        superseded_by_claim_id: null,
      },
      superseded_claim_id: priorClaimId,
    };
    await storeIdempotentResponse(tx, {
      orgId: input.orgId,
      key: input.idempotencyKey,
      route: input.route,
      requestHash: input.requestHash,
      responseJson: body,
      statusCode: 201,
    });
    return { body, statusCode: 201, idempotent: false };
  });
}

async function lockParentRow(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: WriteClaimInput,
) {
  if (input.subject.type === "process") {
    const result = await tx.execute(sql`
      SELECT id
      FROM processes
      WHERE id = ${input.subject.id}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
      FOR UPDATE
    `);
    if (result.rows.length === 0) {
      throw new ApiError(404, "not_found", "Process not found.");
    }
    return;
  }

  if (input.subject.type === "process_version") {
    const result = await tx.execute(sql`
      SELECT id
      FROM process_versions
      WHERE id = ${input.subject.id}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
      FOR UPDATE
    `);
    if (result.rows.length === 0) {
      throw new ApiError(404, "not_found", "Process version not found.");
    }
    return;
  }

  if (input.subject.type === "candidate_process") {
    const result = await tx.execute(sql`
      SELECT id
      FROM candidate_processes
      WHERE id = ${input.subject.id}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
      FOR UPDATE
    `);
    if (result.rows.length === 0) {
      throw new ApiError(404, "not_found", "Candidate process not found.");
    }
    return;
  }

  if (input.subject.type === "system") {
    const result = await tx.execute(sql`
      SELECT id
      FROM systems
      WHERE id = ${input.subject.id}
        AND org_id = ${input.orgId}
      FOR UPDATE
    `);
    if (result.rows.length === 0) {
      throw new ApiError(404, "not_found", "System not found.");
    }
    return;
  }

  if (input.subject.type === "role") {
    const result = await tx.execute(sql`
      SELECT id
      FROM roles
      WHERE id = ${input.subject.id}
        AND org_id = ${input.orgId}
      FOR UPDATE
    `);
    if (result.rows.length === 0) {
      throw new ApiError(404, "not_found", "Role not found.");
    }
    return;
  }

  const result = await tx.execute(sql`
    SELECT id
    FROM people
    WHERE id = ${input.subject.id}
      AND org_id = ${input.orgId}
    FOR UPDATE
  `);
  if (result.rows.length === 0) {
    throw new ApiError(404, "not_found", "Person not found.");
  }
}

async function updateProjection(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: WriteClaimInput,
) {
  if (input.subject.type === "process") {
    if (input.field === "name") {
      const projectedValue = projectionValue(input.value);
      await tx.execute(sql`UPDATE processes SET name = ${projectedValue}, updated_at = now() WHERE id = ${input.subject.id}`);
      return;
    }
    if (input.field === "description") {
      const projectedValue = projectionValue(input.value);
      await tx.execute(sql`UPDATE processes SET description = ${projectedValue}, updated_at = now() WHERE id = ${input.subject.id}`);
      return;
    }
    if (input.field === "status") {
      const projectedValue = projectionValue(input.value);
      assertEnumValue(input.field, projectedValue, [
        "candidate",
        "draft",
        "approved",
        "archived",
      ]);
      await tx.execute(sql`UPDATE processes SET status = ${projectedValue}::process_status, updated_at = now() WHERE id = ${input.subject.id}`);
      return;
    }
  }

  if (input.subject.type === "process_version" && input.field === "summary") {
    const projectedValue = projectionValue(input.value);
    await tx.execute(sql`UPDATE process_versions SET summary = ${projectedValue}, updated_at = now() WHERE id = ${input.subject.id}`);
    return;
  }
  if (input.subject.type === "process_version" && input.field === "status") {
    const projectedValue = projectionValue(input.value);
    assertEnumValue(input.field, projectedValue, [
      "draft",
      "approved",
      "rejected",
    ]);
    await tx.execute(sql`UPDATE process_versions SET status = ${projectedValue}::process_version_status, updated_at = now() WHERE id = ${input.subject.id}`);
    return;
  }

  if (input.subject.type === "candidate_process") {
    if (input.field === "proposed_name") {
      const projectedValue = projectionValue(input.value);
      await tx.execute(sql`UPDATE candidate_processes SET proposed_name = ${projectedValue}, updated_at = now() WHERE id = ${input.subject.id}`);
      return;
    }
    if (input.field === "frequency") {
      const projectedValue = projectionValue(input.value);
      await tx.execute(sql`UPDATE candidate_processes SET frequency = ${projectedValue}, updated_at = now() WHERE id = ${input.subject.id}`);
      return;
    }
    if (input.field === "complexity_hint") {
      const projectedValue = projectionValue(input.value);
      await tx.execute(sql`UPDATE candidate_processes SET complexity_hint = ${projectedValue}, updated_at = now() WHERE id = ${input.subject.id}`);
      return;
    }
    if (input.field === "status") {
      const projectedValue = projectionValue(input.value);
      assertEnumValue(input.field, projectedValue, [
        "pending",
        "promoted",
        "discarded",
        "merged",
      ]);
      await tx.execute(sql`UPDATE candidate_processes SET status = ${projectedValue}::candidate_process_status, updated_at = now() WHERE id = ${input.subject.id}`);
    }
  }
}

function projectionValue(value: unknown) {
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "bad_request",
      "Phase 0 projected fields must be string values.",
    );
  }
  return value;
}

function assertEnumValue(
  field: string,
  value: string,
  allowed: readonly string[],
) {
  if (field === "status" && !allowed.includes(value)) {
    throw new ApiError(
      400,
      "bad_request",
      `Invalid status value: ${value}`,
    );
  }
}

const multiValueClaimFields = new Set([
  "pain_point",
  "risk",
  "kpi",
  "upstream_dependency",
  "downstream_dependency",
  "used_in_process",
  "participates_in_process",
  "handoff_target",
]);
