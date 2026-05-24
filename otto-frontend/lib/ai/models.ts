import { type ServerEnv } from "@/lib/env";

export const MODEL_PRICING_CENTS_PER_MTOK = {
  claudeSonnet: {
    input: 300,
    cacheWrite5m: 375,
    cacheRead: 30,
    output: 1500,
  },
} as const;

export function anthropicInterviewModel(env: Pick<ServerEnv, "ANTHROPIC_MODEL">) {
  return env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
}
