import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { ApiError } from "@/lib/http/json";
import { getDb, setOrgContext } from "@/lib/db/client";
import { evidence, processes, workspaces } from "@/lib/db/schema";
import { getProcessGraphVersion } from "@/lib/processes/graph-queries";
import { getProcessOpportunities } from "@/lib/processes/opportunity-queries";
import type { ProcessGraph } from "@/lib/types/graph";

export type ExportableProcessVersion = {
  processId: string;
  processName: string;
  processStatus: string;
  versionId: string;
  versionNumber: number;
  versionStatus: string;
  summary: string | null;
  nodeCount: number;
  evidenceCount: number;
  updatedAt: Date;
};

export type ProcessJsonExport = {
  export_type: "process_json";
  exported_at: string;
  workspace: {
    id: string;
    name: string;
    function_name: string;
  };
  process: {
    id: string;
    name: string;
    status: string;
  };
  version: {
    id: string;
    version_number: number;
    status: string;
    summary: string | null;
  };
  graph: ProcessGraph;
  evidence: Array<{
    id: string;
    source_type: string;
    source_id: string | null;
    evidence_label: string;
    quote: string | null;
    summary: string | null;
    observed_at: string | null;
    confidence: number;
    redacted: boolean;
  }>;
  opportunities: {
    source: "agent" | "heuristic";
    opportunity_set_key: string;
    items: Awaited<ReturnType<typeof getProcessOpportunities>>["opportunities"];
  };
};

type ExportableRow = {
  process_id: string;
  process_name: string;
  process_status: string;
  version_id: string;
  version_number: number;
  version_status: string;
  summary: string | null;
  graph_json: unknown;
  updated_at: Date;
};

export async function listExportableProcessVersions(
  orgId: string,
  workspaceId: string,
): Promise<ExportableProcessVersion[]> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<ExportableRow>(sql`
      SELECT
        p.id AS process_id,
        p.name AS process_name,
        p.status::text AS process_status,
        pv.id AS version_id,
        pv.version_number,
        pv.status::text AS version_status,
        pv.summary,
        pv.graph_json,
        pv.updated_at
      FROM process_versions pv
      JOIN processes p ON p.id = pv.process_id
      WHERE pv.org_id = ${orgId}
        AND pv.workspace_id = ${workspaceId}
        AND p.org_id = ${orgId}
        AND p.workspace_id = ${workspaceId}
        AND pv.graph_json IS NOT NULL
        AND (
          p.current_draft_version_id = pv.id
          OR p.current_approved_version_id = pv.id
          OR EXISTS (
            SELECT 1
            FROM audit_log al
            WHERE al.org_id = ${orgId}
              AND al.workspace_id = ${workspaceId}
              AND al.event_type = 'synthesis.operator.draft_published'
              AND al.subject_type = 'process_version'
              AND al.subject_id = pv.id
          )
        )
      ORDER BY p.name ASC, pv.version_number DESC
    `);
  });

  return result.rows.map((row) => {
    const graph = parseGraphShape(row.graph_json);
    const evidenceIds = graph ? collectGraphEvidenceIds(graph) : [];
    return {
      processId: row.process_id,
      processName: row.process_name,
      processStatus: row.process_status,
      versionId: row.version_id,
      versionNumber: row.version_number,
      versionStatus: row.version_status,
      summary: row.summary,
      nodeCount: graph?.nodes.length ?? 0,
      evidenceCount: evidenceIds.length,
      updatedAt: row.updated_at,
    };
  });
}

export async function buildProcessJsonExport({
  orgId,
  workspaceId,
  processId,
  versionId,
}: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
}): Promise<ProcessJsonExport> {
  const [workspaceRow, processRow, graph] = await Promise.all([
    loadWorkspace(orgId, workspaceId),
    loadProcess(orgId, workspaceId, processId),
    getProcessGraphVersion(orgId, workspaceId, processId, versionId),
  ]);
  if (!workspaceRow) {
    throw new ApiError(404, "not_found", "Workspace not found.");
  }
  if (!processRow) {
    throw new ApiError(404, "not_found", "Process not found.");
  }
  if (!graph) {
    throw new ApiError(404, "not_found", "Process version graph not found.");
  }

  const evidenceRows = await loadEvidenceRows(
    orgId,
    workspaceId,
    collectGraphEvidenceIds(graph),
  );
  const opportunities = await getProcessOpportunities({
    orgId,
    workspaceId,
    processId,
    graph,
  });

  return {
    export_type: "process_json",
    exported_at: new Date().toISOString(),
    workspace: {
      id: workspaceRow.id,
      name: workspaceRow.name,
      function_name: workspaceRow.functionName,
    },
    process: {
      id: processRow.id,
      name: processRow.name,
      status: processRow.status,
    },
    version: {
      id: graph.version_id ?? versionId,
      version_number: graph.version_number,
      status: graph.status,
      summary: graph.summary ?? null,
    },
    graph,
    evidence: evidenceRows.map((row) => {
      const redacted = Boolean(row.redactedAt || row.tombstonedAt);
      return {
        id: row.id,
        source_type: row.sourceType,
        source_id: row.sourceId ?? null,
        evidence_label: row.evidenceLabel,
        quote: redacted ? null : row.quote,
        summary: redacted
          ? "Evidence text omitted because this row is redacted or tombstoned."
          : row.summary,
        observed_at: row.observedAt?.toISOString() ?? null,
        confidence: Number(row.confidence),
        redacted,
      };
    }),
    opportunities: {
      source: opportunities.source,
      opportunity_set_key: opportunities.opportunitySetKey,
      items: opportunities.opportunities,
    },
  };
}

function loadWorkspace(orgId: string, workspaceId: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return (
      await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.orgId, orgId), eq(workspaces.id, workspaceId)))
        .limit(1)
    )[0];
  });
}

function loadProcess(orgId: string, workspaceId: string, processId: string) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return (
      await tx
        .select()
        .from(processes)
        .where(
          and(
            eq(processes.orgId, orgId),
            eq(processes.workspaceId, workspaceId),
            eq(processes.id, processId),
          ),
        )
        .limit(1)
    )[0];
  });
}

async function loadEvidenceRows(
  orgId: string,
  workspaceId: string,
  evidenceIds: string[],
) {
  if (evidenceIds.length === 0) return [];
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.orgId, orgId),
          eq(evidence.workspaceId, workspaceId),
          inArray(evidence.id, evidenceIds),
        ),
      );
  });
}

function parseGraphShape(value: unknown): Pick<ProcessGraph, "nodes" | "edges"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const graph = value as Partial<ProcessGraph>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
  return { nodes: graph.nodes, edges: graph.edges };
}

function collectGraphEvidenceIds(graph: Pick<ProcessGraph, "nodes" | "edges">) {
  const ids = new Set<string>();
  const add = (values?: string[]) => values?.forEach((id) => ids.add(id));
  for (const node of graph.nodes) {
    add(node.data.evidence_ids);
    for (const item of node.data.inputs ?? []) add(item.evidence_ids);
    for (const item of node.data.outputs ?? []) add(item.evidence_ids);
    for (const item of node.data.exceptions ?? []) add(item.evidence_ids);
    for (const item of node.data.workarounds ?? []) add(item.evidence_ids);
    for (const item of node.data.variants ?? []) add(item.evidence_ids);
  }
  for (const edge of graph.edges) add(edge.evidence_ids);
  return Array.from(ids);
}
