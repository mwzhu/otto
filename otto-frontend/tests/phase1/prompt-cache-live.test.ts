import { loadEnvConfig } from "@next/env";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { generate, PROMPT_CACHE_MIN_STATIC_CHARS } from "@/lib/adapters/llm";
import { buildPromptCacheBlocks } from "@/lib/interview/director/brain";
import { buildOperatorPromptCacheBlocks } from "@/lib/interview/operator/brain";

loadEnvConfig(process.cwd());
loadEnvLocalForLiveTest();

type CacheProbe = {
  name: string;
  promptTemplateId: string;
  staticBlock: string;
  dynamicBlock: string;
};

const liveTest = process.env.OTTO_RUN_LIVE_CACHE_TEST === "true" ? test : test.skip;

describe("live hot interview prompt cache verification", () => {
  liveTest(
    "observes provider cache reads for non-voice Director and Operator prompts",
    async () => {
      expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is required").toBeTruthy();

      const probes = [directorProbe(), operatorProbe()];
      for (const probe of probes) {
        expect(probe.staticBlock.length, probe.name).toBeGreaterThanOrEqual(
          PROMPT_CACHE_MIN_STATIC_CHARS,
        );

        const first = await generate({
          prompt_template_id: probe.promptTemplateId,
          prompt_template_version: "cache-live",
          input: "Return only the text OK.",
          static_input: probe.staticBlock,
          dynamic_input: `${probe.dynamicBlock}\nCache probe turn: first write.`,
        });
        expect(first.mocked, probe.name).toBe(false);
        expect(first.cache_creation_input_tokens, probe.name).toBeGreaterThan(0);

        const second = await generate({
          prompt_template_id: probe.promptTemplateId,
          prompt_template_version: "cache-live",
          input: "Return only the text OK.",
          static_input: probe.staticBlock,
          dynamic_input: `${probe.dynamicBlock}\nCache probe turn: second read.`,
        });
        expect(second.mocked, probe.name).toBe(false);
        expect(second.cache_read_input_tokens, probe.name).toBeGreaterThan(0);
      }
    },
    120_000,
  );
});

function directorProbe(): CacheProbe {
  const blocks = buildPromptCacheBlocks({
    currentSlots: new Map([
      ["process.inventory", { status: "filled", confidence: 0.92 }],
      ["pain.frequency", { status: "filled", confidence: 0.81 }],
    ]),
    recentTurns: [
      "director: Tell me where the quoting process starts.",
      "user: Sales Ops owns it, and it starts when an AE sends a custom quote request.",
    ],
    latestUtterance:
      "The pricing team approves exceptions before finance books the final quote.",
    evidenceIds: ["00000000-0000-0000-0000-000000000101"],
    currentPhase: "inventory",
    candidateProcessNames: ["Custom quote approvals", "Renewal discount review"],
  });
  return {
    name: "director.turn.plan",
    promptTemplateId: "director.turn.plan",
    staticBlock: blocks.staticBlock,
    dynamicBlock: blocks.dynamicBlock,
  };
}

function operatorProbe(): CacheProbe {
  const blocks = buildOperatorPromptCacheBlocks({
    latestUtterance:
      "I open Salesforce, copy the quote number, and paste it into the pricing sheet.",
    evidenceIds: ["00000000-0000-0000-0000-000000000202"],
    currentPhase: "happy_path",
    currentSlots: [
      {
        slotPath: "step.action_object",
        status: "filled",
        confidence: 0.86,
        provisionalStepId: null,
        value: { text: "Copy quote number from Salesforce into pricing sheet" },
      },
    ],
    workspaceMemory: {
      candidateProcesses: ["Custom quote approvals owner=Sales Ops"],
      systems: ["Salesforce", "Pricing Sheet"],
      roles: ["Sales Ops", "Pricing Team"],
      people: [],
      vocabulary: ["quote exception [term] aliases=non-standard discount"],
      claims: ["Finance books final approved quotes"],
    },
    recentTurns: [
      "operator: First I open the opportunity in Salesforce.",
      "operator: Then I check whether the discount needs approval.",
    ],
    recentScreenEvents: [],
    sopChunks: [],
    liveReconciliationSignals: [],
  });
  return {
    name: "operator.turn.plan",
    promptTemplateId: "operator.turn.plan",
    staticBlock: blocks.staticBlock,
    dynamicBlock: blocks.dynamicBlock,
  };
}

function loadEnvLocalForLiveTest() {
  if (process.env.ANTHROPIC_API_KEY) return;
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    const rawValue = trimmed.slice(separator + 1).trim();
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, "$2");
  }
}
