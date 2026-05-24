import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";
import {
  type CoverageStatus,
  type DirectorCoverage,
  type DirectorCoverageSlot,
  type DirectorCoverageSummary,
  type Phase1Telemetry,
} from "@/lib/admin/coverage-types";

type SlotStateRow = {
  id: string;
  slot_path: string;
  status: CoverageStatus;
  confidence: string | number | null;
  evidence_count: string | number | null;
  last_asked_at: Date | null;
  value: unknown;
  open_follow_ups: string | number | null;
};

type CaptureRow = {
  id: string;
};

type TelemetryRow = {
  decision_count: string | number | null;
  degraded_turns: string | number | null;
  total_cost_cents: string | number | null;
  avg_latency_ms: string | number | null;
  p95_latency_ms: string | number | null;
  cache_hits: string | number | null;
  cache_observed: string | number | null;
};

type SynthesisTelemetryRow = {
  run_count: string | number | null;
  failed_runs: string | number | null;
  partial_runs: string | number | null;
  latest_status: string | null;
  latest_stage: string | null;
  latest_updated_at: Date | null;
};

export async function getDirectorCoverage(
  orgId: string,
  workspaceId: string,
  captureSessionId?: string,
): Promise<DirectorCoverage> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);

    const resolvedCaptureSessionId =
      captureSessionId ??
      (
        await tx.execute<CaptureRow>(sql`
          SELECT id
          FROM capture_sessions
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND capture_type = 'director_interview'
          ORDER BY completed_at DESC NULLS LAST,
                   started_at DESC NULLS LAST,
                   created_at DESC
          LIMIT 1
        `)
      ).rows[0]?.id ??
      null;

    const slotRows = resolvedCaptureSessionId
      ? (
          await tx.execute<SlotStateRow>(sql`
            SELECT
              s.id,
              s.slot_path,
              s.status::text AS status,
              s.confidence,
              cardinality(s.evidence_ids) AS evidence_count,
              s.last_asked_at,
              s.value,
              (
                SELECT count(*)::int
                FROM follow_up_tasks f
                WHERE f.org_id = s.org_id
                  AND f.workspace_id = s.workspace_id
                  AND f.capture_session_id = s.capture_session_id
                  AND f.status IN ('open', 'in_progress')
                  AND (
                    f.target_id = s.id
                    OR f.context_json->>'slot_path' = s.slot_path
                  )
              ) AS open_follow_ups
            FROM slot_states s
            WHERE s.org_id = ${orgId}
              AND s.workspace_id = ${workspaceId}
              AND s.capture_session_id = ${resolvedCaptureSessionId}
          `)
        ).rows
      : [];

    const byPath = new Map(slotRows.map((row) => [row.slot_path, row]));
    const slots = directorSlotDefinitions.map((definition) => {
      const row = byPath.get(definition.path);
      return {
        slotPath: definition.path,
        label: definition.label,
        priority: definition.priority,
        status: row?.status ?? "empty",
        confidence: toNumber(row?.confidence),
        evidenceCount: toNumber(row?.evidence_count),
        openFollowUps: toNumber(row?.open_follow_ups),
        lastAskedAt: row?.last_asked_at ?? null,
        value: row?.value ?? null,
      };
    });

    const summary = summarizeCoverage(slots);
    const telemetry = await getPhase1TelemetryInTransaction(
      tx,
      orgId,
      workspaceId,
      resolvedCaptureSessionId,
    );

    return {
      workspaceId,
      captureSessionId: resolvedCaptureSessionId,
      slots,
      summary,
      telemetry,
    };
  });
}

async function getPhase1TelemetryInTransaction(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  orgId: string,
  workspaceId: string,
  captureSessionId: string | null,
): Promise<Phase1Telemetry> {
  const decisionTelemetry = (
    await tx.execute<TelemetryRow>(sql`
      SELECT
        count(*)::int AS decision_count,
        count(*) FILTER (WHERE degraded_quality)::int AS degraded_turns,
        coalesce(sum(cost_cents), 0) AS total_cost_cents,
        coalesce(avg(latency_ms), 0) AS avg_latency_ms,
        coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0) AS p95_latency_ms,
        count(*) FILTER (WHERE cache_hit IS TRUE)::int AS cache_hits,
        count(*) FILTER (WHERE cache_hit IS NOT NULL)::int AS cache_observed
      FROM agent_decision_log
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND (${captureSessionId}::uuid IS NULL OR capture_session_id = ${captureSessionId}::uuid)
    `)
  ).rows[0];

  const synthesisTelemetry = (
    await tx.execute<SynthesisTelemetryRow>(sql`
      WITH latest AS (
        SELECT status::text, stage, updated_at
        FROM synthesis_runs
        WHERE org_id = ${orgId}
          AND workspace_id = ${workspaceId}
          AND (${captureSessionId}::uuid IS NULL OR ${captureSessionId}::uuid = ANY(capture_session_ids))
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      )
      SELECT
        count(*)::int AS run_count,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_runs,
        count(*) FILTER (WHERE status = 'partial_synthesis')::int AS partial_runs,
        (SELECT status FROM latest) AS latest_status,
        (SELECT stage FROM latest) AS latest_stage,
        (SELECT updated_at FROM latest) AS latest_updated_at
      FROM synthesis_runs
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND (${captureSessionId}::uuid IS NULL OR ${captureSessionId}::uuid = ANY(capture_session_ids))
    `)
  ).rows[0];

  const cacheObserved = toNumber(decisionTelemetry?.cache_observed);
  return {
    decisionCount: toNumber(decisionTelemetry?.decision_count),
    degradedTurns: toNumber(decisionTelemetry?.degraded_turns),
    totalCostCents: toNumber(decisionTelemetry?.total_cost_cents),
    avgLatencyMs: Math.round(toNumber(decisionTelemetry?.avg_latency_ms)),
    p95LatencyMs: Math.round(toNumber(decisionTelemetry?.p95_latency_ms)),
    cacheHitRate:
      cacheObserved === 0
        ? 0
        : Math.round((toNumber(decisionTelemetry?.cache_hits) / cacheObserved) * 100),
    synthesisRunCount: toNumber(synthesisTelemetry?.run_count),
    failedSynthesisRuns: toNumber(synthesisTelemetry?.failed_runs),
    partialSynthesisRuns: toNumber(synthesisTelemetry?.partial_runs),
    latestSynthesisStatus: synthesisTelemetry?.latest_status ?? null,
    latestSynthesisStage: synthesisTelemetry?.latest_stage ?? null,
    latestSynthesisUpdatedAt: synthesisTelemetry?.latest_updated_at ?? null,
  };
}

function summarizeCoverage(
  slots: DirectorCoverageSlot[],
): DirectorCoverageSummary {
  const counts = slots.reduce(
    (acc, slot) => {
      if (slot.status === "filled") acc.filled += 1;
      if (slot.status === "partial") acc.partial += 1;
      if (slot.status === "empty") acc.missing += 1;
      if (slot.status === "conflicting") acc.conflicting += 1;
      if (slot.status === "pending_re_extract") acc.pendingReExtract += 1;
      if (slot.status === "asked_unknown") acc.askedUnknown += 1;
      acc.evidenceCount += slot.evidenceCount;
      acc.openFollowUps += slot.openFollowUps;
      acc.confidenceTotal += slot.confidence;
      return acc;
    },
    {
      filled: 0,
      partial: 0,
      missing: 0,
      conflicting: 0,
      pendingReExtract: 0,
      askedUnknown: 0,
      evidenceCount: 0,
      openFollowUps: 0,
      confidenceTotal: 0,
    },
  );

  return {
    filled: counts.filled,
    partial: counts.partial,
    missing: counts.missing,
    conflicting: counts.conflicting,
    pendingReExtract: counts.pendingReExtract,
    askedUnknown: counts.askedUnknown,
    totalSlots: slots.length,
    averageConfidence:
      slots.length === 0 ? 0 : Math.round((counts.confidenceTotal / slots.length) * 100),
    evidenceCount: counts.evidenceCount,
    openFollowUps: counts.openFollowUps,
  };
}

function toNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
