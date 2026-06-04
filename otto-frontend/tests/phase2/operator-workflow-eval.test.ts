import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDeterministicOperatorGraph,
  detectOperatorContradictionGaps,
  segmentOperatorEvidencePack,
  type OperatorEvidencePack,
} from "@/lib/synthesis/operator-process";
import {
  layoutOperatorGraph,
  operatorEdgeWaypoints,
} from "@/lib/synthesis/operator-layout";
import { averageMetric, reportEvalScores } from "../evals/report";

type WorkflowFixture = {
  minimums: Record<
    | "step_recall"
    | "edge_recall"
    | "order_correlation"
    | "evidence_attribution_rate"
    | "exception_recall"
    | "workaround_recall",
    number
  >;
  cases: Array<{
    id: string;
    expected_steps: string[];
    expected_edge_count: number;
    expected_exception_count: number;
    expected_workaround_count: number;
    pack: Omit<
      OperatorEvidencePack,
      "orgId" | "workspaceId" | "processId" | "captureSessionIds"
    > & {
      evidenceByWindow?: Array<{ id: string; startMs: number; endMs: number }>;
    };
  }>;
};

const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "../evals/operator/workflow-fixtures.json"),
    "utf8",
  ),
) as WorkflowFixture;

describe("operator workflow builder early eval gate", () => {
  test("hand-labeled fixtures meet minimum graph quality metrics", () => {
    const scores = fixture.cases.map((evalCase) => {
      const graph = buildDeterministicOperatorGraph(packFromFixture(evalCase.pack));
      const taskNodes = graph.nodes.filter((node) => node.type === "task");
      const actualTitles = taskNodes.map((node) => node.data.title);
      const matchedIndexes = evalCase.expected_steps
        .map((expected) => actualTitles.findIndex((actual) => titleMatches(actual, expected)))
        .filter((index) => index >= 0);
      const evidenceBackedTasks = taskNodes.filter(
        (node) => (node.data.evidence_ids ?? []).length > 0,
      ).length;
      const exceptionCount = taskNodes.reduce(
        (count, node) => count + (node.data.exceptions?.length ?? 0),
        0,
      );
      const workaroundCount = taskNodes.reduce(
        (count, node) => count + (node.data.workarounds?.length ?? 0),
        0,
      );
      return {
        step_recall: ratio(matchedIndexes.length, evalCase.expected_steps.length),
        edge_recall: ratio(graph.edges.length, evalCase.expected_edge_count),
        order_correlation: orderCorrelation(matchedIndexes),
        evidence_attribution_rate: ratio(evidenceBackedTasks, taskNodes.length),
        exception_recall: recallForCount(
          exceptionCount,
          evalCase.expected_exception_count,
        ),
        workaround_recall: recallForCount(
          workaroundCount,
          evalCase.expected_workaround_count,
        ),
      };
    });

    const metrics = Object.entries(fixture.minimums).map(([metric, minimum]) => ({
      name: metric,
      score: averageMetric(scores, metric as keyof (typeof scores)[number]),
      minimum,
    }));
    reportEvalScores({
      suite: "operator.workflow-builder",
      fixture: "../evals/operator/workflow-fixtures.json",
      cases: fixture.cases.length,
      metrics,
    });
    for (const metric of metrics) {
      expect(metric.score, `${metric.name} average`).toBeGreaterThanOrEqual(
        metric.minimum,
      );
    }
  });

  test("screen evidence enriches graph nodes with systems and IO", () => {
    const graph = buildDeterministicOperatorGraph({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Revenue report export",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [],
      screenEvents: [
        {
          id: "se-system-1",
          tsMs: 5000,
          label: "Export Salesforce revenue report to CSV",
          appName: "Salesforce",
          windowTitle: "Salesforce Reports",
          url: "https://salesforce.example/reports",
          ocrText: "Export CSV",
          signalTags: ["copy_paste_between_systems", "file_download_upload"],
          evidenceIds: ["e-system-1"],
        },
      ],
      documentChunks: [],
      provisionalSteps: [],
      slotStates: [],
    });
    const task = graph.nodes.find((node) => node.type === "task");
    expect(task?.data.systems).toContain("Salesforce");
    expect(task?.data.inputs?.map((item) => item.name)).toContain("Copied source data");
    expect(task?.data.outputs?.map((item) => item.name)).toContain("Downloaded or exported file");
    expect(task?.data.outputs?.map((item) => item.name)).toContain("Pasted target data");
  });

  test("mixed capture modes all contribute graph task evidence", () => {
    const graph = buildDeterministicOperatorGraph({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Vendor onboarding",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [
        {
          id: "ts-mixed-1",
          text: "Then we send the vendor packet to legal for review.",
          startMs: 5000,
          endMs: 8000,
          evidenceIds: ["e-transcript-1"],
        },
      ],
      screenEvents: [
        {
          id: "se-mixed-1",
          tsMs: 12000,
          label: "Export vendor CSV from NetSuite",
          appName: "NetSuite",
          windowTitle: "Vendor list",
          url: "https://netsuite.example/vendors",
          ocrText: "Export CSV",
          signalTags: ["file_download_upload"],
          evidenceIds: ["e-screen-1"],
        },
      ],
      documentChunks: [
        {
          id: "dc-mixed-1",
          ordinal: 1,
          text: "Finance verifies the W-9 before vendor activation.",
          evidenceIds: ["e-doc-1"],
        },
      ],
      provisionalSteps: [
        {
          id: "ps-mixed-1",
          tsStartMs: 1000,
          tsEndMs: 3000,
          title: "Create vendor record",
          confidence: 0.72,
        },
      ],
      slotStates: [],
    });

    const taskNodes = graph.nodes.filter((node) => node.type === "task");
    expect(taskNodes.map((node) => node.data.title)).toEqual(
      expect.arrayContaining([
        "Create vendor record",
        "Then We Send The Vendor Packet To Legal For Review.",
        "Export Vendor CSV From NetSuite",
        "Finance Verifies The W 9 Before Vendor Activation.",
      ]),
    );
    expect(taskNodes.flatMap((node) => node.data.evidence_ids ?? [])).toEqual(
      expect.arrayContaining(["e-transcript-1", "e-screen-1", "e-doc-1"]),
    );
  });

  test("technical capture artifacts are not promoted to business workflow nodes", () => {
    const graph = buildDeterministicOperatorGraph({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Promotion Management",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [],
      screenEvents: [],
      visualObservations: [
        {
          id: "vo-technical-1",
          tsMs: 0,
          provider: "deterministic-screen-vision",
          uiSummary: "Keyframe candidate 1 from operator-capture.webm",
          ocrText: null,
          structuredJson: {
            ui_state_label: "Keyframe candidate 1 from operator-capture.webm",
            actions_observed: [
              "screen recording upload",
              "video keyframe candidate",
              "ocr pending",
            ],
          },
          confidence: 0.66,
          evidenceIds: ["e-technical-1"],
          degradedReasons: ["local_frame_ocr_not_configured"],
        },
      ],
      documentChunks: [],
      provisionalSteps: [
        {
          id: "ps-technical-1",
          tsStartMs: 0,
          tsEndMs: 10_000,
          title: "Keyframe Candidate 1 From Operator Capture.Webm",
          confidence: 0.32,
        },
      ],
      slotStates: [],
    });

    const taskTitles = graph.nodes
      .filter((node) => node.type === "task")
      .map((node) => node.data.title);
    expect(taskTitles).toEqual(["Map Promotion Management"]);
  });

  test("mixed-mode evidence is chunked and stitched in timeline order", () => {
    const pack: OperatorEvidencePack = {
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Invoice exception review",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [
        {
          id: "ts-late-1",
          text: "Then we send the exception to AP for review.",
          startMs: 22_000,
          endMs: 28_000,
          evidenceIds: ["e-transcript-late"],
        },
      ],
      screenEvents: [
        {
          id: "se-early-1",
          tsMs: 2_000,
          label: "Open invoice exception queue",
          appName: "SAP",
          windowTitle: "Invoice exceptions",
          url: "https://sap.example/invoices",
          ocrText: "Exception queue",
          signalTags: ["manual_search_or_filtering"],
          evidenceIds: ["e-screen-early"],
        },
      ],
      documentChunks: [
        {
          id: "dc-doc-1",
          ordinal: 1,
          text: "Archive the final invoice approval record.",
          evidenceIds: ["e-doc"],
        },
      ],
      provisionalSteps: [
        {
          id: "ps-middle-1",
          tsStartMs: 12_000,
          tsEndMs: 18_000,
          title: "Check vendor remit-to details",
          confidence: 0.74,
        },
      ],
      slotStates: [],
    };

    const chunks = segmentOperatorEvidencePack(pack, 10_000);
    expect(chunks.map((chunk) => chunk.startMs)).toEqual([
      2_000,
      12_000,
      22_000,
      null,
    ]);
    expect(chunks[0]?.screenEvents.map((event) => event.id)).toEqual([
      "se-early-1",
    ]);
    expect(chunks[1]?.provisionalSteps.map((step) => step.id)).toEqual([
      "ps-middle-1",
    ]);
    expect(chunks[2]?.transcriptSegments.map((segment) => segment.id)).toEqual([
      "ts-late-1",
    ]);
    expect(chunks[3]?.documentChunks.map((chunk) => chunk.id)).toEqual([
      "dc-doc-1",
    ]);

    const graph = buildDeterministicOperatorGraph(pack);
    const taskTitles = graph.nodes
      .filter((node) => node.type === "task")
      .map((node) => node.data.title);
    expect(taskTitles).toEqual([
      "Open Invoice Exception Queue",
      "Check vendor remit-to details",
      "Then We Send The Exception To AP For Review.",
      "Archive The Final Invoice Approval Record.",
    ]);
  });

  test("step-scoped slot states enrich provisional graph nodes", () => {
    const stepId = "00000000-0000-0000-0000-00000000aa01";
    const graph = buildDeterministicOperatorGraph({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Claim review",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [],
      screenEvents: [],
      documentChunks: [],
      provisionalSteps: [
        {
          id: stepId,
          tsStartMs: 1000,
          tsEndMs: 4000,
          title: "Review claim",
          confidence: 0.65,
        },
      ],
      slotStates: [
        {
          id: "slot-1",
          slotPath: "step.systems",
          provisionalStepId: stepId,
          value: { system_name: "Guidewire", role: "source_of_truth" },
          status: "filled",
          confidence: 0.8,
          evidenceIds: ["e-slot-1"],
        },
        {
          id: "slot-2",
          slotPath: "step.exceptions",
          provisionalStepId: stepId,
          value: { condition: "Claim is missing policy number", impact: "Manual lookup" },
          status: "filled",
          confidence: 0.75,
          evidenceIds: ["e-slot-2"],
        },
        {
          id: "slot-3",
          slotPath: "step.workarounds",
          provisionalStepId: stepId,
          value: { workaround: "Search the legacy portal", reason: "Policy link is absent" },
          status: "filled",
          confidence: 0.75,
          evidenceIds: ["e-slot-3"],
        },
        {
          id: "slot-4",
          slotPath: "step.decision_criteria",
          provisionalStepId: stepId,
          value: { condition: "Coverage is expired", branches: ["deny", "escalate"] },
          status: "filled",
          confidence: 0.7,
          evidenceIds: ["e-slot-4"],
        },
      ],
    });
    const task = graph.nodes.find((node) => node.type === "task");
    expect(task?.data.systems).toContain("Guidewire");
    expect(task?.data.exceptions?.[0]?.label).toContain("missing policy number");
    expect(task?.data.workarounds?.[0]?.description).toContain("legacy portal");
    expect(task?.data.variants?.[0]?.condition).toContain("deny / escalate");
    expect(task?.data.evidence_ids).toEqual(
      expect.arrayContaining(["e-slot-1", "e-slot-2", "e-slot-3", "e-slot-4"]),
    );
  });

  test("specific IO and handoff slots enrich provisional graph nodes", () => {
    const stepId = "00000000-0000-0000-0000-00000000aa02";
    const graph = buildDeterministicOperatorGraph({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Renewal prep",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [],
      screenEvents: [],
      documentChunks: [],
      provisionalSteps: [
        {
          id: stepId,
          tsStartMs: 1000,
          tsEndMs: 4000,
          title: "Prepare renewal packet",
          confidence: 0.65,
        },
      ],
      slotStates: [
        {
          id: "slot-io-1",
          slotPath: "step.data_copied_from",
          provisionalStepId: stepId,
          value: { label: "Salesforce renewal report", medium: "CSV" },
          status: "filled",
          confidence: 0.8,
          evidenceIds: ["e-io-1"],
        },
        {
          id: "slot-io-2",
          slotPath: "step.output",
          provisionalStepId: stepId,
          value: { output: "Renewal packet PDF" },
          status: "filled",
          confidence: 0.8,
          evidenceIds: ["e-io-2"],
        },
        {
          id: "slot-handoff-1",
          slotPath: "step.next_owner",
          provisionalStepId: stepId,
          value: { next_owner: "Account manager", handoff_trigger: "Packet is ready" },
          status: "filled",
          confidence: 0.75,
          evidenceIds: ["e-handoff-1"],
        },
      ],
    });
    const task = graph.nodes.find((node) => node.type === "task");
    expect(task?.data.inputs?.map((item) => item.name)).toContain("Salesforce renewal report");
    expect(task?.data.outputs?.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Renewal packet PDF", "Handoff to Account manager"]),
    );
    expect(task?.data.evidence_ids).toEqual(
      expect.arrayContaining(["e-io-1", "e-io-2", "e-handoff-1"]),
    );
  });

  test("long captures keep every task candidate and lay out top to bottom", () => {
    const graph = buildDeterministicOperatorGraph({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Monthly close",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [],
      screenEvents: [],
      documentChunks: [],
      provisionalSteps: Array.from({ length: 80 }, (_, index) => ({
        id: `00000000-0000-0000-0000-00000000bb${String(index).padStart(2, "0")}`,
        tsStartMs: index * 1000,
        tsEndMs: index * 1000 + 900,
        title: `Close task ${index + 1}`,
        confidence: 0.7,
      })),
      slotStates: [],
    });

    const taskNodes = graph.nodes.filter((node) => node.type === "task");
    const startNode = graph.nodes.find((node) => node.type === "start");
    const endNode = graph.nodes.find((node) => node.type === "end");
    expect(taskNodes).toHaveLength(80);
    expect(new Set(taskNodes.map((node) => node.position.y)).size).toBeGreaterThan(1);
    expect(startNode?.position.y).toBeLessThan(taskNodes[0].position.y);
    expect(taskNodes[taskNodes.length - 1].position.y).toBeLessThan(
      endNode?.position.y ?? 0,
    );
    expect(graph.edges.every((edge) => edge.sourceSide === "bottom")).toBe(true);
    expect(graph.edges.every((edge) => edge.targetSide === "top")).toBe(true);
    expect(graph.warnings?.map((warning) => warning.code)).not.toContain(
      "operator_graph_task_limit_applied",
    );
  });

  test("operator layout routes workflow maps from start to end vertically", () => {
    const layout = layoutOperatorGraph(10);
    expect(layout.startPosition).toEqual({ x: 360, y: 80 });
    expect(layout.taskPosition(0)).toEqual({ x: 300, y: 320 });
    expect(layout.decisionPosition(2)).toEqual({ x: 330, y: 790 });
    expect(layout.taskPosition(8)).toEqual({ x: 300, y: 2400 });
    expect(layout.endPosition).toEqual({ x: 350, y: 2890 });
    expect(operatorEdgeWaypoints(layout.taskPosition(7), layout.taskPosition(8))).toBeUndefined();
    expect(operatorEdgeWaypoints({ x: 100, y: 100 }, { x: 500, y: 400 })).toEqual([
      { x: 100, y: 250 },
      { x: 500, y: 250 },
    ]);
  });

  test("SOP-vs-screen spreadsheet mismatch is detected as a contradiction gap", () => {
    const gaps = detectOperatorContradictionGaps({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Promo setup",
      captureSessionIds: ["capture-eval"],
      transcriptSegments: [],
      screenEvents: [
        {
          id: "se-contradiction-1",
          tsMs: 12_000,
          label: "Copy approved promo terms to spreadsheet",
          appName: "Excel",
          windowTitle: "Promo setup.xlsx",
          url: null,
          ocrText: "Approved terms",
          signalTags: ["alt_tab_to_spreadsheet"],
          evidenceIds: ["e-screen-1"],
        },
      ],
      documentChunks: [
        {
          id: "dc-contradiction-1",
          ordinal: 1,
          text: "Approved promo terms must be entered in the promotion management system.",
          evidenceIds: ["e-doc-1"],
        },
      ],
      provisionalSteps: [],
      slotStates: [],
    });

    expect(gaps.map((gap) => gap.kind)).toContain("sop_observed_spreadsheet_gap");
    expect(gaps[0]?.evidenceIds).toEqual(
      expect.arrayContaining(["e-screen-1", "e-doc-1"]),
    );
  });

  test("prior process knowledge vs screen spreadsheet mismatch is detected as a validation gap", () => {
    const gaps = detectOperatorContradictionGaps({
      orgId: "org-eval",
      workspaceId: "workspace-eval",
      processId: "process-eval",
      processName: "Promo setup",
      captureSessionIds: ["capture-eval"],
      priorVersion: {
        id: "version-prior",
        versionNumber: 3,
        status: "approved",
        summary: "Approved promo terms are maintained in the promotion management system.",
      },
      processClaims: [
        {
          id: "claim-prior-system",
          subjectType: "process",
          subjectId: "process-eval",
          field: "source_of_truth",
          value: { system: "Promotion Management" },
          confidence: 0.82,
          evidenceIds: ["e-claim-1"],
        },
      ],
      transcriptSegments: [],
      screenEvents: [
        {
          id: "se-prior-gap-1",
          tsMs: 9_000,
          label: "Update approved promo terms in Excel",
          appName: "Excel",
          windowTitle: "Promo setup.xlsx",
          url: null,
          ocrText: "Approved terms",
          signalTags: ["alt_tab_to_spreadsheet"],
          evidenceIds: ["e-screen-prior"],
        },
      ],
      documentChunks: [],
      provisionalSteps: [],
      slotStates: [],
    });

    expect(gaps.map((gap) => gap.kind)).toContain(
      "prior_process_observed_spreadsheet_gap",
    );
    expect(
      gaps.find((gap) => gap.kind === "prior_process_observed_spreadsheet_gap")
        ?.evidenceIds,
    ).toEqual(expect.arrayContaining(["e-screen-prior", "e-claim-1"]));
  });
});

function packFromFixture(
  pack: WorkflowFixture["cases"][number]["pack"],
): OperatorEvidencePack {
  return {
    orgId: "org-eval",
    workspaceId: "workspace-eval",
    processId: "process-eval",
    processName: pack.processName,
    captureSessionIds: ["capture-eval"],
    transcriptSegments: pack.transcriptSegments,
    screenEvents: pack.screenEvents,
    documentChunks: pack.documentChunks,
    provisionalSteps: pack.provisionalSteps,
    slotStates: [],
  };
}

function titleMatches(actual: string, expected: string) {
  const actualKey = normalize(actual);
  const expectedKey = normalize(expected);
  return actualKey.includes(expectedKey) || expectedKey.includes(actualKey);
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function ratio(actual: number, expected: number) {
  if (expected <= 0) return 1;
  return Math.min(1, actual / expected);
}

function recallForCount(actual: number, expected: number) {
  if (expected === 0) return actual === 0 ? 1 : 0;
  return ratio(actual, expected);
}

function orderCorrelation(indexes: number[]) {
  if (indexes.length <= 1) return 1;
  let orderedPairs = 0;
  let totalPairs = 0;
  for (let left = 0; left < indexes.length; left += 1) {
    for (let right = left + 1; right < indexes.length; right += 1) {
      totalPairs += 1;
      if (indexes[left] < indexes[right]) orderedPairs += 1;
    }
  }
  return ratio(orderedPairs, totalPairs);
}
