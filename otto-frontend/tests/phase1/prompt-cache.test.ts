import { describe, expect, test } from "vitest";
import { PROMPT_CACHE_MIN_STATIC_CHARS } from "@/lib/adapters/llm";
import { buildPromptCacheBlocks } from "@/lib/interview/director/brain";
import { buildOperatorPromptCacheBlocks } from "@/lib/interview/operator/brain";

describe("hot interview prompt cache invariants", () => {
  test("director turn prompt keeps a cache-sized static prefix", () => {
    const latestUtterance = "unique-current-director-turn";
    const blocks = buildPromptCacheBlocks({
      currentSlots: new Map([
        ["process.inventory", { status: "filled", confidence: 0.9 }],
      ]),
      recentTurns: ["director: prior context"],
      latestUtterance,
      evidenceIds: ["00000000-0000-0000-0000-000000000001"],
      currentPhase: "orient",
      candidateProcessNames: ["Quote approvals"],
    });

    expect(blocks.staticBlock.length).toBeGreaterThanOrEqual(
      PROMPT_CACHE_MIN_STATIC_CHARS,
    );
    expect(blocks.staticBlock).not.toContain(latestUtterance);
    expect(blocks.dynamicBlock).toContain(latestUtterance);
  });

  test("operator turn prompt keeps a cache-sized static prefix", () => {
    const latestUtterance = "unique-current-operator-turn";
    const blocks = buildOperatorPromptCacheBlocks({
      latestUtterance,
      evidenceIds: ["00000000-0000-0000-0000-000000000002"],
      currentPhase: "happy_path",
      currentSlots: [
        {
          slotPath: "step.action_object",
          status: "filled",
          confidence: 0.8,
          provisionalStepId: null,
          value: { text: "Open Salesforce report" },
        },
      ],
      workspaceMemory: {
        candidateProcesses: ["Quote approvals owner=Sales Ops"],
        systems: ["Salesforce"],
        roles: ["Sales Ops"],
        people: [],
        vocabulary: ["ARR [metric] aliases=annual recurring revenue"],
        claims: [],
      },
      recentTurns: ["operator: I open Salesforce."],
      recentScreenEvents: [],
      sopChunks: [],
      liveReconciliationSignals: [],
    });

    expect(blocks.staticBlock.length).toBeGreaterThanOrEqual(
      PROMPT_CACHE_MIN_STATIC_CHARS,
    );
    expect(blocks.staticBlock).not.toContain(latestUtterance);
    expect(blocks.dynamicBlock).toContain(latestUtterance);
    expect(blocks.dynamicBlock).toContain("Salesforce");
  });
});
