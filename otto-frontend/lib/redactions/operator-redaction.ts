import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import {
  artifacts,
  auditLog,
  followUpTasks,
  redactions,
} from "@/lib/db/schema";
import { deleteArtifactObject } from "@/lib/adapters/storage";
import { sanitizeForLogs } from "@/lib/security/sanitize";

export type OperatorRedactionInput = {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  redactionId: string;
  userId?: string;
  idempotencyKey?: string;
};

export async function runOperatorRedaction(input: OperatorRedactionInput) {
  try {
    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`operator.redaction:${input.redactionId}`}))
      `);
      const redaction = (
        await tx
          .select()
          .from(redactions)
          .where(
            and(
              eq(redactions.id, input.redactionId),
              eq(redactions.orgId, input.orgId),
              eq(redactions.workspaceId, input.workspaceId),
              eq(redactions.captureSessionId, input.captureSessionId),
            ),
          )
          .limit(1)
      )[0];
      if (!redaction) return { ok: false as const, reason: "redaction_not_found" };
      if (redaction.status === "complete") {
        return { ok: true as const, alreadyComplete: true, redaction };
      }
      if (redaction.status === "failed") {
        return { ok: false as const, reason: "redaction_failed" };
      }
      await tx
        .update(redactions)
        .set({ status: "running", startedAt: redaction.startedAt ?? new Date() })
        .where(eq(redactions.id, redaction.id));

      const transcriptRows = await tx.execute<{ id: string }>(sql`
        UPDATE transcript_segments
        SET redacted_at = coalesce(redacted_at, now()),
            updated_at = now()
        WHERE org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND capture_session_id = ${input.captureSessionId}
          AND start_ms <= ${redaction.endMs}
          AND end_ms >= ${redaction.startMs}
        RETURNING id
      `);
      const screenRows = await tx.execute<{
        id: string;
        screenshot_artifact_id: string | null;
        metadata_artifact_id: string | null;
      }>(sql`
        UPDATE screen_events
        SET redacted_at = coalesce(redacted_at, now()),
            deleted_at = coalesce(deleted_at, now()),
            updated_at = now()
        WHERE org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND capture_session_id = ${input.captureSessionId}
          AND ts_ms BETWEEN ${redaction.startMs} AND ${redaction.endMs}
        RETURNING
          id,
          screenshot_artifact_id,
          CASE
            WHEN metadata_json->>'artifact_id' ~* '^[0-9a-f-]{36}$'
            THEN metadata_json->>'artifact_id'
            ELSE NULL
          END AS metadata_artifact_id
      `);
      const transcriptIds = transcriptRows.rows.map((row) => row.id);
      const screenIds = screenRows.rows.map((row) => row.id);
      const artifactIds = uniqueStrings(
        screenRows.rows.flatMap((row) => [
          row.screenshot_artifact_id,
          row.metadata_artifact_id,
        ]),
      );
      const rawCaptureArtifactRows = (
        await tx.execute<{ id: string; storage_key: string }>(sql`
          SELECT id, storage_key
          FROM artifacts
          WHERE org_id = ${input.orgId}
            AND workspace_id = ${input.workspaceId}
            AND capture_session_id = ${input.captureSessionId}
            AND artifact_type IN ('video', 'audio')
            AND redacted_at IS NULL
        `)
      ).rows;
      const rawCaptureArtifactIds = rawCaptureArtifactRows.map((row) => row.id);
      const allArtifactIds = uniqueStrings([
        ...artifactIds,
        ...rawCaptureArtifactIds,
      ]);
      const artifactRows =
        allArtifactIds.length > 0
          ? (
              await tx.execute<{ id: string; storage_key: string }>(sql`
                SELECT id, storage_key
                FROM artifacts
                WHERE org_id = ${input.orgId}
                  AND workspace_id = ${input.workspaceId}
                  AND id = ANY(${uuidArraySql(allArtifactIds)})
              `)
            ).rows
          : [];
      if (allArtifactIds.length > 0) {
        await tx
          .update(artifacts)
          .set({ redactedAt: new Date(), status: "redacted", updatedAt: new Date() })
          .where(sql`
            org_id = ${input.orgId}
            AND id = ANY(${uuidArraySql(allArtifactIds)})
          `);
      }

      const evidenceRows = await tx.execute<{ id: string }>(sql`
        UPDATE evidence
        SET redacted_at = coalesce(redacted_at, now()),
            tombstoned_at = coalesce(tombstoned_at, now()),
            updated_at = now()
        WHERE org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND (
            (
              source_type = 'transcript_segment'
              AND ${transcriptIds.length > 0}
              AND source_id = ANY(${uuidArraySql(transcriptIds)})
            )
            OR (
              source_type = 'screen_event'
              AND ${screenIds.length > 0}
              AND source_id = ANY(${uuidArraySql(screenIds)})
            )
          )
        RETURNING id
      `);
      const evidenceIds = evidenceRows.rows.map((row) => row.id);
      if (evidenceIds.length > 0) {
        await tx.execute(sql`
          UPDATE claim_evidence
          SET redacted_at = coalesce(redacted_at, now())
          WHERE evidence_id = ANY(${uuidArraySql(evidenceIds)})
        `);
        await tx.execute(sql`
          UPDATE claims
          SET redacted_at = coalesce(redacted_at, now()),
              tombstoned_at = coalesce(tombstoned_at, now()),
              updated_at = now()
          WHERE org_id = ${input.orgId}
            AND workspace_id = ${input.workspaceId}
            AND id IN (
              SELECT claim_id
              FROM claim_evidence
              WHERE evidence_id = ANY(${uuidArraySql(evidenceIds)})
            )
        `);
        await removeRedactedEvidenceFromGraphRefs({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          processId: input.processId,
          evidenceIds,
          tx,
        });
      }

      await tx.execute(sql`
        UPDATE agent_decision_log
        SET delivery_json = coalesce(delivery_json, '{}'::jsonb) ||
          jsonb_build_object(
            'redaction_applied', true,
            'redaction_id', ${redaction.id},
            'redacted_transcript_segment_ids', ${JSON.stringify(transcriptIds)}::jsonb,
            'redacted_screen_event_ids', ${JSON.stringify(screenIds)}::jsonb
          ),
          updated_at = now()
        WHERE org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND capture_session_id = ${input.captureSessionId}
          AND (
            transcript_segment_ids && ${uuidArraySql(transcriptIds)}
            OR delivery_json->>'local_turn_correlation_id' IS NOT NULL
          )
      `);

      const affectedTraceIds = [...transcriptIds, ...screenIds, ...evidenceIds];
      const completed = (
        await tx
          .update(redactions)
          .set({
            status: "complete",
            completedAt: new Date(),
            affectedArtifactIds: allArtifactIds,
            affectedTraceIds,
            updatedAt: new Date(),
          })
          .where(eq(redactions.id, redaction.id))
          .returning()
      )[0];
      await tx.insert(auditLog).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: input.userId ?? redaction.requestedByUserId,
        eventType: "capture.operator.redaction_completed",
        subjectType: "redaction",
        subjectId: redaction.id,
        metadataJson: {
          process_id: input.processId,
          capture_session_id: input.captureSessionId,
          start_ms: redaction.startMs,
          end_ms: redaction.endMs,
          transcript_segment_ids: transcriptIds,
          screen_event_ids: screenIds,
          evidence_ids: evidenceIds,
          affected_artifact_ids: allArtifactIds,
          raw_capture_artifact_ids: rawCaptureArtifactIds,
          idempotency_key: input.idempotencyKey,
        },
      });
      return {
        ok: true as const,
        redaction: completed,
        transcript_segment_ids: transcriptIds,
        screen_event_ids: screenIds,
        evidence_ids: evidenceIds,
        affected_artifact_ids: allArtifactIds,
        raw_capture_artifact_ids: rawCaptureArtifactIds,
        affected_artifact_storage_keys: artifactRows.map((row) => row.storage_key),
      };
    });
    if (
      result.ok &&
      "affected_artifact_storage_keys" in result &&
      Array.isArray(result.affected_artifact_storage_keys)
    ) {
      await deleteRedactedArtifactObjects(input, result.affected_artifact_storage_keys);
    }
    return result;
  } catch (error) {
    await markOperatorRedactionFailed(input, error);
    throw error;
  }
}

async function deleteRedactedArtifactObjects(
  input: OperatorRedactionInput,
  storageKeys: string[],
) {
  if (storageKeys.length === 0) return;
  const attempts = await Promise.allSettled(
    storageKeys.map((key) => deleteArtifactObject({ key })),
  );
  const deletedKeys: string[] = [];
  const failed: Array<{ key: string; reason: string }> = [];
  for (const [index, attempt] of attempts.entries()) {
    const key = storageKeys[index];
    if (attempt.status === "fulfilled") {
      deletedKeys.push(key);
    } else {
      failed.push({
        key,
        reason: sanitizeForLogs(
          attempt.reason instanceof Error
            ? attempt.reason.message
            : "Unknown storage deletion error",
        ),
      });
    }
  }
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      eventType: "capture.operator.redaction_artifacts_deleted",
      subjectType: "redaction",
      subjectId: input.redactionId,
      metadataJson: {
        process_id: input.processId,
        capture_session_id: input.captureSessionId,
        deleted_storage_keys: deletedKeys,
        failed_storage_deletions: failed,
        idempotency_key: input.idempotencyKey,
      },
    });
    if (failed.length > 0) {
      await tx.insert(followUpTasks).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        processId: input.processId,
        captureSessionId: input.captureSessionId,
        taskType: "redaction_failure",
        title: "Redaction storage deletion needs review",
        description:
          "One or more redacted screen artifacts could not be deleted from storage.",
        targetType: "redaction",
        targetId: input.redactionId,
        priority: "1.0",
        status: "open",
        assignedToUserId: input.userId,
        contextJson: {
          redaction_id: input.redactionId,
          failed_storage_deletions: failed,
          idempotency_key: input.idempotencyKey,
        },
      });
    }
  });
}

async function markOperatorRedactionFailed(
  input: OperatorRedactionInput,
  error: unknown,
) {
  const message = sanitizeForLogs(
    error instanceof Error ? error.message : "Unknown redaction error",
  );
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .update(redactions)
      .set({
        status: "failed",
        failureReason: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(redactions.id, input.redactionId),
          eq(redactions.orgId, input.orgId),
        ),
      );
    await tx.insert(followUpTasks).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      taskType: "redaction_failure",
      title: "Operator capture redaction failed",
      description: message,
      targetType: "redaction",
      targetId: input.redactionId,
      priority: "1.0",
      status: "open",
      assignedToUserId: input.userId,
      contextJson: {
        redaction_id: input.redactionId,
        idempotency_key: input.idempotencyKey,
      },
    });
  });
}

async function removeRedactedEvidenceFromGraphRefs(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  evidenceIds: string[];
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
}) {
  const evidenceArray = uuidArraySql(input.evidenceIds);
  await input.tx.execute(sql`
    UPDATE process_nodes
    SET top_evidence_ids = ARRAY(
          SELECT id FROM unnest(top_evidence_ids) AS id
          WHERE NOT (id = ANY(${evidenceArray}))
        ),
        evidence_count = cardinality(ARRAY(
          SELECT id FROM unnest(top_evidence_ids) AS id
          WHERE NOT (id = ANY(${evidenceArray}))
        )),
        updated_at = now()
    WHERE org_id = ${input.orgId}
      AND workspace_id = ${input.workspaceId}
      AND process_id = ${input.processId}
      AND top_evidence_ids && ${evidenceArray}
  `);
  await input.tx.execute(sql`
    UPDATE process_edges
    SET top_evidence_ids = ARRAY(
          SELECT id FROM unnest(top_evidence_ids) AS id
          WHERE NOT (id = ANY(${evidenceArray}))
        ),
        evidence_count = cardinality(ARRAY(
          SELECT id FROM unnest(top_evidence_ids) AS id
          WHERE NOT (id = ANY(${evidenceArray}))
        )),
        updated_at = now()
    WHERE org_id = ${input.orgId}
      AND workspace_id = ${input.workspaceId}
      AND process_id = ${input.processId}
      AND top_evidence_ids && ${evidenceArray}
  `);
  for (const table of ["node_io", "node_systems"] as const) {
    await input.tx.execute(sql`
      UPDATE ${sql.raw(table)}
      SET evidence_ids = ARRAY(
            SELECT id FROM unnest(evidence_ids) AS id
            WHERE NOT (id = ANY(${evidenceArray}))
          ),
          updated_at = now()
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND evidence_ids && ${evidenceArray}
    `);
  }
  for (const table of ["exceptions", "workarounds", "variants"] as const) {
    await input.tx.execute(sql`
      UPDATE ${sql.raw(table)}
      SET top_evidence_ids = ARRAY(
            SELECT id FROM unnest(top_evidence_ids) AS id
            WHERE NOT (id = ANY(${evidenceArray}))
          ),
          evidence_count = cardinality(ARRAY(
            SELECT id FROM unnest(top_evidence_ids) AS id
            WHERE NOT (id = ANY(${evidenceArray}))
          )),
          updated_at = now()
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND process_id = ${input.processId}
        AND top_evidence_ids && ${evidenceArray}
    `);
  }

  const versionRows = await input.tx.execute<{ id: string; graph_json: unknown }>(sql`
    SELECT id, graph_json
    FROM process_versions
    WHERE org_id = ${input.orgId}
      AND workspace_id = ${input.workspaceId}
      AND process_id = ${input.processId}
      AND graph_json IS NOT NULL
  `);
  for (const row of versionRows.rows) {
    const redactedGraph = stripEvidenceIdsFromJson(row.graph_json, new Set(input.evidenceIds));
    await input.tx.execute(sql`
      UPDATE process_versions
      SET graph_json = ${JSON.stringify(redactedGraph)}::jsonb,
          updated_at = now()
      WHERE id = ${row.id}
    `);
  }
}

function stripEvidenceIdsFromJson(value: unknown, redactedEvidenceIds: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== "string" || !redactedEvidenceIds.has(item))
      .map((item) => stripEvidenceIdsFromJson(item, redactedEvidenceIds));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "evidence_ids" && Array.isArray(child)
        ? child.filter((item) => typeof item !== "string" || !redactedEvidenceIds.has(item))
        : stripEvidenceIdsFromJson(child, redactedEvidenceIds),
    ]),
  );
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
