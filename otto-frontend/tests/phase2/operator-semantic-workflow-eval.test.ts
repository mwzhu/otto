import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { validateOperatorGraph } from "@/lib/synthesis/operator-graph-validation";
import type { ProcessGraph } from "@/lib/types/graph";
import type { WorkflowSemanticModel } from "@/lib/workflow/semantic-model";
import { validateWorkflowSemanticModel } from "@/lib/workflow/semantic-validation";
import { workflowSemanticModelToGraph } from "@/lib/workflow/semantic-to-graph";

type BusinessWorkflowFixture = {
  minimums: {
    business_step_recall: number;
    decision_recall: number;
    wait_recall: number;
    exception_loop_recall: number;
    technical_artifact_leakage_rate: number;
    hallucinated_evidence_id_count: number;
    unresolved_topology_target_count: number;
  };
  cases: Array<{
    id: string;
    expected?: {
      key_phrases: string[];
      decision_count: number;
      wait_count: number;
      exception_count: number;
      loop_count: number;
      handoff_count: number;
    };
    expected_issue_codes?: string[];
    evidenceById: Record<string, string>;
    model: WorkflowSemanticModel;
  }>;
};

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "../evals/operator/business-workflow-fixtures.json"),
    "utf8",
  ),
) as BusinessWorkflowFixture;

describe("operator semantic workflow business-map evals", () => {
  test("positive fixtures meet structural and grounding gates", () => {
    const scores = fixture.cases
      .filter((evalCase) => evalCase.expected)
      .map((evalCase) => {
        const validation = validateWorkflowSemanticModel({
          model: evalCase.model,
          evidenceById: evalCase.evidenceById,
        });
        expect(validation.issues, evalCase.id).toEqual([]);
        const graph = workflowSemanticModelToGraph(validation.model);
        expect(validateOperatorGraph(graph).issues, evalCase.id).toEqual([]);
        return scoreFixture(evalCase.expected!, graph);
      });

    const average = averageScores(scores);
    expect(average.business_step_recall).toBeGreaterThanOrEqual(
      fixture.minimums.business_step_recall,
    );
    expect(average.decision_recall).toBeGreaterThanOrEqual(
      fixture.minimums.decision_recall,
    );
    expect(average.wait_recall).toBeGreaterThanOrEqual(
      fixture.minimums.wait_recall,
    );
    expect(average.exception_loop_recall).toBeGreaterThanOrEqual(
      fixture.minimums.exception_loop_recall,
    );
    expect(average.technical_artifact_leakage_rate).toBe(
      fixture.minimums.technical_artifact_leakage_rate,
    );
    expect(average.hallucinated_evidence_id_count).toBe(
      fixture.minimums.hallucinated_evidence_id_count,
    );
    expect(average.unresolved_topology_target_count).toBe(
      fixture.minimums.unresolved_topology_target_count,
    );
  });

  test("negative fixtures catch technical artifacts and invalid topology", () => {
    for (const evalCase of fixture.cases.filter((item) => item.expected_issue_codes)) {
      const validation = validateWorkflowSemanticModel({
        model: evalCase.model,
        evidenceById: evalCase.evidenceById,
      });
      expect(validation.ok, evalCase.id).toBe(false);
      for (const code of evalCase.expected_issue_codes ?? []) {
        expect(validation.issues.map((issue) => issue.code), evalCase.id).toContain(
          code,
        );
      }
    }
  });
});

function scoreFixture(
  expected: NonNullable<BusinessWorkflowFixture["cases"][number]["expected"]>,
  graph: Omit<ProcessGraph, "process_id" | "version_number" | "status">,
) {
  const nodeTitles = graph.nodes.map((node) => normalize(node.data.title));
  const allTitles = nodeTitles.join(" ");
  const keyPhraseMatches = expected.key_phrases.filter((phrase) =>
    phrase
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => allTitles.includes(normalize(token))),
  ).length;
  const decisionCount = graph.nodes.filter((node) => node.type === "decision").length;
  const waitCount = graph.nodes.filter((node) => node.type === "wait").length;
  const exceptionCount = graph.nodes.filter((node) => node.type === "exception").length;
  const loopCount = graph.edges.filter((edge) => edge.is_exception_path).length;
  const handoffCount =
    graph.nodes.filter((node) => node.type === "handoff").length +
    graph.edges.filter((edge) => edge.edge_type === "handoff").length;
  const technicalLeakCount = graph.nodes.filter((node) =>
    /keyframe|operator capture|ocr pending|livekit|screen frame sampled/i.test(
      node.data.title,
    ),
  ).length;

  return {
    business_step_recall: ratio(keyPhraseMatches, expected.key_phrases.length),
    decision_recall: recallForCount(decisionCount, expected.decision_count),
    wait_recall: recallForCount(waitCount, expected.wait_count),
    exception_loop_recall: recallForCount(loopCount, expected.loop_count),
    handoff_recall: recallForCount(handoffCount, expected.handoff_count),
    technical_artifact_leakage_rate: ratio(technicalLeakCount, graph.nodes.length),
    hallucinated_evidence_id_count: 0,
    unresolved_topology_target_count: graph.edges.filter((edge) => !edge.target).length,
    exception_recall: recallForCount(exceptionCount, expected.exception_count),
  };
}

function averageScores(scores: ReturnType<typeof scoreFixture>[]) {
  const keys = Object.keys(scores[0] ?? {}) as Array<keyof ReturnType<typeof scoreFixture>>;
  return Object.fromEntries(
    keys.map((key) => [
      key,
      scores.reduce((sum, score) => sum + Number(score[key]), 0) /
        Math.max(scores.length, 1),
    ]),
  ) as ReturnType<typeof scoreFixture>;
}

function recallForCount(actual: number, expected: number) {
  if (expected === 0) return actual === 0 ? 1 : 0;
  return Math.min(1, actual / expected);
}

function ratio(numerator: number, denominator: number) {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

function normalize(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
