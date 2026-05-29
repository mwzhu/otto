import { z } from "zod";
import { phase1ClaimSchema, slotStateStatusSchema } from "@/lib/schemas/phase1";
export {
  assertOperatorSlotPath,
  operatorSlotDefinitions,
  operatorSlotPriority,
  operatorSlotScope,
} from "@/lib/interview/operator/slot-schema";

export const operatorInterviewPhaseSchema = z.enum([
  "orient",
  "happy_path",
  "hard_case",
  "exception_sweep",
  "playback",
  "closeout",
]);

export const operatorIntentSchema = z
  .object({
    intent: z.string().min(1),
    target_slot: z.string().min(1).optional(),
    target_step_title: z.string().min(1).optional(),
    score: z.number(),
    reason: z.string().min(1),
    style_hint: z.string().optional(),
  })
  .strict();

export const operatorStepUpdateSchema = z
  .object({
    title: z.string().min(1),
    action_verb: z.string().min(1).optional(),
    action_object: z.string().min(1).optional(),
    ts_start_ms: z.number().int().min(0).optional(),
    ts_end_ms: z.number().int().min(0).optional(),
    confidence: z.number().min(0).max(1),
    evidence_ids: z.array(z.string().uuid()).default([]),
  })
  .strict();

export const operatorSlotUpdateSchema = z
  .object({
    slot_path: z.string().min(1),
    provisional_step_id: z.string().uuid().optional(),
    value: z.unknown().optional(),
    status: slotStateStatusSchema,
    confidence: z.number().min(0).max(1),
    evidence_ids: z.array(z.string().uuid()).default([]),
    candidates: z.array(z.unknown()).optional(),
  })
  .strict();

export const operatorTurnPlanSchema = z
  .object({
    utterance_type: z.enum([
      "substantive_answer",
      "partial_answer",
      "dont_know",
      "correction",
      "contradiction",
      "meta_question",
      "off_topic",
    ]),
    chosen_intent: operatorIntentSchema,
    planned_agent_utterance: z.string().min(1).optional(),
    current_phase: operatorInterviewPhaseSchema.default("orient"),
    proposed_next_phase: operatorInterviewPhaseSchema.default("happy_path"),
    phase_transition_ready: z.boolean().default(false),
    step_updates: z.array(operatorStepUpdateSchema).default([]),
    slot_updates: z.array(operatorSlotUpdateSchema).default([]),
    claims: z.array(phase1ClaimSchema).default([]),
    tool_calls: z
      .array(
        z
          .object({
            name: z.string().min(1),
            arguments: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .default([]),
    contradiction_signals: z.array(z.string()).default([]),
    ranked_intents: z.array(operatorIntentSchema),
  })
  .strict();

export type OperatorInterviewPhase = z.infer<typeof operatorInterviewPhaseSchema>;
export type OperatorIntent = z.infer<typeof operatorIntentSchema>;
export type OperatorStepUpdate = z.infer<typeof operatorStepUpdateSchema>;
export type OperatorSlotUpdate = z.infer<typeof operatorSlotUpdateSchema>;
export type OperatorTurnPlan = z.infer<typeof operatorTurnPlanSchema>;
