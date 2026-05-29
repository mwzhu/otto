import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  NodeType,
  ProcessGraph,
} from "@/lib/types/graph";

type VersionRow = {
  process_id: string;
  version_id: string;
  version_number: number;
  status: "draft" | "approved" | "rejected";
  summary: string | null;
  graph_json: unknown;
};

export type ProcessGraphVersionSummary = {
  version_id: string;
  version_number: number;
  status: "draft" | "approved" | "rejected";
  summary: string | null;
  is_current_draft: boolean;
  is_current_approved: boolean;
  created_at: string;
};

type NodeRow = {
  id: string;
  parent_node_id: string | null;
  ordinal: number;
  node_type: NodeType;
  title: string;
  description: string | null;
  role: string | null;
  sla_seconds: number | null;
  est_minutes_per_run: string | null;
  confidence: string | null;
  evidence_ids: string[];
  position_json: unknown;
  system_names: string[];
  exception_count: number;
  workaround_count: number;
  claim_ids: string[];
  input_rows: Array<{ name?: string; description?: string; evidence_ids?: string[] }>;
  output_rows: Array<{ name?: string; description?: string; evidence_ids?: string[] }>;
  exception_rows: Array<{
    label?: string;
    sub_type?: string;
    trigger?: string;
    detection?: string;
    evidence_ids?: string[];
  }>;
  workaround_rows: Array<{
    description?: string;
    why_it_exists?: string;
    evidence_ids?: string[];
  }>;
  variant_rows: Array<{
    condition?: string;
    alt_node_id?: string;
    evidence_ids?: string[];
  }>;
  metadata_json: unknown;
};

type EdgeRow = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: EdgeType;
  label: string | null;
  condition: string | null;
  is_exception_path: boolean;
  evidence_ids: string[];
};

export async function getCurrentProcessGraph(
  orgId: string,
  workspaceId: string,
  processId: string,
): Promise<ProcessGraph | null> {
  const version = await loadCurrentVersion(orgId, workspaceId, processId);
  if (!version) return null;
  return graphFromVersion(orgId, workspaceId, version);
}

export async function getProcessGraphVersion(
  orgId: string,
  workspaceId: string,
  processId: string,
  versionId: string,
): Promise<ProcessGraph | null> {
  const version = await loadVersion(orgId, workspaceId, processId, versionId);
  if (!version) return null;
  return graphFromVersion(orgId, workspaceId, version);
}

export async function getProcessGraphVersions(
  orgId: string,
  workspaceId: string,
  processId: string,
): Promise<ProcessGraphVersionSummary[]> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<{
      version_id: string;
      version_number: number;
      status: "draft" | "approved" | "rejected";
      summary: string | null;
      is_current_draft: boolean;
      is_current_approved: boolean;
      created_at: string;
    }>(sql`
      SELECT
        pv.id AS version_id,
        pv.version_number,
        pv.status::text,
        pv.summary,
        p.current_draft_version_id = pv.id AS is_current_draft,
        p.current_approved_version_id = pv.id AS is_current_approved,
        pv.created_at::text
      FROM process_versions pv
      JOIN processes p ON p.id = pv.process_id
      WHERE pv.org_id = ${orgId}
        AND pv.workspace_id = ${workspaceId}
        AND pv.process_id = ${processId}
        AND pv.graph_json IS NOT NULL
        AND p.org_id = ${orgId}
        AND p.workspace_id = ${workspaceId}
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
      ORDER BY pv.version_number DESC, pv.created_at DESC
    `);
  });
  return result.rows;
}

async function graphFromVersion(
  orgId: string,
  workspaceId: string,
  version: VersionRow,
): Promise<ProcessGraph> {
  const cached = parseGraphJson(version.graph_json);
  if (cached) {
    return {
      ...cached,
      process_id: version.process_id,
      version_id: version.version_id,
      version_number: version.version_number,
      status: version.status === "approved" ? "approved" : "draft",
      summary: cached.summary ?? version.summary,
    };
  }

  const [nodes, edges] = await Promise.all([
    loadGraphNodes(orgId, workspaceId, version.version_id),
    loadGraphEdges(orgId, workspaceId, version.version_id),
  ]);

  return {
    version_id: version.version_id,
    process_id: version.process_id,
    version_number: version.version_number,
    status: version.status === "approved" ? "approved" : "draft",
    summary: version.summary,
    warnings: [],
    nodes,
    edges,
  };
}

async function loadVersion(
  orgId: string,
  workspaceId: string,
  processId: string,
  versionId: string,
) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<VersionRow>(sql`
      SELECT
        pv.process_id,
        pv.id AS version_id,
        pv.version_number,
        pv.status::text,
        pv.summary,
        pv.graph_json
      FROM process_versions pv
      JOIN processes p ON p.id = pv.process_id
      WHERE pv.org_id = ${orgId}
        AND pv.workspace_id = ${workspaceId}
        AND pv.process_id = ${processId}
        AND pv.id = ${versionId}
        AND p.org_id = ${orgId}
        AND p.workspace_id = ${workspaceId}
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
      LIMIT 1
    `);
  });
  return result.rows[0] ?? null;
}

async function loadCurrentVersion(
  orgId: string,
  workspaceId: string,
  processId: string,
) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<VersionRow>(sql`
      SELECT
        p.id AS process_id,
        pv.id AS version_id,
        pv.version_number,
        pv.status::text,
        pv.summary,
        pv.graph_json
      FROM processes p
      JOIN process_versions pv
        ON pv.id = COALESCE(p.current_draft_version_id, p.current_approved_version_id)
      WHERE p.org_id = ${orgId}
        AND p.workspace_id = ${workspaceId}
        AND p.id = ${processId}
      LIMIT 1
    `);
  });
  return result.rows[0] ?? null;
}

async function loadGraphNodes(
  orgId: string,
  workspaceId: string,
  versionId: string,
): Promise<GraphNode[]> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<NodeRow>(sql`
      SELECT
        n.id,
        n.parent_node_id,
        n.ordinal,
        n.node_type::text,
        n.title,
        n.description,
        COALESCE(owner.name, lane.name) AS role,
        n.sla_seconds,
        n.est_minutes_per_run::text,
        n.confidence::text,
        n.top_evidence_ids AS evidence_ids,
        n.position_json,
        COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS system_names,
        COUNT(DISTINCT ex.id)::int AS exception_count,
        COUNT(DISTINCT w.id)::int AS workaround_count,
        COALESCE(array_agg(DISTINCT c.id) FILTER (WHERE c.id IS NOT NULL), '{}') AS claim_ids,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('name', nio.name, 'description', nio.description, 'evidence_ids', nio.evidence_ids))
            FILTER (WHERE nio.id IS NOT NULL AND nio.kind = 'input'),
          '[]'::jsonb
        ) AS input_rows,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('name', nio.name, 'description', nio.description, 'evidence_ids', nio.evidence_ids))
            FILTER (WHERE nio.id IS NOT NULL AND nio.kind = 'output'),
          '[]'::jsonb
        ) AS output_rows,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('label', ex.label, 'sub_type', ex.sub_type, 'trigger', ex.trigger, 'detection', ex.detection, 'evidence_ids', ex.top_evidence_ids))
            FILTER (WHERE ex.id IS NOT NULL),
          '[]'::jsonb
        ) AS exception_rows,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('description', w.description, 'why_it_exists', w.why_it_exists, 'evidence_ids', w.top_evidence_ids))
            FILTER (WHERE w.id IS NOT NULL),
          '[]'::jsonb
        ) AS workaround_rows,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('condition', v.condition, 'alt_node_id', v.alt_node_id, 'evidence_ids', v.top_evidence_ids))
            FILTER (WHERE v.id IS NOT NULL),
          '[]'::jsonb
        ) AS variant_rows,
        n.metadata_json
      FROM process_nodes n
      LEFT JOIN roles owner ON owner.id = n.owner_role_id
      LEFT JOIN roles lane ON lane.id = n.lane_role_id
      LEFT JOIN node_systems ns ON ns.node_id = n.id
      LEFT JOIN systems s ON s.id = ns.system_id
      LEFT JOIN node_io nio ON nio.node_id = n.id
      LEFT JOIN exceptions ex ON ex.node_id = n.id
      LEFT JOIN workarounds w ON w.node_id = n.id
      LEFT JOIN variants v ON v.node_id = n.id
      LEFT JOIN claims c
        ON c.subject_type = 'process_node'
       AND c.subject_id = n.id
       AND c.status = 'active'
       AND c.superseded_by_claim_id IS NULL
      WHERE n.org_id = ${orgId}
        AND n.workspace_id = ${workspaceId}
        AND n.version_id = ${versionId}
      GROUP BY n.id, owner.id, lane.id
      ORDER BY n.ordinal ASC, n.created_at ASC
    `);
  });

  return result.rows.map((row, index) => ({
    id: row.id,
    type: row.node_type,
    position: positionFromJson(row.position_json, index),
    parent_node_id: row.parent_node_id ?? undefined,
    data: {
      title: row.title,
      description: row.description ?? undefined,
      role: row.role ?? undefined,
      systems: row.system_names ?? [],
      sla_seconds: row.sla_seconds ?? undefined,
      est_minutes:
        row.est_minutes_per_run !== null
          ? Number(row.est_minutes_per_run)
          : undefined,
      confidence: row.confidence !== null ? Number(row.confidence) : undefined,
      evidence_ids: row.evidence_ids ?? [],
      exception_count: row.exception_count,
      has_workaround: row.workaround_count > 0,
      claim_ids: row.claim_ids ?? [],
      inputs: validIoRows(row.input_rows),
      outputs: validIoRows(row.output_rows),
      exceptions: validExceptionRows(row.exception_rows),
      workarounds: validWorkaroundRows(row.workaround_rows),
      variants: validVariantRows(row.variant_rows),
      source_provisional_step_ids: sourceProvisionalStepIds(row.metadata_json),
    },
  }));
}

async function loadGraphEdges(
  orgId: string,
  workspaceId: string,
  versionId: string,
): Promise<GraphEdge[]> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<EdgeRow>(sql`
      SELECT
        id,
        source_node_id,
        target_node_id,
        edge_type::text,
        label,
        condition,
        is_exception_path,
        top_evidence_ids AS evidence_ids
      FROM process_edges
      WHERE org_id = ${orgId}
        AND workspace_id = ${workspaceId}
        AND version_id = ${versionId}
      ORDER BY created_at ASC
    `);
  });

  return result.rows.map((row) => ({
    id: row.id,
    source: row.source_node_id,
    target: row.target_node_id,
    edge_type: row.edge_type,
    label: row.label ?? undefined,
    condition: row.condition ?? undefined,
    is_exception_path: row.is_exception_path,
    evidence_ids: row.evidence_ids ?? [],
  }));
}

function parseGraphJson(value: unknown): ProcessGraph | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const graph = value as Partial<ProcessGraph>;
  if (
    typeof graph.process_id !== "string" ||
    typeof graph.version_number !== "number" ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    return null;
  }
  return {
    version_id:
      typeof graph.version_id === "string" ? graph.version_id : undefined,
    process_id: graph.process_id,
    version_number: graph.version_number,
    status: graph.status === "approved" ? "approved" : "draft",
    summary: typeof graph.summary === "string" ? graph.summary : null,
    warnings: validWarnings(graph.warnings),
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

function validWarnings(value: unknown): NonNullable<ProcessGraph["warnings"]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => item as { code?: unknown; message?: unknown; evidence_ids?: unknown })
    .filter((item) => typeof item.code === "string" && typeof item.message === "string")
    .map((item) => ({
      code: item.code as string,
      message: item.message as string,
      evidence_ids: Array.isArray(item.evidence_ids)
        ? item.evidence_ids.filter((id): id is string => typeof id === "string")
        : [],
    }));
}

function positionFromJson(value: unknown, index: number) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const position = value as { x?: unknown; y?: unknown };
    if (typeof position.x === "number" && typeof position.y === "number") {
      return { x: position.x, y: position.y };
    }
  }
  return { x: 80 + (index % 4) * 280, y: 80 + Math.floor(index / 4) * 180 };
}

function validIoRows(
  rows: Array<{ name?: string; description?: string; evidence_ids?: string[] }>,
) {
  return rows
    .filter((row) => typeof row.name === "string" && row.name.trim())
    .map((row) => ({
      name: row.name as string,
      description: row.description ?? undefined,
      evidence_ids: row.evidence_ids ?? [],
    }));
}

function validExceptionRows(
  rows: Array<{
    label?: string;
    sub_type?: string;
    trigger?: string;
    detection?: string;
    evidence_ids?: string[];
  }>,
) {
  return rows
    .filter((row) => typeof row.label === "string" && row.label.trim())
    .map((row) => ({
      label: row.label as string,
      sub_type: row.sub_type,
      trigger: row.trigger,
      detection: row.detection,
      evidence_ids: row.evidence_ids ?? [],
    }));
}

function validWorkaroundRows(
  rows: Array<{
    description?: string;
    why_it_exists?: string;
    evidence_ids?: string[];
  }>,
) {
  return rows
    .filter((row) => typeof row.description === "string" && row.description.trim())
    .map((row) => ({
      description: row.description as string,
      why_it_exists: row.why_it_exists,
      evidence_ids: row.evidence_ids ?? [],
    }));
}

function validVariantRows(
  rows: Array<{
    condition?: string;
    alt_node_id?: string;
    evidence_ids?: string[];
  }>,
) {
  return rows
    .filter((row) => typeof row.condition === "string" && row.condition.trim())
    .map((row) => ({
      condition: row.condition as string,
      alt_node_id: row.alt_node_id,
      evidence_ids: row.evidence_ids ?? [],
    }));
}

function sourceProvisionalStepIds(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = (value as { source_provisional_step_ids?: unknown })
    .source_provisional_step_ids;
  return Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string")
    : [];
}
