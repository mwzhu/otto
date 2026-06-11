import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generate } from "@/lib/adapters/llm";

/**
 * Task 8: the director extraction call sends its large, byte-stable JSON tool
 * schema in `tools`, which renders before `system`/`messages` in the Anthropic
 * cache prefix. The adapter must mark that tool definition cacheable, otherwise
 * the schema is re-billed at full input price every turn.
 */
describe("anthropic tool-call prompt caching", () => {
  const priorKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used-network-is-mocked";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
  });

  test("tool definition on the extraction call carries an ephemeral cache breakpoint", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            name: "emit_director_slot_extraction",
            input: { slot_updates: [], claims: [], tool_calls: [], contradiction_signals: [] },
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_input_tokens: 4096,
          cache_read_input_tokens: 0,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await generate({
      prompt_template_id: "director.turn.extract",
      input: "",
      static_input: "static contract".repeat(400),
      dynamic_input: "latest utterance",
      anthropic_tool: {
        name: "emit_director_slot_extraction",
        description: "Emit director slot extraction.",
        input_schema: {
          type: "object",
          properties: { slot_updates: { type: "array", items: { type: "object" } } },
          additionalProperties: false,
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const tools = capturedBody?.tools as Array<Record<string, unknown>> | undefined;
    expect(tools).toHaveLength(1);
    expect(tools?.[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
