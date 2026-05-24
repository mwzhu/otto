import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import type { ProcessSummary } from "@/lib/types";

export type OverviewMetrics = {
  processCount: number;
  documentationCoverage: number;
  averageComplexity: number;
  spofCount: number;
  hasCaptures: boolean;
  hasProcessingCaptures: boolean;
  hasPartialSynthesis: boolean;
};

type CardRow = {
  id: string;
  source: "process" | "candidate";
  name: string;
  function_name: string | null;
  description: string | null;
  status: string;
  frequency: string | null;
  system_names: string[] | null;
  people_count: number;
  evidence_count: number;
  complexity_score: number | null;
  recommended_reason: string | null;
  narrative_summary: string | null;
};

export async function getOverviewMetrics(orgId: string, workspaceId: string): Promise<OverviewMetrics> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<{
      process_count: number;
      documented_count: number;
      average_complexity: number | null;
      spof_count: number;
      capture_count: number;
      processing_count: number;
      partial_count: number;
    }>(sql`
      WITH inventory AS (
        SELECT id, 'process' AS source
        FROM processes
        WHERE org_id = ${orgId}
          AND workspace_id = ${workspaceId}
          AND status IN ('draft', 'approved')
        UNION ALL
        SELECT id, 'candidate' AS source
        FROM candidate_processes
        WHERE org_id = ${orgId}
          AND workspace_id = ${workspaceId}
          AND status = 'pending'
      ),
      complexity AS (
        SELECT
          subject_id,
          CASE
            WHEN jsonb_typeof(value) = 'object' THEN COALESCE((value->>'total')::numeric, 0)
            WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric
            ELSE 0
          END AS score
        FROM claims
        WHERE org_id = ${orgId}
          AND workspace_id = ${workspaceId}
          AND field = 'complexity_score'
          AND status = 'active'
          AND superseded_by_claim_id IS NULL
      )
      SELECT
        (SELECT count(*)::int FROM inventory) AS process_count,
        (
          SELECT count(DISTINCT i.id)::int
          FROM inventory i
          LEFT JOIN candidate_processes cp ON cp.id = i.id AND i.source = 'candidate'
          LEFT JOIN claims pc
            ON pc.subject_type = 'process'
           AND pc.subject_id = i.id
           AND i.source = 'process'
           AND pc.status = 'active'
           AND pc.superseded_by_claim_id IS NULL
          LEFT JOIN claim_evidence pce ON pce.claim_id = pc.id
          LEFT JOIN evidence pe ON pe.id = pce.evidence_id
          LEFT JOIN evidence e ON e.id = ANY(cp.evidence_ids)
          WHERE e.evidence_label = 'documented'
             OR pe.evidence_label = 'documented'
        ) AS documented_count,
        (SELECT avg(score)::float FROM complexity) AS average_complexity,
        (
          SELECT count(*)::int
          FROM claims
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND field = 'risk'
            AND status = 'active'
            AND superseded_by_claim_id IS NULL
            AND value::text ILIKE '%single_point_of_failure%'
        ) AS spof_count,
        (
          SELECT count(*)::int
          FROM capture_sessions
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
        ) AS capture_count,
        (
          SELECT count(*)::int
          FROM artifacts
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND status IN ('uploaded', 'processing')
        ) AS processing_count,
        (
          SELECT count(*)::int
          FROM synthesis_runs
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND status IN ('partial_synthesis', 'failed')
        ) AS partial_count
    `);
  });
  const row = result.rows[0];
  const count = Number(row?.process_count ?? 0);
  const documented = Number(row?.documented_count ?? 0);
  return {
    processCount: count,
    documentationCoverage: count === 0 ? 0 : Math.round((documented / count) * 100),
    averageComplexity: Math.round(Number(row?.average_complexity ?? 0)),
    spofCount: Number(row?.spof_count ?? 0),
    hasCaptures: Number(row?.capture_count ?? 0) > 0,
    hasProcessingCaptures: Number(row?.processing_count ?? 0) > 0,
    hasPartialSynthesis: Number(row?.partial_count ?? 0) > 0,
  };
}

export async function getProcessCards(orgId: string, workspaceId: string): Promise<ProcessSummary[]> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<CardRow>(sql`
      WITH candidate_cards AS (
        SELECT
          cp.id,
          'candidate' AS source,
          cp.proposed_name AS name,
          cp.proposed_function AS function_name,
          COALESCE(cp.complexity_hint, cp.proposed_function, 'Candidate process from intake evidence.') AS description,
          cp.status::text AS status,
          cp.frequency,
          COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS system_names,
          GREATEST(
            count(DISTINCT r.id),
            count(DISTINCT person_claim.subject_id),
            count(DISTINCT role_claim.subject_id)
          )::int AS people_count,
          count(DISTINCT e.id)::int AS evidence_count,
          MAX(
            CASE
              WHEN cscore.id IS NOT NULL AND jsonb_typeof(cscore.value) = 'object' THEN (cscore.value->>'total')::numeric
              ELSE NULL
            END
          )::float AS complexity_score,
          MAX(narrative.value->>'recommendedDrilldownReason') AS recommended_reason,
          MAX(narrative.value->>'summaryParagraph') AS narrative_summary
        FROM candidate_processes cp
        LEFT JOIN claims system_claim
          ON system_claim.org_id = cp.org_id
         AND system_claim.workspace_id = cp.workspace_id
         AND system_claim.field = 'used_in_process'
         AND system_claim.status = 'active'
         AND system_claim.superseded_by_claim_id IS NULL
         AND system_claim.value->>'candidate_process_id' = cp.id::text
        LEFT JOIN systems s ON s.id = system_claim.subject_id AND system_claim.subject_type = 'system'
        LEFT JOIN roles r ON r.id = cp.proposed_owner_role_id
        LEFT JOIN claims person_claim
          ON person_claim.org_id = cp.org_id
         AND person_claim.workspace_id = cp.workspace_id
         AND person_claim.subject_type = 'person'
         AND person_claim.field = 'role'
         AND person_claim.status = 'active'
         AND person_claim.superseded_by_claim_id IS NULL
        LEFT JOIN claims role_claim
          ON role_claim.org_id = cp.org_id
         AND role_claim.workspace_id = cp.workspace_id
         AND role_claim.subject_type = 'role'
         AND role_claim.field = 'used_in_process'
         AND role_claim.status = 'active'
         AND role_claim.superseded_by_claim_id IS NULL
         AND role_claim.value->>'candidate_process_id' = cp.id::text
        LEFT JOIN evidence e ON e.id = ANY(cp.evidence_ids)
        LEFT JOIN claims cscore
          ON cscore.subject_type = 'candidate_process'
         AND cscore.subject_id = cp.id
         AND cscore.field = 'complexity_score'
         AND cscore.status = 'active'
         AND cscore.superseded_by_claim_id IS NULL
        LEFT JOIN claims narrative
          ON narrative.subject_type = 'candidate_process'
         AND narrative.subject_id = cp.id
         AND narrative.field = 'narrative'
         AND narrative.status = 'active'
         AND narrative.superseded_by_claim_id IS NULL
        WHERE cp.org_id = ${orgId}
          AND cp.workspace_id = ${workspaceId}
          AND cp.status = 'pending'
        GROUP BY cp.id
      ),
      process_cards AS (
        SELECT
          p.id,
          'process' AS source,
          p.name,
          COALESCE(r.name, 'Captured process') AS function_name,
          COALESCE(p.description, pv.summary, 'Promoted process draft from Phase 1 intake.') AS description,
          p.status::text AS status,
          MAX(freq.value #>> '{}') AS frequency,
          COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS system_names,
          (count(DISTINCT pr.role_id) + count(DISTINCT pp.person_id))::int AS people_count,
          count(DISTINCT ce.evidence_id)::int AS evidence_count,
          MAX(
            CASE
              WHEN cscore.id IS NOT NULL AND jsonb_typeof(cscore.value) = 'object' THEN (cscore.value->>'total')::numeric
              ELSE NULL
            END
          )::float AS complexity_score,
          MAX(narrative.value->>'recommendedDrilldownReason') AS recommended_reason,
          MAX(narrative.value->>'summaryParagraph') AS narrative_summary
        FROM processes p
        LEFT JOIN process_versions pv ON pv.id = p.current_draft_version_id
        LEFT JOIN roles r ON r.id = p.owner_role_id
        LEFT JOIN process_systems ps ON ps.process_id = p.id
        LEFT JOIN systems s ON s.id = ps.system_id
        LEFT JOIN process_roles pr ON pr.process_id = p.id
        LEFT JOIN process_people pp ON pp.process_id = p.id
        LEFT JOIN claims freq
          ON freq.subject_type = 'process'
         AND freq.subject_id = p.id
         AND freq.field = 'frequency'
         AND freq.status = 'active'
         AND freq.superseded_by_claim_id IS NULL
        LEFT JOIN claims cscore
          ON cscore.subject_type = 'process'
         AND cscore.subject_id = p.id
         AND cscore.field = 'complexity_score'
         AND cscore.status = 'active'
         AND cscore.superseded_by_claim_id IS NULL
        LEFT JOIN claims narrative
          ON narrative.subject_type = 'process'
         AND narrative.subject_id = p.id
         AND narrative.field = 'narrative'
         AND narrative.status = 'active'
         AND narrative.superseded_by_claim_id IS NULL
        LEFT JOIN claims evidence_claim
          ON evidence_claim.subject_type = 'process'
         AND evidence_claim.subject_id = p.id
         AND evidence_claim.status = 'active'
         AND evidence_claim.superseded_by_claim_id IS NULL
        LEFT JOIN claim_evidence ce ON ce.claim_id = evidence_claim.id
        WHERE p.org_id = ${orgId}
          AND p.workspace_id = ${workspaceId}
          AND p.status IN ('draft', 'approved')
        GROUP BY p.id, pv.id, r.id
      )
      SELECT * FROM candidate_cards
      UNION ALL
      SELECT * FROM process_cards
      ORDER BY complexity_score DESC NULLS LAST, name ASC
    `);
  });

  return result.rows.map(toProcessSummary);
}

export async function getDrilldownRecommendations(orgId: string, workspaceId: string) {
  const cards = await getProcessCards(orgId, workspaceId);
  return cards.filter((card) => card.recommended).slice(0, 3);
}

function toProcessSummary(row: CardRow): ProcessSummary {
  const score = Math.round(Number(row.complexity_score ?? 0));
  return {
    id: row.id,
    source: row.source,
    href: row.source === "process" ? `/process/${row.id}` : undefined,
    name: row.name,
    function: row.function_name ?? "Captured process",
    department: row.function_name ?? "Commercial Department",
    status: row.source === "process" ? "documented" : "in_progress",
    complexity: score >= 65 ? "high" : score >= 35 ? "med" : "low",
    complexity_score: score,
    doc_coverage: row.evidence_count > 0 ? 1 : 0,
    description:
      row.narrative_summary ??
      row.description ??
      "Intake evidence is still being synthesized.",
    people_count: Number(row.people_count ?? 0),
    systems: row.system_names ?? [],
    frequency: row.frequency ?? "Unknown",
    evidence_count: Number(row.evidence_count ?? 0),
    recommended: score >= 55 || Boolean(row.recommended_reason),
    recommended_reason: row.recommended_reason ?? undefined,
  };
}
