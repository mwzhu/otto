import "server-only";

import {
  StructuredOutputError,
  preflightAnthropicModelForPrompt,
  structured,
  type Generation,
} from "@/lib/adapters/llm";
import { anthropicModelForPrompt } from "@/lib/ai/models";
import { getServerEnv } from "@/lib/env";
import {
  opportunityEvidencePackToPrompt,
  type OpportunityEvidencePack,
} from "@/lib/processes/opportunity-evidence";
import {
  assertNoForbiddenOpportunityKeys,
  opportunitySetSchema,
  stableHash,
  type OpportunityProposal,
} from "@/lib/processes/opportunity-schema";

export type OpportunityExtraction = {
  proposals: OpportunityProposal[];
  diagnostics: Array<{ code: string; message: string }>;
  metadata: Generation;
  promptTemplateId: string;
  promptTemplateVersion: string;
  modelId: string;
  llmRequestHash: string;
  llmResponseHash: string;
  evidencePackHash: string;
};

export async function extractAutomationOpportunities(input: {
  pack: OpportunityEvidencePack;
  mock?: unknown;
}): Promise<OpportunityExtraction> {
  const promptTemplateId = "synthesis.opportunities";
  const promptTemplateVersion = "2";
  const promptInput = opportunityEvidencePackToPrompt(input.pack);
  const staticInput = buildOpportunityStaticInput();
  const preflightModelId = await preflightAnthropicModelForPrompt(promptTemplateId);
  const { value, metadata } = await structured({
    prompt_template_id: promptTemplateId,
    prompt_template_version: promptTemplateVersion,
    schema_name: "AutomationOpportunitySet",
    schema: opportunitySetSchema,
    static_input: staticInput,
    input: promptInput,
    anthropic_tool: {
      name: "emit_automation_opportunities",
      description:
        "Emit evidence-grounded automation opportunity proposals without any dollar values or ROI scores.",
      input_schema: automationOpportunityAnthropicToolSchema,
      strict: true,
    },
    mock: input.mock,
  });
  assertNoForbiddenOpportunityKeys(value);
  const env = getServerEnv();
  const modelId =
    metadata.model || preflightModelId || anthropicModelForPrompt(env, promptTemplateId);
  return {
    proposals: value.opportunities,
    diagnostics: value.diagnostics,
    metadata,
    promptTemplateId,
    promptTemplateVersion,
    modelId,
    llmRequestHash: stableHash({ staticInput, promptInput }),
    llmResponseHash: stableHash(value),
    evidencePackHash: input.pack.evidencePackHash,
  };
}

function buildOpportunityStaticInput() {
  return [
    "You are Otto's automation strategist.",
    "Return the highest-ROI automation opportunities as structured data.",
    "For each opportunity, write implementation_plan as the concrete automation-agent architecture for this process: triggers, inputs, systems, controls, exception handling, and human review.",
    "For each opportunity, write expected_result as process-specific business impact using cycle-time, hours, error, exception, SLA, capacity, or working-capital metrics.",
    "Avoid generic transformation text; tie the problem, implementation_plan, and expected_result to this department's process evidence.",
    "Never output dollars, prices, savings, gross_value, annual_*_value, or net_score.",
    "Estimate operational quantities only: annual volume, minutes saved per case, error rate, and exception rate.",
    "Each evidence-based operational quantity must cite evidence_ids present in the pack.",
    "If a quantity is inferred, confidence must be <= 0.45.",
    "Prefer fewer high-confidence opportunities over broad weak ones. Max 12.",
  ].join("\n");
}

const operationalAssumptionInputSchema = {
  type: "object",
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: { basis: { const: "evidence" } },
        required: ["basis"],
      },
      then: {
        properties: {
          evidence_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
        },
        required: ["evidence_ids"],
      },
    },
  ],
  properties: {
    value: { type: "number", minimum: 0 },
    basis: { type: "string", enum: ["evidence", "inferred"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence_ids: { type: "array", items: { type: "string" } },
  },
  required: ["value", "basis", "confidence"],
} as const;

const automationOpportunityAnthropicToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    opportunities: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_node_ids: { type: "array", items: { type: "string" }, minItems: 1 },
          title: { type: "string" },
          problem: { type: "string" },
          proposed_solution: { type: "string" },
          implementation_plan: { type: "string" },
          expected_result: { type: "string" },
          current_state: { type: "string" },
          target_state: { type: "string" },
          automation_type: {
            type: "string",
            enum: [
              "workflow_automation",
              "agent_assistant",
              "data_validation",
              "intake_form",
              "system_integration",
              "exception_monitoring",
              "report_generation",
              "approval_routing",
              "knowledge_base",
            ],
          },
          pattern_id: { type: "string" },
          pattern_label: { type: "string" },
          impact_band: { type: "string", enum: ["high", "med", "low"] },
          effort_band: { type: "string", enum: ["low", "med", "high"] },
          assumption_confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence_ids: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          assumptions: {
            type: "object",
            additionalProperties: false,
            properties: {
              annual_volume: operationalAssumptionInputSchema,
              minutes_saved_per_case: operationalAssumptionInputSchema,
              error_rate: operationalAssumptionInputSchema,
              exception_rate: operationalAssumptionInputSchema,
            },
          },
        },
        required: [
          "source_node_ids",
          "title",
          "problem",
          "proposed_solution",
          "implementation_plan",
          "expected_result",
          "current_state",
          "target_state",
          "automation_type",
          "pattern_id",
          "pattern_label",
          "impact_band",
          "effort_band",
          "assumption_confidence",
          "rationale",
        ],
      },
    },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
      },
    },
  },
  required: ["opportunities"],
} as const;

export function isStructuredTruncationError(error: unknown) {
  return (
    error instanceof StructuredOutputError &&
    /truncat|parse|json/i.test(error.message)
  );
}
