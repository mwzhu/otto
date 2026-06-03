import { describe, expect, test } from "vitest";

import { anthropicMaxTokensForPrompt } from "@/lib/ai/models";
import {
  computeSemanticEvidencePackHash,
  computeSemanticModelHash,
  workflowSemanticModelSchema,
  type WorkflowSemanticModel,
} from "@/lib/workflow/semantic-model";
import {
  quoteMatchesEvidence,
  validateWorkflowSemanticModel,
} from "@/lib/workflow/semantic-validation";
import { workflowSemanticModelToGraph } from "@/lib/workflow/semantic-to-graph";
import {
  buildSemanticPromptContext,
  semanticPromptContextToText,
} from "@/lib/workflow/semantic-context";
import { extractWorkflowSemanticModel } from "@/lib/workflow/semantic-llm-extractor";
import {
  RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS,
  workflowSemanticModelAnthropicToolSchema,
} from "@/lib/workflow/semantic-llm-extractor";
import { validateOperatorGraph } from "@/lib/synthesis/operator-graph-validation";
import {
  buildOperatorWorkflowGraph,
  shouldPublishOperatorWorkflowGraph,
  type OperatorEvidencePack,
} from "@/lib/synthesis/operator-process";

const baseModel: WorkflowSemanticModel = {
  processName: "Promotion Management",
  steps: [
    {
      id: "align-proposal",
      type: "task",
      title: "Align on promo proposal with category team",
      description: "Confirm the intended promotion before funding review.",
      actorRole: "Revenue Operations",
      systemNames: ["Google Sheets"],
      inputs: [],
      outputs: [],
      citations: [
        {
          evidenceId: "ev-transcript-1",
          sourceType: "transcript",
          quote: "I align with the category manager on the promo proposal",
          grounding: "quoted",
        },
      ],
      grounding: "quoted",
    },
    {
      id: "funding-confirmed",
      type: "decision",
      title: "Supplier funding confirmed?",
      systemNames: ["Salesforce"],
      inputs: [],
      outputs: [],
      citations: [
        {
          evidenceId: "ev-transcript-2",
          sourceType: "transcript",
          quote: "if supplier funding is not confirmed",
          grounding: "quoted",
        },
      ],
      grounding: "quoted",
    },
    {
      id: "enter-promo",
      type: "task",
      title: "Enter approved promo details",
      systemNames: ["Salesforce"],
      inputs: [{ name: "Approved promo terms", evidenceIds: ["ev-screen-1"] }],
      outputs: [{ name: "Promotion record", evidenceIds: ["ev-screen-1"] }],
      citations: [
        {
          evidenceId: "ev-screen-1",
          sourceType: "visual_observation",
          grounding: "observed",
        },
      ],
      grounding: "observed",
    },
    {
      id: "resolve-funding",
      type: "exception",
      title: "Resolve missing supplier funding",
      inputs: [],
      outputs: [],
      citations: [
        {
          evidenceId: "ev-transcript-2",
          sourceType: "transcript",
          quote: "if supplier funding is not confirmed",
          grounding: "quoted",
        },
      ],
      grounding: "quoted",
    },
  ],
  edges: [
    {
      id: "edge-align-funding",
      sourceId: "align-proposal",
      targetId: "funding-confirmed",
      type: "sequence",
      citations: [
        {
          evidenceId: "ev-transcript-1",
          sourceType: "transcript",
          quote: "I align with the category manager on the promo proposal",
          grounding: "quoted",
        },
      ],
      grounding: "quoted",
    },
    {
      id: "edge-funded-yes",
      sourceId: "funding-confirmed",
      targetId: "enter-promo",
      type: "conditional",
      label: "Yes",
      condition: "Funding confirmed",
      citations: [
        {
          evidenceId: "ev-screen-1",
          sourceType: "visual_observation",
          grounding: "observed",
        },
      ],
      grounding: "observed",
    },
    {
      id: "edge-funded-no",
      sourceId: "funding-confirmed",
      targetId: "resolve-funding",
      type: "conditional",
      label: "No",
      condition: "Funding missing",
      citations: [
        {
          evidenceId: "ev-transcript-2",
          sourceType: "transcript",
          quote: "if supplier funding is not confirmed",
          grounding: "quoted",
        },
      ],
      grounding: "quoted",
    },
    {
      id: "edge-resolve-loop",
      sourceId: "resolve-funding",
      targetId: "funding-confirmed",
      type: "loop",
      label: "Recheck",
      citations: [
        {
          evidenceId: "ev-transcript-2",
          sourceType: "transcript",
          quote: "if supplier funding is not confirmed",
          grounding: "quoted",
        },
      ],
      grounding: "quoted",
    },
  ],
  unresolvedQuestions: [],
  diagnostics: [],
};

const evidenceById = {
  "ev-transcript-1":
    "I align with the category manager on the promo proposal, then I check supplier funding.",
  "ev-transcript-2":
    "If supplier funding is not confirmed, I go back and resolve it before entering the promo.",
  "ev-screen-1": "Salesforce promotion record form with approved promo terms.",
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("operator semantic workflow layer", () => {
  test("semantic model schema accepts business topology with citations", () => {
    expect(() => workflowSemanticModelSchema.parse(baseModel)).not.toThrow();
  });

  test("validation verifies citations, derives confidence, and allows business topology", () => {
    const result = validateWorkflowSemanticModel({
      model: baseModel,
      evidenceById,
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(
      result.model.steps.find((step) => step.id === "align-proposal")
        ?.confidence,
    ).toBe(0.82);
    expect(
      result.model.steps.find((step) => step.id === "enter-promo")?.confidence,
    ).toBe(0.64);
  });

  test("semantic-to-graph preserves business node types and passes graph validation", () => {
    const verified = validateWorkflowSemanticModel({
      model: baseModel,
      evidenceById,
    }).model;
    const graph = workflowSemanticModelToGraph(verified);
    expect(graph.nodes.map((node) => node.type)).toEqual([
      "start",
      "task",
      "decision",
      "task",
      "exception",
      "end",
    ]);
    expect(graph.nodes.map((node) => node.data.title)).toContain(
      "Supplier funding confirmed?",
    );
    expect(graph.edges.map((edge) => edge.edge_type)).toContain("conditional");
    expect(graph.edges.some((edge) => edge.is_exception_path)).toBe(true);
    expect(
      graph.edges.find((edge) => edge.semantic_edge_id === "edge-align-funding")
        ?.label,
    ).toBeUndefined();
    expect(
      graph.edges.find((edge) => edge.semantic_edge_id === "edge-funded-yes")
        ?.label,
    ).toBe("Yes");
    expect(graph.nodes.every((node) => uuidPattern.test(node.id))).toBe(true);
    expect(graph.edges.every((edge) => uuidPattern.test(edge.id))).toBe(true);
    expect(validateOperatorGraph(graph).ok).toBe(true);
  });

  test("semantic-to-graph collapses terminal outcomes into labeled end edges", () => {
    const terminalModel: WorkflowSemanticModel = {
      ...baseModel,
      steps: [
        baseModel.steps[0],
        {
          id: "promo-rejected",
          type: "terminal",
          title: "Promotion rejected",
          terminalOutcome: "Rejected",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              quote: "promo proposal",
              grounding: "quoted",
            },
          ],
          grounding: "quoted",
        },
      ],
      edges: [
        {
          id: "edge-rejected",
          sourceId: "align-proposal",
          targetId: "promo-rejected",
          type: "conditional",
          label: "Rejected",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              quote: "promo proposal",
              grounding: "quoted",
            },
          ],
          grounding: "quoted",
        },
      ],
    };
    const verified = validateWorkflowSemanticModel({
      model: terminalModel,
      evidenceById,
    }).model;
    const graph = workflowSemanticModelToGraph(verified);
    expect(graph.nodes.map((node) => node.data.title)).not.toContain(
      "Promotion rejected",
    );
    const alignNode = graph.nodes.find(
      (node) => node.data.semantic_step_id === "align-proposal",
    );
    const endNode = graph.nodes.find((node) => node.type === "end");
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        source: alignNode?.id,
        target: endNode?.id,
        label: "Rejected",
      }),
    );
    expect(validateOperatorGraph(graph).ok).toBe(true);
  });

  test("technical capture titles and hallucinated evidence are blocked", () => {
    const result = validateWorkflowSemanticModel({
      model: {
        ...baseModel,
        steps: [
          {
            ...baseModel.steps[0],
            id: "technical-step",
            title: "Keyframe candidate 1 from operator-capture.webm",
            citations: [
              {
                evidenceId: "missing-ev",
                sourceType: "visual_observation",
                grounding: "observed",
              },
            ],
            grounding: "observed",
          },
        ],
        edges: [],
      },
      evidenceById,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "technical_capture_artifact",
        "hallucinated_evidence_id",
      ]),
    );
  });

  test("one-branch decisions require demotion or an inferred follow-up branch", () => {
    const oneBranchModel: WorkflowSemanticModel = {
      ...baseModel,
      edges: baseModel.edges.filter((edge) => edge.id !== "edge-funded-no"),
    };
    const blocked = validateWorkflowSemanticModel({
      model: oneBranchModel,
      evidenceById,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.issues.map((issue) => issue.code)).toContain(
      "decision_missing_branch",
    );

    const withFollowUpBranch = validateWorkflowSemanticModel({
      model: {
        ...oneBranchModel,
        edges: [
          ...oneBranchModel.edges,
          {
            id: "edge-funded-unknown",
            sourceId: "funding-confirmed",
            targetId: "resolve-funding",
            type: "conditional",
            label: "Unknown",
            grounding: "inferred",
            citations: [],
            needsFollowUp: true,
            followUpQuestion:
              "What happens when supplier funding is not confirmed?",
          },
        ],
      },
      evidenceById,
    });
    expect(withFollowUpBranch.ok).toBe(true);
  });

  test("decision branches can be modeled as exception or loop edges", () => {
    const exceptionBranch = validateWorkflowSemanticModel({
      model: {
        ...baseModel,
        edges: baseModel.edges.map((edge) =>
          edge.id === "edge-funded-no"
            ? { ...edge, type: "exception" as const }
            : edge,
        ),
      },
      evidenceById,
    });
    expect(exceptionBranch.ok).toBe(true);
  });

  test("quoted citations require a verifiable quote and redacted ids are blocked", async () => {
    const missingQuote = validateWorkflowSemanticModel({
      model: {
        ...baseModel,
        steps: [
          {
            ...baseModel.steps[0],
            citations: [
              {
                evidenceId: "ev-transcript-1",
                sourceType: "transcript",
                grounding: "quoted",
              },
            ],
          },
        ],
        edges: [],
      },
      evidenceById,
    });
    expect(missingQuote.ok).toBe(false);
    expect(missingQuote.issues.map((issue) => issue.code)).toContain(
      "quoted_citation_missing_quote",
    );

    const redacted = await extractWorkflowSemanticModel({
      pack: {
        ...packFromEvidence(),
        redactionWindows: [
          {
            id: "redaction-1",
            captureSessionId: "capture-1",
            startMs: 0,
            endMs: 2_000,
            status: "completed",
          },
        ],
      },
      mock: baseModel,
    });
    expect(redacted.validationIssues.map((issue) => issue.code)).toContain(
      "redacted_evidence_id",
    );
  });

  test("quote verification is fuzzy only for short snippets", () => {
    expect(
      quoteMatchesEvidence(
        "align category manager promo proposal",
        evidenceById["ev-transcript-1"],
      ),
    ).toBe(true);
    expect(
      quoteMatchesEvidence(
        Array.from({ length: 30 }, (_, index) => `unsupported${index}`).join(
          " ",
        ),
        evidenceById["ev-transcript-1"],
      ),
    ).toBe(false);
  });

  test("semantic cache hashes are stable and sensitive to prompt versions", () => {
    const baseInput = {
      orgId: "org-1",
      workspaceId: "workspace-1",
      processId: "process-1",
      processName: "Promotion Management",
      captureSessionIds: ["capture-b", "capture-a"],
      promptTemplateId: "operator-workflow-semantic",
      promptTemplateVersion: "v1",
      modelId: "claude-sonnet",
      extractionConfig: { maxWindows: 2 },
      evidence: { transcript: ["align", "funding"] },
    };
    expect(computeSemanticEvidencePackHash(baseInput)).toBe(
      computeSemanticEvidencePackHash({
        ...baseInput,
        captureSessionIds: ["capture-a", "capture-b"],
      }),
    );
    expect(computeSemanticEvidencePackHash(baseInput)).not.toBe(
      computeSemanticEvidencePackHash({
        ...baseInput,
        promptTemplateVersion: "v2",
      }),
    );
    expect(computeSemanticModelHash(baseModel)).toHaveLength(64);
  });

  test("prompt context assembly omits redacted evidence before extraction", () => {
    const context = buildSemanticPromptContext({
      ...packFromEvidence(),
      redactionWindows: [
        {
          id: "redaction-1",
          captureSessionId: "capture-1",
          startMs: 0,
          endMs: 2_000,
          status: "completed",
        },
      ],
    });
    expect(
      context.context.transcriptSegments.map((segment) => segment.id),
    ).not.toContain("segment-1");
    expect(
      context.context.transcriptSegments.map((segment) => segment.id),
    ).toContain("segment-2");
    expect(context.context.screenEvents.map((event) => event.id)).toEqual([
      "screen-1",
    ]);
  });

  test("prompt context assembly samples long captures across the full timeline", () => {
    const context = buildSemanticPromptContext(
      {
        ...packFromEvidence(),
        transcriptSegments: Array.from({ length: 6 }, (_, index) => ({
          id: `segment-${index}`,
          text: `Business action ${index}`,
          startMs: index * 1_000,
          endMs: index * 1_000 + 500,
          evidenceIds: [`ev-transcript-${index}`],
        })),
      },
      {
        transcriptSegments: 3,
        screenEvents: 0,
        visualObservations: 0,
        documentChunks: 0,
        slotStates: 0,
      },
    );
    expect(
      context.context.transcriptSegments.map((segment) => segment.id),
    ).toEqual(["segment-0", "segment-3", "segment-5"]);
    expect(context.context.omitted.transcriptSegments).toBe(3);
  });

  test("semantic extraction prompt pins topology, evidence, and technical-artifact rules", () => {
    const prompt = semanticPromptContextToText(
      buildSemanticPromptContext(packFromEvidence()).context,
    );
    expect(prompt).toContain("The model owns topology");
    expect(prompt).toContain("Do not invent evidence IDs");
    expect(prompt).toContain("operator-capture.webm");
    expect(prompt).toContain("Decision titles should be questions");
    expect(prompt).toContain("needsFollowUp to true");
    expect(prompt).toContain("Return only JSON matching WorkflowSemanticModel");
    expect(prompt).not.toContain("\n  \"process\"");
  });

  test("semantic extraction uses a compact bounded Anthropic tool schema", () => {
    expect(workflowSemanticModelAnthropicToolSchema.properties.steps.maxItems).toBe(12);
    expect(workflowSemanticModelAnthropicToolSchema.properties.edges.maxItems).toBe(18);
    expect(
      workflowSemanticModelAnthropicToolSchema.properties.steps.items.properties.title
        .maxLength,
    ).toBe(120);
    expect(RETRY_SEMANTIC_PROMPT_CONTEXT_LIMITS.transcriptSegments).toBeLessThan(
      16,
    );
  });

  test("operator workflow prompt ids receive workflow token budget", () => {
    expect(
      anthropicMaxTokensForPrompt("operator.workflow_semantic_extraction"),
    ).toBe(16000);
    expect(
      anthropicMaxTokensForPrompt("operator.workflow.semantic_extraction"),
    ).toBe(16000);
    expect(anthropicMaxTokensForPrompt("unknown.prompt")).toBe(1200);
  });

  test("LLM extraction boundary validates mock output and returns deterministic hashes", async () => {
    const result = await extractWorkflowSemanticModel({
      pack: packFromEvidence(),
      mock: baseModel,
    });
    expect(result.validationIssues).toEqual([]);
    expect(result.evidencePackHash).toHaveLength(64);
    expect(result.semanticModelHash).toHaveLength(64);
    expect(result.metadata.mocked).toBe(true);
    expect(result.model.steps.map((step) => step.title)).toContain(
      "Supplier funding confirmed?",
    );
  });

  test("LLM extraction verifier accepts process-claim evidence ids", async () => {
    const claimModel: WorkflowSemanticModel = {
      processName: "Promotion Management",
      steps: [
        {
          id: "review-weekly-forecast",
          type: "task",
          title: "Review weekly forecast",
          citations: [
            {
              evidenceId: "ev-claim-1",
              sourceType: "document_chunk",
              quote: "review weekly sales forecasts",
              grounding: "documented",
            },
          ],
          grounding: "documented",
        },
      ],
      edges: [],
      unresolvedQuestions: [],
      diagnostics: [],
    };
    const result = await extractWorkflowSemanticModel({
      pack: {
        ...packFromEvidence(),
        processClaims: [
          {
            id: "claim-1",
            subjectType: "process",
            subjectId: "process-1",
            field: "summary",
            value: "Review weekly sales forecasts.",
            confidence: 0.8,
            evidenceIds: ["ev-claim-1"],
            evidenceTexts: [
              {
                id: "ev-claim-1",
                text: "The operator must review weekly sales forecasts before publishing.",
              },
            ],
          },
        ],
      },
      mock: claimModel,
    });
    expect(result.validationIssues).toEqual([]);
  });

  test("LLM extraction normalizes missing inferred follow-up questions", async () => {
    const inferredModel: WorkflowSemanticModel = {
      processName: "Promotion Management",
      steps: [
        {
          id: "check-category-margin",
          type: "task",
          title: "Check category margin",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              quote: "promo proposal",
              grounding: "quoted",
            },
          ],
          grounding: "quoted",
        },
        {
          id: "approve-margin",
          type: "decision",
          title: "Margin acceptable?",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              grounding: "inferred",
            },
          ],
          grounding: "inferred",
        },
        {
          id: "publish-promo",
          type: "task",
          title: "Publish promotion",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              quote: "promo proposal",
              grounding: "quoted",
            },
          ],
          grounding: "quoted",
        },
      ],
      edges: [
        {
          id: "edge-check-approve",
          sourceId: "check-category-margin",
          targetId: "approve-margin",
          type: "sequence",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              grounding: "inferred",
            },
          ],
          grounding: "inferred",
        },
        {
          id: "edge-approve-yes",
          sourceId: "approve-margin",
          targetId: "publish-promo",
          type: "conditional",
          label: "Yes",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              quote: "promo proposal",
              grounding: "quoted",
            },
          ],
          grounding: "quoted",
        },
        {
          id: "edge-approve-no",
          sourceId: "approve-margin",
          targetId: "check-category-margin",
          type: "conditional",
          label: "No",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              grounding: "inferred",
            },
          ],
          grounding: "inferred",
        },
      ],
      unresolvedQuestions: [],
      diagnostics: [],
    };
    const result = await extractWorkflowSemanticModel({
      pack: packFromEvidence(),
      mock: inferredModel,
    });
    expect(result.validationIssues).toEqual([]);
    expect(
      result.model.steps.find((step) => step.id === "approve-margin")
        ?.followUpQuestion,
    ).toContain("Validate inferred workflow step");
    expect(
      result.model.edges.find((edge) => edge.id === "edge-approve-no")
        ?.needsFollowUp,
    ).toBe(true);
  });

  test("LLM extraction downgrades paraphrased quotes without losing evidence", async () => {
    const paraphrasedQuoteModel: WorkflowSemanticModel = {
      processName: "Promotion Management",
      steps: [
        {
          id: "align-proposal",
          type: "task",
          title: "Align on promo proposal",
          citations: [
            {
              evidenceId: "ev-transcript-1",
              sourceType: "transcript",
              quote: "totally different quote text",
              grounding: "quoted",
            },
          ],
          grounding: "quoted",
        },
      ],
      edges: [],
      unresolvedQuestions: [],
      diagnostics: [],
    };
    const result = await extractWorkflowSemanticModel({
      pack: packFromEvidence(),
      mock: paraphrasedQuoteModel,
    });
    expect(result.validationIssues).toEqual([]);
    expect(result.model.steps[0].citations?.[0]).toMatchObject({
      evidenceId: "ev-transcript-1",
      grounding: "observed",
    });
    expect(result.model.steps[0].citations?.[0].quote).toBeUndefined();
  });

  test("operator synthesis graph wrapper uses verified semantic topology when available", async () => {
    const result = await buildOperatorWorkflowGraph(packFromEvidence(), {
      forceSemantic: true,
      semanticMock: baseModel,
    });
    expect(result.mode).toBe("semantic");
    expect(result.semanticModelHash).toHaveLength(64);
    expect(result.graph.nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(["decision", "exception"]),
    );
    expect(result.graph.edges.map((edge) => edge.edge_type)).toContain(
      "conditional",
    );
    expect(validateOperatorGraph(result.graph).ok).toBe(true);
  });

  test("operator synthesis graph wrapper carries semantic follow-up questions", async () => {
    const result = await buildOperatorWorkflowGraph(packFromEvidence(), {
      forceSemantic: true,
      semanticMock: {
        ...baseModel,
        edges: [
          ...baseModel.edges,
          {
            id: "edge-unknown",
            sourceId: "funding-confirmed",
            targetId: "resolve-funding",
            type: "conditional",
            label: "Unknown",
            grounding: "inferred",
            needsFollowUp: true,
            followUpQuestion:
              "What happens when supplier funding cannot be confirmed?",
            citations: [],
          },
        ],
      },
    });
    expect(result.mode).toBe("semantic");
    expect(
      result.semanticFollowUpQuestions.map((question) => question.question),
    ).toContain("What happens when supplier funding cannot be confirmed?");
  });

  test("operator synthesis graph wrapper surfaces skipped semantic extraction and blocks runtime publish", async () => {
    const result = await buildOperatorWorkflowGraph(packFromEvidence());
    expect(result.mode).toBe("deterministic_fallback");
    expect(result.graph.warnings?.map((warning) => warning.code)).toContain(
      "semantic_extraction_skipped",
    );
    expect(
      shouldPublishOperatorWorkflowGraph(result, {
        NODE_ENV: "development",
        OTTO_OPERATOR_ALLOW_DETERMINISTIC_WORKFLOW_FALLBACK: false,
      }),
    ).toBe(false);
    expect(
      shouldPublishOperatorWorkflowGraph(result, {
        NODE_ENV: "development",
        OTTO_OPERATOR_ALLOW_DETERMINISTIC_WORKFLOW_FALLBACK: true,
      }),
    ).toBe(true);
    expect(
      shouldPublishOperatorWorkflowGraph(result, {
        NODE_ENV: "production",
        OTTO_OPERATOR_ALLOW_DETERMINISTIC_WORKFLOW_FALLBACK: true,
      }),
    ).toBe(false);
  });
});

function packFromEvidence(): OperatorEvidencePack {
  return {
    orgId: "org-1",
    workspaceId: "workspace-1",
    processId: "process-1",
    processName: "Promotion Management",
    captureSessionIds: ["capture-1"],
    transcriptSegments: [
      {
        id: "segment-1",
        text: evidenceById["ev-transcript-1"],
        startMs: 1_000,
        endMs: 1_500,
        evidenceIds: ["ev-transcript-1"],
      },
      {
        id: "segment-2",
        text: evidenceById["ev-transcript-2"],
        startMs: 3_000,
        endMs: 4_000,
        evidenceIds: ["ev-transcript-2"],
      },
    ],
    screenEvents: [
      {
        id: "screen-1",
        tsMs: 5_000,
        label: "Salesforce promotion record form",
        appName: "Salesforce",
        windowTitle: "Promotion record",
        url: null,
        ocrText: evidenceById["ev-screen-1"],
        signalTags: ["form_entry"],
        evidenceIds: ["ev-screen-1"],
      },
    ],
    visualObservations: [],
    documentChunks: [],
    provisionalSteps: [],
    slotStates: [],
  };
}
