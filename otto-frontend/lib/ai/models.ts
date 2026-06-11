import { type ServerEnv } from "@/lib/env";

export const MODEL_PRICING_CENTS_PER_MTOK = {
  claudeHaiku: {
    input: 80,
    cacheWrite5m: 100,
    cacheRead: 8,
    output: 400,
  },
  claudeSonnet: {
    input: 300,
    cacheWrite5m: 375,
    cacheRead: 30,
    output: 1500,
  },
  claudeOpus: {
    input: 1500,
    cacheWrite5m: 1875,
    cacheRead: 150,
    output: 7500,
  },
} as const;

export const FAST_VOICE_MODEL = "claude-haiku-4-5-20251001";

type AnthropicPricing = (typeof MODEL_PRICING_CENTS_PER_MTOK)[
  keyof typeof MODEL_PRICING_CENTS_PER_MTOK
];

export function anthropicInterviewModel(env: Pick<ServerEnv, "ANTHROPIC_MODEL">) {
  return env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
}

export function anthropicModelForPrompt(
  env: Partial<
    Pick<
      ServerEnv,
      | "ANTHROPIC_MODEL"
      | "DIRECTOR_BRAIN_MODEL"
      | "DIRECTOR_VOICE_MODEL"
      | "OPERATOR_BRAIN_MODEL"
      | "OPERATOR_VOICE_MODEL"
      | "OPERATOR_WORKFLOW_MODEL"
      | "SYNTHESIS_PLANNER_MODEL"
      | "OPPORTUNITY_MODEL"
      | "ANTHROPIC_OPUS_MODEL"
      | "ANTHROPIC_API_KEY"
    >
  >,
  promptTemplateId: string,
) {
  if (
    promptTemplateId.startsWith("director.turn.plan") ||
    promptTemplateId.startsWith("director.turn.extract")
  ) {
    return env.DIRECTOR_BRAIN_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  }
  if (promptTemplateId.startsWith("director.voice.")) {
    return env.DIRECTOR_VOICE_MODEL ?? FAST_VOICE_MODEL;
  }
  if (
    promptTemplateId.startsWith("director.checker.") ||
    promptTemplateId.startsWith("operator.checker.")
  ) {
    // Post-hoc spoken-output checkers. Deliberately outside the `*.voice.`
    // namespace: the voice prefixes carry a 200-token speech budget that
    // cannot fit a checker verdict (see anthropicMaxTokensForPrompt).
    return FAST_VOICE_MODEL;
  }
  if (promptTemplateId.startsWith("operator.turn.plan")) {
    return env.OPERATOR_BRAIN_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  }
  if (promptTemplateId.startsWith("operator.voice.")) {
    return env.OPERATOR_VOICE_MODEL ?? FAST_VOICE_MODEL;
  }
  if (isOperatorWorkflowPrompt(promptTemplateId)) {
    return (
      env.OPERATOR_WORKFLOW_MODEL ??
      env.OPERATOR_BRAIN_MODEL ??
      env.ANTHROPIC_MODEL ??
      "claude-sonnet-4-6"
    );
  }
  if (promptTemplateId.startsWith("synthesis.opportunities")) {
    return (
      env.OPPORTUNITY_MODEL ??
      env.SYNTHESIS_PLANNER_MODEL ??
      env.ANTHROPIC_MODEL ??
      providerDefaultOpusModel(env)
    );
  }
  if (promptTemplateId.startsWith("synthesis.director_automation")) {
    return env.SYNTHESIS_PLANNER_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  }
  if (promptTemplateId.startsWith("synthesis.")) {
    return env.SYNTHESIS_PLANNER_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  }
  return anthropicInterviewModel(env);
}

export function anthropicMaxTokensForPrompt(promptTemplateId: string) {
  if (promptTemplateId.startsWith("document.extract-claims")) return 8000;
  if (promptTemplateId.startsWith("director.turn.plan")) return 8000;
  // Task 8: cap the async extraction output budget. The extract schema emits
  // only slot_updates / claims / tool_calls / contradiction_signals (no spoken
  // utterance, no intent ranking), bounded by ~16 director slots plus a handful
  // of claims per turn. Prod session 83fdd5a6 peaked at ~1791 output tokens
  // across 20 turns, so 3000 leaves ~67% headroom over the worst observed turn
  // while bounding worst-case latency on a pathological over-generating turn
  // (Sonnet latency scales with tokens actually emitted, not the cap). Was 8000.
  if (promptTemplateId.startsWith("director.turn.extract")) return 3000;
  if (promptTemplateId.startsWith("director.voice.")) return 200;
  if (promptTemplateId.startsWith("director.checker.")) return 1500;
  if (promptTemplateId.startsWith("operator.turn.plan")) return 2000;
  if (promptTemplateId.startsWith("operator.voice.")) return 200;
  if (promptTemplateId.startsWith("operator.checker.")) return 1500;
  if (isOperatorWorkflowPrompt(promptTemplateId)) return 16000;
  if (promptTemplateId.startsWith("synthesis.opportunities")) return 4000;
  if (promptTemplateId.startsWith("synthesis.director_automation")) return 6000;
  return 1200;
}

export function providerDefaultOpusModel(
  env: Partial<Pick<ServerEnv, "ANTHROPIC_OPUS_MODEL" | "ANTHROPIC_API_KEY">>,
) {
  if (env.ANTHROPIC_OPUS_MODEL) return env.ANTHROPIC_OPUS_MODEL;
  if (!env.ANTHROPIC_API_KEY) return "deterministic-local-llm";
  throw new Error(
    "OPPORTUNITY_MODEL, SYNTHESIS_PLANNER_MODEL, ANTHROPIC_MODEL, or ANTHROPIC_OPUS_MODEL must be configured before running opportunity synthesis.",
  );
}

function isOperatorWorkflowPrompt(promptTemplateId: string) {
  return (
    promptTemplateId.startsWith("operator.workflow.") ||
    promptTemplateId.startsWith("operator.workflow_")
  );
}

export function anthropicPricingForModel(model: string): AnthropicPricing {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return MODEL_PRICING_CENTS_PER_MTOK.claudeHaiku;
  if (normalized.includes("opus")) return MODEL_PRICING_CENTS_PER_MTOK.claudeOpus;
  return MODEL_PRICING_CENTS_PER_MTOK.claudeSonnet;
}
