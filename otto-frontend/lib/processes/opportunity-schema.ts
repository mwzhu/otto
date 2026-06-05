import { createHash } from "node:crypto";
import { z } from "zod";
import type { AutomationType, Opportunity, ROIAssumptions } from "@/lib/types";

export const AUTOMATION_TYPES = [
  "workflow_automation",
  "agent_assistant",
  "data_validation",
  "intake_form",
  "system_integration",
  "exception_monitoring",
  "report_generation",
  "approval_routing",
  "knowledge_base",
] as const satisfies AutomationType[];

export const OPPORTUNITY_PATTERN_CATALOG = [
  { pattern_id: "system-integration", pattern_label: "System integration", automation_type: "system_integration" },
  { pattern_id: "agent-assistant", pattern_label: "Agent assistant", automation_type: "agent_assistant" },
  { pattern_id: "exception-monitoring", pattern_label: "Exception monitoring", automation_type: "exception_monitoring" },
  { pattern_id: "approval-routing", pattern_label: "Approval routing", automation_type: "approval_routing" },
  { pattern_id: "data-validation", pattern_label: "Data validation", automation_type: "data_validation" },
  { pattern_id: "intake-form", pattern_label: "Intake form", automation_type: "intake_form" },
  { pattern_id: "report-generation", pattern_label: "Report generation", automation_type: "report_generation" },
  { pattern_id: "workflow-automation", pattern_label: "Workflow automation", automation_type: "workflow_automation" },
  { pattern_id: "knowledge-base", pattern_label: "Knowledge base", automation_type: "knowledge_base" },
  { pattern_id: "evidence-gap", pattern_label: "Evidence gap", automation_type: "knowledge_base" },
] as const;

export type OpportunityImpactBand = "high" | "med" | "low";
export type OpportunityEffortBand = "low" | "med" | "high";

const operationalAssumptionInput = z
  .object({
    value: z.number().nonnegative(),
    basis: z.enum(["evidence", "inferred"]),
    confidence: z.number().min(0).max(1),
    evidence_ids: z.array(z.string()).default([]),
  })
  .strict()
  .refine(
    (value) => value.basis !== "evidence" || value.evidence_ids.length > 0,
    {
      path: ["evidence_ids"],
      message: 'evidence_ids is required when basis is "evidence"',
    },
  );

export const opportunityProposalSchema = z
  .object({
    source_node_ids: z.array(z.string()).min(1),
    title: z.string().min(3),
    problem: z.string().min(3),
    proposed_solution: z.string().min(3),
    implementation_plan: z.string().min(3),
    expected_result: z.string().min(3),
    current_state: z.string().min(3),
    target_state: z.string().min(3),
    automation_type: z.enum(AUTOMATION_TYPES),
    pattern_id: z.string().min(1),
    pattern_label: z.string().min(1),
    impact_band: z.enum(["high", "med", "low"]),
    effort_band: z.enum(["low", "med", "high"]),
    assumption_confidence: z.number().min(0).max(1),
    evidence_ids: z.array(z.string()).default([]),
    rationale: z.string().min(3),
    assumptions: z
      .object({
        annual_volume: operationalAssumptionInput.optional(),
        minutes_saved_per_case: operationalAssumptionInput.optional(),
        error_rate: operationalAssumptionInput.optional(),
        exception_rate: operationalAssumptionInput.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export const opportunitySetSchema = z
  .object({
    opportunities: z.array(opportunityProposalSchema).max(12),
    diagnostics: z
      .array(z.object({ code: z.string(), message: z.string() }).strict())
      .default([]),
  })
  .strict();

export type OperationalAssumptionInput = z.infer<typeof operationalAssumptionInput>;
export type OpportunityProposal = z.infer<typeof opportunityProposalSchema>;
export type OpportunitySetExtraction = z.infer<typeof opportunitySetSchema>;

export type GroundedOpportunity = Opportunity & {
  source_node_ids: string[];
  source_node_id: string;
  source_node_title: string;
  evidence_ids: string[];
  evidence_label: string;
  current_state: string;
  target_state: string;
  implementation_plan: string;
  expected_result: string;
  impact: OpportunityImpactBand;
  effort_band: OpportunityEffortBand;
  grounding: "evidence" | "assumption";
  assumption_sources?: Record<string, {
    basis: "evidence" | "inferred";
    confidence: number;
    evidence_ids: string[];
  }>;
};

export type OpportunityPriceConstants = Pick<
  ROIAssumptions,
  "loaded_hourly_cost" | "cost_per_error" | "delay_cost"
>;

const forbiddenKeyPatterns = [
  /^net_score$/i,
  /^gross_value$/i,
  /^annual_.*_value$/i,
  /_cost$/i,
  /^price$/i,
  /^usd$/i,
  /^dollars$/i,
];

export function assertNoForbiddenOpportunityKeys(value: unknown) {
  const badKey = findForbiddenKey(value);
  if (badKey) {
    throw new Error(`Opportunity proposal contained forbidden ROI key: ${badKey}`);
  }
}

function findForbiddenKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findForbiddenKey(child);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeyPatterns.some((pattern) => pattern.test(key))) return key;
    const found = findForbiddenKey(child);
    if (found) return found;
  }
  return null;
}

export function stableHash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
