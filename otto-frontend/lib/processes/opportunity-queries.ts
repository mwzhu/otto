import "server-only";

import { sql } from "drizzle-orm";
import { getServerEnv } from "@/lib/env";
import { getDb, setOrgContext } from "@/lib/db/client";
import { computeROI } from "@/lib/roi";
import type { ProcessGraph } from "@/lib/types/graph";
import type { ROIAssumptions } from "@/lib/types/opportunity";
import {
  buildTransformationOpportunities,
  HEURISTIC_OPPORTUNITY_VERSION,
} from "@/lib/processes/opportunity-heuristics";
import {
  applyPricesToAssumptions,
  clampOperationalAssumptions,
  injectPricesIntoHeuristicOpportunity,
} from "@/lib/processes/opportunity-grounding";
import type { GroundedOpportunity } from "@/lib/processes/opportunity-schema";
import { getWorkspaceRoiPrices } from "@/lib/workspaces/roi-prices";

export type ProcessOpportunitySource = "agent" | "heuristic";

export type ProcessOpportunity = GroundedOpportunity & {
  opportunity_set_key: string;
};

export type ProcessOpportunitiesResult = {
  source: ProcessOpportunitySource;
  opportunitySetKey: string;
  opportunities: ProcessOpportunity[];
};

type OpportunitySetRow = {
  id: string;
  generator: string;
  opportunities_json: unknown;
};

type OverrideRow = {
  opportunity_id: string;
  assumptions_json: unknown;
};

export async function getProcessOpportunities(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  graph: ProcessGraph;
}): Promise<ProcessOpportunitiesResult> {
  const priceConstants = await getWorkspaceRoiPrices(input.orgId, input.workspaceId);
  const heuristicKey = heuristicOpportunitySetKey(input.graph.version_id);
  const heuristic = () => heuristicOpportunities(input.graph, heuristicKey, priceConstants);

  if (!getServerEnv().OPPORTUNITY_AGENT_ENABLED || !input.graph.version_id) {
    return heuristic();
  }

  const set = await loadLatestCompletedOpportunitySet({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    processId: input.processId,
    versionId: input.graph.version_id,
  });
  if (!set || set.generator !== "agent") return heuristic();

  const opportunitySetKey = agentOpportunitySetKey(set.id);
  const opportunities = parseGroundedOpportunities(set.opportunities_json);
  if (opportunities.length === 0) return heuristic();

  const overrides = await loadAssumptionOverrides({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    versionId: input.graph.version_id,
    opportunitySetKey,
  });
  const overridesByOpportunity = new Map(
    overrides.map((override) => [
      override.opportunity_id,
      parseAssumptionPatch(override.assumptions_json),
    ]),
  );

  return {
    source: "agent",
    opportunitySetKey,
    opportunities: opportunities
      .map((opportunity) => {
        const assumptions = clampOperationalAssumptions(
          applyPricesToAssumptions(
            {
              ...opportunity.assumptions,
              ...overridesByOpportunity.get(opportunity.id),
            },
            priceConstants,
          ),
        );
        return {
          ...opportunity,
          ...computeROI(assumptions),
          assumptions,
          opportunity_set_key: opportunitySetKey,
        };
      })
      .sort((a, b) => (b.net_score ?? 0) - (a.net_score ?? 0)),
  };
}

export async function isOpportunitySetKeyReadable(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
  opportunitySetKey: string;
}) {
  if (input.opportunitySetKey === heuristicOpportunitySetKey(input.versionId)) {
    return true;
  }
  const setId = input.opportunitySetKey.startsWith("agent:")
    ? input.opportunitySetKey.slice("agent:".length)
    : null;
  if (!setId) return false;
  const row = await loadCompletedOpportunitySetById({ ...input, setId });
  return Boolean(row);
}

export function agentOpportunitySetKey(setId: string) {
  return `agent:${setId}`;
}

export function heuristicOpportunitySetKey(versionId: string | undefined) {
  return `heuristic:${versionId ?? "current"}:${HEURISTIC_OPPORTUNITY_VERSION}`;
}

async function loadLatestCompletedOpportunitySet(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
}) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx.execute<OpportunitySetRow>(sql`
      SELECT
        aos.id,
        aos.generator,
        aos.opportunities_json
      FROM automation_opportunity_sets aos
      WHERE aos.org_id = ${input.orgId}
        AND aos.workspace_id = ${input.workspaceId}
        AND aos.process_id = ${input.processId}
        AND aos.version_id = ${input.versionId}
        AND EXISTS (
          SELECT 1
          FROM synthesis_stage_outputs sso,
            jsonb_array_elements(sso.output_row_refs) AS ref
          WHERE sso.org_id = ${input.orgId}
            AND sso.workspace_id = ${input.workspaceId}
            AND sso.stage_name = 'stage-9-opportunity-synthesis'
            AND sso.status = 'completed'
            AND ref->>'table' = 'automation_opportunity_sets'
            AND ref->>'id' = aos.id::text
        )
      ORDER BY aos.created_at DESC
      LIMIT 1
    `);
  });
  return result.rows[0] ?? null;
}

async function loadCompletedOpportunitySetById(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
  setId: string;
}) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx.execute<{ id: string }>(sql`
      SELECT aos.id
      FROM automation_opportunity_sets aos
      WHERE aos.org_id = ${input.orgId}
        AND aos.workspace_id = ${input.workspaceId}
        AND aos.process_id = ${input.processId}
        AND aos.version_id = ${input.versionId}
        AND aos.id = ${input.setId}
        AND EXISTS (
          SELECT 1
          FROM synthesis_stage_outputs sso,
            jsonb_array_elements(sso.output_row_refs) AS ref
          WHERE sso.org_id = ${input.orgId}
            AND sso.workspace_id = ${input.workspaceId}
            AND sso.stage_name = 'stage-9-opportunity-synthesis'
            AND sso.status = 'completed'
            AND ref->>'table' = 'automation_opportunity_sets'
            AND ref->>'id' = aos.id::text
        )
      LIMIT 1
    `);
  });
  return result.rows[0] ?? null;
}

async function loadAssumptionOverrides(input: {
  orgId: string;
  workspaceId: string;
  versionId: string;
  opportunitySetKey: string;
}) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx.execute<OverrideRow>(sql`
      SELECT opportunity_id, assumptions_json
      FROM opportunity_assumption_overrides
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND version_id = ${input.versionId}
        AND opportunity_set_key = ${input.opportunitySetKey}
    `);
  });
  return result.rows;
}

function heuristicOpportunities(
  graph: ProcessGraph,
  opportunitySetKey: string,
  priceConstants: Awaited<ReturnType<typeof getWorkspaceRoiPrices>>,
): ProcessOpportunitiesResult {
  const opportunities = buildTransformationOpportunities(graph)
    .map((opportunity) =>
      injectPricesIntoHeuristicOpportunity(opportunity, priceConstants),
    )
    .map((opportunity) => {
      const roi = computeROI(opportunity.assumptions);
      return {
        ...opportunity,
        source_node_ids: [opportunity.source_node_id],
        grounding: opportunity.evidence_ids.length > 0 ? "evidence" : "assumption",
        effort_band: effortBandForPenalty(opportunity.assumptions.effort_penalty),
        ...roi,
        opportunity_set_key: opportunitySetKey,
      } satisfies ProcessOpportunity;
    })
    .sort((a, b) => (b.net_score ?? 0) - (a.net_score ?? 0));
  return { source: "heuristic", opportunitySetKey, opportunities };
}

function parseGroundedOpportunities(value: unknown): GroundedOpportunity[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isGroundedOpportunity);
}

function isGroundedOpportunity(value: unknown): value is GroundedOpportunity {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as GroundedOpportunity).id === "string" &&
      typeof (value as GroundedOpportunity).process_id === "string" &&
      (value as GroundedOpportunity).assumptions,
  );
}

function parseAssumptionPatch(value: unknown): Partial<ROIAssumptions> {
  if (!value || typeof value !== "object") return {};
  const patch: Partial<ROIAssumptions> = {};
  for (const key of [
    "annual_volume",
    "minutes_saved_per_case",
    "error_rate",
    "exception_rate",
    "confidence",
    "effort_penalty",
  ] as const) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      patch[key] = candidate;
    }
  }
  return patch;
}

function effortBandForPenalty(penalty: number): "low" | "med" | "high" {
  if (penalty >= 1.6) return "high";
  if (penalty >= 1.25) return "med";
  return "low";
}
