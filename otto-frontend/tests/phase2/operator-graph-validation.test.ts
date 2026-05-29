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
});
