import { withRetry, type RetryOptions } from "@/lib/adapters/retry";
import { getServerEnv } from "@/lib/env";
import {
  anthropicMaxTokensForPrompt,
  anthropicModelForPrompt,
  anthropicPricingForModel,
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
  anthropic_tool?: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
};

export type Generation = {
  text: string;
  model: string;
  prompt_template_id: string;
  prompt_template_version: string;
  token_count_input: number;
  token_count_output: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_cents: number;
  latency_ms: number;
  cache_hit: boolean;
  mocked: boolean;
  streaming?: boolean;
  stream_cutoff?: "first_question" | "message_stop";
  stop_reason?: string;
};

export const PROMPT_CACHE_MIN_STATIC_CHARS = 4096;
const anthropicModelPreflightCache = new Set<string>();

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
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_cents: 0,
      latency_ms: Math.max(1, Date.now() - started),
      cache_hit: false,
      mocked: true,
    };
  }, opts.retry);
}

export async function preflightAnthropicModelForPrompt(
  promptTemplateId: string,
): Promise<string> {
  const env = getServerEnv();
  const model = anthropicModelForPrompt(env, promptTemplateId);
  if (!env.ANTHROPIC_API_KEY || anthropicModelPreflightCache.has(model)) {
    return model;
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "OK" }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic model preflight failed for ${model}: ${response.status}`);
  }
  anthropicModelPreflightCache.add(model);
  return model;
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
  if (metadata.stop_reason === "max_tokens") {
    throw new StructuredOutputError(
      `Structured response for ${opts.schema_name} was truncated at max_tokens.`,
      { stop_reason: metadata.stop_reason, token_count_output: metadata.token_count_output },
    );
  }
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
  if (metadata.stop_reason === "max_tokens") {
    throw new StructuredOutputError(
      `Structured repair response for ${opts.schema_name} was truncated at max_tokens.`,
      { stop_reason: metadata.stop_reason, token_count_output: metadata.token_count_output },
    );
  }
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

export async function structuredStream<T>(
  opts: GenerateOpts & {
    schema_name: string;
    schema?: z.ZodType<T>;
    mock?: unknown;
    onFieldComplete?: (field: string, value: string) => void;
  },
): Promise<StructuredGeneration<T>> {
  const env = getServerEnv();
  if (!env.ANTHROPIC_API_KEY || !opts.anthropic_tool) {
    const metadata = await generate(opts);
    const value = opts.mock ?? safeParseJson(metadata.text);
    const validation = validateStructuredValue(value, opts.schema);
    if (validation.ok) {
      return {
        value: validation.value,
        metadata: {
          ...metadata,
          streaming: false,
          stream_cutoff: "message_stop",
        },
      };
    }
    throw new StructuredOutputError(
      `Structured response did not match ${opts.schema_name}.`,
      validation.issues,
    );
  }

  const result = await generateAnthropicToolStream(opts);
  if (result.stop_reason === "max_tokens") {
    throw new StructuredOutputError(
      `Structured response for ${opts.schema_name} was truncated at max_tokens.`,
      { stop_reason: result.stop_reason, token_count_output: result.token_count_output },
    );
  }
  const parsed = safeParseJson(result.text);
  const validation = parsed.ok ? validateStructuredValue(parsed.value, opts.schema) : parsed;
  if ("ok" in validation && validation.ok) {
    return { value: validation.value, metadata: result };
  }
  throw new StructuredOutputError(
    `Structured response did not match ${opts.schema_name}.`,
    "issues" in validation ? validation.issues : validation.message,
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
  const model = anthropicModelForPrompt(env, opts.prompt_template_id);
  const content = [
    staticTextBlock(opts.static_input),
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
      max_tokens: anthropicMaxTokensForPrompt(opts.prompt_template_id),
      messages: [{ role: "user", content }],
      ...(opts.anthropic_tool
        ? {
            tools: [
              {
                name: opts.anthropic_tool.name,
                description: opts.anthropic_tool.description,
                input_schema: opts.anthropic_tool.input_schema,
              },
            ],
            tool_choice: {
              type: "tool",
              name: opts.anthropic_tool.name,
            },
          }
        : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    stop_reason?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const toolUse = opts.anthropic_tool
    ? body.content?.find(
        (block) =>
          block.type === "tool_use" &&
          block.name === opts.anthropic_tool?.name &&
          block.input !== undefined,
      )
    : undefined;
  const text = toolUse
    ? JSON.stringify(toolUse.input)
    : body.content?.find((block) => block.type === "text")?.text?.trim() ?? "";
  const inputTokens =
    body.usage?.input_tokens ??
    estimateTokens([opts.static_input, opts.dynamic_input, opts.input].join("\n"));
  const outputTokens = body.usage?.output_tokens ?? estimateTokens(text);
  const cacheReadTokens = body.usage?.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = body.usage?.cache_creation_input_tokens ?? 0;
  return {
    text,
    model,
    prompt_template_id: opts.prompt_template_id,
    prompt_template_version: opts.prompt_template_version ?? "1",
    token_count_input: inputTokens,
    token_count_output: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cost_cents: estimateAnthropicCostCents({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    }),
    latency_ms: Math.max(1, Date.now() - started),
    cache_hit: cacheReadTokens > 0,
    mocked: false,
    stop_reason: body.stop_reason,
  };
}

async function generateAnthropicToolStream(
  opts: GenerateOpts & {
    onFieldComplete?: (field: string, value: string) => void;
  },
): Promise<Generation> {
  if (!opts.anthropic_tool) {
    throw new Error("Anthropic tool streaming requires anthropic_tool.");
  }
  const started = Date.now();
  const env = getServerEnv();
  const model = anthropicModelForPrompt(env, opts.prompt_template_id);
  const content = [
    staticTextBlock(opts.static_input),
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
      max_tokens: anthropicMaxTokensForPrompt(opts.prompt_template_id),
      stream: true,
      messages: [{ role: "user", content }],
      tools: [
        {
          name: opts.anthropic_tool.name,
          description: opts.anthropic_tool.description,
          input_schema: opts.anthropic_tool.input_schema,
        },
      ],
      tool_choice: {
        type: "tool",
        name: opts.anthropic_tool.name,
      },
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Anthropic streaming request failed: ${response.status}`);
  }

  let toolJson = "";
  let plannedUtteranceEmitted = false;
  let usage: AnthropicUsage = {};
  let stopReason: string | undefined;
  for await (const event of anthropicStreamEvents(response.body)) {
    usage = mergeAnthropicUsage(usage, event);
    stopReason = event.delta?.stop_reason ?? event.message?.stop_reason ?? stopReason;
    const delta = event.delta;
    if (!delta || delta.type !== "input_json_delta") continue;
    toolJson += String(delta.partial_json ?? "");
    if (!plannedUtteranceEmitted) {
      const plannedUtterance = completeJsonStringField(
        toolJson,
        "planned_agent_utterance",
      );
      if (plannedUtterance) {
        plannedUtteranceEmitted = true;
        opts.onFieldComplete?.("planned_agent_utterance", plannedUtterance);
      }
    }
  }

  const inputTokens =
    usage.input_tokens ??
    estimateTokens([opts.static_input, opts.dynamic_input, opts.input].join("\n"));
  const outputTokens = usage.output_tokens ?? estimateTokens(toolJson);
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    text: toolJson,
    model,
    prompt_template_id: opts.prompt_template_id,
    prompt_template_version: opts.prompt_template_version ?? "1",
    token_count_input: inputTokens,
    token_count_output: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cost_cents: estimateAnthropicCostCents({
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    }),
    latency_ms: Math.max(1, Date.now() - started),
    cache_hit: cacheReadTokens > 0,
    mocked: false,
    streaming: true,
    stream_cutoff: plannedUtteranceEmitted ? "first_question" : "message_stop",
    stop_reason: stopReason,
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

function staticTextBlock(text?: string) {
  if (!text) return undefined;
  return text.length >= PROMPT_CACHE_MIN_STATIC_CHARS
    ? {
        type: "text",
        text,
        cache_control: { type: "ephemeral" },
      }
    : { type: "text", text };
}

function estimateAnthropicCostCents(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}) {
  const billableInput = Math.max(0, input.inputTokens - input.cacheReadTokens);
  const pricing = anthropicPricingForModel(input.model);
  const cents =
    (billableInput / 1_000_000) * pricing.input +
    (input.cacheCreationTokens / 1_000_000) * pricing.cacheWrite5m +
    (input.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (input.outputTokens / 1_000_000) * pricing.output;
  return Number(cents.toFixed(4));
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AnthropicStreamEvent = {
  delta?: {
    type?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
  message?: {
    usage?: AnthropicUsage;
    stop_reason?: string;
  };
};

async function* anthropicStreamEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let separator = pending.indexOf("\n\n");
      while (separator !== -1) {
        const rawEvent = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        const parsed = parseAnthropicSseEvent(rawEvent);
        if (parsed) yield parsed;
        separator = pending.indexOf("\n\n");
      }
    }
    pending += decoder.decode();
    const parsed = parseAnthropicSseEvent(pending);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function parseAnthropicSseEvent(rawEvent: string): AnthropicStreamEvent | null {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as AnthropicStreamEvent;
  } catch {
    return null;
  }
}

function mergeAnthropicUsage(
  current: AnthropicUsage,
  event: AnthropicStreamEvent,
): AnthropicUsage {
  const next = { ...current };
  for (const source of [event.usage, event.message?.usage]) {
    if (!source) continue;
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ] as const) {
      const value = source[key];
      if (typeof value === "number") next[key] = Math.max(next[key] ?? 0, value);
    }
  }
  return next;
}

export function completeJsonStringField(text: string, field: string) {
  const key = JSON.stringify(field);
  const keyIndex = text.indexOf(key);
  if (keyIndex === -1) return null;
  let index = keyIndex + key.length;
  while (/\s/.test(text[index] ?? "")) index += 1;
  if (text[index] !== ":") return null;
  index += 1;
  while (/\s/.test(text[index] ?? "")) index += 1;
  if (text[index] !== "\"") return null;
  const valueStart = index;
  index += 1;
  let escaped = false;
  while (index < text.length) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      try {
        return JSON.parse(text.slice(valueStart, index + 1)) as string;
      } catch {
        return null;
      }
    }
    index += 1;
  }
  return null;
}
