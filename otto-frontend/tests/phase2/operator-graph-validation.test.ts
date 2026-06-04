import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OperatorGraphValidationError,
  assertValidOperatorGraph,
  validateOperatorGraph,
  type OperatorGraphValidationIssue,
} from "@/lib/synthesis/operator-graph-validation";
import type { GraphEdge, GraphNode } from "@/lib/types/graph";
import { ratio, reportEvalScores } from "../evals/report";

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "../evals/operator/graph-fixtures.json"), "utf8"),
) as {
  cases: Array<{
    id: string;
    expected_ok: boolean;
    expected_issue_codes?: OperatorGraphValidationIssue["code"][];
    graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  }>;
};

describe("operator graph validation evals", () => {
  for (const evalCase of fixture.cases) {
    test(evalCase.id, () => {
      const result = validateOperatorGraph(evalCase.graph);
      expect(result.ok).toBe(evalCase.expected_ok);
      for (const code of evalCase.expected_issue_codes ?? []) {
        expect(result.issues.map((issue) => issue.code)).toContain(code);
      }
      if (evalCase.expected_ok) {
        expect(() => assertValidOperatorGraph(evalCase.graph)).not.toThrow();
      } else {
        expect(() => assertValidOperatorGraph(evalCase.graph)).toThrow(
          OperatorGraphValidationError,
        );
      }
    });
  }

  test("reports graph validation scored metrics", () => {
    const scores = fixture.cases.map((evalCase) => {
      const result = validateOperatorGraph(evalCase.graph);
      const expectedCodes = evalCase.expected_issue_codes ?? [];
      const actualCodes = result.issues.map((issue) => issue.code);
      return {
        expected_status_accuracy: result.ok === evalCase.expected_ok ? 1 : 0,
        expected_issue_recall: ratio(
          expectedCodes.filter((code) => actualCodes.includes(code)).length,
          expectedCodes.length,
        ),
        false_positive_issue_rate:
          expectedCodes.length === 0
            ? result.issues.length === 0
              ? 0
              : 1
            : ratio(
                actualCodes.filter((code) => !expectedCodes.includes(code)).length,
                actualCodes.length,
              ),
      };
    });
    const average = (metric: keyof (typeof scores)[number]) =>
      scores.reduce((sum, score) => sum + score[metric], 0) / scores.length;
    const metrics = [
      {
        name: "expected_status_accuracy",
        score: average("expected_status_accuracy"),
        minimum: 1,
      },
      {
        name: "expected_issue_recall",
        score: average("expected_issue_recall"),
        minimum: 1,
      },
      {
        name: "extra_issue_rate",
        score: average("false_positive_issue_rate"),
      },
    ];
    reportEvalScores({
      suite: "operator.graph-validation",
      fixture: "../evals/operator/graph-fixtures.json",
      cases: fixture.cases.length,
      metrics,
    });
    expect(metrics[0].score, metrics[0].name).toBeGreaterThanOrEqual(1);
    expect(metrics[1].score, metrics[1].name).toBeGreaterThanOrEqual(1);
  });
});
