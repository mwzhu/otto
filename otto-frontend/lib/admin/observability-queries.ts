import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";

export type ObservabilityTone = "ok" | "warn" | "danger";

export type ObservabilityMetric = {
  key: string;
  label: string;
  value: number;
  unit: "ms" | "%" | "count" | "cents";
  tone: ObservabilityTone;
  threshold: string;
  detail: string;
};

export type ObservabilityAlert = {
  key: string;
  label: string;
  tone: Exclude<ObservabilityTone, "ok">;
  detail: string;
};

export type ObservabilityDashboard = {
  metrics: ObservabilityMetric[];
  alerts: ObservabilityAlert[];
  generatedAt: string;
};

type DecisionTelemetryRow = {
  turn_count: string | number | null;
  p50_latency_ms: string | number | null;
  p95_latency_ms: string | number | null;
  extraction_observed: string | number | null;
  extraction_failures: string | number | null;
  cache_hits: string | number | null;
  cache_observed: string | number | null;
  degraded_backlog: string | number | null;
  total_cost_cents: string | number | null;
};

type SynthesisTelemetryRow = {
  stage_count: string | number | null;
  failed_stages: string | number | null;
  synthesis_cost_cents: string | number | null;
  synthesis_runs: string | number | null;
};

const OBSERVABILITY_WINDOW_LABEL = "last 7 days";

export async function getObservabilityDashboard(
  orgId: string,
  workspaceId: string,
): Promise<ObservabilityDashboard> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    const decisionTelemetry = (
      await tx.execute<DecisionTelemetryRow>(sql`
        WITH recovered AS (
          SELECT DISTINCT tool_calls->>'source_agent_decision_log_id' AS source_decision_log_id
          FROM agent_decision_log
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND stage_name = 're_extract_degraded_turns.recovered'
        )
        SELECT
          count(*) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND stage_name IN ('director.turn', 'operator.turn')
          )::int AS turn_count,
          coalesce(percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND stage_name IN ('director.turn', 'operator.turn')
              AND latency_ms IS NOT NULL
          ), 0) AS p50_latency_ms,
          coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND stage_name IN ('director.turn', 'operator.turn')
              AND latency_ms IS NOT NULL
          ), 0) AS p95_latency_ms,
          count(*) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND stage_name IN ('director.extraction', 'operator.extraction')
          )::int AS extraction_observed,
          count(*) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND stage_name IN ('director.extraction', 'operator.extraction')
              AND degraded_quality IS TRUE
              AND (
                degraded_reasons::text ILIKE '%extract%'
                OR degraded_reasons::text ILIKE '%schema%'
                OR degraded_reasons::text ILIKE '%invalid%'
              )
          )::int AS extraction_failures,
          count(*) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND cache_hit IS TRUE
          )::int AS cache_hits,
          count(*) FILTER (
            WHERE ts_start >= now() - interval '7 days'
              AND cache_hit IS NOT NULL
          )::int AS cache_observed,
          count(*) FILTER (
            WHERE degraded_quality IS TRUE
              AND recovered.source_decision_log_id IS NULL
          )::int AS degraded_backlog,
          coalesce(sum(cost_cents) FILTER (
            WHERE ts_start >= now() - interval '7 days'
          ), 0) AS total_cost_cents
        FROM agent_decision_log d
        LEFT JOIN recovered ON recovered.source_decision_log_id = d.id::text
        WHERE d.org_id = ${orgId}
          AND d.workspace_id = ${workspaceId}
      `)
    ).rows[0];
    const synthesisTelemetry = (
      await tx.execute<SynthesisTelemetryRow>(sql`
        WITH stage_counts AS (
          SELECT
            count(*)::int AS stage_count,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_stages
          FROM synthesis_stage_outputs
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND created_at >= now() - interval '7 days'
        ),
        stage_runs AS (
          SELECT DISTINCT synthesis_run_id
          FROM synthesis_stage_outputs
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND created_at >= now() - interval '7 days'
        ),
        run_costs AS (
          SELECT
            synthesis_run_id,
            coalesce(sum(cost_cents), 0) AS run_cost_cents
          FROM agent_decision_log
          WHERE org_id = ${orgId}
            AND workspace_id = ${workspaceId}
            AND synthesis_run_id IS NOT NULL
            AND ts_start >= now() - interval '7 days'
          GROUP BY synthesis_run_id
        )
        SELECT
          stage_counts.stage_count,
          stage_counts.failed_stages,
          coalesce((
            SELECT sum(coalesce(run_costs.run_cost_cents, 0))
            FROM stage_runs
            LEFT JOIN run_costs
              ON run_costs.synthesis_run_id = stage_runs.synthesis_run_id
          ), 0) AS synthesis_cost_cents,
          coalesce((SELECT count(*) FROM stage_runs), 0)::int AS synthesis_runs
        FROM stage_counts
      `)
    ).rows[0];

    const turnCount = toNumber(decisionTelemetry?.turn_count);
    const extractionObserved = toNumber(decisionTelemetry?.extraction_observed);
    const extractionFailureRate =
      extractionObserved === 0
        ? 0
        : (toNumber(decisionTelemetry?.extraction_failures) / extractionObserved) * 100;
    const cacheObserved = toNumber(decisionTelemetry?.cache_observed);
    const cacheHitRate =
      cacheObserved === 0
        ? 0
        : (toNumber(decisionTelemetry?.cache_hits) / cacheObserved) * 100;
    const stageCount = toNumber(synthesisTelemetry?.stage_count);
    const synthesisFailureRate =
      stageCount === 0
        ? 0
        : (toNumber(synthesisTelemetry?.failed_stages) / stageCount) * 100;
    const synthesisRuns = toNumber(synthesisTelemetry?.synthesis_runs);
    const decisionCostCents = toNumber(decisionTelemetry?.total_cost_cents);
    const costPerRun =
      synthesisRuns === 0
        ? 0
        : toNumber(synthesisTelemetry?.synthesis_cost_cents) / synthesisRuns;

    const metrics: ObservabilityMetric[] = [
      metric({
        key: "turn_latency_p50",
        label: "Turn latency p50",
        value: Math.round(toNumber(decisionTelemetry?.p50_latency_ms)),
        unit: "ms",
        warnAt: 2500,
        dangerAt: 5000,
        threshold: "warn >= 2.5s, danger >= 5s",
        detail: `${turnCount} director/operator turns observed in the ${OBSERVABILITY_WINDOW_LABEL}.`,
      }),
      metric({
        key: "turn_latency_p95",
        label: "Turn latency p95",
        value: Math.round(toNumber(decisionTelemetry?.p95_latency_ms)),
        unit: "ms",
        warnAt: 8000,
        dangerAt: 15000,
        threshold: "warn >= 8s, danger >= 15s",
        detail: `${turnCount} director/operator turns observed in the ${OBSERVABILITY_WINDOW_LABEL}.`,
      }),
      extractionObserved === 0
        ? inactiveMetric({
            key: "extraction_failure_rate",
            label: "Extraction-failure rate",
            value: 0,
            unit: "%",
            threshold: "not evaluated until extraction decisions exist",
            detail: `No extraction decisions observed in the ${OBSERVABILITY_WINDOW_LABEL}.`,
          })
        : metric({
            key: "extraction_failure_rate",
            label: "Extraction-failure rate",
            value: Math.round(extractionFailureRate),
            unit: "%",
            warnAt: 5,
            dangerAt: 15,
            threshold: "warn >= 5%, danger >= 15%",
            detail: `${toNumber(decisionTelemetry?.extraction_failures)} failed of ${extractionObserved} extraction decisions in the ${OBSERVABILITY_WINDOW_LABEL}.`,
          }),
      cacheObserved === 0
        ? inactiveMetric({
            key: "cache_hit_rate",
            label: "Cache-hit rate",
            value: 0,
            unit: "%",
            threshold: "not evaluated until cache observations exist",
            detail: `No cache-observed decisions in the ${OBSERVABILITY_WINDOW_LABEL}.`,
          })
        : inverseMetric({
            key: "cache_hit_rate",
            label: "Cache-hit rate",
            value: Math.round(cacheHitRate),
            unit: "%",
            warnBelow: 60,
            dangerBelow: 30,
            threshold: "warn < 60%, danger < 30%",
            detail: `${cacheObserved} cache-observed decisions in the ${OBSERVABILITY_WINDOW_LABEL}.`,
          }),
      metric({
        key: "degraded_turn_backlog",
        label: "Degraded-turn backlog",
        value: toNumber(decisionTelemetry?.degraded_backlog),
        unit: "count",
        warnAt: 1,
        dangerAt: 10,
        threshold: "warn >= 1, danger >= 10",
        detail: "Unrecovered degraded decisions that need recovery or review.",
      }),
      metric({
        key: "synthesis_stage_failure_rate",
        label: "Synthesis stage-failure rate",
        value: Math.round(synthesisFailureRate),
        unit: "%",
        warnAt: 1,
        dangerAt: 10,
        threshold: "warn >= 1%, danger >= 10%",
        detail: `${toNumber(synthesisTelemetry?.failed_stages)} failed of ${stageCount} synthesis stages in the ${OBSERVABILITY_WINDOW_LABEL}.`,
      }),
      synthesisRuns === 0
        ? inactiveMetric({
            key: "cost_per_run",
            label: "Cost per run",
            value: Math.round(decisionCostCents * 1000) / 1000,
            unit: "cents",
            threshold: "not evaluated until synthesis runs exist",
            detail: `No synthesis runs in the ${OBSERVABILITY_WINDOW_LABEL}; showing total decision cost for context only.`,
          })
        : metric({
            key: "cost_per_run",
            label: "Cost per run",
            value: Math.round(costPerRun * 1000) / 1000,
            unit: "cents",
            warnAt: 20,
            dangerAt: 100,
            threshold: "warn >= 20c, danger >= 100c",
            detail: `${synthesisRuns} synthesis runs observed in the ${OBSERVABILITY_WINDOW_LABEL}.`,
          }),
    ];
    return {
      metrics,
      alerts: metrics
        .filter((item) => item.tone !== "ok")
        .map((item) => ({
          key: item.key,
          label: item.label,
          tone: item.tone as Exclude<ObservabilityTone, "ok">,
          detail: item.detail,
        })),
      generatedAt: new Date().toISOString(),
    };
  });
}

function inactiveMetric(input: {
  key: string;
  label: string;
  value: number;
  unit: ObservabilityMetric["unit"];
  threshold: string;
  detail: string;
}): ObservabilityMetric {
  return {
    ...input,
    tone: "ok",
  };
}

function metric(input: {
  key: string;
  label: string;
  value: number;
  unit: ObservabilityMetric["unit"];
  warnAt: number;
  dangerAt: number;
  threshold: string;
  detail: string;
}): ObservabilityMetric {
  return {
    ...input,
    tone:
      input.value >= input.dangerAt
        ? "danger"
        : input.value >= input.warnAt
          ? "warn"
          : "ok",
  };
}

function inverseMetric(input: {
  key: string;
  label: string;
  value: number;
  unit: ObservabilityMetric["unit"];
  warnBelow: number;
  dangerBelow: number;
  threshold: string;
  detail: string;
}): ObservabilityMetric {
  return {
    ...input,
    tone:
      input.value <= input.dangerBelow
        ? "danger"
        : input.value < input.warnBelow
          ? "warn"
          : "ok",
  };
}

function toNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
