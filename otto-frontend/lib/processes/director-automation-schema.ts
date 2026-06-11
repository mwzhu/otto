import { z } from "zod";
import { AUTOMATION_TYPES, stableHash } from "@/lib/processes/opportunity-schema";

export const DIRECTOR_AUTOMATION_PROMPT_ID = "synthesis.director_automation";
// v2: tight planning bands (low >= 0.9 x base, high <= 1.1 x base) and the
// no-dollars rule extended to prose. The version feeds plan_input_hash, so
// bumping it lets unchanged inventory regenerate under the new rules instead
// of reusing a cached wide-band plan.
export const DIRECTOR_AUTOMATION_PROMPT_VERSION = "2";

export const DIRECTOR_AUTOMATION_PATTERN_CATALOG = [
  { pattern_id: "system-integration", pattern_label: "System integration", automation_type: "system_integration" },
  { pattern_id: "agent-assistant", pattern_label: "Agent assistant", automation_type: "agent_assistant" },
  { pattern_id: "exception-monitoring", pattern_label: "Exception monitoring", automation_type: "exception_monitoring" },
  { pattern_id: "approval-routing", pattern_label: "Approval routing", automation_type: "approval_routing" },
  { pattern_id: "data-validation", pattern_label: "Data validation", automation_type: "data_validation" },
  { pattern_id: "intake-form", pattern_label: "Intake form", automation_type: "intake_form" },
  { pattern_id: "report-generation", pattern_label: "Report generation", automation_type: "report_generation" },
  { pattern_id: "workflow-automation", pattern_label: "Workflow automation", automation_type: "workflow_automation" },
  { pattern_id: "knowledge-base", pattern_label: "Knowledge base", automation_type: "knowledge_base" },
] as const;

const rangeAssumption = (max?: number) =>
  z
    .object({
      low: z.number().nonnegative(),
      base: z.number().nonnegative(),
      high: z.number().nonnegative(),
      basis: z.enum(["evidence", "inferred"]),
      confidence: z.number().min(0).max(1),
      evidence_ids: z.array(z.string()).default([]),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.low > value.base || value.base > value.high) {
        ctx.addIssue({
          code: "custom",
          message: "range must satisfy low <= base <= high",
          path: ["base"],
        });
      }
      if (max !== undefined) {
        for (const key of ["low", "base", "high"] as const) {
          if (value[key] > max) {
            ctx.addIssue({
              code: "custom",
              message: `range ${key} must be <= ${max}`,
              path: [key],
            });
          }
        }
      }
      if (value.basis === "evidence" && value.evidence_ids.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: 'evidence_ids is required when basis is "evidence"',
          path: ["evidence_ids"],
        });
      }
      if (value.basis === "inferred" && value.confidence > 0.45) {
        ctx.addIssue({
          code: "custom",
          message: 'confidence must be <= 0.45 when basis is "inferred"',
          path: ["confidence"],
        });
      }
    });

export const directorAutomationPlanPayloadSchema = z
  .object({
    department_name: z.string().min(1),
    audit: z
      .object({
        problem: z.string().min(3),
        patterns: z
          .array(
            z
              .object({
                text: z.string().min(3),
                metric_basis: z.string().min(1),
                evidence_ids: z.array(z.string()).default([]),
              })
              .strict(),
          )
          .min(3),
      })
      .strict(),
    processes: z
      .array(
        z
          .object({
            candidate_process_id: z.string().min(1),
            process_name: z.string().min(1),
            implementation_plan: z.string().min(3),
            expected_result: z.string().min(3),
            automation_type: z.enum(AUTOMATION_TYPES),
            pattern_id: z.string().min(1),
            pattern_label: z.string().min(1),
            affected_roles: z.array(z.string()).default([]),
            affected_systems: z.array(z.string()).default([]),
            evidence_gaps: z.array(z.string()).default([]),
            confidence: z.number().min(0).max(1),
            effort_band: z.enum(["low", "med", "high"]),
            assumptions: z
              .object({
                annual_volume: rangeAssumption(),
                minutes_saved_per_case: rangeAssumption(),
                error_rate: rangeAssumption(1),
                exception_rate: rangeAssumption(1),
              })
              .strict(),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export const directorAutomationExtractionSchema = directorAutomationPlanPayloadSchema
  .extend({
    diagnostics: z
      .array(z.object({ code: z.string(), message: z.string() }).strict())
      .default([]),
  })
  .strict();

export type DirectorAutomationPlanPayload = z.infer<
  typeof directorAutomationPlanPayloadSchema
>;
export type DirectorAutomationExtractionValue = z.infer<
  typeof directorAutomationExtractionSchema
>;
export type DirectorRangeAssumption =
  DirectorAutomationPlanPayload["processes"][number]["assumptions"]["annual_volume"];

export const directorAutomationAnthropicToolSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    department_name: { type: "string" },
    audit: {
      type: "object",
      additionalProperties: false,
      properties: {
        problem: { type: "string" },
        patterns: {
          type: "array",
          minItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              metric_basis: { type: "string" },
              evidence_ids: { type: "array", items: { type: "string" } },
            },
            required: ["text", "metric_basis", "evidence_ids"],
          },
        },
      },
      required: ["problem", "patterns"],
    },
    processes: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_process_id: { type: "string" },
          process_name: { type: "string" },
          implementation_plan: { type: "string" },
          expected_result: { type: "string" },
          automation_type: { type: "string", enum: [...AUTOMATION_TYPES] },
          pattern_id: { type: "string" },
          pattern_label: { type: "string" },
          affected_roles: { type: "array", items: { type: "string" } },
          affected_systems: { type: "array", items: { type: "string" } },
          evidence_gaps: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          effort_band: { type: "string", enum: ["low", "med", "high"] },
          assumptions: {
            type: "object",
            additionalProperties: false,
            properties: {
              annual_volume: rangeAssumptionToolSchema(),
              minutes_saved_per_case: rangeAssumptionToolSchema(),
              error_rate: rangeAssumptionToolSchema(1),
              exception_rate: rangeAssumptionToolSchema(1),
            },
            required: [
              "annual_volume",
              "minutes_saved_per_case",
              "error_rate",
              "exception_rate",
            ],
          },
        },
        required: [
          "candidate_process_id",
          "process_name",
          "implementation_plan",
          "expected_result",
          "automation_type",
          "pattern_id",
          "pattern_label",
          "affected_roles",
          "affected_systems",
          "evidence_gaps",
          "confidence",
          "effort_band",
          "assumptions",
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
  required: ["department_name", "audit", "processes"],
} as const;

function rangeAssumptionToolSchema(max?: number) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      low: { type: "number", minimum: 0, ...(max === undefined ? {} : { maximum: max }) },
      base: { type: "number", minimum: 0, ...(max === undefined ? {} : { maximum: max }) },
      high: { type: "number", minimum: 0, ...(max === undefined ? {} : { maximum: max }) },
      basis: { type: "string", enum: ["evidence", "inferred"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence_ids: { type: "array", items: { type: "string" } },
    },
    required: ["low", "base", "high", "basis", "confidence", "evidence_ids"],
  };
}

export function directorAutomationPlanHash(value: DirectorAutomationPlanPayload) {
  return stableHash(value);
}
