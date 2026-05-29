import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import {
  auditLog,
  claimEvidence,
  claims,
  captureProcessLinks,
  followUpTasks,
  slotStates,
  synthesisRuns,
  synthesisStageOutputs,
} from "@/lib/db/schema";
import { computeComplexityScore } from "@/lib/synthesis/complexity";
import {
  layoutOperatorGraph,
  operatorEdgeWaypoints,
} from "@/lib/synthesis/operator-layout";
import {
  writeOperatorGraphDraft,
  publishOperatorGraphDraft,
} from "@/lib/synthesis/operator";
import { validateOperatorGraph } from "@/lib/synthesis/operator-graph-validation";
import type { GraphEdge, GraphNode, ProcessGraph } from "@/lib/types/graph";

export type OperatorProcessSynthesisInput = {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionIds: string[];
  userId?: string;
  idempotencyKey?: string;
};

export type OperatorEvidencePack = {
  orgId: string;
  workspaceId: string;
  processId: string;
  processName: string;
  captureSessionIds: string[];
  priorVersion?: {
    id: string;
    versionNumber: number;
    status: "draft" | "approved" | "rejected";
    summary: string | null;
  } | null;
  processClaims?: Array<{
    id: string;
    subjectType: string;
    subjectId: string;
    field: string;
    value: unknown;
    confidence: number;
    evidenceIds: string[];
  }>;
  redactionWindows?: Array<{
    id: string;
    captureSessionId: string;
    startMs: number;
    endMs: number;
    status: string;
  }>;
  transcriptSegments: Array<{
    id: string;
    text: string;
    startMs: number;
    endMs: number;
    evidenceIds: string[];
  }>;
  screenEvents: Array<{
    id: string;
    tsMs: number;
    label: string;
    appName: string | null;
    windowTitle: string | null;
    url: string | null;
    ocrText: string | null;
    signalTags: string[];
    evidenceIds: string[];
  }>;
  documentChunks: Array<{
    id: string;
    ordinal: number;
    text: string;
    evidenceIds: string[];
  }>;
  provisionalSteps: Array<{
    id: string;
    tsStartMs: number;
    tsEndMs: number | null;
    title: string;
    confidence: number;
  }>;
  slotStates: Array<{
    id: string;
    slotPath: string;
    provisionalStepId: string | null;
    value: unknown;
    status: string;
    confidence: number;
    evidenceIds: string[];
  }>;
};

export type OperatorEvidenceChunk = {
  index: number;
  startMs: number | null;
  endMs: number | null;
  transcriptSegments: OperatorEvidencePack["transcriptSegments"];
  screenEvents: OperatorEvidencePack["screenEvents"];
  provisionalSteps: OperatorEvidencePack["provisionalSteps"];
  documentChunks: OperatorEvidencePack["documentChunks"];
};

const operatorProcessStageVersions = {
  "stage-0-capture-ingest": 1,
  "stage-1-evidence-pack": 1,
  "stage-2-provisional-step-dedupe": 1,
  "stage-3-gap-and-contradiction-detection": 1,
  "stage-4-graph-build": 1,
  "stage-5-gap-and-contradiction-followups": 1,
  "stage-6-complexity-and-coverage": 1,
  "stage-7-narrative": 1,
  "stage-8-publish-draft": 1,
} as const;

export async function runOperatorProcessSynthesis(
  input: OperatorProcessSynthesisInput,
) {
  if (input.captureSessionIds.length === 0) {
    return { ok: false as const, reason: "missing_capture_sessions" };
  }

  const runResult = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`synthesis.operator_process:${input.processId}:${input.captureSessionIds.join(",")}:${input.idempotencyKey ?? ""}`}))
    `);

    const captureRows = await tx.execute<{
      id: string;
      process_id: string | null;
    }>(sql`
      SELECT id, process_id
      FROM capture_sessions
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND id = ANY(${uuidArraySql(input.captureSessionIds)})
    `);
    if (captureRows.rows.length !== input.captureSessionIds.length) {
      return { ok: false as const, reason: "capture_session_not_found" };
    }
    const hasWrongProcess = captureRows.rows.some(
      (row) => row.process_id !== input.processId,
    );
    if (hasWrongProcess) {
      return { ok: false as const, reason: "capture_session_process_mismatch" };
    }

    const existingRows = await tx.execute<{ id: string }>(sql`
      SELECT al.subject_id AS id
      FROM audit_log al
      JOIN synthesis_runs sr ON sr.id = al.subject_id
      WHERE al.org_id = ${input.orgId}
        AND al.workspace_id = ${input.workspaceId}
        AND al.event_type = 'synthesis.operator_process.started'
        AND al.metadata_json->>'idempotency_key' = ${input.idempotencyKey ?? ""}
        AND sr.status <> 'failed'
      LIMIT 1
    `);
    if (existingRows.rows[0]) {
      return {
        ok: true as const,
        alreadyStarted: true,
        synthesisRunId: existingRows.rows[0].id,
      };
    }

    const run = (
      await tx
        .insert(synthesisRuns)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          captureSessionIds: input.captureSessionIds,
          runType: "process_graph",
          status: "partial_synthesis",
          stage: "stage-1-evidence-pack",
          stageVersions: operatorProcessStageVersions,
        })
        .returning()
    )[0];

    await tx.insert(synthesisStageOutputs).values([
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: run.id,
        stageName: "stage-0-capture-ingest",
        inputRowRefs: input.captureSessionIds.map((id) => ({
          table: "capture_sessions",
          id,
        })),
        outputRowRefs: input.captureSessionIds.map((id) => ({
          table: "capture_sessions",
          id,
        })),
        status: "completed",
      },
      {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: run.id,
        stageName: "stage-1-evidence-pack",
        inputRowRefs: input.captureSessionIds.map((id) => ({
          table: "capture_sessions",
          id,
        })),
        outputRowRefs: [],
        status: "queued",
      },
    ]);

    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      eventType: "synthesis.operator_process.started",
      subjectType: "synthesis_run",
      subjectId: run.id,
      metadataJson: {
        process_id: input.processId,
        capture_session_ids: input.captureSessionIds,
        idempotency_key: input.idempotencyKey,
      },
    });

    return {
      ok: true as const,
      alreadyStarted: false,
      synthesisRunId: run.id,
    };
  });

  if (!runResult.ok || runResult.alreadyStarted) {
    return runResult;
  }

  try {
    const evidencePack = await loadOperatorEvidencePack(input);
    const graph = buildDeterministicOperatorGraph(evidencePack);
    const graphValidation = validateOperatorGraph(graph);
    const contradictionGaps = detectOperatorContradictionGaps(evidencePack);
    const draftWarnings = operatorDraftWarnings(contradictionGaps);
    const complexity = computeOperatorGraphComplexity(evidencePack, graph);
    const narrative = buildOperatorDraftNarrative({
      evidencePack,
      graph,
      complexityTotal: complexity.total,
      contradictionCount: contradictionGaps.length,
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-1-evidence-pack",
      inputRowRefs: input.captureSessionIds.map((id) => ({
        table: "capture_sessions",
        id,
      })),
      outputRowRefs: evidencePackRefs(evidencePack),
      status: "completed",
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-2-provisional-step-dedupe",
      inputRowRefs: evidencePack.provisionalSteps.map((step) => ({
        table: "provisional_steps",
        id: step.id,
      })),
      outputRowRefs: graph.nodes
        .filter((node) => node.type === "task")
        .map((node) => ({ table: "graph_node_candidate", id: node.id })),
      status: "completed",
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-3-gap-and-contradiction-detection",
      inputRowRefs: evidencePackRefs(evidencePack),
      outputRowRefs: contradictionGaps.map((gap, index) => ({
        table: "operator_contradiction_gap",
        id: `${gap.kind}:${index}`,
      })),
      status: "completed",
    });

    if (!graphValidation.ok) {
      await recordOperatorStage({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: runResult.synthesisRunId,
        stageName: "stage-4-graph-build",
        inputRowRefs: evidencePackRefs(evidencePack),
        outputRowRefs: graphValidation.issues.map((issue, index) => ({
          table: "graph_validation_issue",
          id: `${issue.code}:${issue.node_id ?? issue.edge_id ?? index}`,
        })),
        status: "failed",
      });
      await failOperatorSynthesisRun({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: runResult.synthesisRunId,
        stage: "stage-4-graph-build",
        reason: "graph_validation_failed",
        issues: graphValidation.issues,
        userId: input.userId ?? null,
      });
      return {
        ...runResult,
        ok: false as const,
        reason: "graph_validation_failed",
        issues: graphValidation.issues,
      };
    }

    const draft = await writeOperatorGraphDraft({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      graph,
      summary: narrative.summary,
      warnings: draftWarnings,
    });
    await linkProvisionalStepsToGraphNodes({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      graph: draft.graph,
    });
    const materializedClaims = await materializeProcessVersionClaims({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      versionId: draft.versionId,
      captureSessionIds: input.captureSessionIds,
      evidencePack,
      graph: draft.graph,
      narrative,
      warnings: draftWarnings,
      userId: input.userId ?? null,
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-4-graph-build",
      inputRowRefs: evidencePackRefs(evidencePack),
      outputRowRefs: [
        { table: "process_versions", id: draft.versionId },
        ...draft.graph.nodes.map((node) => ({
          table: "process_nodes",
          id: node.id,
        })),
        ...draft.graph.edges.map((edge) => ({
          table: "process_edges",
          id: edge.id,
        })),
        ...materializedClaims.map((claim) => ({
          table: "claims",
          id: claim.id,
        })),
      ],
      status: "completed",
    });

    await createContradictionFollowUpTasks({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionIds: input.captureSessionIds,
      versionId: draft.versionId,
      gaps: contradictionGaps,
      userId: input.userId ?? null,
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-5-gap-and-contradiction-followups",
      inputRowRefs: evidencePackRefs(evidencePack),
      outputRowRefs: contradictionGaps.map((gap, index) => ({
        table: "follow_up_tasks",
        id: `${gap.kind}:${index}`,
      })),
      status: "completed",
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-6-complexity-and-coverage",
      inputRowRefs: [
        { table: "process_versions", id: draft.versionId },
        ...evidencePackRefs(evidencePack),
      ],
      outputRowRefs: [
        {
          table: "operator_complexity_score",
          id: `${draft.versionId}:${complexity.total}`,
        },
      ],
      status: "completed",
    });
    await recordOperatorStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      stageName: "stage-7-narrative",
      inputRowRefs: [{ table: "process_versions", id: draft.versionId }],
      outputRowRefs: [{ table: "process_versions", id: draft.versionId }],
      status: "completed",
    });

    await publishOperatorGraphDraft({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      versionId: draft.versionId,
      userId: input.userId ?? null,
    });
    const linkedCaptureRefs = await linkOperatorCapturesToProcess({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionIds: input.captureSessionIds,
    });
    await createGraphFollowUpTasks({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionIds: input.captureSessionIds,
      versionId: draft.versionId,
      graph: draft.graph,
      userId: input.userId ?? null,
    });
    await completeOperatorSynthesisRun({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: runResult.synthesisRunId,
      versionId: draft.versionId,
      linkedCaptureRefs,
      complexity,
      narrative,
      userId: input.userId ?? null,
    });

    return {
      ...runResult,
      versionId: draft.versionId,
      versionNumber: draft.versionNumber,
      graphNodeCount: draft.graph.nodes.length,
      graphEdgeCount: draft.graph.edges.length,
    };
  } catch (error) {
    try {
      await failOperatorSynthesisRun({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: runResult.synthesisRunId,
        stage: "failed",
        reason: "operator_synthesis_unhandled_error",
        issues: [
          {
            message:
              error instanceof Error
                ? error.message
                : "Unknown operator synthesis error",
          },
        ],
        userId: input.userId ?? null,
      });
    } catch {
      // Preserve the original synthesis error.
    }
    throw error;
  }
}

type MaterializedProcessVersionClaim = {
  id: string;
  field: "summary" | "steps" | "evidence_coverage";
};

async function materializeProcessVersionClaims(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
  captureSessionIds: string[];
  evidencePack: OperatorEvidencePack;
  graph: ProcessGraph;
  narrative: ReturnType<typeof buildOperatorDraftNarrative>;
  warnings: NonNullable<ProcessGraph["warnings"]>;
  userId?: string | null;
}): Promise<MaterializedProcessVersionClaim[]> {
  const allEvidenceIds = uniqueStrings([
    ...input.evidencePack.transcriptSegments.flatMap((row) => row.evidenceIds),
    ...input.evidencePack.screenEvents.flatMap((row) => row.evidenceIds),
    ...input.evidencePack.documentChunks.flatMap((row) => row.evidenceIds),
    ...input.graph.nodes.flatMap((node) => node.data.evidence_ids ?? []),
    ...input.graph.edges.flatMap((edge) => edge.evidence_ids ?? []),
  ]);
  const taskNodes = input.graph.nodes.filter((node) => node.type === "task");
  const evidencedNodeCount = input.graph.nodes.filter(
    (node) => (node.data.evidence_ids ?? []).length > 0,
  ).length;
  const stepClaimEvidenceIds = uniqueStrings(
    taskNodes.flatMap((node) => node.data.evidence_ids ?? []),
  );
  const claimInputs: Array<{
    field: MaterializedProcessVersionClaim["field"];
    value: unknown;
    confidence: string;
    evidenceIds: string[];
  }> = [
    {
      field: "summary",
      value: input.narrative.summary,
      confidence: "0.800",
      evidenceIds: allEvidenceIds.slice(0, 50),
    },
    {
      field: "steps",
      value: taskNodes.map((node, index) => ({
        id: node.id,
        ordinal: index + 1,
        title: node.data.title,
        description: node.data.description ?? null,
        confidence: node.data.confidence ?? null,
        evidence_ids: node.data.evidence_ids ?? [],
        exceptions: node.data.exceptions ?? [],
        workarounds: node.data.workarounds ?? [],
        source_provisional_step_ids:
          node.data.source_provisional_step_ids ?? [],
      })),
      confidence: averageConfidence(taskNodes, 0.75).toFixed(3),
      evidenceIds: stepClaimEvidenceIds.slice(0, 50),
    },
    {
      field: "evidence_coverage",
      value: {
        ...input.narrative.coverage,
        node_count: input.graph.nodes.length,
        edge_count: input.graph.edges.length,
        evidenced_node_count: evidencedNodeCount,
        unevidenced_node_count: input.graph.nodes.length - evidencedNodeCount,
        warning_count: input.warnings.length,
        capture_session_count: input.captureSessionIds.length,
      },
      confidence: allEvidenceIds.length > 0 ? "0.850" : "0.450",
      evidenceIds: allEvidenceIds.slice(0, 50),
    },
  ];

  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const existingRows = await tx.execute<{
      id: string;
      field: MaterializedProcessVersionClaim["field"];
    }>(sql`
      SELECT id, field
      FROM claims
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND subject_type = 'process_version'
        AND subject_id = ${input.versionId}
        AND field IN ('summary', 'steps', 'evidence_coverage')
        AND status = 'active'
        AND superseded_by_claim_id IS NULL
        AND redacted_at IS NULL
        AND tombstoned_at IS NULL
      FOR UPDATE
    `);
    const existingByField = new Map(
      existingRows.rows.map((row) => [row.field, row.id] as const),
    );

    const validEvidenceIds =
      allEvidenceIds.length > 0
        ? new Set(
            (
              await tx.execute<{ id: string }>(sql`
                SELECT id
                FROM evidence
                WHERE org_id = ${input.orgId}
                  AND workspace_id = ${input.workspaceId}
                  AND id = ANY(${uuidArraySql(allEvidenceIds)})
                  AND redacted_at IS NULL
                  AND tombstoned_at IS NULL
              `)
            ).rows.map((row) => row.id),
          )
        : new Set<string>();

    const materialized: MaterializedProcessVersionClaim[] = [];
    const insertedClaimIds: string[] = [];
    for (const claimInput of claimInputs) {
      const existingId = existingByField.get(claimInput.field);
      if (existingId) {
        materialized.push({ id: existingId, field: claimInput.field });
        continue;
      }

      const claimId = randomUUID();
      await tx.insert(claims).values({
        id: claimId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        subjectType: "process_version",
        subjectId: input.versionId,
        field: claimInput.field,
        value: claimInput.value,
        confidence: claimInput.confidence,
        status: "active",
        metadataJson: {
          source: "operator_process_synthesis",
          process_id: input.processId,
          version_id: input.versionId,
          capture_session_ids: input.captureSessionIds,
        },
      });

      const evidenceIds = uniqueStrings(claimInput.evidenceIds).filter((id) =>
        validEvidenceIds.has(id),
      );
      if (evidenceIds.length > 0) {
        await tx
          .insert(claimEvidence)
          .values(
            evidenceIds.map((evidenceId) => ({
              claimId,
              evidenceId,
            })),
          )
          .onConflictDoNothing();
      }

      materialized.push({ id: claimId, field: claimInput.field });
      insertedClaimIds.push(claimId);
    }

    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      eventType: "synthesis.operator.version_claims_materialized",
      subjectType: "process_version",
      subjectId: input.versionId,
      metadataJson: {
        process_id: input.processId,
        version_id: input.versionId,
        capture_session_ids: input.captureSessionIds,
        claim_ids: materialized.map((claim) => claim.id),
        inserted_claim_ids: insertedClaimIds,
        fields: materialized.map((claim) => claim.field),
      },
    });

    return materialized;
  });
}

async function createGraphFollowUpTasks(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionIds: string[];
  versionId: string;
  graph: ProcessGraph;
  userId?: string | null;
}) {
  const lowConfidenceNodes = input.graph.nodes.filter(
    (node) =>
      node.type !== "start" &&
      node.type !== "end" &&
      (node.data.evidence_ids ?? []).length === 0 &&
      (node.data.confidence ?? 0) <= 0.45,
  );
  if (lowConfidenceNodes.length === 0) return;
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.insert(followUpTasks).values(
      lowConfidenceNodes.map((node) => ({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        processId: input.processId,
        captureSessionId: input.captureSessionIds[0],
        taskType: "open_question" as const,
        title: `Confirm inferred workflow step: ${node.data.title}`,
        description:
          "This step was included as a low-confidence inference because no direct operator evidence supported it.",
        targetType: "process_node",
        targetId: node.id,
        priority: "0.75",
        status: "open" as const,
        assignedToUserId: input.userId ?? undefined,
        contextJson: {
          version_id: input.versionId,
          process_id: input.processId,
          capture_session_ids: input.captureSessionIds,
          confidence: node.data.confidence ?? null,
          reason: "low_confidence_inferred_graph_node",
        },
      })),
    );
  });
}

async function linkOperatorCapturesToProcess(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionIds: string[];
}) {
  if (input.captureSessionIds.length === 0) return [];
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .insert(captureProcessLinks)
      .values(
        input.captureSessionIds.map((captureSessionId) => ({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          captureSessionId,
          processId: input.processId,
          linkType: "enriched" as const,
          confidence: "1",
        })),
      )
      .onConflictDoNothing();
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      eventType: "synthesis.operator.capture_links_materialized",
      subjectType: "process",
      subjectId: input.processId,
      metadataJson: {
        process_id: input.processId,
        capture_session_ids: input.captureSessionIds,
        link_type: "enriched",
      },
    });
  });
  return input.captureSessionIds.map((captureSessionId) => ({
    table: "capture_process_links",
    id: `${captureSessionId}:${input.processId}:enriched`,
  }));
}

async function linkProvisionalStepsToGraphNodes(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  graph: ProcessGraph;
}) {
  const mappings = input.graph.nodes.flatMap((node) =>
    (node.data.source_provisional_step_ids ?? []).map((stepId) => ({
      stepId,
      nodeId: node.id,
    })),
  );
  if (mappings.length === 0) return;
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    for (const mapping of mappings) {
      await tx.execute(sql`
        UPDATE provisional_steps
        SET superseded_by_node_id = ${mapping.nodeId},
            updated_at = now()
        WHERE id = ${mapping.stepId}
          AND org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND process_id = ${input.processId}
      `);
    }
  });
}

type OperatorContradictionGap = {
  kind:
    | "sop_observed_spreadsheet_gap"
    | "prior_process_observed_spreadsheet_gap"
    | "document_only_workflow_gap";
  title: string;
  description: string;
  evidenceIds: string[];
};

export function detectOperatorContradictionGaps(
  pack: OperatorEvidencePack,
): OperatorContradictionGap[] {
  const hasDocumentedEvidence = pack.documentChunks.length > 0;
  const observedSpreadsheetEvents = pack.screenEvents.filter(
    (event) =>
      event.signalTags.some((tag) =>
        ["alt_tab_to_spreadsheet", "left_system_of_record"].includes(tag),
      ) || /excel|spreadsheet|sheet|csv|xlsx/i.test(event.label),
  );
  const documentText = pack.documentChunks
    .map((chunk) => chunk.text)
    .join("\n");
  const gaps: OperatorContradictionGap[] = [];
  if (
    hasDocumentedEvidence &&
    observedSpreadsheetEvents.length > 0 &&
    !/excel|spreadsheet|sheet|csv|xlsx/i.test(documentText)
  ) {
    gaps.push({
      kind: "sop_observed_spreadsheet_gap",
      title: "Clarify spreadsheet work observed outside the SOP",
      description:
        "Documented SOP evidence does not mention spreadsheet work, but observed screen evidence shows spreadsheet or CSV/XLSX usage.",
      evidenceIds: uniqueStrings([
        ...pack.documentChunks.flatMap((chunk) => chunk.evidenceIds),
        ...observedSpreadsheetEvents.flatMap((event) => event.evidenceIds),
      ]),
    });
  }
  const priorProcessKnowledgeText = [
    pack.priorVersion?.summary,
    ...(pack.processClaims ?? []).map((claim) =>
      `${claim.field}: ${JSON.stringify(claim.value)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
  if (
    priorProcessKnowledgeText &&
    observedSpreadsheetEvents.length > 0 &&
    !/excel|spreadsheet|sheet|csv|xlsx/i.test(priorProcessKnowledgeText)
  ) {
    gaps.push({
      kind: "prior_process_observed_spreadsheet_gap",
      title: "Validate spreadsheet work against prior process knowledge",
      description:
        "Prior process knowledge does not mention spreadsheet work, but observed screen evidence shows spreadsheet or CSV/XLSX usage.",
      evidenceIds: uniqueStrings([
        ...(pack.processClaims ?? []).flatMap((claim) => claim.evidenceIds),
        ...observedSpreadsheetEvents.flatMap((event) => event.evidenceIds),
      ]),
    });
  }
  if (
    hasDocumentedEvidence &&
    pack.transcriptSegments.length === 0 &&
    pack.screenEvents.length === 0
  ) {
    gaps.push({
      kind: "document_only_workflow_gap",
      title: "Validate documented SOP against observed operator behavior",
      description:
        "This draft includes documented workflow evidence but no observed or narrated operator capture yet.",
      evidenceIds: uniqueStrings(
        pack.documentChunks.flatMap((chunk) => chunk.evidenceIds),
      ),
    });
  }
  return gaps;
}

async function createContradictionFollowUpTasks(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionIds: string[];
  versionId: string;
  gaps: OperatorContradictionGap[];
  userId?: string | null;
}) {
  if (input.gaps.length === 0) return;
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.insert(followUpTasks).values(
      input.gaps.map((gap) => ({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        processId: input.processId,
        captureSessionId: input.captureSessionIds[0],
        taskType: "open_question" as const,
        title: gap.title,
        description: gap.description,
        targetType: "process_version",
        targetId: input.versionId,
        priority: "0.9",
        status: "open" as const,
        assignedToUserId: input.userId ?? undefined,
        contextJson: {
          version_id: input.versionId,
          process_id: input.processId,
          capture_session_ids: input.captureSessionIds,
          evidence_ids: gap.evidenceIds,
          reason: gap.kind,
        },
      })),
    );
  });
}

function operatorDraftWarnings(
  gaps: OperatorContradictionGap[],
): NonNullable<ProcessGraph["warnings"]> {
  return gaps.map((gap) => ({
    code: gap.kind,
    message: gap.description,
    evidence_ids: gap.evidenceIds,
  }));
}

function computeOperatorGraphComplexity(
  pack: OperatorEvidencePack,
  graph: Omit<ProcessGraph, "process_id" | "version_number" | "status">,
) {
  const taskNodes = graph.nodes.filter((node) => node.type === "task");
  const systemNames = uniqueStrings(
    graph.nodes.flatMap((node) => node.data.systems ?? []),
  );
  const handoffCount =
    graph.nodes.filter((node) => node.type === "handoff").length +
    graph.edges.filter((edge) => edge.edge_type === "handoff").length;
  const frictionSignals = pack.screenEvents
    .filter((event) =>
      event.signalTags.some((tag) =>
        [
          "copy_paste_between_systems",
          "manual_search_or_filtering",
          "waiting_or_refreshing",
          "duplicate_data_entry",
          "left_system_of_record",
        ].includes(tag),
      ),
    )
    .map((event) => ({
      text: `${event.label} (${event.signalTags.join(", ")})`,
      evidenceIds: event.evidenceIds,
    }));
  return computeComplexityScore({
    systemCount: systemNames.length,
    roleCount: Math.max(0, handoffCount),
    peopleCount: 0,
    painPoints: frictionSignals,
    risks: detectOperatorContradictionGaps(pack).map((gap) => ({
      text: gap.description,
      evidenceIds: gap.evidenceIds,
    })),
    documentationEvidenceCount: pack.documentChunks.reduce(
      (count, chunk) => count + chunk.evidenceIds.length,
      0,
    ),
    evidenceIds: uniqueStrings([
      ...taskNodes.flatMap((node) => node.data.evidence_ids ?? []),
      ...pack.transcriptSegments.flatMap((segment) => segment.evidenceIds),
      ...pack.screenEvents.flatMap((event) => event.evidenceIds),
      ...pack.documentChunks.flatMap((chunk) => chunk.evidenceIds),
    ]),
  });
}

function buildOperatorDraftNarrative(input: {
  evidencePack: OperatorEvidencePack;
  graph: Omit<ProcessGraph, "process_id" | "version_number" | "status">;
  complexityTotal: number;
  contradictionCount: number;
}) {
  const taskCount = input.graph.nodes.filter(
    (node) => node.type === "task",
  ).length;
  const decisionCount = input.graph.nodes.filter(
    (node) => node.type === "decision",
  ).length;
  const exceptionCount = input.graph.nodes.filter(
    (node) => node.type === "exception" || (node.data.exception_count ?? 0) > 0,
  ).length;
  const evidenceCount = uniqueStrings([
    ...input.evidencePack.transcriptSegments.flatMap((row) => row.evidenceIds),
    ...input.evidencePack.screenEvents.flatMap((row) => row.evidenceIds),
    ...input.evidencePack.documentChunks.flatMap((row) => row.evidenceIds),
  ]).length;
  const summary =
    `${input.evidencePack.processName} draft map includes ${taskCount} operator step${taskCount === 1 ? "" : "s"}, ` +
    `${decisionCount} decision node${decisionCount === 1 ? "" : "s"}, ` +
    `${exceptionCount} exception signal${exceptionCount === 1 ? "" : "s"}, and ` +
    `${evidenceCount} evidence source${evidenceCount === 1 ? "" : "s"}. ` +
    `Complexity score is ${input.complexityTotal}/100` +
    (input.contradictionCount
      ? ` with ${input.contradictionCount} contradiction or validation gap${input.contradictionCount === 1 ? "" : "s"}.`
      : ".");
  return {
    summary,
    coverage: {
      task_count: taskCount,
      decision_count: decisionCount,
      exception_count: exceptionCount,
      evidence_count: evidenceCount,
      prior_version_id: input.evidencePack.priorVersion?.id ?? null,
      process_claim_count: input.evidencePack.processClaims?.length ?? 0,
      redaction_window_count: input.evidencePack.redactionWindows?.length ?? 0,
      transcript_segment_count: input.evidencePack.transcriptSegments.length,
      screen_event_count: input.evidencePack.screenEvents.length,
      document_chunk_count: input.evidencePack.documentChunks.length,
    },
  };
}

export async function loadOperatorEvidencePack(
  input: OperatorProcessSynthesisInput,
): Promise<OperatorEvidencePack> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const processRows = await tx.execute<{
      id: string;
      name: string;
      current_draft_version_id: string | null;
      current_approved_version_id: string | null;
    }>(sql`
      SELECT id, name, current_draft_version_id, current_approved_version_id
      FROM processes
      WHERE id = ${input.processId}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
      LIMIT 1
    `);
    const process = processRows.rows[0];
    if (!process) {
      throw new Error("Process not found for operator evidence pack.");
    }
    const targetPriorVersionId =
      process.current_draft_version_id ?? process.current_approved_version_id;
    const priorVersion = targetPriorVersionId
      ? (
          await tx.execute<{
            id: string;
            version_number: number;
            status: "draft" | "approved" | "rejected";
            summary: string | null;
          }>(sql`
            SELECT id, version_number, status::text AS status, summary
            FROM process_versions
            WHERE id = ${targetPriorVersionId}
              AND org_id = ${input.orgId}
              AND workspace_id = ${input.workspaceId}
              AND process_id = ${input.processId}
            LIMIT 1
          `)
        ).rows[0] ?? null
      : null;

    const transcriptRows = await tx.execute<{
      id: string;
      text: string;
      start_ms: number;
      end_ms: number;
      evidence_ids: string[];
    }>(sql`
      SELECT
        ts.id,
        ts.text,
        ts.start_ms,
        ts.end_ms,
        COALESCE(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '{}') AS evidence_ids
      FROM transcript_segments ts
      LEFT JOIN evidence e
        ON e.source_type = 'transcript_segment'
       AND e.source_id = ts.id
       AND e.redacted_at IS NULL
       AND e.tombstoned_at IS NULL
      WHERE ts.org_id = ${input.orgId}
        AND ts.workspace_id = ${input.workspaceId}
        AND ts.capture_session_id = ANY(${uuidArraySql(input.captureSessionIds)})
        AND ts.redacted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM redactions r
          WHERE r.org_id = ts.org_id
            AND r.workspace_id = ts.workspace_id
            AND r.capture_session_id = ts.capture_session_id
            AND r.status <> 'failed'
            AND ts.start_ms <= r.end_ms
            AND ts.end_ms >= r.start_ms
        )
      GROUP BY ts.id
      ORDER BY ts.start_ms ASC, ts.created_at ASC
    `);

    const screenRows = await tx.execute<{
      id: string;
      ts_ms: number;
      label: string | null;
      app_name: string | null;
      window_title: string | null;
      url: string | null;
      ocr_text: string | null;
      signal_tags: string[];
      evidence_ids: string[];
    }>(sql`
      SELECT
        se.id,
        se.ts_ms,
        COALESCE(se.ui_state_label, se.window_title, se.app_name, se.event_type) AS label,
        se.app_name,
        se.window_title,
        se.url,
        se.ocr_text,
        se.signal_tags,
        COALESCE(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '{}') AS evidence_ids
      FROM screen_events se
      LEFT JOIN evidence e
        ON e.source_type = 'screen_event'
       AND e.source_id = se.id
       AND e.redacted_at IS NULL
       AND e.tombstoned_at IS NULL
      WHERE se.org_id = ${input.orgId}
        AND se.workspace_id = ${input.workspaceId}
        AND se.capture_session_id = ANY(${uuidArraySql(input.captureSessionIds)})
        AND se.deleted_at IS NULL
        AND se.redacted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM redactions r
          WHERE r.org_id = se.org_id
            AND r.workspace_id = se.workspace_id
            AND r.capture_session_id = se.capture_session_id
            AND r.status <> 'failed'
            AND se.ts_ms BETWEEN r.start_ms AND r.end_ms
        )
      GROUP BY se.id
      ORDER BY se.ts_ms ASC, se.created_at ASC
    `);

    const documentRows = await tx.execute<{
      id: string;
      ordinal: number;
      text: string;
      evidence_ids: string[];
    }>(sql`
      SELECT
        dc.id,
        dc.ordinal,
        dc.text,
        COALESCE(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL), '{}') AS evidence_ids
      FROM document_chunks dc
      JOIN artifacts a ON a.id = dc.artifact_id
      LEFT JOIN evidence e
        ON e.source_type = 'document_chunk'
       AND e.source_id = dc.id
       AND e.redacted_at IS NULL
       AND e.tombstoned_at IS NULL
      WHERE dc.org_id = ${input.orgId}
        AND dc.workspace_id = ${input.workspaceId}
        AND a.capture_session_id = ANY(${uuidArraySql(input.captureSessionIds)})
        AND dc.redacted_at IS NULL
      GROUP BY dc.id
      ORDER BY dc.ordinal ASC, dc.created_at ASC
    `);

    const provisionalRows = await tx.execute<{
      id: string;
      ts_start_ms: number;
      ts_end_ms: number | null;
      action_verb: string | null;
      action_object: string | null;
      confidence: string | null;
    }>(sql`
      SELECT
        id,
        ts_start_ms,
        ts_end_ms,
        action_verb,
        action_object,
        confidence::text
      FROM provisional_steps
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND process_id = ${input.processId}
        AND capture_session_id = ANY(${uuidArraySql(input.captureSessionIds)})
        AND NOT EXISTS (
          SELECT 1
          FROM redactions r
          WHERE r.org_id = provisional_steps.org_id
            AND r.workspace_id = provisional_steps.workspace_id
            AND r.capture_session_id = provisional_steps.capture_session_id
            AND r.status <> 'failed'
            AND provisional_steps.ts_start_ms <= r.end_ms
            AND COALESCE(provisional_steps.ts_end_ms, provisional_steps.ts_start_ms) >= r.start_ms
        )
      ORDER BY COALESCE(ordinal_hint, 999999), ts_start_ms ASC, created_at ASC
    `);
    const redactionRows = await tx.execute<{
      id: string;
      capture_session_id: string;
      start_ms: number;
      end_ms: number;
      status: string;
    }>(sql`
      SELECT id, capture_session_id, start_ms, end_ms, status
      FROM redactions
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND capture_session_id = ANY(${uuidArraySql(input.captureSessionIds)})
        AND status <> 'failed'
      ORDER BY capture_session_id, start_ms ASC
    `);
    const slotRows = await tx
      .select({
        id: slotStates.id,
        slotPath: slotStates.slotPath,
        provisionalStepId: slotStates.provisionalStepId,
        value: slotStates.value,
        status: slotStates.status,
        confidence: slotStates.confidence,
        evidenceIds: slotStates.evidenceIds,
      })
      .from(slotStates)
      .where(
        sql`
          ${slotStates.orgId} = ${input.orgId}
          AND ${slotStates.workspaceId} = ${input.workspaceId}
          AND ${slotStates.captureSessionId} = ANY(${uuidArraySql(input.captureSessionIds)})
          AND ${slotStates.status} IN ('filled', 'partial', 'conflicting')
        `,
      );
    const processClaimRows = await tx.execute<{
      id: string;
      subject_type: string;
      subject_id: string;
      field: string;
      value: unknown;
      confidence: string | null;
      evidence_ids: string[];
    }>(sql`
      SELECT
        c.id,
        c.subject_type,
        c.subject_id,
        c.field,
        c.value,
        c.confidence::text,
        COALESCE(array_agg(e.id)
          FILTER (WHERE e.id IS NOT NULL), '{}') AS evidence_ids
      FROM claims c
      LEFT JOIN claim_evidence ce
        ON ce.claim_id = c.id
       AND ce.redacted_at IS NULL
      LEFT JOIN evidence e
        ON e.id = ce.evidence_id
       AND e.org_id = c.org_id
       AND e.workspace_id = c.workspace_id
       AND e.redacted_at IS NULL
       AND e.tombstoned_at IS NULL
      WHERE c.org_id = ${input.orgId}
        AND c.workspace_id = ${input.workspaceId}
        AND c.status = 'active'
        AND c.superseded_by_claim_id IS NULL
        AND c.redacted_at IS NULL
        AND c.tombstoned_at IS NULL
        AND (
          (c.subject_type = 'process' AND c.subject_id = ${input.processId})
          OR (
            ${priorVersion?.id ?? null}::uuid IS NOT NULL
            AND c.subject_type = 'process_version'
            AND c.subject_id = ${priorVersion?.id ?? null}::uuid
          )
        )
      GROUP BY c.id
      ORDER BY c.created_at ASC
    `);
    const validSlotEvidenceIds = new Set(
      slotRows.flatMap((slot) => slot.evidenceIds ?? []),
    );
    if (validSlotEvidenceIds.size > 0) {
      const validEvidenceRows = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM evidence
        WHERE org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND id = ANY(${uuidArraySql([...validSlotEvidenceIds])})
          AND redacted_at IS NULL
          AND tombstoned_at IS NULL
      `);
      validSlotEvidenceIds.clear();
      for (const row of validEvidenceRows.rows)
        validSlotEvidenceIds.add(row.id);
    }

    return {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      processName: process.name,
      captureSessionIds: input.captureSessionIds,
      priorVersion: priorVersion
        ? {
            id: priorVersion.id,
            versionNumber: priorVersion.version_number,
            status: priorVersion.status,
            summary: priorVersion.summary,
          }
        : null,
      processClaims: processClaimRows.rows.map((row) => ({
        id: row.id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        field: row.field,
        value: row.value,
        confidence: Number(row.confidence ?? 0),
        evidenceIds: row.evidence_ids ?? [],
      })),
      redactionWindows: redactionRows.rows.map((row) => ({
        id: row.id,
        captureSessionId: row.capture_session_id,
        startMs: row.start_ms,
        endMs: row.end_ms,
        status: row.status,
      })),
      transcriptSegments: transcriptRows.rows.map((row) => ({
        id: row.id,
        text: row.text,
        startMs: row.start_ms,
        endMs: row.end_ms,
        evidenceIds: row.evidence_ids ?? [],
      })),
      screenEvents: screenRows.rows.map((row) => ({
        id: row.id,
        tsMs: row.ts_ms,
        label: row.label ?? "Screen event",
        appName: row.app_name,
        windowTitle: row.window_title,
        url: row.url,
        ocrText: row.ocr_text,
        signalTags: row.signal_tags ?? [],
        evidenceIds: row.evidence_ids ?? [],
      })),
      documentChunks: documentRows.rows.map((row) => ({
        id: row.id,
        ordinal: row.ordinal,
        text: row.text,
        evidenceIds: row.evidence_ids ?? [],
      })),
      provisionalSteps: provisionalRows.rows.map((row) => ({
        id: row.id,
        tsStartMs: row.ts_start_ms,
        tsEndMs: row.ts_end_ms,
        title: titleFromParts(row.action_verb, row.action_object),
        confidence: row.confidence !== null ? Number(row.confidence) : 0.55,
      })),
      slotStates: slotRows.map((row) => ({
        id: row.id,
        slotPath: row.slotPath,
        provisionalStepId: row.provisionalStepId,
        value: row.value,
        status: row.status,
        confidence: Number(row.confidence ?? 0),
        evidenceIds: (row.evidenceIds ?? []).filter((id) =>
          validSlotEvidenceIds.has(id),
        ),
      })),
    };
  });
}

export function buildDeterministicOperatorGraph(
  pack: OperatorEvidencePack,
): Omit<ProcessGraph, "process_id" | "version_number" | "status"> {
  const taskSeeds = taskSeedsFromPack(pack);
  const startId = randomUUID();
  const endId = randomUUID();
  const layout = layoutOperatorGraph(taskSeeds.length);
  const nodes: GraphNode[] = [
    {
      id: startId,
      type: "start",
      position: layout.startPosition,
      data: {
        title: "Start",
        description: `Begin ${pack.processName}.`,
        confidence: 0.35,
      },
    },
    ...taskSeeds.map((seed, index) => ({
      id: seed.id,
      type: "task" as const,
      position: layout.taskPosition(index),
      data: {
        title: seed.title,
        description: seed.description,
        confidence: seed.confidence,
        evidence_ids: seed.evidenceIds,
        systems: seed.systems,
        inputs: seed.inputs,
        outputs: seed.outputs,
        exceptions: seed.exceptions,
        workarounds: seed.workarounds,
        variants: seed.variants,
        source_provisional_step_ids: seed.provisionalStepIds,
      },
    })),
    {
      id: endId,
      type: "end",
      position: layout.endPosition,
      data: {
        title: "End",
        description: `Complete ${pack.processName}.`,
        confidence: 0.35,
      },
    },
  ];

  const edges: GraphEdge[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const source = nodes[index];
    const target = nodes[index + 1];
    edges.push({
      id: randomUUID(),
      source: source.id,
      target: target.id,
      edge_type: "seq",
      evidence_ids: target.data.evidence_ids ?? source.data.evidence_ids ?? [],
      waypoints: operatorEdgeWaypoints(source.position, target.position),
      sourceSide: "right",
      targetSide: "left",
    });
  }

  return { nodes, edges, warnings: [] };
}

type OperatorTaskSeed = {
  id: string;
  title: string;
  description: string;
  confidence: number;
  sortKey: number;
  evidenceIds: string[];
  provisionalStepIds: string[];
  systems?: string[];
  inputs?: GraphNode["data"]["inputs"];
  outputs?: GraphNode["data"]["outputs"];
  exceptions?: GraphNode["data"]["exceptions"];
  workarounds?: GraphNode["data"]["workarounds"];
  variants?: GraphNode["data"]["variants"];
};

function taskSeedsFromPack(pack: OperatorEvidencePack) {
  const chunks = segmentOperatorEvidencePack(pack);
  const timelineChunks = chunks.filter((chunk) => chunk.startMs !== null);
  const documentChunks = chunks.filter(
    (chunk) => chunk.startMs === null && chunk.documentChunks.length > 0,
  );

  const provisionalSeeds: OperatorTaskSeed[] = timelineChunks.flatMap((chunk) =>
    chunk.provisionalSteps.map((step) => {
      const slotDetails = slotDetailsForProvisionalStep(pack, step.id);
      return {
        id: randomUUID(),
        title: step.title,
        description: `Captured around ${Math.round(step.tsStartMs / 1000)}s in the operator walkthrough.`,
        confidence: Math.max(
          step.confidence || 0.65,
          slotDetails.confidence ?? 0,
        ),
        sortKey: step.tsStartMs,
        evidenceIds: uniqueStrings([
          ...nearbyEvidenceIds(pack, step.tsStartMs, step.tsEndMs),
          ...slotDetails.evidenceIds,
        ]),
        provisionalStepIds: [step.id],
        systems: slotDetails.systems,
        inputs: slotDetails.inputs,
        outputs: slotDetails.outputs,
        exceptions: slotDetails.exceptions,
        workarounds: slotDetails.workarounds,
        variants: slotDetails.variants,
      };
    }),
  );

  const transcriptSeeds: OperatorTaskSeed[] = timelineChunks.flatMap((chunk) =>
    chunk.transcriptSegments.flatMap(
    (segment) =>
      splitActionSentences(segment.text).map((text, index) => ({
        id: randomUUID(),
        title: titleCase(trimText(text, 64)),
        description: trimText(text, 220),
        confidence: segment.evidenceIds.length ? 0.72 : 0.48,
        sortKey: segment.startMs + index / 100,
        evidenceIds: segment.evidenceIds,
        provisionalStepIds: [],
      })),
    ),
  );

  const screenSeeds: OperatorTaskSeed[] = timelineChunks.flatMap((chunk) =>
    chunk.screenEvents.map((event) => {
    const signalDetails = screenSignalDetails(
      event.signalTags,
      event.evidenceIds,
    );
    const ioDetails = screenIoDetails(event);
    return {
      id: randomUUID(),
      title: titleCase(trimText(event.label, 64)),
      description: event.signalTags.length
        ? `Observed screen signal tags: ${event.signalTags.join(", ")}.`
        : "Observed screen event.",
      confidence: event.evidenceIds.length ? 0.68 : 0.42,
      sortKey: event.tsMs,
      evidenceIds: event.evidenceIds,
      provisionalStepIds: [],
      systems: systemNamesFromScreenEvent(event),
      inputs: ioDetails.inputs,
      outputs: ioDetails.outputs,
      ...signalDetails,
    };
    }),
  );

  const documentSeeds: OperatorTaskSeed[] = documentChunks
    .flatMap((chunk) => chunk.documentChunks)
    .map((chunk) => ({
      id: randomUUID(),
      title: titleCase(trimText(firstSentence(chunk.text), 64)),
      description: trimText(chunk.text, 220),
      confidence: chunk.evidenceIds.length ? 0.58 : 0.38,
      sortKey: Number.MAX_SAFE_INTEGER - 10_000 + chunk.ordinal,
      evidenceIds: chunk.evidenceIds,
      provisionalStepIds: [],
      systems: systemNamesFromText(chunk.text),
    }));

  const seeds = mergeTaskSeeds([
    ...provisionalSeeds,
    ...transcriptSeeds,
    ...screenSeeds,
    ...documentSeeds,
  ]);
  if (seeds.length) return seeds;

  return [
    {
      id: randomUUID(),
      title: `Map ${pack.processName}`,
      description:
        "No detailed operator evidence has been extracted yet; this inferred node marks the draft as requiring follow-up.",
      confidence: 0.2,
      sortKey: 0,
      evidenceIds: [],
      provisionalStepIds: [],
    },
  ];
}

export function segmentOperatorEvidencePack(
  pack: OperatorEvidencePack,
  chunkSizeMs = 10 * 60 * 1000,
): OperatorEvidenceChunk[] {
  const starts = [
    ...pack.transcriptSegments.map((segment) => segment.startMs),
    ...pack.screenEvents.map((event) => event.tsMs),
    ...pack.provisionalSteps.map((step) => step.tsStartMs),
  ].filter((value) => Number.isFinite(value));
  const firstStart = starts.length ? Math.min(...starts) : null;
  const chunksByIndex = new Map<number, OperatorEvidenceChunk>();

  function chunkForTime(tsMs: number) {
    const index =
      firstStart === null
        ? 0
        : Math.max(0, Math.floor((tsMs - firstStart) / chunkSizeMs));
    const existing = chunksByIndex.get(index);
    if (existing) return existing;
    const startMs = firstStart === null ? null : firstStart + index * chunkSizeMs;
    const chunk: OperatorEvidenceChunk = {
      index,
      startMs,
      endMs: startMs === null ? null : startMs + chunkSizeMs - 1,
      transcriptSegments: [],
      screenEvents: [],
      provisionalSteps: [],
      documentChunks: [],
    };
    chunksByIndex.set(index, chunk);
    return chunk;
  }

  for (const segment of pack.transcriptSegments) {
    chunkForTime(segment.startMs).transcriptSegments.push(segment);
  }
  for (const event of pack.screenEvents) {
    chunkForTime(event.tsMs).screenEvents.push(event);
  }
  for (const step of pack.provisionalSteps) {
    chunkForTime(step.tsStartMs).provisionalSteps.push(step);
  }

  const timelineChunks = [...chunksByIndex.values()].sort(
    (left, right) => left.index - right.index,
  );
  if (pack.documentChunks.length > 0) {
    timelineChunks.push({
      index: timelineChunks.length,
      startMs: null,
      endMs: null,
      transcriptSegments: [],
      screenEvents: [],
      provisionalSteps: [],
      documentChunks: pack.documentChunks,
    });
  }
  if (timelineChunks.length > 0) return timelineChunks;
  return [
    {
      index: 0,
      startMs: null,
      endMs: null,
      transcriptSegments: [],
      screenEvents: [],
      provisionalSteps: [],
      documentChunks: [],
    },
  ];
}

function screenSignalDetails(signalTags: string[], evidenceIds: string[]) {
  const workarounds: NonNullable<GraphNode["data"]["workarounds"]> = [];
  const exceptions: NonNullable<GraphNode["data"]["exceptions"]> = [];
  if (
    signalTags.some((tag) =>
      [
        "duplicate_data_entry",
        "copy_paste_between_systems",
        "left_system_of_record",
        "alt_tab_to_spreadsheet",
      ].includes(tag),
    )
  ) {
    workarounds.push({
      description:
        "Observed screen activity suggests a manual workaround outside the primary workflow path.",
      why_it_exists:
        "Operator moved data across systems or outside the system of record.",
      evidence_ids: evidenceIds,
    });
  }
  if (
    signalTags.some((tag) =>
      ["waiting_or_refreshing", "manual_search_or_filtering"].includes(tag),
    )
  ) {
    exceptions.push({
      label: "Observed friction or waiting during the screen walkthrough",
      sub_type: "screen_signal",
      trigger: signalTags.join(", "),
      detection: "screen_event_signal_tags",
      evidence_ids: evidenceIds,
    });
  }
  return {
    ...(workarounds.length ? { workarounds } : {}),
    ...(exceptions.length ? { exceptions } : {}),
  };
}

function slotDetailsForProvisionalStep(
  pack: OperatorEvidencePack,
  provisionalStepId: string,
) {
  const slots = pack.slotStates.filter(
    (slot) => slot.provisionalStepId === provisionalStepId,
  );
  const systems: string[] = [];
  const inputs: NonNullable<GraphNode["data"]["inputs"]> = [];
  const outputs: NonNullable<GraphNode["data"]["outputs"]> = [];
  const exceptions: NonNullable<GraphNode["data"]["exceptions"]> = [];
  const workarounds: NonNullable<GraphNode["data"]["workarounds"]> = [];
  const variants: NonNullable<GraphNode["data"]["variants"]> = [];
  const evidenceIds = uniqueStrings(slots.flatMap((slot) => slot.evidenceIds));
  const confidenceValues = slots
    .map((slot) => slot.confidence)
    .filter((value) => Number.isFinite(value));

  for (const slot of slots) {
    const value = recordValue(slot.value);
    if (slot.slotPath === "step.systems") {
      const systemName = stringValue(
        value.system_name ?? value.name ?? value.system,
      );
      if (systemName) systems.push(systemName);
      continue;
    }
    if (slot.slotPath === "step.inputs_outputs") {
      const name = stringValue(value.label ?? value.name);
      if (!name) continue;
      const item = {
        name,
        description:
          stringValue(value.medium ?? value.description) ?? undefined,
        evidence_ids: slot.evidenceIds,
      };
      if (value.io_type === "output") outputs.push(item);
      else inputs.push(item);
      continue;
    }
    if (
      slot.slotPath === "step.data_copied_from" ||
      slot.slotPath === "step.data_copied_to" ||
      slot.slotPath === "step.output"
    ) {
      const name = stringValue(
        value.label ??
          value.name ??
          value.source ??
          value.target ??
          value.output,
      );
      if (!name) continue;
      const item = {
        name,
        description:
          stringValue(value.medium ?? value.description) ?? undefined,
        evidence_ids: slot.evidenceIds,
      };
      if (slot.slotPath === "step.data_copied_from") inputs.push(item);
      else outputs.push(item);
      continue;
    }
    if (
      slot.slotPath === "step.decisions" ||
      slot.slotPath === "step.decision_criteria" ||
      slot.slotPath === "step.variant_conditions"
    ) {
      const condition = stringValue(value.condition);
      const branches = Array.isArray(value.branches)
        ? value.branches.map((branch) => String(branch)).filter(Boolean)
        : [];
      if (condition) {
        variants.push({
          condition: branches.length
            ? `${condition}: ${branches.join(" / ")}`
            : condition,
          evidence_ids: slot.evidenceIds,
        });
      }
      continue;
    }
    if (slot.slotPath === "step.next_owner") {
      const owner = stringValue(value.next_owner ?? value.owner ?? value.role);
      if (owner) {
        outputs.push({
          name: `Handoff to ${owner}`,
          description:
            stringValue(value.handoff_trigger ?? value.medium) ?? undefined,
          evidence_ids: slot.evidenceIds,
        });
      }
      continue;
    }
    if (slot.slotPath === "step.exceptions") {
      const label = stringValue(value.condition ?? value.label);
      if (label) {
        exceptions.push({
          label,
          sub_type: "operator_reported",
          trigger: stringValue(value.frequency) ?? undefined,
          detection: stringValue(value.impact) ?? undefined,
          evidence_ids: slot.evidenceIds,
        });
      }
      continue;
    }
    if (
      slot.slotPath === "step.workarounds" ||
      slot.slotPath === "step.intentional_deviations"
    ) {
      const description = stringValue(
        value.workaround ?? value.deviation ?? value.description,
      );
      if (description) {
        workarounds.push({
          description,
          why_it_exists: stringValue(value.reason) ?? undefined,
          evidence_ids: slot.evidenceIds,
        });
      }
    }
  }

  return {
    systems: uniqueStrings(systems),
    inputs,
    outputs,
    exceptions,
    workarounds,
    variants,
    evidenceIds,
    confidence:
      confidenceValues.length > 0
        ? confidenceValues.reduce((sum, value) => sum + value, 0) /
          confidenceValues.length
        : null,
  };
}

function screenIoDetails(event: OperatorEvidencePack["screenEvents"][number]) {
  const inputs: NonNullable<GraphNode["data"]["inputs"]> = [];
  const outputs: NonNullable<GraphNode["data"]["outputs"]> = [];
  const evidenceIds = event.evidenceIds;
  const text = [event.label, event.windowTitle, event.ocrText]
    .filter(Boolean)
    .join(" ");
  if (/\b(search|filter|lookup|find)\b/i.test(text)) {
    inputs.push({
      name: "Search criteria",
      description: trimText(text, 160),
      evidence_ids: evidenceIds,
    });
  }
  if (/\b(csv|xlsx|spreadsheet|download|export|report)\b/i.test(text)) {
    outputs.push({
      name: "Downloaded or exported file",
      description: trimText(text, 160),
      evidence_ids: evidenceIds,
    });
  }
  if (event.signalTags.includes("copy_paste_between_systems")) {
    inputs.push({
      name: "Copied source data",
      description: "Observed copy/paste activity between workflow systems.",
      evidence_ids: evidenceIds,
    });
    outputs.push({
      name: "Pasted target data",
      description: "Observed manual data transfer into another system.",
      evidence_ids: evidenceIds,
    });
  }
  return { inputs, outputs };
}

function systemNamesFromScreenEvent(
  event: OperatorEvidencePack["screenEvents"][number],
) {
  const values = [
    event.appName,
    ...systemNamesFromText(
      [event.label, event.windowTitle, event.ocrText, event.url]
        .filter(Boolean)
        .join(" "),
    ),
    systemNameFromUrl(event.url),
  ];
  return uniqueStrings(
    values.filter((value): value is string => Boolean(value)),
  );
}

function systemNamesFromText(text: string) {
  return uniqueStrings(
    [
      ["Salesforce", /\bsalesforce\b/i],
      ["NetSuite", /\bnetsuite\b/i],
      ["SAP", /\bsap\b/i],
      ["Workday", /\bworkday\b/i],
      ["ServiceNow", /\bservice ?now\b/i],
      ["Zendesk", /\bzendesk\b/i],
      ["Excel", /\b(excel|spreadsheet|xlsx|csv)\b/i],
      ["Google Sheets", /\bgoogle sheets?\b/i],
      ["Gmail", /\bgmail\b/i],
      ["Slack", /\bslack\b/i],
    ]
      .filter(([, pattern]) => (pattern as RegExp).test(text))
      .map(([name]) => name as string),
  );
}

function systemNameFromUrl(url: string | null) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    const domain = hostname.split(".")[0];
    return domain ? titleCase(domain) : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nearbyEvidenceIds(
  pack: OperatorEvidencePack,
  startMs: number,
  endMs: number | null,
) {
  const windowEnd = endMs ?? startMs + 20_000;
  const transcriptIds = pack.transcriptSegments
    .filter(
      (segment) => segment.startMs <= windowEnd && segment.endMs >= startMs,
    )
    .flatMap((segment) => segment.evidenceIds);
  const screenIds = pack.screenEvents
    .filter((event) => event.tsMs >= startMs && event.tsMs <= windowEnd)
    .flatMap((event) => event.evidenceIds);
  return [...new Set([...transcriptIds, ...screenIds])];
}

function mergeTaskSeeds(seeds: OperatorTaskSeed[]) {
  const byKey = new Map<string, OperatorTaskSeed>();
  for (const seed of seeds) {
    const key = normalizeKey(seed.title);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, seed);
      continue;
    }
    byKey.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, seed.confidence),
      sortKey: Math.min(existing.sortKey, seed.sortKey),
      evidenceIds: uniqueStrings([...existing.evidenceIds, ...seed.evidenceIds]),
      provisionalStepIds: uniqueStrings([
        ...existing.provisionalStepIds,
        ...seed.provisionalStepIds,
      ]),
      systems: uniqueStrings([
        ...(existing.systems ?? []),
        ...(seed.systems ?? []),
      ]),
      inputs: mergeGraphItems(existing.inputs, seed.inputs),
      outputs: mergeGraphItems(existing.outputs, seed.outputs),
      exceptions: mergeGraphItems(existing.exceptions, seed.exceptions),
      workarounds: mergeGraphItems(existing.workarounds, seed.workarounds),
      variants: mergeGraphItems(existing.variants, seed.variants),
    });
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.sortKey - right.sortKey || left.title.localeCompare(right.title),
  );
}

function mergeGraphItems<T extends { evidence_ids?: string[] }>(
  left: T[] | undefined,
  right: T[] | undefined,
) {
  const values = [...(left ?? []), ...(right ?? [])];
  const byKey = new Map<string, T>();
  for (const value of values) {
    const key = normalizeKey(JSON.stringify({ ...value, evidence_ids: [] }));
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, value);
      continue;
    }
    byKey.set(key, {
      ...existing,
      evidence_ids: uniqueStrings([
        ...(existing.evidence_ids ?? []),
        ...(value.evidence_ids ?? []),
      ]),
    });
  }
  return values.length ? [...byKey.values()] : undefined;
}

function splitActionSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) =>
      /\b(I|we|then|next|after|before|open|check|copy|paste|enter|submit|approve|review|send|download|upload|update|create|look|go|export|import)\b/i.test(
        part,
      ),
    )
    .slice(0, 4);
}

function titleFromParts(verb: string | null, object: string | null) {
  const text = [verb, object].filter(Boolean).join(" ").trim();
  return text ? titleCase(text) : "Captured operator step";
}

function firstSentence(text: string) {
  return text.split(/(?<=[.!?])\s+/)[0] ?? text;
}

function trimText(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function titleCase(text: string) {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function averageConfidence(nodes: GraphNode[], fallback: number) {
  const values = nodes
    .map((node) => node.data.confidence)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  if (values.length === 0) return fallback;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.min(1, Math.max(0, average));
}

function evidencePackRefs(pack: OperatorEvidencePack) {
  return [
    ...pack.transcriptSegments.map((row) => ({
      table: "transcript_segments",
      id: row.id,
    })),
    ...pack.screenEvents.map((row) => ({ table: "screen_events", id: row.id })),
    ...pack.documentChunks.map((row) => ({
      table: "document_chunks",
      id: row.id,
    })),
    ...pack.provisionalSteps.map((row) => ({
      table: "provisional_steps",
      id: row.id,
    })),
    ...(pack.processClaims ?? []).map((row) => ({
      table: "claims",
      id: row.id,
    })),
    ...(pack.redactionWindows ?? []).map((row) => ({
      table: "redactions",
      id: row.id,
    })),
  ];
}

async function recordOperatorStage(input: {
  orgId: string;
  workspaceId: string;
  synthesisRunId: string;
  stageName: string;
  inputRowRefs: Array<{ table: string; id: string }>;
  outputRowRefs: Array<{ table: string; id: string }>;
  status: "queued" | "running" | "completed" | "skipped" | "failed";
}) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.insert(synthesisStageOutputs).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName: input.stageName,
      inputRowRefs: input.inputRowRefs,
      outputRowRefs: input.outputRowRefs,
      status: input.status,
    });
  });
}

async function completeOperatorSynthesisRun(input: {
  orgId: string;
  workspaceId: string;
  synthesisRunId: string;
  versionId: string;
  linkedCaptureRefs: Array<{ table: string; id: string }>;
  complexity: ReturnType<typeof computeComplexityScore>;
  narrative: ReturnType<typeof buildOperatorDraftNarrative>;
  userId?: string | null;
}) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .update(synthesisRuns)
      .set({
        status: "completed",
        stage: "stage-8-publish-draft",
        updatedAt: new Date(),
      })
      .where(sql`id = ${input.synthesisRunId}`);
    await tx.insert(synthesisStageOutputs).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName: "stage-8-publish-draft",
      inputRowRefs: [{ table: "process_versions", id: input.versionId }],
      outputRowRefs: [
        { table: "process_versions", id: input.versionId },
        ...input.linkedCaptureRefs,
      ],
      status: "completed",
    });
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      eventType: "synthesis.operator.completed",
      subjectType: "synthesis_run",
      subjectId: input.synthesisRunId,
      metadataJson: {
        version_id: input.versionId,
        complexity: input.complexity,
        narrative: input.narrative,
      },
    });
  });
}

async function failOperatorSynthesisRun(input: {
  orgId: string;
  workspaceId: string;
  synthesisRunId: string;
  stage: string;
  reason: string;
  issues: unknown[];
  userId?: string | null;
}) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .update(synthesisRuns)
      .set({
        status: "failed",
        stage: input.stage,
        errorJson: {
          reason: input.reason,
          issues: input.issues,
        },
        updatedAt: new Date(),
      })
      .where(sql`id = ${input.synthesisRunId}`);
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      eventType: "synthesis.operator.failed",
      subjectType: "synthesis_run",
      subjectId: input.synthesisRunId,
      metadataJson: {
        stage: input.stage,
        reason: input.reason,
        issues: input.issues,
      },
    });
  });
}
