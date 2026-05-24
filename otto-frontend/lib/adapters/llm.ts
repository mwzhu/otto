import { withRetry, type RetryOptions } from "@/lib/adapters/retry";
import { getServerEnv } from "@/lib/env";
import {
  anthropicInterviewModel,
  MODEL_PRICING_CENTS_PER_MTOK,
} from "@/lib/ai/models";
import { z } from "zod";

export type PromptedCall = {
  prompt_template_id: string;
  prompt_template_version?: string;
  retry?: RetryOptions;
};

export type GenerateOpts = PromptedCall & {
  input: string;
  static_input?: string;
  dynamic_input?: string;
};

export type Generation = {
  text: string;
  model: string;
  prompt_template_id: string;
  prompt_template_version: string;
  token_count_input: number;
  token_count_output: number;
  cost_cents: number;
  latency_ms: number;
  cache_hit: boolean;
  mocked: boolean;
};

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

export async function generate(opts: GenerateOpts): Promise<Generation> {
  const started = Date.now();
  return withRetry(async () => {
    const input = [opts.static_input, opts.dynamic_input, opts.input]
      .filter(Boolean)
      .join("\n");
    const env = getServerEnv();
    if (env.ANTHROPIC_API_KEY) {
      return generateAnthropic(opts, started);
    }
    const text = `[mock:${opts.prompt_template_id}] ${input}`;
    return {
      text,
      model: "deterministic-local-llm",
      prompt_template_id: opts.prompt_template_id,
      prompt_template_version: opts.prompt_template_version ?? "1",
      token_count_input: estimateTokens(input),
      token_count_output: estimateTokens(text),
      cost_cents: 0,
      latency_ms: Math.max(1, Date.now() - started),
      cache_hit: false,
      mocked: true,
    };
  }, opts.retry);
}

export type StructuredGeneration<T> = {
  value: T;
  metadata: Generation;
};

export async function structured<T>(
  opts: GenerateOpts & {
    schema_name: string;
    schema?: z.ZodType<T>;
    mock?: unknown;
    mock_sequence?: unknown[];
  },
): Promise<StructuredGeneration<T>> {
  if (process.env.OTTO_LLM_FORCE_INVALID === "true") {
    throw new StructuredOutputError("Forced invalid structured output.");
  }
  const env = getServerEnv();
  if (!env.ANTHROPIC_API_KEY && (opts.mock !== undefined || opts.mock_sequence)) {
    const sequence = opts.mock_sequence ?? [opts.mock];
    let metadata = await generate(opts);
    const first = validateStructuredValue(sequence[0], opts.schema);
    if (first.ok) return { value: first.value, metadata };
    metadata = await generate({
      ...opts,
      input: [
        opts.input,
        "The previous response failed schema validation.",
        `Validation issues: ${JSON.stringify(first.issues)}`,
      ].join("\n"),
    });
    const second = validateStructuredValue(sequence[1] ?? sequence[0], opts.schema);
    if (second.ok) return { value: second.value, metadata };
    throw new StructuredOutputError(
      `Structured response did not match ${opts.schema_name}.`,
      second.issues,
    );
  }

  let metadata = await generate({
    ...opts,
    input: [
      opts.input,
      `Return only valid JSON for schema "${opts.schema_name}".`,
    ].join("\n"),
  });
  let parsed = safeParseJson(metadata.text);
  if (!opts.schema) {
    if (!parsed.ok) {
      throw new StructuredOutputError(parsed.message);
    }
    return { value: parsed.value as T, metadata };
  }
  let validation = parsed.ok ? opts.schema.safeParse(parsed.value) : parsed;
  if ("success" in validation && validation.success) {
    return { value: validation.data, metadata };
  }

  const issues =
    "success" in validation ? validation.error.issues : validation.message;
  metadata = await generate({
    ...opts,
    input: [
      opts.input,
      "The previous response failed schema validation.",
      `Validation issues: ${JSON.stringify(issues)}`,
      `Return only corrected valid JSON for schema "${opts.schema_name}".`,
    ].join("\n"),
  });
  parsed = safeParseJson(metadata.text);
  validation = parsed.ok ? opts.schema.safeParse(parsed.value) : parsed;
  if ("success" in validation && validation.success) {
    return { value: validation.data, metadata };
  }
  throw new StructuredOutputError(
    `Structured response did not match ${opts.schema_name}.`,
    "success" in validation ? validation.error.issues : validation.message,
  );
}

function validateStructuredValue<T>(
  value: unknown,
  schema?: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; issues: unknown } {
  if (!schema) return { ok: true, value: value as T };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: parsed.error.issues };
}

function estimateTokens(input: string) {
  return Math.max(1, Math.ceil(input.length / 4));
}

async function generateAnthropic(
  opts: GenerateOpts,
  started: number,
): Promise<Generation> {
  const env = getServerEnv();
  const model = anthropicInterviewModel(env);
  const content = [
    opts.static_input
      ? {
          type: "text",
          text: opts.static_input,
          cache_control: { type: "ephemeral" },
        }
      : undefined,
    opts.dynamic_input ? { type: "text", text: opts.dynamic_input } : undefined,
    opts.input ? { type: "text", text: opts.input } : undefined,
  ].filter(Boolean);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [{ role: "user", content }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const text =
    body.content?.find((block) => block.type === "text")?.text?.trim() ?? "";
  const inputTokens =
    body.usage?.input_tokens ??
    estimateTokens([opts.static_input, opts.dynamic_input, opts.input].join("\n"));
  const outputTokens = body.usage?.output_tokens ?? estimateTokens(text);
  const cacheReadTokens = body.usage?.cache_read_input_tokens ?? 0;
  return {
    text,
    model,
    prompt_template_id: opts.prompt_template_id,
    prompt_template_version: opts.prompt_template_version ?? "1",
    token_count_input: inputTokens,
    token_count_output: outputTokens,
    cost_cents: estimateAnthropicCostCents({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: body.usage?.cache_creation_input_tokens ?? 0,
    }),
    latency_ms: Math.max(1, Date.now() - started),
    cache_hit: cacheReadTokens > 0,
    mocked: false,
  };
}

function safeParseJson(text: string):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = match?.[1] ?? text;
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid JSON response.",
    };
  }
}

function estimateAnthropicCostCents(input: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) {
  const billableInput = Math.max(0, input.inputTokens - input.cacheReadTokens);
  const pricing = MODEL_PRICING_CENTS_PER_MTOK.claudeSonnet;
  const cents =
    (billableInput / 1_000_000) * pricing.input +
    (input.cacheCreationTokens / 1_000_000) * pricing.cacheWrite5m +
    (input.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (input.outputTokens / 1_000_000) * pricing.output;
  return Number(cents.toFixed(4));
}
