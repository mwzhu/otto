import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkOperatorSpokenOutput,
  deterministicOperatorTurnPlan,
} from "@/lib/interview/operator/brain";
import { ratio, reportEvalScores } from "../evals/report";

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

  test("operator output checker accepts concise single-question turns", async () => {
    const check = await checkOperatorSpokenOutput({
      spokenAgentUtterance: "What happens immediately after that step?",
      steeringContext: {},
    });

    expect(check.checker_status).toBe("complete");
    expect(check.checker_violation_count).toBe(0);
  });

  test("operator output checker catches internal mechanics and multiple questions", async () => {
    const check = await checkOperatorSpokenOutput({
      spokenAgentUtterance:
        "Which slot should I update? Should I emit the schema now?",
      steeringContext: {},
    });

    expect(check.violations.map((violation) => violation.type)).toEqual(
      expect.arrayContaining(["multiple_questions", "internal_mechanics"]),
    );
  });

  test("reports aggregate conversational quality metrics", () => {
    const scores = fixture.cases.map((evalCase) => {
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
      const normalized = utterance.toLowerCase();
      return {
        intent_accuracy:
          plan.chosen_intent.intent === evalCase.expected.chosen_intent ? 1 : 0,
        required_phrase_recall: ratio(
          (evalCase.expected.required_phrase_fragments ?? []).filter((fragment) =>
            normalized.includes(fragment.toLowerCase()),
          ).length,
          evalCase.expected.required_phrase_fragments?.length ?? 0,
        ),
        forbidden_phrase_precision: (evalCase.expected.forbidden_phrase_fragments ?? [])
          .every((fragment) => !normalized.includes(fragment.toLowerCase()))
          ? 1
          : 0,
        single_question_rate: questionCount(utterance) <= 1 ? 1 : 0,
        brevity_rate: utterance.length <= 160 ? 1 : 0,
        internal_jargon_avoidance: /slot|schema|ranked intent/i.test(utterance)
          ? 0
          : 1,
      };
    });
    const average = (metric: keyof (typeof scores)[number]) =>
      scores.reduce((sum, score) => sum + score[metric], 0) / scores.length;
    const metrics = [
      "intent_accuracy",
      "required_phrase_recall",
      "forbidden_phrase_precision",
      "single_question_rate",
      "brevity_rate",
      "internal_jargon_avoidance",
    ].map((name) => ({
      name,
      score: average(name as keyof (typeof scores)[number]),
      minimum: 1,
    }));
    reportEvalScores({
      suite: "operator.conversational-quality",
      fixture: "../evals/operator/conversational-quality.json",
      cases: fixture.cases.length,
      metrics,
    });
    for (const metric of metrics) {
      expect(metric.score, metric.name).toBeGreaterThanOrEqual(metric.minimum);
    }
  });
});

function questionCount(text: string) {
  return [...text].filter((char) => char === "?").length;
}
