import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { ApiError } from "@/lib/http/json";

export type CandidateMutationContext = {
  orgId: string;
  workspaceId: string;
  userId: string;
  idempotencyKey?: string;
};

export async function promoteCandidateProcess(
  context: CandidateMutationContext,
  candidateProcessId: string,
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const result = await tx.execute<{
      process_id: string;
      process_version_id: string;
      candidate_process_id: string;
    }>(sql`
      WITH candidate AS (
        SELECT *
        FROM candidate_processes
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND id = ${candidateProcessId}
        FOR UPDATE
      ),
      guard AS (
        SELECT *
        FROM candidate
        WHERE status = 'pending'
      ),
      owner_role AS (
        INSERT INTO roles (org_id, name, canonical_key)
        SELECT
          ${context.orgId},
          COALESCE(NULLIF(proposed_function, ''), 'Process owner'),
          regexp_replace(lower(COALESCE(NULLIF(proposed_function, ''), 'Process owner')), '[^a-z0-9]+', '_', 'g')
        FROM guard
        WHERE proposed_owner_role_id IS NULL
        ON CONFLICT DO NOTHING
        RETURNING id
      ),
      resolved_owner AS (
        SELECT
          COALESCE(
            guard.proposed_owner_role_id,
            (SELECT id FROM owner_role LIMIT 1),
            (
              SELECT id FROM roles
              WHERE org_id = ${context.orgId}
                AND lower(name) = lower(COALESCE(NULLIF(guard.proposed_function, ''), 'Process owner'))
              LIMIT 1
            )
          ) AS role_id
        FROM guard
      ),
      inserted_process AS (
        INSERT INTO processes (
          org_id,
          workspace_id,
          name,
          description,
          status,
          owner_role_id
        )
        SELECT
          org_id,
          workspace_id,
          proposed_name,
          COALESCE(complexity_hint, proposed_function, 'Promoted from Phase 1 intake evidence.'),
          'draft'::process_status,
          (SELECT role_id FROM resolved_owner)
        FROM guard
        RETURNING *
      ),
      inserted_version AS (
        INSERT INTO process_versions (
          org_id,
          workspace_id,
          process_id,
          version_number,
          status,
          summary,
          graph_json
        )
        SELECT
          p.org_id,
          p.workspace_id,
          p.id,
          1,
          'draft'::process_version_status,
          p.description,
          jsonb_build_object('source', 'phase1_candidate_promotion', 'candidate_process_id', ${candidateProcessId}::uuid)
        FROM inserted_process p
        RETURNING *
      ),
      update_process AS (
        UPDATE processes p
        SET current_draft_version_id = v.id,
            updated_at = now()
        FROM inserted_version v
        WHERE p.id = v.process_id
        RETURNING p.id
      ),
      link_capture AS (
        INSERT INTO capture_process_links (
          org_id,
          workspace_id,
          capture_session_id,
          process_id,
          link_type,
          confidence
        )
        SELECT
          c.org_id,
          c.workspace_id,
          c.capture_session_id,
          p.id,
          'created'::capture_link_type,
          c.confidence
        FROM guard c
        CROSS JOIN inserted_process p
        ON CONFLICT DO NOTHING
      ),
      process_claims AS (
        INSERT INTO claims (
          org_id,
          workspace_id,
          subject_type,
          subject_id,
          field,
          value,
          confidence,
          metadata_json
        )
        SELECT
          cc.org_id,
          cc.workspace_id,
          'process',
          p.id,
          cc.field,
          cc.value,
          cc.confidence,
          cc.metadata_json || jsonb_build_object(
            'copied_from_candidate_process_id', cc.subject_id,
            'copied_from_candidate_claim_id', cc.id
          )
        FROM claims cc
        CROSS JOIN inserted_process p
        WHERE cc.org_id = ${context.orgId}
          AND cc.workspace_id = ${context.workspaceId}
          AND cc.subject_type = 'candidate_process'
          AND cc.subject_id = ${candidateProcessId}
          AND cc.status = 'active'
          AND cc.superseded_by_claim_id IS NULL
        RETURNING id, field, (metadata_json->>'copied_from_candidate_claim_id')::uuid AS source_claim_id
      ),
      column_claims AS (
        INSERT INTO claims (
          org_id,
          workspace_id,
          subject_type,
          subject_id,
          field,
          value,
          confidence,
          metadata_json
        )
        SELECT
          g.org_id,
          g.workspace_id,
          'process',
          p.id,
          column_values.field,
          to_jsonb(column_values.value),
          COALESCE(g.confidence, 0.72),
          jsonb_build_object('source', 'candidate_column', 'copied_from_candidate_process_id', g.id)
        FROM guard g
        CROSS JOIN inserted_process p
        CROSS JOIN LATERAL (
          VALUES
            ('frequency', g.frequency),
            ('complexity_hint', g.complexity_hint)
        ) AS column_values(field, value)
        WHERE column_values.value IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM claims cc
            WHERE cc.org_id = ${context.orgId}
              AND cc.workspace_id = ${context.workspaceId}
              AND cc.subject_type = 'candidate_process'
              AND cc.subject_id = ${candidateProcessId}
              AND cc.field = column_values.field
              AND cc.status = 'active'
              AND cc.superseded_by_claim_id IS NULL
          )
        RETURNING id, field
      ),
      projected_systems AS (
        INSERT INTO process_systems (
          org_id,
          workspace_id,
          process_id,
          system_id,
          evidence_ids
        )
        SELECT
          ${context.orgId},
          ${context.workspaceId},
          p.id,
          sc.subject_id,
          COALESCE(array_agg(DISTINCT ce.evidence_id) FILTER (WHERE ce.evidence_id IS NOT NULL), '{}')
        FROM inserted_process p
        JOIN claims sc
          ON sc.org_id = ${context.orgId}
         AND sc.workspace_id = ${context.workspaceId}
         AND sc.subject_type = 'system'
         AND sc.field = 'used_in_process'
         AND sc.status = 'active'
         AND sc.superseded_by_claim_id IS NULL
         AND sc.value->>'candidate_process_id' = ${candidateProcessId}
        LEFT JOIN claim_evidence ce ON ce.claim_id = sc.id
        GROUP BY p.id, sc.subject_id
        ON CONFLICT (process_id, system_id)
        DO UPDATE SET evidence_ids = excluded.evidence_ids, updated_at = now()
      ),
      person_role_claims AS (
        SELECT
          pc.subject_id AS person_id,
          r.id AS role_id,
          COALESCE(array_agg(DISTINCT ce.evidence_id) FILTER (WHERE ce.evidence_id IS NOT NULL), '{}') AS evidence_ids
        FROM guard g
        JOIN claims pc
          ON pc.org_id = ${context.orgId}
         AND pc.workspace_id = ${context.workspaceId}
         AND pc.subject_type = 'person'
         AND pc.field = 'role'
         AND pc.status = 'active'
         AND pc.superseded_by_claim_id IS NULL
        JOIN claim_evidence ce
          ON ce.claim_id = pc.id
         AND ce.evidence_id = ANY(g.evidence_ids)
        LEFT JOIN roles r
          ON r.org_id = ${context.orgId}
         AND (
           r.id::text = pc.metadata_json->>'role_id'
           OR lower(r.name) = lower(pc.value #>> '{}')
         )
        WHERE r.id IS NOT NULL
        GROUP BY pc.subject_id, r.id
      ),
      projected_roles AS (
        INSERT INTO process_roles (
          org_id,
          workspace_id,
          process_id,
          role_id,
          evidence_ids
        )
        SELECT ${context.orgId}, ${context.workspaceId}, p.id, role_rows.role_id, role_rows.evidence_ids
        FROM inserted_process p
        CROSS JOIN guard g
        CROSS JOIN LATERAL (
          SELECT
            source_roles.role_id,
            COALESCE(array_agg(DISTINCT source_roles.evidence_id) FILTER (WHERE source_roles.evidence_id IS NOT NULL), '{}') AS evidence_ids
          FROM (
            SELECT ro.role_id, owner_evidence.evidence_id
            FROM resolved_owner ro
            LEFT JOIN unnest(g.evidence_ids) AS owner_evidence(evidence_id) ON true
            WHERE ro.role_id IS NOT NULL
            UNION ALL
            SELECT prc.role_id, person_evidence.evidence_id
            FROM person_role_claims prc
            LEFT JOIN unnest(prc.evidence_ids) AS person_evidence(evidence_id) ON true
          ) source_roles
          WHERE source_roles.role_id IS NOT NULL
          GROUP BY source_roles.role_id
        ) AS role_rows
        ON CONFLICT (process_id, role_id)
        DO UPDATE SET evidence_ids = excluded.evidence_ids, updated_at = now()
      ),
      projected_people AS (
        INSERT INTO process_people (
          org_id,
          workspace_id,
          process_id,
          person_id,
          evidence_ids
        )
        SELECT
          ${context.orgId},
          ${context.workspaceId},
          p.id,
          prc.person_id,
          prc.evidence_ids
        FROM inserted_process p
        JOIN person_role_claims prc ON true
        ON CONFLICT (process_id, person_id)
        DO UPDATE SET evidence_ids = excluded.evidence_ids, updated_at = now()
      ),
      update_candidate AS (
        UPDATE candidate_processes c
        SET status = 'promoted',
            promoted_process_id = (SELECT id FROM inserted_process),
            updated_at = now()
        WHERE c.id = ${candidateProcessId}
        RETURNING c.id
      ),
      audit AS (
        INSERT INTO audit_log (
          org_id,
          workspace_id,
          user_id,
          event_type,
          subject_type,
          subject_id,
          metadata_json
        )
        SELECT
          ${context.orgId},
          ${context.workspaceId},
          ${context.userId},
          'candidate_process.promoted',
          'candidate_process',
          ${candidateProcessId},
          jsonb_build_object(
            'process_id', p.id,
            'idempotency_key', ${context.idempotencyKey ?? null}::text
          )
        FROM inserted_process p
      )
      SELECT
        p.id AS process_id,
        v.id AS process_version_id,
        ${candidateProcessId} AS candidate_process_id
      FROM inserted_process p
      JOIN inserted_version v ON v.process_id = p.id
    `);
    const promoted = result.rows[0];
    if (!promoted) {
      const existing = await tx.execute<{ promoted_process_id: string | null; status: string }>(sql`
        SELECT promoted_process_id, status
        FROM candidate_processes
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND id = ${candidateProcessId}
        LIMIT 1
      `);
      const row = existing.rows[0];
      if (row?.status === "promoted" && row.promoted_process_id) {
        return {
          candidate_process_id: candidateProcessId,
          process_id: row.promoted_process_id,
          already_promoted: true,
        };
      }
      if (row) {
        throw new ApiError(
          409,
          "conflict",
          `Candidate process is ${row.status}; only pending candidates can be promoted.`,
        );
      }
      throw new ApiError(404, "not_found", "Candidate process not found.");
    }
    await tx.execute(sql`
      INSERT INTO claim_evidence (claim_id, evidence_id)
      SELECT process_claim.id, candidate_evidence.evidence_id
      FROM claims process_claim
      JOIN claim_evidence candidate_evidence
        ON candidate_evidence.claim_id = (process_claim.metadata_json->>'copied_from_candidate_claim_id')::uuid
      WHERE process_claim.org_id = ${context.orgId}
        AND process_claim.workspace_id = ${context.workspaceId}
        AND process_claim.subject_type = 'process'
        AND process_claim.subject_id = ${promoted.process_id}
        AND process_claim.metadata_json ? 'copied_from_candidate_claim_id'
      ON CONFLICT DO NOTHING
    `);
    // Candidate columns do not have source claim rows, so their process claims
    // inherit the candidate's coarse evidence bundle instead of a 1:1 claim copy.
    await tx.execute(sql`
      INSERT INTO claim_evidence (claim_id, evidence_id)
      SELECT process_claim.id, candidate_evidence.evidence_id
      FROM claims process_claim
      JOIN candidate_processes candidate
        ON candidate.id = ${candidateProcessId}
       AND candidate.org_id = ${context.orgId}
       AND candidate.workspace_id = ${context.workspaceId}
      CROSS JOIN unnest(candidate.evidence_ids) AS candidate_evidence(evidence_id)
      WHERE process_claim.org_id = ${context.orgId}
        AND process_claim.workspace_id = ${context.workspaceId}
        AND process_claim.subject_type = 'process'
        AND process_claim.subject_id = ${promoted.process_id}
        AND process_claim.metadata_json->>'source' = 'candidate_column'
      ON CONFLICT DO NOTHING
    `);
    return promoted;
  });
}

export async function discardCandidateProcess(
  context: CandidateMutationContext,
  candidateProcessId: string,
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE candidate_processes
      SET status = 'discarded',
          updated_at = now()
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND id = ${candidateProcessId}
        AND status = 'pending'
      RETURNING id
    `);
    if (!result.rows[0]) {
      await throwCandidateStateError(context, candidateProcessId, "discarded");
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
        ${context.orgId},
        ${context.workspaceId},
        ${context.userId},
        'candidate_process.discarded',
        'candidate_process',
        ${candidateProcessId},
        ${JSON.stringify({ idempotency_key: context.idempotencyKey })}::jsonb
      )
    `);
    return { candidate_process_id: candidateProcessId, status: "discarded" };
  });
}

export async function mergeCandidateProcess(
  context: CandidateMutationContext,
  candidateProcessId: string,
  targetProcessId: string,
) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    const target = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM processes
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND id = ${targetProcessId}
        AND status IN ('draft', 'approved')
      LIMIT 1
    `);
    if (!target.rows[0]) {
      throw new ApiError(404, "not_found", "Target process not found.");
    }
    const result = await tx.execute<{ id: string; capture_session_id: string }>(sql`
      UPDATE candidate_processes
      SET status = 'merged',
          promoted_process_id = ${targetProcessId},
          updated_at = now()
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND id = ${candidateProcessId}
        AND status = 'pending'
      RETURNING id, capture_session_id
    `);
    const row = result.rows[0];
    if (!row) {
      await throwCandidateStateError(context, candidateProcessId, "merged");
    }
    await tx.execute(sql`
      INSERT INTO capture_process_links (
        org_id,
        workspace_id,
        capture_session_id,
        process_id,
        link_type,
        confidence
      )
      VALUES (
        ${context.orgId},
        ${context.workspaceId},
        ${row.capture_session_id},
        ${targetProcessId},
        'enriched',
        0.72
      )
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO claims (
        org_id,
        workspace_id,
        subject_type,
        subject_id,
        field,
        value,
        confidence,
        metadata_json
      )
      SELECT
        cc.org_id,
        cc.workspace_id,
        'process',
        ${targetProcessId},
        cc.field,
        cc.value,
        cc.confidence,
        cc.metadata_json || jsonb_build_object(
          'source', 'candidate_process_merge',
          'copied_from_candidate_process_id', cc.subject_id,
          'copied_from_candidate_claim_id', cc.id
        )
      FROM claims cc
      WHERE cc.org_id = ${context.orgId}
        AND cc.workspace_id = ${context.workspaceId}
        AND cc.subject_type = 'candidate_process'
        AND cc.subject_id = ${candidateProcessId}
        AND cc.status = 'active'
        AND cc.superseded_by_claim_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM claims existing
          WHERE existing.org_id = ${context.orgId}
            AND existing.workspace_id = ${context.workspaceId}
            AND existing.subject_type = 'process'
            AND existing.subject_id = ${targetProcessId}
            AND existing.field = cc.field
            AND existing.status = 'active'
            AND existing.superseded_by_claim_id IS NULL
        )
    `);
    await tx.execute(sql`
      INSERT INTO claim_evidence (claim_id, evidence_id)
      SELECT process_claim.id, candidate_evidence.evidence_id
      FROM claims process_claim
      JOIN claim_evidence candidate_evidence
        ON candidate_evidence.claim_id = (process_claim.metadata_json->>'copied_from_candidate_claim_id')::uuid
      WHERE process_claim.org_id = ${context.orgId}
        AND process_claim.workspace_id = ${context.workspaceId}
        AND process_claim.subject_type = 'process'
        AND process_claim.subject_id = ${targetProcessId}
        AND process_claim.metadata_json->>'source' = 'candidate_process_merge'
        AND process_claim.metadata_json ? 'copied_from_candidate_claim_id'
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO claim_evidence (claim_id, evidence_id)
      SELECT existing.id, candidate_evidence.evidence_id
      FROM claims candidate_claim
      JOIN claim_evidence candidate_evidence
        ON candidate_evidence.claim_id = candidate_claim.id
      JOIN claims existing
        ON existing.org_id = ${context.orgId}
       AND existing.workspace_id = ${context.workspaceId}
       AND existing.subject_type = 'process'
       AND existing.subject_id = ${targetProcessId}
       AND existing.field = candidate_claim.field
       AND existing.status = 'active'
       AND existing.superseded_by_claim_id IS NULL
      WHERE candidate_claim.org_id = ${context.orgId}
        AND candidate_claim.workspace_id = ${context.workspaceId}
        AND candidate_claim.subject_type = 'candidate_process'
        AND candidate_claim.subject_id = ${candidateProcessId}
        AND candidate_claim.status = 'active'
        AND candidate_claim.superseded_by_claim_id IS NULL
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      WITH candidate AS (
        SELECT *
        FROM candidate_processes
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND id = ${candidateProcessId}
      ),
      column_values AS (
        SELECT
          candidate.id,
          candidate.evidence_ids,
          column_rows.field,
          column_rows.value
        FROM candidate
        CROSS JOIN LATERAL (
          VALUES
            ('frequency', candidate.frequency),
            ('complexity_hint', candidate.complexity_hint)
        ) AS column_rows(field, value)
        WHERE column_rows.value IS NOT NULL
      )
      INSERT INTO claims (
        org_id,
        workspace_id,
        subject_type,
        subject_id,
        field,
        value,
        confidence,
        metadata_json
      )
      SELECT
        ${context.orgId},
        ${context.workspaceId},
        'process',
        ${targetProcessId},
        column_values.field,
        to_jsonb(column_values.value),
        0.72,
        jsonb_build_object(
          'source', 'candidate_process_merge_column',
          'copied_from_candidate_process_id', column_values.id
        )
      FROM column_values
      WHERE NOT EXISTS (
        SELECT 1
        FROM claims existing
        WHERE existing.org_id = ${context.orgId}
          AND existing.workspace_id = ${context.workspaceId}
          AND existing.subject_type = 'process'
          AND existing.subject_id = ${targetProcessId}
          AND existing.field = column_values.field
          AND existing.status = 'active'
          AND existing.superseded_by_claim_id IS NULL
      )
    `);
    await tx.execute(sql`
      WITH candidate AS (
        SELECT *
        FROM candidate_processes
        WHERE org_id = ${context.orgId}
          AND workspace_id = ${context.workspaceId}
          AND id = ${candidateProcessId}
      ),
      column_values AS (
        SELECT
          candidate.evidence_ids,
          column_rows.field
        FROM candidate
        CROSS JOIN LATERAL (
          VALUES
            ('frequency', candidate.frequency),
            ('complexity_hint', candidate.complexity_hint)
        ) AS column_rows(field, value)
        WHERE column_rows.value IS NOT NULL
      )
      INSERT INTO claim_evidence (claim_id, evidence_id)
      SELECT target_claim.id, candidate_evidence.evidence_id
      FROM column_values
      JOIN claims target_claim
        ON target_claim.org_id = ${context.orgId}
       AND target_claim.workspace_id = ${context.workspaceId}
       AND target_claim.subject_type = 'process'
       AND target_claim.subject_id = ${targetProcessId}
       AND target_claim.field = column_values.field
       AND target_claim.status = 'active'
       AND target_claim.superseded_by_claim_id IS NULL
      CROSS JOIN unnest(column_values.evidence_ids) AS candidate_evidence(evidence_id)
      ON CONFLICT DO NOTHING
    `);
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
        ${context.orgId},
        ${context.workspaceId},
        ${context.userId},
        'candidate_process.merged',
        'candidate_process',
        ${candidateProcessId},
        ${JSON.stringify({ target_process_id: targetProcessId, idempotency_key: context.idempotencyKey })}::jsonb
      )
    `);
    return {
      candidate_process_id: candidateProcessId,
      target_process_id: targetProcessId,
      status: "merged",
    };
  });
}

async function throwCandidateStateError(
  context: CandidateMutationContext,
  candidateProcessId: string,
  action: string,
): Promise<never> {
  const existing = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, context.orgId);
    return tx.execute<{ status: string }>(sql`
      SELECT status
      FROM candidate_processes
      WHERE org_id = ${context.orgId}
        AND workspace_id = ${context.workspaceId}
        AND id = ${candidateProcessId}
      LIMIT 1
    `);
  });
  const row = existing.rows[0];
  if (row) {
    throw new ApiError(
      409,
      "conflict",
      `Candidate process is ${row.status}; only pending candidates can be ${action}.`,
    );
  }
  throw new ApiError(404, "not_found", "Candidate process not found.");
}
