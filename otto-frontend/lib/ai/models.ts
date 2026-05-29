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

type AnthropicPricing = (typeof MODEL_PRICING_CENTS_PER_MTOK)[
  keyof typeof MODEL_PRICING_CENTS_PER_MTOK
];

export function anthropicInterviewModel(env: Pick<ServerEnv, "ANTHROPIC_MODEL">) {
  return env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
}

export function anthropicModelForPrompt(
  env: Pick<
    ServerEnv,
    | "ANTHROPIC_MODEL"
    | "DIRECTOR_BRAIN_MODEL"
    | "DIRECTOR_VOICE_MODEL"
    | "OPERATOR_BRAIN_MODEL"
    | "SYNTHESIS_PLANNER_MODEL"
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
    return env.DIRECTOR_VOICE_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  }
  if (promptTemplateId.startsWith("operator.turn.plan")) {
    return env.OPERATOR_BRAIN_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  }
  if (promptTemplateId.startsWith("operator.voice.")) {
    return env.OPERATOR_BRAIN_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  }
  if (promptTemplateId.startsWith("synthesis.")) {
    return env.SYNTHESIS_PLANNER_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  }
  return anthropicInterviewModel(env);
}

export function anthropicMaxTokensForPrompt(promptTemplateId: string) {
  if (promptTemplateId.startsWith("director.turn.plan")) return 8000;
  if (promptTemplateId.startsWith("director.turn.extract")) return 8000;
  if (promptTemplateId.startsWith("director.voice.")) return 200;
  if (promptTemplateId.startsWith("operator.turn.plan")) return 700;
  if (promptTemplateId.startsWith("operator.voice.")) return 200;
  return 1200;
}

export function anthropicPricingForModel(model: string): AnthropicPricing {
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return MODEL_PRICING_CENTS_PER_MTOK.claudeHaiku;
  if (normalized.includes("opus")) return MODEL_PRICING_CENTS_PER_MTOK.claudeOpus;
  return MODEL_PRICING_CENTS_PER_MTOK.claudeSonnet;
}
