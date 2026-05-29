import { z } from "zod";

const uuidSchema = z.string().uuid();

export const operatorToolSchemas = {
  mark_step_boundary: z
    .object({
      title: z.string().min(1),
      ts_start_ms: z.number().int().min(0).optional(),
      ts_end_ms: z.number().int().min(0).optional(),
      confidence: z.number().min(0).max(1).default(0.65),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  record_system_observed: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      system_name: z.string().min(1),
      role: z.enum(["source_of_truth", "working_tool", "communication", "unknown"]),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  record_input_output: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      io_type: z.enum(["input", "output"]),
      label: z.string().min(1),
      medium: z.string().min(1).optional(),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  record_decision_rule: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      condition: z.string().min(1),
      branches: z.array(z.string().min(1)).min(1),
      decision_owner: z.string().min(1).optional(),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  record_handoff: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      next_owner: z.string().min(1),
      handoff_trigger: z.string().min(1).optional(),
      medium: z.string().min(1).optional(),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  record_exception: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      condition: z.string().min(1),
      frequency: z.string().min(1).optional(),
      impact: z.string().min(1).optional(),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  record_workaround: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      workaround: z.string().min(1),
      reason: z.string().min(1).optional(),
      normal_workflow: z.boolean().optional(),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  flag_intentional_deviation: z
    .object({
      provisional_step_id: uuidSchema.optional(),
      deviation: z.string().min(1),
      reason: z.string().min(1).optional(),
      normal_workflow: z.boolean().optional(),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  update_slot_state: z
    .object({
      slot_path: z.string().min(1),
      provisional_step_id: uuidSchema.optional(),
      value: z.unknown().optional(),
      status: z.enum([
        "empty",
        "partial",
        "filled",
        "asked_unknown",
        "conflicting",
        "pending_re_extract",
      ]),
      confidence: z.number().min(0).max(1).default(0.65),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
  request_redaction: z
    .object({
      start_ms: z.number().int().min(0),
      end_ms: z.number().int().min(0),
      reason: z.string().min(1).optional(),
    })
    .strict()
    .refine((value) => value.end_ms >= value.start_ms, {
      message: "end_ms must be greater than or equal to start_ms",
    }),
  create_follow_up_gap: z
    .object({
      question: z.string().min(1),
      target_slot: z.string().min(1).optional(),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
      evidence_ids: z.array(uuidSchema).default([]),
    })
    .strict(),
} as const;

export type OperatorToolName = keyof typeof operatorToolSchemas;
export type OperatorToolCall<TName extends OperatorToolName = OperatorToolName> = {
  name: TName;
  arguments: z.infer<(typeof operatorToolSchemas)[TName]>;
};

export function isOperatorToolName(name: string): name is OperatorToolName {
  return name in operatorToolSchemas;
}

export function parseOperatorToolCall(call: {
  name: string;
  arguments: unknown;
}): OperatorToolCall {
  if (!isOperatorToolName(call.name)) {
    throw new Error(`Unknown operator tool: ${call.name}`);
  }
  return {
    name: call.name,
    arguments: operatorToolSchemas[call.name].parse(call.arguments),
  } as OperatorToolCall;
}
