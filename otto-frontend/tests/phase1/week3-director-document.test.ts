import { describe, expect, test } from "vitest";
import { z } from "zod";
import { buildPromptCacheBlocks } from "@/lib/interview/director/brain";
import { structured, StructuredOutputError } from "@/lib/adapters/llm";
import { embedBatch, embedTextWithMetadata } from "@/lib/adapters/vector";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";
import {
  buildDocumentExtractionStaticInput,
  chunkDocument,
} from "@/lib/documents/pipeline";

describe("Week 3 director brain and document pipeline", () => {
  test("prompt cache assembly keeps static and dynamic blocks separate", () => {
    const blocks = buildPromptCacheBlocks({
      currentSlots: new Map([["scope.boundaries", { status: "empty", confidence: 0 }]]),
      recentTurns: ["We run promotion management weekly."],
      latestUtterance: "Salesforce and Google Sheets are involved.",
    });

    expect(blocks.staticBlock).toContain("Probe library");
    expect(blocks.staticBlock).toContain(directorSlotDefinitions[0].path);
    expect(blocks.staticBlock).not.toContain("Salesforce and Google Sheets");
    expect(blocks.dynamicBlock).toContain("Salesforce and Google Sheets");
    expect(blocks.dynamicBlock).toContain("scope.boundaries: empty");
  });

  test("cacheable static prompt blocks are large enough for Anthropic prompt caching", () => {
    const blocks = buildPromptCacheBlocks({
      currentSlots: new Map(),
      recentTurns: [],
      latestUtterance: "test",
    });
    expect(blocks.staticBlock.length).toBeGreaterThan(4096);
    expect(buildDocumentExtractionStaticInput().length).toBeGreaterThan(4096);
  });

  test("document chunking preserves stable ordinals and readable text", () => {
    const chunks = chunkDocument(
      [
        "Process: Promotion Management",
        "Systems: Salesforce, Google Sheets",
        "Pain points: manual spreadsheet cleanup.",
      ].join("\n"),
      40,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(
      "Promotion Management",
    );
  });

  test("structured adapter validates deterministic fallback and exposes forced failure", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const schema = z.object({ ok: z.boolean() });
    const result = await structured({
      prompt_template_id: "test.structured",
      schema_name: "test",
      schema,
      input: "Return ok",
      mock: { ok: true },
    });
    expect(result.value).toEqual({ ok: true });
    expect(result.metadata.mocked).toBe(true);
    expect(result.metadata.cache_hit).toBe(false);

    process.env.OTTO_LLM_FORCE_INVALID = "true";
    await expect(
      structured({
        prompt_template_id: "test.structured",
        schema_name: "test",
        schema,
        input: "Return ok",
        mock: { ok: true },
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    delete process.env.OTTO_LLM_FORCE_INVALID;
    if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
  });

  test("structured adapter retries once after local schema validation failure", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const schema = z.object({ ok: z.boolean() });
    const result = await structured({
      prompt_template_id: "test.structured.retry",
      schema_name: "test",
      schema,
      input: "Return ok",
      mock_sequence: [{ ok: "nope" }, { ok: true }],
    });
    expect(result.value).toEqual({ ok: true });
    if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
  });

  test("embedding adapter reports lexical fallback when no provider key is configured", async () => {
    const priorVoyage = process.env.VOYAGE_API_KEY;
    const priorOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = await embedTextWithMetadata({
      prompt_template_id: "test.embed",
      text: "Promotion Management",
      dimensions: 8,
    });
    expect(result.provider).toBe("lexical-fallback");
    expect(result.lexicalFallback).toBe(true);
    expect(result.embedding).toHaveLength(8);
    if (priorVoyage) process.env.VOYAGE_API_KEY = priorVoyage;
    if (priorOpenAi) process.env.OPENAI_API_KEY = priorOpenAi;
  });

  test("batch embedding preserves provider metadata", async () => {
    const priorVoyage = process.env.VOYAGE_API_KEY;
    const priorOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const results = await embedBatch({
      prompt_template_id: "test.embed.batch",
      texts: ["one", "two"],
      dimensions: 4,
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.provider === "lexical-fallback")).toBe(
      true,
    );
    expect(results[0].embedding).toHaveLength(4);
    if (priorVoyage) process.env.VOYAGE_API_KEY = priorVoyage;
    if (priorOpenAi) process.env.OPENAI_API_KEY = priorOpenAi;
  });
});
