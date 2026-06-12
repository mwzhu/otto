import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { genericCandidateProcessNames } from "@/lib/candidate-processes/name-quality";
import {
  directorCoreCoverageSlotPaths,
  directorSlotLabel,
} from "@/lib/interview/director/slot-schema";
import type { ProcessSummary } from "@/lib/types";

function junkCandidateNamesSql() {
  return sql`(${sql.join(
    genericCandidateProcessNames.map((name) => sql`${name}`),
    sql`, `,
  )})`;
}

function coreCoverageSlotPathsSql() {
  return sql`(${sql.join(
    directorCoreCoverageSlotPaths.map((path) => sql`${path}`),
    sql`, `,
  )})`;
}

/**
 * G1: per-candidate capture coverage — weighted fill of the seven core
 * director slots (filled/asked_unknown = 1, partial = 0.5). Promoted
 * processes inherit their source candidate's coverage via
 * candidate_processes.promoted_process_id.
 */
function coreSlotCoverageCte(orgId: string, workspaceId: string) {
  return sql`
    core_slot_coverage AS (
      SELECT
        ss.candidate_process_id AS candidate_id,
        LEAST(1.0, sum(
          CASE ss.status
            WHEN 'filled' THEN 1.0
            WHEN 'asked_unknown' THEN 1.0
            WHEN 'partial' THEN 0.5
            ELSE 0
          END
        ) / ${sql.raw(`${directorCoreCoverageSlotPaths.length}.0`)}) AS coverage,
        COALESCE(
          array_agg(ss.slot_path) FILTER (
            WHERE ss.status IN ('filled', 'asked_unknown', 'partial', 'conflicting')
          ),
          '{}'
        ) AS covered_paths
      FROM slot_states ss
      WHERE ss.org_id = ${orgId}
        AND ss.workspace_id = ${workspaceId}
        AND ss.candidate_process_id IS NOT NULL
        AND ss.slot_path IN ${coreCoverageSlotPathsSql()}
      GROUP BY ss.candidate_process_id
    )
  `;
}

/** Coverage below this fraction means "not enough info to score" (G3). */
export const COMPLEXITY_COVERAGE_GATE = 0.4;

export type OverviewMetrics = {
  processCount: number;
  documentationCoverage: number;
  averageComplexity: number;
  /** Processes with enough capture coverage to carry a complexity score. */
  scoredProcessCount: number;
  spofCount: number;
  hasCaptures: boolean;
  hasProcessingCaptures: boolean;
  hasPartialSynthesis: boolean;
};

export type OverviewQueryOptions = {
  captureSessionId?: string | null;
};

type CardRow = {
  id: string;
  source: "process" | "candidate";
  name: string;
  function_name: string | null;
  description: string | null;
  status: string;
  frequency: string | null;
  coverage: number | null;
  covered_slot_paths: string[] | null;
  system_names: string[] | null;
  people_count: number;
  evidence_count: number;
  documented_evidence_count: number;
  complexity_score: number | null;
  recommended_reason: string | null;
  narrative_summary: string | null;
};

export async function getOverviewMetrics(
  orgId: string,
  workspaceId: string,
  options: OverviewQueryOptions = {},
): Promise<OverviewMetrics> {
  const captureSessionId = options.captureSessionId ?? null;
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<{
      process_count: number;
      average_coverage: number | null;
      scored_process_count: number;
      average_complexity: number | null;
      spof_count: number;
      capture_count: number;
      processing_count: number;
      partial_count: number;
    }>(sql`
      WITH inventory AS (
        SELECT id, 'process' AS source
        FROM processes p
        WHERE org_id = ${orgId}
          AND workspace_id = ${workspaceId}
          AND status IN ('draft', 'approved')
          ${
            captureSessionId
              ? // Match getProcessCards: count processes promoted from / linked
                // to this session so the metric tracks the visible cards.
                sql`AND EXISTS (
                  SELECT 1 FROM capture_process_links cpl
                  WHERE cpl.process_id = p.id
                    AND cpl.org_id = p.org_id
                    AND cpl.workspace_id = p.workspace_id
                    AND cpl.capture_session_id = ${captureSessionId}
                )`
              : sql``
          }
        UNION ALL
        SELECT id, 'candidate' AS source
        FROM candidate_processes
        WHERE org_id = ${orgId}
          AND workspace_id = ${workspaceId}
          AND status = 'pending'
          AND lower(proposed_name) NOT IN ${junkCandidateNamesSql()}
          ${captureSessionId ? sql`AND capture_session_id = ${captureSessionId}` : sql``}
      ),
      ${coreSlotCoverageCte(orgId, workspaceId)},
      inventory_coverage AS (
        -- Candidates use their own slot coverage; promoted processes inherit
        -- from their best source candidate. LATERAL ... LIMIT 1 guarantees one
        -- row per inventory member even when several candidates were promoted
        -- or merged into the same process.
        SELECT
          i.id,
          COALESCE(own.coverage, promoted.coverage, 0)::float AS coverage
        FROM inventory i
        LEFT JOIN core_slot_coverage own ON own.candidate_id = i.id
        LEFT JOIN LATERAL (
          SELECT cov.coverage
          FROM candidate_processes source_cp
          JOIN core_slot_coverage cov ON cov.candidate_id = source_cp.id
          WHERE source_cp.promoted_process_id = i.id
          ORDER BY cov.coverage DESC
          LIMIT 1
        ) promoted ON true
      ),
      complexity AS (
        -- Scoped to the inventory above AND gated on capture coverage: a
        -- process nobody asked about must not drag the average down with a
        -- defaults-only score (G3).
        SELECT
          c.subject_id,
          CASE
            WHEN jsonb_typeof(c.value) = 'object' THEN COALESCE((c.value->>'total')::numeric, 0)
            WHEN jsonb_typeof(c.value) = 'number' THEN (c.value #>> '{}')::numeric
            ELSE 0
          END AS score
        FROM claims c
        JOIN inventory i ON i.id = c.subject_id
        JOIN inventory_coverage ic ON ic.id = i.id AND ic.coverage >= ${COMPLEXITY_COVERAGE_GATE}
        WHERE c.org_id = ${orgId}
          AND c.workspace_id = ${workspaceId}
          AND c.subject_type IN ('candidate_process', 'process')
          AND c.field = 'complexity_score'
          AND c.status = 'active'
          AND c.superseded_by_claim_id IS NULL
      ),
      person_works_on AS (
        SELECT
          link.subject_id AS person_id,
          link.value->>'candidate_process_id' AS candidate_id_text
        FROM claims link
        WHERE link.org_id = ${orgId}
          AND link.workspace_id = ${workspaceId}
          AND link.subject_type = 'person'
          AND link.field = 'works_on'
          AND link.status = 'active'
          AND link.superseded_by_claim_id IS NULL
      ),
      person_spof AS (
        SELECT DISTINCT pc.subject_id AS person_id
        FROM claims pc
        WHERE pc.org_id = ${orgId}
          AND pc.workspace_id = ${workspaceId}
          AND pc.subject_type = 'person'
          AND pc.field = 'single_point_of_failure'
          AND pc.status = 'active'
          AND pc.superseded_by_claim_id IS NULL
          AND pc.value::text <> 'false'
      )
      SELECT
        (SELECT count(*)::int FROM inventory) AS process_count,
        -- G1: documentation coverage = average slot-fill across the inventory,
        -- not uploaded-document evidence (which read 0% for every voice-only
        -- interview regardless of how much was captured).
        (SELECT avg(coverage)::float FROM inventory_coverage) AS average_coverage,
        (
          SELECT count(*)::int FROM inventory_coverage
          WHERE coverage >= ${COMPLEXITY_COVERAGE_GATE}
        ) AS scored_process_count,
        (SELECT avg(score)::float FROM complexity) AS average_complexity,
        (
          -- SPOF counts both claim shapes: risk claims written by recordSpof
          -- on inventory processes, and person single_point_of_failure claims
          -- (the shape the brain has emitted in prod). Person claims count
          -- when linked to an inventory process via works_on; unlinked legacy
          -- person claims count only in the unscoped workspace view.
          (
            SELECT count(*)::int
            FROM claims c
            JOIN inventory i ON i.id = c.subject_id
            WHERE c.org_id = ${orgId}
              AND c.workspace_id = ${workspaceId}
              AND c.field = 'risk'
              AND c.status = 'active'
              AND c.superseded_by_claim_id IS NULL
              AND c.value::text ILIKE '%single_point_of_failure%'
          )
          +
          (
            SELECT count(*)::int
            FROM person_spof ps
            WHERE EXISTS (
                SELECT 1
                FROM person_works_on pw
                JOIN inventory i ON i.id::text = pw.candidate_id_text
                WHERE pw.person_id = ps.person_id
              )
              OR (
                ${captureSessionId ? sql`false` : sql`true`}
                AND NOT EXISTS (
                  SELECT 1 FROM person_works_on pw2 WHERE pw2.person_id = ps.person_id
                )
              )
          )
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
  return {
    processCount: count,
    documentationCoverage:
      count === 0 ? 0 : Math.round(Number(row?.average_coverage ?? 0) * 100),
    averageComplexity: Math.round(Number(row?.average_complexity ?? 0)),
    scoredProcessCount: Number(row?.scored_process_count ?? 0),
    spofCount: Number(row?.spof_count ?? 0),
    hasCaptures: Number(row?.capture_count ?? 0) > 0,
    hasProcessingCaptures: Number(row?.processing_count ?? 0) > 0,
    hasPartialSynthesis: Number(row?.partial_count ?? 0) > 0,
  };
}

export async function getProcessCards(
  orgId: string,
  workspaceId: string,
  options: OverviewQueryOptions = {},
): Promise<ProcessSummary[]> {
  const captureSessionId = options.captureSessionId ?? null;
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<CardRow>(sql`
      WITH ${coreSlotCoverageCte(orgId, workspaceId)},
      candidate_cards AS (
        SELECT
          cp.id,
          'candidate' AS source,
          cp.proposed_name AS name,
          cp.proposed_function AS function_name,
          COALESCE(cp.complexity_hint, cp.proposed_function, 'Candidate process from intake evidence.') AS description,
          cp.status::text AS status,
          cp.frequency,
          COALESCE(cov.coverage, 0)::float AS coverage,
          COALESCE(cov.covered_paths, '{}') AS covered_slot_paths,
          COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS system_names,
          GREATEST(
            count(DISTINCT r.id),
            count(DISTINCT person_claim.subject_id),
            count(DISTINCT role_claim.subject_id)
          )::int AS people_count,
          count(DISTINCT e.id)::int AS evidence_count,
          count(DISTINCT e.id) FILTER (WHERE e.evidence_label = 'documented')::int AS documented_evidence_count,
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
         AND person_claim.field = 'works_on'
         AND person_claim.status = 'active'
         AND person_claim.superseded_by_claim_id IS NULL
         AND person_claim.value->>'candidate_process_id' = cp.id::text
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
        LEFT JOIN core_slot_coverage cov ON cov.candidate_id = cp.id
        WHERE cp.org_id = ${orgId}
          AND cp.workspace_id = ${workspaceId}
          AND cp.status = 'pending'
          AND lower(cp.proposed_name) NOT IN ${junkCandidateNamesSql()}
          ${captureSessionId ? sql`AND cp.capture_session_id = ${captureSessionId}` : sql``}
        GROUP BY cp.id, cov.coverage, cov.covered_paths
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
          COALESCE(source_cov.coverage, 0)::float AS coverage,
          COALESCE(source_cov.covered_paths, '{}') AS covered_slot_paths,
          COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS system_names,
          (count(DISTINCT pr.role_id) + count(DISTINCT pp.person_id))::int AS people_count,
          count(DISTINCT ce.evidence_id)::int AS evidence_count,
          count(DISTINCT ce.evidence_id) FILTER (WHERE pe.evidence_label = 'documented')::int AS documented_evidence_count,
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
        LEFT JOIN evidence pe ON pe.id = ce.evidence_id
        LEFT JOIN LATERAL (
          SELECT cov.coverage, cov.covered_paths
          FROM candidate_processes source_cp
          JOIN core_slot_coverage cov ON cov.candidate_id = source_cp.id
          WHERE source_cp.promoted_process_id = p.id
          ORDER BY cov.coverage DESC
          LIMIT 1
        ) source_cov ON true
        WHERE p.org_id = ${orgId}
          AND p.workspace_id = ${workspaceId}
          AND p.status IN ('draft', 'approved')
          ${
            captureSessionId
              ? // Session-scoped overview: show processes tied to this capture
                // session (e.g. a candidate just promoted from it — promotion
                // writes a capture_process_links 'created' row). Was `AND false`,
                // which hid the promoted process the moment it left 'pending'.
                sql`AND EXISTS (
                  SELECT 1 FROM capture_process_links cpl
                  WHERE cpl.process_id = p.id
                    AND cpl.org_id = p.org_id
                    AND cpl.workspace_id = p.workspace_id
                    AND cpl.capture_session_id = ${captureSessionId}
                )`
              : sql``
          }
        GROUP BY p.id, pv.id, r.id, source_cov.coverage, source_cov.covered_paths
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
  const coverage = Math.round(Number(row.coverage ?? 0) * 100);
  // G3: a process below the coverage gate shows "more info needed" instead of
  // a defaults-only complexity score.
  const needsCapture = Number(row.coverage ?? 0) < COMPLEXITY_COVERAGE_GATE;
  const missingSlots =
    needsCapture && row.covered_slot_paths !== null
      ? directorCoreCoverageSlotPaths
          .filter((path) => !(row.covered_slot_paths ?? []).includes(path))
          .map((path) => directorSlotLabel(path))
      : [];
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
    // G1: capture coverage — how completely the core interview slots are
    // filled for this process (uploads raise it by filling slots).
    doc_coverage: Number(row.coverage ?? 0),
    coverage_percent: coverage,
    needs_capture: needsCapture,
    missing_slots: missingSlots,
    description:
      row.narrative_summary ??
      row.description ??
      "Intake evidence is still being synthesized.",
    people_count: Number(row.people_count ?? 0),
    systems: row.system_names ?? [],
    frequency: row.frequency ?? "Unknown",
    evidence_count: Number(row.evidence_count ?? 0),
    recommended: !needsCapture && (score >= 55 || Boolean(row.recommended_reason)),
    recommended_reason: row.recommended_reason ?? undefined,
  };
}
