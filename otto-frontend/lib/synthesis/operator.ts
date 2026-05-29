import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { assertValidOperatorGraph } from "@/lib/synthesis/operator-graph-validation";
import type { GraphEdge, GraphNode, ProcessGraph } from "@/lib/types/graph";

export type WriteOperatorGraphDraftInput = {
  orgId: string;
  workspaceId: string;
  processId: string;
  graph: Omit<ProcessGraph, "process_id" | "version_number" | "status">;
  summary?: string;
  warnings?: ProcessGraph["warnings"];
};

export type WriteOperatorGraphDraftResult = {
  versionId: string;
  versionNumber: number;
  graph: ProcessGraph;
};

export async function writeOperatorGraphDraft(
  input: WriteOperatorGraphDraftInput,
): Promise<WriteOperatorGraphDraftResult> {
  assertValidOperatorGraph(input.graph);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const processRows = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM processes
      WHERE id = ${input.processId}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
      FOR UPDATE
    `);
    if (!processRows.rows[0]) {
      throw new Error("Process not found for operator graph draft.");
    }

    const versionRows = await tx.execute<{ next_version: number }>(sql`
      SELECT COALESCE(MAX(version_number), 0)::int + 1 AS next_version
      FROM process_versions
      WHERE process_id = ${input.processId}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
    `);
    const versionNumber = versionRows.rows[0]?.next_version ?? 1;
    const versionId = randomUUID();
    const graph: ProcessGraph = {
      version_id: versionId,
      process_id: input.processId,
      version_number: versionNumber,
      status: "draft",
      summary: input.summary ?? null,
      warnings: input.warnings ?? input.graph.warnings ?? [],
      nodes: input.graph.nodes,
      edges: input.graph.edges,
    };

    await tx.execute(sql`
      INSERT INTO process_versions (
        id,
        org_id,
        workspace_id,
        process_id,
        version_number,
        status,
        summary,
        graph_json
      )
      VALUES (
        ${versionId},
        ${input.orgId},
        ${input.workspaceId},
        ${input.processId},
        ${versionNumber},
        'draft',
        ${input.summary ?? null},
        ${JSON.stringify(graph)}::jsonb
      )
    `);

    for (const [index, node] of input.graph.nodes.entries()) {
      await insertNode({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        processId: input.processId,
        versionId,
        node,
        ordinal: index + 1,
      }, tx);
    }

    for (const edge of input.graph.edges) {
      await insertEdge({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        processId: input.processId,
        versionId,
        edge,
      }, tx);
    }

    return { versionId, versionNumber, graph };
  });
}

export async function publishOperatorGraphDraft(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
  userId?: string | null;
}) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM process_versions
      WHERE id = ${input.versionId}
        AND process_id = ${input.processId}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND status = 'draft'
      FOR UPDATE
    `);
    if (!rows.rows[0]) {
      throw new Error("Draft process version not found.");
    }

    await tx.execute(sql`
      UPDATE processes
      SET current_draft_version_id = ${input.versionId},
          updated_at = now()
      WHERE id = ${input.processId}
        AND org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
    `);
    await tx.execute(sql`
      INSERT INTO audit_log (
        org_id,
        workspace_id,
        user_id,
        event_type,
        subject_type,
        subject_id,
        metadata_json
      )
      VALUES (
        ${input.orgId},
        ${input.workspaceId},
        ${input.userId ?? null},
        'synthesis.operator.draft_published',
        'process_version',
        ${input.versionId},
        ${JSON.stringify({
          process_id: input.processId,
        })}::jsonb
      )
    `);
    return { versionId: input.versionId };
  });
}

async function insertNode(
  input: {
    orgId: string;
    workspaceId: string;
    processId: string;
    versionId: string;
    node: GraphNode;
    ordinal: number;
  },
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
) {
  const data = input.node.data;
  const evidenceIds = data.evidence_ids ?? [];
  await tx.execute(sql`
    INSERT INTO process_nodes (
      id,
      org_id,
      workspace_id,
      process_id,
      version_id,
      parent_node_id,
      ordinal,
      node_type,
      title,
      description,
      sla_seconds,
      est_minutes_per_run,
      confidence,
      evidence_count,
      top_evidence_ids,
      position_json,
      metadata_json
    )
    VALUES (
      ${input.node.id},
      ${input.orgId},
      ${input.workspaceId},
      ${input.processId},
      ${input.versionId},
      ${input.node.parent_node_id ?? null},
      ${input.ordinal},
      ${input.node.type},
      ${data.title},
      ${data.description ?? null},
      ${data.sla_seconds ?? null},
      ${data.est_minutes ?? null},
      ${data.confidence ?? 0},
      ${evidenceIds.length},
      ${uuidArraySql(evidenceIds)},
      ${JSON.stringify(input.node.position)}::jsonb,
      ${JSON.stringify({
        role: data.role,
        systems: data.systems ?? [],
        claim_ids: data.claim_ids ?? [],
        source_provisional_step_ids: data.source_provisional_step_ids ?? [],
      })}::jsonb
    )
  `);
  await insertNodeDetails(
    {
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      versionId: input.versionId,
      node: input.node,
    },
    tx,
  );
}

async function insertNodeDetails(
  input: {
    orgId: string;
    workspaceId: string;
    processId: string;
    versionId: string;
    node: GraphNode;
  },
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
) {
  const data = input.node.data;
  await insertNodeSystems(input, tx);
  for (const item of data.inputs ?? []) {
    await insertNodeIo({ ...input, kind: "input", item }, tx);
  }
  for (const item of data.outputs ?? []) {
    await insertNodeIo({ ...input, kind: "output", item }, tx);
  }
  for (const item of data.exceptions ?? []) {
    const evidenceIds = item.evidence_ids ?? data.evidence_ids ?? [];
    await tx.execute(sql`
      INSERT INTO exceptions (
        org_id,
        workspace_id,
        process_id,
        version_id,
        node_id,
        sub_type,
        label,
        trigger,
        detection,
        evidence_count,
        top_evidence_ids
      )
      VALUES (
        ${input.orgId},
        ${input.workspaceId},
        ${input.processId},
        ${input.versionId},
        ${input.node.id},
        ${item.sub_type ?? "operator_reported"},
        ${item.label},
        ${item.trigger ?? null},
        ${item.detection ?? null},
        ${evidenceIds.length},
        ${uuidArraySql(evidenceIds)}
      )
    `);
  }
  for (const item of data.workarounds ?? []) {
    const evidenceIds = item.evidence_ids ?? data.evidence_ids ?? [];
    await tx.execute(sql`
      INSERT INTO workarounds (
        org_id,
        workspace_id,
        process_id,
        version_id,
        node_id,
        description,
        why_it_exists,
        evidence_count,
        top_evidence_ids
      )
      VALUES (
        ${input.orgId},
        ${input.workspaceId},
        ${input.processId},
        ${input.versionId},
        ${input.node.id},
        ${item.description},
        ${item.why_it_exists ?? null},
        ${evidenceIds.length},
        ${uuidArraySql(evidenceIds)}
      )
    `);
  }
  for (const item of data.variants ?? []) {
    const evidenceIds = item.evidence_ids ?? data.evidence_ids ?? [];
    await tx.execute(sql`
      INSERT INTO variants (
        org_id,
        workspace_id,
        process_id,
        version_id,
        node_id,
        condition,
        alt_node_id,
        evidence_count,
        top_evidence_ids
      )
      VALUES (
        ${input.orgId},
        ${input.workspaceId},
        ${input.processId},
        ${input.versionId},
        ${input.node.id},
        ${item.condition},
        ${item.alt_node_id ?? null},
        ${evidenceIds.length},
        ${uuidArraySql(evidenceIds)}
      )
    `);
  }
}

async function insertNodeSystems(
  input: {
    orgId: string;
    workspaceId: string;
    node: GraphNode;
  },
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
) {
  const systemNames = uniqueStrings(input.node.data.systems ?? []);
  if (systemNames.length === 0) return;
  const evidenceIds = input.node.data.evidence_ids ?? [];
  for (const systemName of systemNames) {
    await tx.execute(sql`
      WITH existing_system AS (
        SELECT id
        FROM systems
        WHERE org_id = ${input.orgId}
          AND lower(name) = lower(${systemName})
        ORDER BY created_at ASC
        LIMIT 1
      ),
      inserted_system AS (
        INSERT INTO systems (
          org_id,
          name,
          type,
          canonical_key
        )
        SELECT
          ${input.orgId},
          ${systemName},
          'operator_observed',
          lower(regexp_replace(${systemName}, '[^a-zA-Z0-9]+', '_', 'g'))
        WHERE NOT EXISTS (SELECT 1 FROM existing_system)
        RETURNING id
      ),
      selected_system AS (
        SELECT id FROM existing_system
        UNION ALL
        SELECT id FROM inserted_system
        LIMIT 1
      )
      INSERT INTO node_systems (
        org_id,
        workspace_id,
        node_id,
        system_id,
        usage,
        evidence_ids
      )
      SELECT
        ${input.orgId},
        ${input.workspaceId},
        ${input.node.id},
        selected_system.id,
        'unknown',
        ${uuidArraySql(evidenceIds)}
      FROM selected_system
      ON CONFLICT DO NOTHING
    `);
  }
}

async function insertNodeIo(
  input: {
    orgId: string;
    workspaceId: string;
    node: GraphNode;
    kind: "input" | "output";
    item: { name: string; description?: string; evidence_ids?: string[] };
  },
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
) {
  await tx.execute(sql`
    INSERT INTO node_io (
      org_id,
      workspace_id,
      node_id,
      kind,
      name,
      description,
      evidence_ids
    )
    VALUES (
      ${input.orgId},
      ${input.workspaceId},
      ${input.node.id},
      ${input.kind},
      ${input.item.name},
      ${input.item.description ?? null},
      ${uuidArraySql(input.item.evidence_ids ?? input.node.data.evidence_ids ?? [])}
    )
  `);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function insertEdge(
  input: {
    orgId: string;
    workspaceId: string;
    processId: string;
    versionId: string;
    edge: GraphEdge;
  },
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
) {
  const evidenceIds = input.edge.evidence_ids ?? [];
  await tx.execute(sql`
    INSERT INTO process_edges (
      id,
      org_id,
      workspace_id,
      process_id,
      version_id,
      source_node_id,
      target_node_id,
      edge_type,
      label,
      condition,
      is_exception_path,
      evidence_count,
      top_evidence_ids,
      metadata_json
    )
    VALUES (
      ${input.edge.id},
      ${input.orgId},
      ${input.workspaceId},
      ${input.processId},
      ${input.versionId},
      ${input.edge.source},
      ${input.edge.target},
      ${input.edge.edge_type},
      ${input.edge.label ?? null},
      ${input.edge.condition ?? null},
      ${input.edge.is_exception_path ?? false},
      ${evidenceIds.length},
      ${uuidArraySql(evidenceIds)},
      ${JSON.stringify({
        waypoints: input.edge.waypoints ?? [],
        sourceSide: input.edge.sourceSide,
        targetSide: input.edge.targetSide,
      })}::jsonb
    )
  `);
}
