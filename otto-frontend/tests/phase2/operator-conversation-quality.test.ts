import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicOperatorTurnPlan } from "@/lib/interview/operator/brain";

type OperatorConversationEvalCase = {
  id: string;
  utterance: string;
  expected: {
    chosen_intent: string;
    required_phrase_fragments?: string[];
    forbidden_phrase_fragments?: string[];
  };
};

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "../evals/operator/conversational-quality.json"),
    "utf8",
  ),
) as { cases: OperatorConversationEvalCase[] };

describe("operator conversational quality smoke evals", () => {
  for (const evalCase of fixture.cases) {
    test(evalCase.id, () => {
      const plan = deterministicOperatorTurnPlan({
        orgId: "00000000-0000-0000-0000-000000000001",
        workspaceId: "00000000-0000-0000-0000-000000000002",
        processId: "00000000-0000-0000-0000-000000000003",
        captureSessionId: "00000000-0000-0000-0000-000000000004",
        userId: "00000000-0000-0000-0000-000000000005",
        language: "en",
        latestUtterance: evalCase.utterance,
        transcriptSegmentIds: ["00000000-0000-0000-0000-000000000006"],
        evidenceIds: ["00000000-0000-0000-0000-000000000007"],
        turnIndex: 1,
      });
      const utterance = plan.planned_agent_utterance ?? "";
      expect(plan.chosen_intent.intent).toBe(evalCase.expected.chosen_intent);
      expect(utterance).toBeTruthy();
      expect(questionCount(utterance)).toBeLessThanOrEqual(1);
      expect(utterance.length).toBeLessThanOrEqual(160);
      const normalized = utterance.toLowerCase();
      for (const fragment of evalCase.expected.required_phrase_fragments ?? []) {
        expect(normalized).toContain(fragment.toLowerCase());
      }
      for (const fragment of evalCase.expected.forbidden_phrase_fragments ?? []) {
        expect(normalized).not.toContain(fragment.toLowerCase());
      }
      expect(normalized).not.toContain("slot");
      expect(normalized).not.toContain("schema");
      expect(normalized).not.toContain("ranked intent");
    });
  }

  test("deterministic planner advances from orient into happy path after a concrete step", () => {
    const plan = deterministicOperatorTurnPlan({
      orgId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
      processId: "00000000-0000-0000-0000-000000000003",
      captureSessionId: "00000000-0000-0000-0000-000000000004",
      userId: "00000000-0000-0000-0000-000000000005",
      language: "en",
      latestUtterance: "I open Salesforce and export the weekly renewal report.",
      transcriptSegmentIds: ["00000000-0000-0000-0000-000000000006"],
      evidenceIds: ["00000000-0000-0000-0000-000000000007"],
      turnIndex: 1,
      currentPhase: "orient",
    });

    expect(plan.current_phase).toBe("orient");
    expect(plan.proposed_next_phase).toBe("happy_path");
    expect(plan.phase_transition_ready).toBe(true);
  });
});

function questionCount(text: string) {
  return [...text].filter((char) => char === "?").length;
}
