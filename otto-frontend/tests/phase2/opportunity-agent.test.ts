import { afterEach, describe, expect, test, vi } from "vitest";
import { anthropicModelForPrompt } from "@/lib/ai/models";
import { groundOpportunities } from "@/lib/processes/opportunity-grounding";
import {
  assertNoForbiddenOpportunityKeys,
  opportunityProposalSchema,
  type OpportunityProposal,
} from "@/lib/processes/opportunity-schema";
import type { ProcessGraph } from "@/lib/types/graph";
import { reportEvalScores } from "../evals/report";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const graph: ProcessGraph = {
  process_id: "process-1",
  version_id: "version-1",
  version_number: 1,
  status: "approved",
  nodes: [
    {
      id: "node-1",
      type: "task",
      position: { x: 0, y: 0 },
      data: {
        title: "Validate invoice",
        systems: ["ERP"],
        claim_ids: ["claim-1"],
      },
    },
  ],
  edges: [],
};

describe("automation opportunity agent", () => {
  test("rejects evidence-based operational assumptions without evidence ids", () => {
    expect(() =>
      opportunityProposalSchema.parse({
        source_node_ids: ["node-1"],
        title: "Validate invoice totals",
        problem: "Invoice totals are manually checked.",
        proposed_solution: "Use validation rules before approval.",
        current_state: "Operators compare the invoice total manually.",
        target_state: "The system validates totals before routing.",
        automation_type: "data_validation",
        pattern_id: "data-validation",
        pattern_label: "Data validation",
        impact_band: "high",
        effort_band: "low",
        assumption_confidence: 0.8,
        evidence_ids: ["claim-1"],
        rationale: "The workflow has repeated manual checks.",
        assumptions: {
          annual_volume: {
            value: 1200,
            basis: "evidence",
            confidence: 0.8,
          },
        },
      }),
    ).toThrow(/evidence_ids/);
  });

  test("blocks model-supplied ROI and pricing fields", () => {
    expect(() =>
      assertNoForbiddenOpportunityKeys({
        opportunities: [
          {
            title: "Bad proposal",
            assumptions: {
              annual_volume: { value: 100, basis: "inferred" },
              cost_per_error: 50,
            },
            net_score: 12345,
          },
        ],
      }),
    ).toThrow(/forbidden ROI key/);
  });

  test("grounds proposals with workspace prices and downgraded quantity evidence", () => {
    const proposals: OpportunityProposal[] = [
      {
        source_node_ids: ["node-1"],
        title: "Validate invoice totals",
        problem: "Invoice totals are manually checked.",
        proposed_solution: "Use validation rules before approval.",
        current_state: "Operators compare the invoice total manually.",
        target_state: "The system validates totals before routing.",
        automation_type: "data_validation",
        pattern_id: "data-validation",
        pattern_label: "Data validation",
        impact_band: "high",
        effort_band: "low",
        assumption_confidence: 0.8,
        evidence_ids: ["claim-1", "missing-evidence"],
        rationale: "The workflow has repeated manual checks.",
        assumptions: {
          annual_volume: {
            value: 1000,
            basis: "evidence",
            confidence: 0.9,
            evidence_ids: ["volume-evidence"],
          },
          minutes_saved_per_case: {
            value: 15,
            basis: "evidence",
            confidence: 0.9,
            evidence_ids: ["missing-evidence"],
          },
          error_rate: {
            value: 2,
            basis: "inferred",
            confidence: 0.8,
            evidence_ids: [],
          },
        },
      },
      {
        source_node_ids: ["missing-node"],
        title: "Unanchored idea",
        problem: "No graph node supports this.",
        proposed_solution: "Drop it.",
        current_state: "No current state.",
        target_state: "No target state.",
        automation_type: "workflow_automation",
        pattern_id: "workflow-automation",
        pattern_label: "Workflow automation",
        impact_band: "low",
        effort_band: "low",
        assumption_confidence: 0.5,
        evidence_ids: [],
        rationale: "No anchor.",
        assumptions: {},
      },
    ];

    const result = groundOpportunities(proposals, {
      graph,
      allowedEvidenceIds: ["claim-1", "volume-evidence"],
      priceConstants: {
        loaded_hourly_cost: 100,
        cost_per_error: 250,
        delay_cost: 40,
      },
    });

    expect(result.opportunities).toHaveLength(1);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "invalid_source_nodes",
        "quantity_evidence_downgraded",
      ]),
    );
    const opportunity = result.opportunities[0];
    expect(opportunity.evidence_ids).toEqual(["claim-1"]);
    expect(opportunity.assumptions.loaded_hourly_cost).toBe(100);
    expect(opportunity.assumptions.cost_per_error).toBe(250);
    expect(opportunity.assumptions.delay_cost).toBe(40);
    expect(opportunity.assumptions.error_rate).toBe(1);
    expect(opportunity.assumptions.confidence).toBe(0.45);
    expect(opportunity.assumption_sources?.minutes_saved_per_case).toMatchObject({
      basis: "inferred",
      confidence: 0.45,
      evidence_ids: [],
    });
  });

  test("reports opportunity and ROI scored metrics", () => {
    const proposals: OpportunityProposal[] = [
      {
        source_node_ids: ["node-1"],
        title: "Validate invoice totals",
        problem: "Invoice totals are manually checked.",
        proposed_solution: "Use validation rules before approval.",
        current_state: "Operators compare the invoice total manually.",
        target_state: "The system validates totals before routing.",
        automation_type: "data_validation",
        pattern_id: "data-validation",
        pattern_label: "Data validation",
        impact_band: "high",
        effort_band: "low",
        assumption_confidence: 0.8,
        evidence_ids: ["claim-1"],
        rationale: "The workflow has repeated manual checks.",
        assumptions: {
          annual_volume: {
            value: 1000,
            basis: "evidence",
            confidence: 0.9,
            evidence_ids: ["claim-1"],
          },
        },
      },
    ];
    const result = groundOpportunities(proposals, {
      graph,
      allowedEvidenceIds: ["claim-1"],
      priceConstants: {
        loaded_hourly_cost: 100,
        cost_per_error: 250,
        delay_cost: 40,
      },
    });
    const opportunity = result.opportunities[0];
    const netScore = opportunity?.net_score;
    const metrics = [
      {
        name: "ranking_agreement",
        score: result.opportunities[0]?.pattern_id === "data-validation" ? 1 : 0,
        minimum: 1,
      },
      {
        name: "evidence_link_validity",
        score: opportunity?.evidence_ids.every((id) => id === "claim-1") ? 1 : 0,
        minimum: 1,
      },
      {
        name: "roi_sanity",
        score:
          typeof netScore === "number" &&
          Number.isFinite(netScore) &&
          netScore > 0 &&
          netScore < 1_000_000
            ? 1
            : 0,
        minimum: 1,
      },
    ];
    reportEvalScores({
      suite: "opportunity.roi",
      fixture: "tests/phase2/opportunity-agent.test.ts",
      cases: proposals.length,
      metrics,
    });
    for (const metric of metrics) {
      expect(metric.score, metric.name).toBeGreaterThanOrEqual(metric.minimum);
    }
  });

  test("read path kill switch ignores persisted opportunity sets", async () => {
    const { getProcessOpportunities, execute } = await loadOpportunityQueries({
      opportunityAgentEnabled: false,
      executeRows: [
        [
          {
            id: "set-1",
            generator: "agent",
            opportunities_json: [agentOpportunity()],
          },
        ],
      ],
    });

    const result = await getProcessOpportunities({
      orgId: "org-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      graph,
    });

    expect(result.source).toBe("heuristic");
    expect(result.opportunities[0].id).toBe("heuristic-opportunity");
    expect(execute).not.toHaveBeenCalled();
  });

  test("read path ignores agent sets without completed-stage eligibility", async () => {
    const { getProcessOpportunities, execute } = await loadOpportunityQueries({
      opportunityAgentEnabled: true,
      executeRows: [[]],
    });

    const result = await getProcessOpportunities({
      orgId: "org-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      graph,
    });

    expect(result.source).toBe("heuristic");
    expect(result.opportunities[0].id).toBe("heuristic-opportunity");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("read path applies overrides from the eligible opportunity set", async () => {
    const { getProcessOpportunities } = await loadOpportunityQueries({
      opportunityAgentEnabled: true,
      executeRows: [
        [
          {
            id: "set-1",
            generator: "agent",
            opportunities_json: [agentOpportunity()],
          },
        ],
        [
          {
            opportunity_id: "agent-opportunity",
            assumptions_json: {
              annual_volume: 200,
              minutes_saved_per_case: 30,
            },
          },
        ],
      ],
    });

    const result = await getProcessOpportunities({
      orgId: "org-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      graph,
    });

    expect(result.source).toBe("agent");
    expect(result.opportunitySetKey).toBe("agent:set-1");
    expect(result.opportunities[0]).toMatchObject({
      id: "agent-opportunity",
      opportunity_set_key: "agent:set-1",
      assumptions: {
        annual_volume: 200,
        minutes_saved_per_case: 30,
        loaded_hourly_cost: 100,
        cost_per_error: 250,
        delay_cost: 40,
      },
    });
    expect(result.opportunities[0].net_score).toBeGreaterThan(0);
  });

  test("opportunity model routing requires deployment-owned model config for live Anthropic", () => {
    expect(
      anthropicModelForPrompt(
        {
          OPPORTUNITY_MODEL: "opportunity-model",
          SYNTHESIS_PLANNER_MODEL: "planner-model",
          ANTHROPIC_MODEL: "global-model",
        },
        "synthesis.opportunities",
      ),
    ).toBe("opportunity-model");
    expect(
      anthropicModelForPrompt(
        {
          SYNTHESIS_PLANNER_MODEL: "planner-model",
          ANTHROPIC_MODEL: "global-model",
        },
        "synthesis.opportunities",
      ),
    ).toBe("planner-model");
    expect(() =>
      anthropicModelForPrompt(
        {
          ANTHROPIC_API_KEY: "live-key",
        },
        "synthesis.opportunities",
      ),
    ).toThrow(/must be configured/);
  });

  test("persistence conflict reuses immutable set without duplicate audit or decision writes", async () => {
    vi.resetModules();
    const insert = vi.fn((table: unknown) => {
      const callNumber = insert.mock.calls.length;
      return {
        values: vi.fn(() => {
          if (callNumber === 1) {
            return {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => []),
              })),
            };
          }
          return {};
        }),
      };
    });
    const tx = {
      insert,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ id: "existing-set" }]),
          })),
        })),
      })),
    };
    vi.doMock("@/lib/db/client", () => ({
      getDb: () => ({
        transaction: async (callback: (tx: unknown) => unknown) => callback(tx),
      }),
      setOrgContext: vi.fn(),
    }));

    const { persistCompletedAutomationOpportunityStage } = await import(
      "@/lib/processes/opportunity-persistence"
    );

    const set = await persistCompletedAutomationOpportunityStage({
      orgId: "org-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      versionId: "version-1",
      synthesisRunId: "run-1",
      extraction: {
        proposals: [],
        diagnostics: [],
        metadata: {
          text: "{}",
          model: "model-1",
          prompt_template_id: "synthesis.opportunities",
          prompt_template_version: "1",
          token_count_input: 1,
          token_count_output: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_cents: 1,
          latency_ms: 1,
          cache_hit: false,
          mocked: true,
        },
        promptTemplateId: "synthesis.opportunities",
        promptTemplateVersion: "1",
        modelId: "model-1",
        llmRequestHash: "request-hash",
        llmResponseHash: "response-hash",
        evidencePackHash: "pack-hash",
      },
      grounded: [],
      diagnostics: [],
      generator: "agent",
      inputRowRefs: [{ table: "process_versions", id: "version-1" }],
    });

    expect(set.id).toBe("existing-set");
    expect(insert).toHaveBeenCalledTimes(2);
  });
});

async function loadOpportunityQueries(input: {
  opportunityAgentEnabled: boolean;
  executeRows: unknown[][];
}) {
  vi.resetModules();
  const executeRows = [...input.executeRows];
  const execute = vi.fn(async () => ({ rows: executeRows.shift() ?? [] }));
  vi.doMock("@/lib/env", () => ({
    getServerEnv: () => ({
      OPPORTUNITY_AGENT_ENABLED: input.opportunityAgentEnabled,
    }),
  }));
  vi.doMock("@/lib/db/client", () => ({
    getDb: () => ({
      transaction: async (callback: (tx: unknown) => unknown) =>
        callback({ execute }),
    }),
    setOrgContext: vi.fn(),
  }));
  vi.doMock("@/lib/workspaces/roi-prices", () => ({
    getWorkspaceRoiPrices: vi.fn(async () => ({
      loaded_hourly_cost: 100,
      cost_per_error: 250,
      delay_cost: 40,
      currency: "USD",
    })),
  }));
  vi.doMock("@/lib/processes/opportunity-grounding", () => ({
    applyPricesToAssumptions: (
      assumptions: Record<string, number>,
      prices: Record<string, number>,
    ) => ({
      ...assumptions,
      loaded_hourly_cost: prices.loaded_hourly_cost,
      cost_per_error: prices.cost_per_error,
      delay_cost: prices.delay_cost,
    }),
    clampOperationalAssumptions: (assumptions: unknown) => assumptions,
    injectPricesIntoHeuristicOpportunity: (
      opportunity: { assumptions: Record<string, number> },
      prices: Record<string, number>,
    ) => ({
      ...opportunity,
      assumptions: {
        ...opportunity.assumptions,
        loaded_hourly_cost: prices.loaded_hourly_cost,
        cost_per_error: prices.cost_per_error,
        delay_cost: prices.delay_cost,
      },
    }),
  }));
  vi.doMock("@/lib/processes/opportunity-heuristics", () => ({
    HEURISTIC_OPPORTUNITY_VERSION: 1,
    buildTransformationOpportunities: vi.fn(() => [heuristicOpportunity()]),
  }));
  const queries = await import("@/lib/processes/opportunity-queries");
  return { ...queries, execute };
}

function heuristicOpportunity() {
  return {
    id: "heuristic-opportunity",
    process_id: "process-1",
    source_node_id: "node-1",
    source_node_title: "Validate invoice",
    title: "Heuristic opportunity",
    problem: "Manual validation.",
    proposed_solution: "Automate validation.",
    automation_type: "data_validation",
    pattern_id: "data-validation",
    pattern_label: "Data validation",
    evidence_ids: ["claim-1"],
    evidence_label: "1 linked evidence source",
    current_state: "Manual validation.",
    target_state: "Automated validation.",
    impact: "med",
    assumptions: {
      annual_volume: 50,
      minutes_saved_per_case: 5,
      loaded_hourly_cost: 65,
      error_rate: 0.01,
      cost_per_error: 90,
      exception_rate: 0.01,
      delay_cost: 35,
      confidence: 0.7,
      effort_penalty: 1.2,
    },
    integration_requirements: ["ERP"],
    dependencies: ["Owner review"],
    claim_ids: ["claim-1"],
  };
}

function agentOpportunity() {
  return {
    ...heuristicOpportunity(),
    id: "agent-opportunity",
    source_node_ids: ["node-1"],
    grounding: "evidence",
    effort_band: "low",
    assumptions: {
      annual_volume: 100,
      minutes_saved_per_case: 10,
      loaded_hourly_cost: 65,
      error_rate: 0.01,
      cost_per_error: 90,
      exception_rate: 0.01,
      delay_cost: 35,
      confidence: 0.8,
      effort_penalty: 1.1,
    },
  };
}
