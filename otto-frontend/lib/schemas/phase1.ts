import { z } from "zod";

export const slotStateStatusSchema = z.enum([
  "empty",
  "partial",
  "filled",
  "asked_unknown",
  "conflicting",
  "pending_re_extract",
]);

export const phase1ClaimSchema = z.object({
  subject_type: z.string().min(1),
  subject_id: z.string().uuid(),
  field: z.string().min(1),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string().uuid()),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const phase1EvidenceSchema = z.object({
  source_type: z.enum([
    "transcript_segment",
    "screen_event",
    "document_chunk",
    "user_correction",
    "agent_inference",
  ]),
  source_id: z.string().uuid().optional(),
  evidence_label: z.enum([
    "observed",
    "stated_operator",
    "stated_director",
    "documented",
    "inferred",
    "confirmed",
    "corrected",
  ]),
  span_start: z.number().int().min(0).optional(),
  span_end: z.number().int().min(0).optional(),
  quote: z.string().optional(),
  summary: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export const phase1SlotStateSchema = z.object({
  slot_path: z.string().min(1),
  candidate_process_id: z.string().uuid().optional(),
  value: z.unknown().optional(),
  status: slotStateStatusSchema,
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string().uuid()),
  last_asked_at: z.string().datetime().optional(),
  priority: z.number().int().min(0),
  candidates: z.array(z.unknown()).optional(),
}).strict();

export const slotExtractionSchema = z.object({
  slot_updates: z.array(phase1SlotStateSchema).default([]),
  claims: z.array(phase1ClaimSchema).default([]),
  tool_calls: z
    .array(
      z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
      }).strict(),
    )
    .default([]),
  contradiction_signals: z.array(z.string()).default([]),
});

export const directorUtteranceTypeSchema = z.enum([
  "greeting",
  "meta_question",
  "clarification_request",
  "substantive_answer",
  "partial_answer",
  "non_answer",
  "dont_know",
  "correction",
  "contradiction",
  "off_topic",
]);

export const directorInterviewPhaseSchema = z.enum([
  "orient",
  "inventory",
  "expand",
  "enrich",
  "closeout",
]);

export const directorIntentSchema = z.object({
  intent: z.string().min(1),
  target_slot: z.string().min(1).optional(),
  target_process: z.string().min(1).optional(),
  score: z.number(),
  info_gain: z.number().optional(),
  conversational_fit: z.number().optional(),
  priority: z.number().optional(),
  recency: z.number().optional(),
  reason: z.string().min(1),
  style_hint: z.string().optional(),
}).strict();

export const directorTurnPlanSchema = z.object({
  utterance_type: directorUtteranceTypeSchema,
  chosen_intent: directorIntentSchema,
  planned_agent_utterance: z.string().min(1).optional(),
  current_phase: directorInterviewPhaseSchema,
  proposed_next_phase: directorInterviewPhaseSchema,
  phase_transition_ready: z.boolean(),
  slot_updates: z.array(phase1SlotStateSchema),
  claims: z.array(phase1ClaimSchema),
  tool_calls: z
    .array(
      z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()),
      }).strict(),
    ),
  contradiction_signals: z.array(z.string()),
  ranked_intents: z.array(directorIntentSchema),
  focus_candidate_process_id: z.string().uuid().optional(),
}).strict();

export const probeIntentRankingSchema = z.object({
  ranked_intents: z.array(
    z.object({
      probe_id: z.string().min(1),
      target_slot: z.string().min(1),
      score: z.number(),
      reason: z.string(),
      style_hint: z.string().optional(),
    }),
  ),
});

export const candidateProcessSchema = z.object({
  proposed_name: z.string().min(1),
  proposed_function: z.string().optional(),
  frequency: z.string().optional(),
  complexity_hint: z.string().optional(),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string().uuid()).default([]),
});

export const directorProcessInventorySchema = z.object({
  candidate_processes: z.array(candidateProcessSchema).default([]),
});

export const documentExtractionSchema = z.object({
  claims: z.array(phase1ClaimSchema).default([]),
  candidate_processes: z.array(candidateProcessSchema).default([]),
});

export const complexityScoreSchema = z.object({
  total: z.number().min(0).max(100),
  factors: z.array(
    z.object({
      name: z.string().min(1),
      score: z.number().min(0),
      assumption: z.string().optional(),
      evidence_ids: z.array(z.string().uuid()).default([]),
    }),
  ),
});

export const narrativeTabSchema = z.object({
  summary_paragraph: z.string(),
  what_this_process_involves: z.string().optional(),
  top_risks: z.array(z.string()).default([]),
  friction_signals: z.array(z.string()).default([]),
  recommended_drilldown_reason: z.string().optional(),
  evidence_ids: z.array(z.string().uuid()).min(1),
});

export const agentDecisionLogSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid().optional(),
  captureSessionId: z.string().uuid().optional(),
  synthesisRunId: z.string().uuid().optional(),
  turnIndex: z.number().int().min(0).optional(),
  stageName: z.string().min(1).optional(),
  tsStart: z.date().default(() => new Date()),
  tsEnd: z.date().optional(),
  transcriptSegmentIds: z.array(z.string().uuid()).default([]),
  slotUpdates: z.unknown().optional(),
  rankedProbeIntents: z.unknown().optional(),
  chosenIntent: z.unknown().optional(),
  sanitizedAgentUtterance: z.string().optional(),
  promptTemplateId: z.string().optional(),
  promptTemplateVersion: z.string().optional(),
  toolCalls: z.unknown().optional(),
  deliveryJson: z.unknown().optional(),
  model: z.string().optional(),
  tokenCountInput: z.number().int().min(0).optional(),
  tokenCountOutput: z.number().int().min(0).optional(),
  costCents: z.string().or(z.number()).optional(),
  latencyMs: z.number().int().min(0).optional(),
  cacheHit: z.boolean().optional(),
  degradedQuality: z.boolean().default(false),
  degradedReasons: z.array(z.string().min(1)).default([]),
});

export type AgentDecisionLogInput = z.input<typeof agentDecisionLogSchema>;
export type DirectorTurnPlan = z.infer<typeof directorTurnPlanSchema>;
export type SlotExtraction = z.infer<typeof slotExtractionSchema>;
export type DirectorIntent = z.infer<typeof directorIntentSchema>;
export type DirectorInterviewPhase = z.infer<typeof directorInterviewPhaseSchema>;
export type DirectorUtteranceType = z.infer<typeof directorUtteranceTypeSchema>;
