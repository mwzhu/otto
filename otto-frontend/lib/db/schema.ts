import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orgRoleEnum = pgEnum("org_role", ["org_admin", "fde"]);
export const workspaceRoleEnum = pgEnum("workspace_role", [
  "director",
  "operator",
  "viewer",
]);
export const workspaceStatusEnum = pgEnum("workspace_status", [
  "active",
  "archived",
]);
export const processStatusEnum = pgEnum("process_status", [
  "candidate",
  "draft",
  "approved",
  "archived",
]);
export const processVersionStatusEnum = pgEnum("process_version_status", [
  "draft",
  "approved",
  "rejected",
]);
export const claimStatusEnum = pgEnum("claim_status", [
  "active",
  "superseded",
  "redacted",
  "tombstoned",
]);
export const evidenceLabelEnum = pgEnum("evidence_label", [
  "observed",
  "preview",
  "stated_operator",
  "stated_director",
  "documented",
  "inferred",
  "confirmed",
  "corrected",
]);
export const evidenceSourceTypeEnum = pgEnum("evidence_source_type", [
  "transcript_segment",
  "screen_event",
  "document_chunk",
  "user_correction",
  "agent_inference",
]);
export const captureTypeEnum = pgEnum("capture_type", [
  "director_interview",
  "operator_interview",
  "screen_recording_upload",
  "document_upload",
  "mixed",
]);
export const artifactStatusEnum = pgEnum("artifact_status", [
  "pending_upload",
  "uploaded",
  "processing",
  "ready",
  "failed",
  "redacted",
]);
export const artifactTypeEnum = pgEnum("artifact_type", [
  "document",
  "audio",
  "video",
  "screen_frame",
  "image",
  "other",
]);
export const ontologyTermTypeEnum = pgEnum("ontology_term_type", [
  "role",
  "system",
  "process",
  "metric",
  "custom",
]);
export const slotStateStatusEnum = pgEnum("slot_state_status", [
  "empty",
  "partial",
  "filled",
  "asked_unknown",
  "conflicting",
  "pending_re_extract",
]);
export const candidateProcessStatusEnum = pgEnum("candidate_process_status", [
  "pending",
  "promoted",
  "discarded",
  "merged",
]);
export const captureLinkTypeEnum = pgEnum("capture_link_type", [
  "created",
  "enriched",
  "corrected",
  "candidate",
]);
export const followUpTaskTypeEnum = pgEnum("follow_up_task_type", [
  "open_question",
  "conflicting_slot",
  "low_confidence_claim",
  "failed_stage",
  "weak_merge",
  "redaction_failure",
]);
export const followUpTaskStatusEnum = pgEnum("follow_up_task_status", [
  "open",
  "in_progress",
  "resolved",
  "dismissed",
]);
export const synthesisRunStatusEnum = pgEnum("synthesis_run_status", [
  "queued",
  "running",
  "partial_synthesis",
  "completed",
  "failed",
]);
export const synthesisRunTypeEnum = pgEnum("synthesis_run_type", [
  "document_inventory",
  "director_inventory",
  "combined_inventory",
  "process_graph",
  "director_automation_plan",
]);
export const synthesisStageStatusEnum = pgEnum("synthesis_stage_status", [
  "queued",
  "running",
  "completed",
  "skipped",
  "failed",
]);
export const captureModeEnum = pgEnum("capture_mode", [
  "director_voice",
  "operator_voice",
  "operator_screenshare",
  "screen_recording_upload",
  "process_document_upload",
  "mixed",
]);
export const processNodeTypeEnum = pgEnum("process_node_type", [
  "start",
  "task",
  "decision",
  "wait",
  "handoff",
  "exception",
  "end",
]);
export const processEdgeTypeEnum = pgEnum("process_edge_type", [
  "seq",
  "conditional",
  "handoff",
  "parallel",
]);
export const processNodeLevelEnum = pgEnum("process_node_level", ["L3", "L4"]);

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType(config) {
    const dimensions =
      typeof config === "object" && config && "dimensions" in config
        ? Number((config as { dimensions?: number }).dimensions)
        : 1536;
    return `vector(${Number.isFinite(dimensions) ? dimensions : 1536})`;
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workosOrganizationId: text("workos_organization_id").notNull(),
    name: text("name").notNull(),
    ...timestamps,
  },
  (table) => ({
    workosOrganizationIdIdx: uniqueIndex("organizations_workos_org_id_idx").on(
      table.workosOrganizationId,
    ),
  }),
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workosUserId: text("workos_user_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    orgRole: orgRoleEnum("org_role"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("users_org_id_idx").on(table.orgId),
    workosUserIdx: uniqueIndex("users_workos_user_id_idx").on(table.workosUserId),
    emailOrgIdx: uniqueIndex("users_org_email_idx").on(table.orgId, table.email),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    name: text("name").notNull(),
    functionName: text("function_name").notNull(),
    dataTier: text("data_tier").default("trial").notNull(),
    status: workspaceStatusEnum("status").default("active").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("workspaces_org_id_idx").on(table.orgId),
  }),
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    workspaceRole: workspaceRoleEnum("workspace_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
    orgIdx: index("workspace_memberships_org_id_idx").on(table.orgId),
    userIdx: index("workspace_memberships_user_id_idx").on(table.userId),
  }),
);

export const processes = pgTable(
  "processes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: processStatusEnum("status").default("draft").notNull(),
    ownerRoleId: uuid("owner_role_id"),
    currentDraftVersionId: uuid("current_draft_version_id"),
    currentApprovedVersionId: uuid("current_approved_version_id"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("processes_org_id_idx").on(table.orgId),
    workspaceIdx: index("processes_workspace_id_idx").on(table.workspaceId),
  }),
);

export const processVersions = pgTable(
  "process_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionNumber: integer("version_number").notNull(),
    status: processVersionStatusEnum("status").default("draft").notNull(),
    summary: text("summary"),
    graphJson: jsonb("graph_json").default(sql`'{}'::jsonb`).notNull(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("process_versions_org_id_idx").on(table.orgId),
    processIdx: index("process_versions_process_id_idx").on(table.processId),
    versionIdx: uniqueIndex("process_versions_process_version_idx").on(
      table.processId,
      table.versionNumber,
    ),
  }),
);

export const processNodes = pgTable(
  "process_nodes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    parentNodeId: uuid("parent_node_id").references(
      (): AnyPgColumn => processNodes.id,
    ),
    ordinal: integer("ordinal").notNull(),
    level: processNodeLevelEnum("level").default("L4").notNull(),
    nodeType: processNodeTypeEnum("node_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    laneRoleId: uuid("lane_role_id").references(() => roles.id),
    ownerRoleId: uuid("owner_role_id").references(() => roles.id),
    ownerPersonId: uuid("owner_person_id").references(() => people.id),
    slaSeconds: integer("sla_seconds"),
    frequency: text("frequency"),
    estMinutesPerRun: numeric("est_minutes_per_run", {
      precision: 10,
      scale: 2,
    }),
    automationCandidate: boolean("automation_candidate").default(false).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("0")
      .notNull(),
    positionJson: jsonb("position_json").default(sql`'{}'::jsonb`).notNull(),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    evidenceCount: integer("evidence_count").default(0).notNull(),
    topEvidenceIds: uuid("top_evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("process_nodes_org_id_idx").on(table.orgId),
    workspaceProcessIdx: index("process_nodes_workspace_process_idx").on(
      table.workspaceId,
      table.processId,
    ),
    versionOrdinalIdx: index("process_nodes_version_ordinal_idx").on(
      table.versionId,
      table.ordinal,
    ),
    parentIdx: index("process_nodes_parent_node_id_idx").on(table.parentNodeId),
  }),
);

export const processEdges = pgTable(
  "process_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    sourceNodeId: uuid("source_node_id").references(() => processNodes.id).notNull(),
    targetNodeId: uuid("target_node_id").references(() => processNodes.id).notNull(),
    edgeType: processEdgeTypeEnum("edge_type").notNull(),
    label: text("label"),
    condition: text("condition"),
    probability: numeric("probability", { precision: 5, scale: 4 }),
    isExceptionPath: boolean("is_exception_path").default(false).notNull(),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    evidenceCount: integer("evidence_count").default(0).notNull(),
    topEvidenceIds: uuid("top_evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    versionIdx: index("process_edges_version_id_idx").on(table.versionId),
    sourceIdx: index("process_edges_source_node_id_idx").on(table.sourceNodeId),
    targetIdx: index("process_edges_target_node_id_idx").on(table.targetNodeId),
    orgIdx: index("process_edges_org_id_idx").on(table.orgId),
    workspaceProcessIdx: index("process_edges_workspace_process_idx").on(
      table.workspaceId,
      table.processId,
    ),
  }),
);

export const nodeSystems = pgTable(
  "node_systems",
  {
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    nodeId: uuid("node_id").references(() => processNodes.id).notNull(),
    systemId: uuid("system_id").references(() => systems.id).notNull(),
    usage: text("usage").notNull(),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.nodeId, table.systemId, table.usage] }),
    orgIdx: index("node_systems_org_id_idx").on(table.orgId),
    workspaceIdx: index("node_systems_workspace_id_idx").on(table.workspaceId),
    systemIdx: index("node_systems_system_id_idx").on(table.systemId),
  }),
);

export const nodeIo = pgTable(
  "node_io",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    nodeId: uuid("node_id").references(() => processNodes.id).notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("node_io_org_id_idx").on(table.orgId),
    workspaceIdx: index("node_io_workspace_id_idx").on(table.workspaceId),
    nodeIdx: index("node_io_node_id_idx").on(table.nodeId),
  }),
);

export const exceptions = pgTable(
  "exceptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    nodeId: uuid("node_id").references(() => processNodes.id).notNull(),
    subType: text("sub_type").notNull(),
    label: text("label").notNull(),
    trigger: text("trigger"),
    detection: text("detection"),
    handlerRoleId: uuid("handler_role_id").references(() => roles.id),
    frequencyPct: numeric("frequency_pct", { precision: 5, scale: 2 }),
    timeToResolveSeconds: integer("time_to_resolve_seconds"),
    impactCents: integer("impact_cents"),
    evidenceCount: integer("evidence_count").default(0).notNull(),
    topEvidenceIds: uuid("top_evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("exceptions_org_id_idx").on(table.orgId),
    versionIdx: index("exceptions_version_id_idx").on(table.versionId),
    nodeIdx: index("exceptions_node_id_idx").on(table.nodeId),
  }),
);

export const workarounds = pgTable(
  "workarounds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    nodeId: uuid("node_id").references(() => processNodes.id).notNull(),
    description: text("description").notNull(),
    whyItExists: text("why_it_exists"),
    evidenceCount: integer("evidence_count").default(0).notNull(),
    topEvidenceIds: uuid("top_evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("workarounds_org_id_idx").on(table.orgId),
    versionIdx: index("workarounds_version_id_idx").on(table.versionId),
    nodeIdx: index("workarounds_node_id_idx").on(table.nodeId),
  }),
);

export const variants = pgTable(
  "variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    nodeId: uuid("node_id").references(() => processNodes.id).notNull(),
    condition: text("condition").notNull(),
    altNodeId: uuid("alt_node_id").references(() => processNodes.id),
    evidenceCount: integer("evidence_count").default(0).notNull(),
    topEvidenceIds: uuid("top_evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("variants_org_id_idx").on(table.orgId),
    versionIdx: index("variants_version_id_idx").on(table.versionId),
    nodeIdx: index("variants_node_id_idx").on(table.nodeId),
  }),
);

export const captureSessions = pgTable(
  "capture_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id),
    participantPersonId: uuid("participant_person_id"),
    captureType: captureTypeEnum("capture_type").notNull(),
    captureMode: captureModeEnum("capture_mode"),
    frameEgressDir: text("frame_egress_dir"),
    recordingUrl: text("recording_url"),
    recordingArtifactId: uuid("recording_artifact_id"),
    recordingStatus: text("recording_status"),
    recordingStartedAt: timestamp("recording_started_at", { withTimezone: true }),
    recordingCompletedAt: timestamp("recording_completed_at", { withTimezone: true }),
    recordingProvider: text("recording_provider"),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("capture_sessions_org_id_idx").on(table.orgId),
    workspaceIdx: index("capture_sessions_workspace_id_idx").on(table.workspaceId),
  }),
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id").references(
      () => captureSessions.id,
    ),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
    artifactType: artifactTypeEnum("artifact_type").notNull(),
    status: artifactStatusEnum("status").default("pending_upload").notNull(),
    storageKey: text("storage_key").notNull(),
    storageUrl: text("storage_url"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes"),
    durationSeconds: integer("duration_seconds"),
    ttlAt: timestamp("ttl_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("artifacts_org_id_idx").on(table.orgId),
    workspaceIdx: index("artifacts_workspace_id_idx").on(table.workspaceId),
  }),
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    speaker: text("speaker").notNull(),
    speakerRole: text("speaker_role"),
    turnIndex: integer("turn_index"),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    timingSource: text("timing_source"),
    embedding: vector("embedding", { dimensions: 1536 }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("transcript_segments_org_id_idx").on(table.orgId),
    captureIdx: index("transcript_segments_capture_session_id_idx").on(
      table.captureSessionId,
    ),
  }),
);

export const directorExtractionWindows = pgTable(
  "director_extraction_windows",
  {
    extractionWindowId: text("extraction_window_id").primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    turnIndex: integer("turn_index"),
    transcriptSegmentIds: uuid("transcript_segment_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    status: text("status").default("pending").notNull(),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("director_extraction_windows_org_id_idx").on(table.orgId),
    captureIdx: index("director_extraction_windows_capture_session_id_idx").on(
      table.captureSessionId,
    ),
    captureTurnIdx: index("director_extraction_windows_capture_turn_idx").on(
      table.captureSessionId,
      table.turnIndex,
    ),
  }),
);

export const operatorExtractionWindows = pgTable(
  "operator_extraction_windows",
  {
    extractionWindowId: text("extraction_window_id").primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    turnIndex: integer("turn_index"),
    transcriptSegmentIds: uuid("transcript_segment_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    status: text("status").default("pending").notNull(),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("operator_extraction_windows_org_id_idx").on(table.orgId),
    captureIdx: index("operator_extraction_windows_capture_session_id_idx").on(
      table.captureSessionId,
    ),
    captureTurnIdx: index("operator_extraction_windows_capture_turn_idx").on(
      table.captureSessionId,
      table.turnIndex,
    ),
  }),
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    artifactId: uuid("artifact_id").references(() => artifacts.id).notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("document_chunks_org_id_idx").on(table.orgId),
    artifactIdx: index("document_chunks_artifact_id_idx").on(table.artifactId),
    artifactOrdinalIdx: uniqueIndex("document_chunks_artifact_ordinal_idx").on(
      table.artifactId,
      table.ordinal,
    ),
  }),
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    sourceType: evidenceSourceTypeEnum("source_type").notNull(),
    sourceId: uuid("source_id"),
    evidenceLabel: evidenceLabelEnum("evidence_label").notNull(),
    spanStart: integer("span_start"),
    spanEnd: integer("span_end"),
    quote: text("quote"),
    summary: text("summary"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("evidence_org_id_idx").on(table.orgId),
    workspaceIdx: index("evidence_workspace_id_idx").on(table.workspaceId),
  }),
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    field: text("field").notNull(),
    value: jsonb("value").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("1")
      .notNull(),
    status: claimStatusEnum("status").default("active").notNull(),
    supersededByClaimId: uuid("superseded_by_claim_id"),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("claims_org_id_idx").on(table.orgId),
    workspaceIdx: index("claims_workspace_id_idx").on(table.workspaceId),
    subjectFieldIdx: index("claims_subject_field_idx").on(
      table.subjectType,
      table.subjectId,
      table.field,
    ),
    activeSubjectFieldIdx: uniqueIndex("claims_active_subject_field_idx")
      .on(table.subjectType, table.subjectId, table.field)
      .where(sql`status = 'active'
        AND superseded_by_claim_id IS NULL
        AND field NOT IN (
          'pain_point',
          'risk',
          'kpi',
          'business_outcome',
          'upstream_dependency',
          'downstream_dependency',
          'used_in_process',
          'participates_in_process',
          'handoff_target',
          'works_on'
        )`),
  }),
);

export const claimEvidence = pgTable(
  "claim_evidence",
  {
    claimId: uuid("claim_id").references(() => claims.id).notNull(),
    evidenceId: uuid("evidence_id").references(() => evidence.id).notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.claimId, table.evidenceId] }),
    evidenceIdx: index("claim_evidence_evidence_id_idx").on(table.evidenceId),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    userId: uuid("user_id").references(() => users.id),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgIdx: index("audit_log_org_id_idx").on(table.orgId),
    workspaceIdx: index("audit_log_workspace_id_idx").on(table.workspaceId),
  }),
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    key: text("key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: jsonb("response_json"),
    statusCode: integer("status_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    orgKeyRouteIdx: uniqueIndex("idempotency_keys_org_key_route_idx").on(
      table.orgId,
      table.key,
      table.route,
    ),
  }),
);

export const systems = pgTable(
  "systems",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    name: text("name").notNull(),
    type: text("type"),
    description: text("description"),
    integrationStatus: text("integration_status"),
    canonicalKey: text("canonical_key"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("systems_org_id_idx").on(table.orgId),
  }),
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    name: text("name").notNull(),
    title: text("title"),
    department: text("department"),
    managerId: uuid("manager_id"),
    source: text("source"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("people_org_id_idx").on(table.orgId),
  }),
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    canonicalKey: text("canonical_key"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("roles_org_id_idx").on(table.orgId),
  }),
);

export const ontologyTerms = pgTable(
  "ontology_terms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    term: text("term").notNull(),
    type: ontologyTermTypeEnum("type").notNull(),
    definition: text("definition"),
    aliases: text("aliases").array().default(sql`ARRAY[]::text[]`).notNull(),
    sourceEvidenceIds: uuid("source_evidence_ids").array(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("ontology_terms_org_id_idx").on(table.orgId),
  }),
);

export const screenEvents = pgTable(
  "screen_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    tsMs: integer("ts_ms").notNull(),
    eventType: text("event_type").notNull(),
    appName: text("app_name"),
    windowTitle: text("window_title"),
    url: text("url"),
    ocrText: text("ocr_text"),
    uiStateLabel: text("ui_state_label"),
    screenshotArtifactId: uuid("screenshot_artifact_id").references(
      () => artifacts.id,
    ),
    signalTags: text("signal_tags")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    captureTsIdx: index("screen_events_capture_ts_idx").on(
      table.captureSessionId,
      table.tsMs,
    ),
    orgIdx: index("screen_events_org_id_idx").on(table.orgId),
    workspaceIdx: index("screen_events_workspace_id_idx").on(table.workspaceId),
    screenshotIdx: index("screen_events_screenshot_artifact_id_idx").on(
      table.screenshotArtifactId,
    ),
  }),
);

export const visualObservations = pgTable(
  "visual_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    screenEventId: uuid("screen_event_id").references(() => screenEvents.id),
    artifactId: uuid("artifact_id").references(() => artifacts.id),
    tsMs: integer("ts_ms").notNull(),
    provider: text("provider").notNull(),
    ocrText: text("ocr_text"),
    uiSummary: text("ui_summary"),
    structuredJson: jsonb("structured_json").default(sql`'{}'::jsonb`).notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("0")
      .notNull(),
    degradedReasons: text("degraded_reasons")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    model: text("model").notNull(),
    promptTemplateId: text("prompt_template_id"),
    promptTemplateVersion: text("prompt_template_version"),
    idempotencyKey: text("idempotency_key").notNull(),
    emitsEvidence: boolean("emits_evidence").default(true).notNull(),
    evidenceId: uuid("evidence_id").references(() => evidence.id),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    captureTsIdx: index("visual_observations_capture_ts_idx").on(
      table.captureSessionId,
      table.tsMs,
    ),
    screenEventIdx: index("visual_observations_screen_event_id_idx").on(
      table.screenEventId,
    ),
    artifactIdx: index("visual_observations_artifact_id_idx").on(table.artifactId),
    retryGuardIdx: uniqueIndex("visual_observations_retry_guard_idx").on(
      table.orgId,
      table.screenEventId,
      table.provider,
      table.idempotencyKey,
    ),
    evidenceUniqueIdx: uniqueIndex("visual_observations_evidence_id_idx")
      .on(table.evidenceId)
      .where(sql`evidence_id IS NOT NULL`),
  }),
);

export const provisionalSteps = pgTable(
  "provisional_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    processId: uuid("process_id").references(() => processes.id),
    tsStartMs: integer("ts_start_ms").notNull(),
    tsEndMs: integer("ts_end_ms"),
    ordinalHint: integer("ordinal_hint"),
    actionVerb: text("action_verb"),
    actionObject: text("action_object"),
    systemIdSet: uuid("system_id_set")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    candidateRoleId: uuid("candidate_role_id").references(() => roles.id),
    source: text("source").notNull(),
    sourceEventId: text("source_event_id"),
    idempotencyKey: text("idempotency_key"),
    supersededByNodeId: uuid("superseded_by_node_id").references(
      () => processNodes.id,
    ),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("0")
      .notNull(),
    metadataJson: jsonb("metadata_json").default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => ({
    captureTsIdx: index("provisional_steps_capture_ts_idx").on(
      table.captureSessionId,
      table.tsStartMs,
    ),
    processIdx: index("provisional_steps_process_id_idx").on(table.processId),
    orgIdx: index("provisional_steps_org_id_idx").on(table.orgId),
    workspaceIdx: index("provisional_steps_workspace_id_idx").on(
      table.workspaceId,
    ),
    idempotencyIdx: uniqueIndex("provisional_steps_capture_idempotency_idx")
      .on(table.captureSessionId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  }),
);

export const slotStates = pgTable(
  "slot_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    candidateProcessId: uuid("candidate_process_id").references(
      () => candidateProcesses.id,
    ),
    provisionalStepId: uuid("provisional_step_id").references(
      () => provisionalSteps.id,
    ),
    slotPath: text("slot_path").notNull(),
    value: jsonb("value"),
    status: slotStateStatusEnum("status").default("empty").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 })
      .default("0")
      .notNull(),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    lastAskedAt: timestamp("last_asked_at", { withTimezone: true }),
    priority: integer("priority").default(0).notNull(),
    candidates: jsonb("candidates"),
    ...timestamps,
  },
  (table) => ({
    captureGlobalSlotIdx: uniqueIndex("slot_states_capture_global_slot_idx")
      .on(
        table.captureSessionId,
        table.slotPath,
      )
      .where(sql`candidate_process_id IS NULL AND provisional_step_id IS NULL`),
    captureCandidateSlotIdx: uniqueIndex("slot_states_capture_candidate_slot_idx")
      .on(
        table.captureSessionId,
        table.candidateProcessId,
        table.slotPath,
      )
      .where(sql`candidate_process_id IS NOT NULL`),
    captureProvisionalStepSlotIdx: uniqueIndex(
      "slot_states_capture_provisional_step_slot_idx",
    )
      .on(table.captureSessionId, table.provisionalStepId, table.slotPath)
      .where(sql`provisional_step_id IS NOT NULL`),
    candidateProcessIdx: index("slot_states_candidate_process_id_idx")
      .on(table.candidateProcessId)
      .where(sql`candidate_process_id IS NOT NULL`),
    provisionalStepIdx: index("slot_states_provisional_step_id_idx")
      .on(table.provisionalStepId)
      .where(sql`provisional_step_id IS NOT NULL`),
    captureSlotIdx: index("slot_states_capture_slot_idx").on(
      table.captureSessionId,
      table.slotPath,
    ),
    orgIdx: index("slot_states_org_id_idx").on(table.orgId),
    workspaceIdx: index("slot_states_workspace_id_idx").on(table.workspaceId),
    captureIdx: index("slot_states_capture_session_id_idx").on(
      table.captureSessionId,
    ),
    statusPriorityIdx: index("slot_states_capture_status_priority_idx").on(
      table.captureSessionId,
      table.status,
      table.priority,
    ),
  }),
);

export const candidateProcesses = pgTable(
  "candidate_processes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    proposedName: text("proposed_name").notNull(),
    proposedFunction: text("proposed_function"),
    proposedOwnerRoleId: uuid("proposed_owner_role_id").references(
      () => roles.id,
    ),
    frequency: text("frequency"),
    complexityHint: text("complexity_hint"),
    status: candidateProcessStatusEnum("status").default("pending").notNull(),
    promotedProcessId: uuid("promoted_process_id").references(() => processes.id),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("candidate_processes_org_id_idx").on(table.orgId),
    workspaceStatusIdx: index("candidate_processes_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    captureIdx: index("candidate_processes_capture_session_id_idx").on(
      table.captureSessionId,
    ),
  }),
);

export const captureProcessLinks = pgTable(
  "capture_process_links",
  {
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    linkType: captureLinkTypeEnum("link_type").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.captureSessionId, table.processId, table.linkType],
    }),
    orgIdx: index("capture_process_links_org_id_idx").on(table.orgId),
    workspaceIdx: index("capture_process_links_workspace_id_idx").on(
      table.workspaceId,
    ),
    processIdx: index("capture_process_links_process_id_idx").on(table.processId),
  }),
);

export const followUpTasks = pgTable(
  "follow_up_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    processId: uuid("process_id").references(() => processes.id),
    captureSessionId: uuid("capture_session_id").references(
      () => captureSessions.id,
    ),
    taskType: followUpTaskTypeEnum("task_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    priority: numeric("priority", { precision: 6, scale: 3 })
      .default("1.0")
      .notNull(),
    status: followUpTaskStatusEnum("status").default("open").notNull(),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id),
    contextJson: jsonb("context_json").default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    orgIdx: index("follow_up_tasks_org_id_idx").on(table.orgId),
    workspaceStatusPriorityIdx: index(
      "follow_up_tasks_workspace_status_priority_idx",
    ).on(table.workspaceId, table.status, table.priority),
    captureIdx: index("follow_up_tasks_capture_session_id_idx").on(
      table.captureSessionId,
    ),
  }),
);

export const redactions = pgTable(
  "redactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    reason: text("reason"),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    affectedArtifactIds: uuid("affected_artifact_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    affectedTraceIds: uuid("affected_trace_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("redactions_org_id_idx").on(table.orgId),
    workspaceIdx: index("redactions_workspace_id_idx").on(table.workspaceId),
    captureIdx: index("redactions_capture_session_id_idx").on(
      table.captureSessionId,
    ),
    statusIdx: index("redactions_capture_status_idx").on(
      table.captureSessionId,
      table.status,
    ),
  }),
);

export const synthesisRuns = pgTable(
  "synthesis_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionIds: uuid("capture_session_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    runType: synthesisRunTypeEnum("run_type").notNull(),
    status: synthesisRunStatusEnum("status").default("queued").notNull(),
    stage: text("stage"),
    stageVersions: jsonb("stage_versions").default(sql`'{}'::jsonb`).notNull(),
    errorJson: jsonb("error_json"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("synthesis_runs_org_id_idx").on(table.orgId),
    workspaceStatusIdx: index("synthesis_runs_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export const synthesisStageOutputs = pgTable(
  "synthesis_stage_outputs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    synthesisRunId: uuid("synthesis_run_id")
      .references(() => synthesisRuns.id)
      .notNull(),
    stageName: text("stage_name").notNull(),
    inputRowRefs: jsonb("input_row_refs")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    outputRowRefs: jsonb("output_row_refs")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    status: synthesisStageStatusEnum("status").default("queued").notNull(),
    errorJson: jsonb("error_json"),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("synthesis_stage_outputs_org_id_idx").on(table.orgId),
    runStageIdx: index("synthesis_stage_outputs_run_stage_idx").on(
      table.synthesisRunId,
      table.stageName,
    ),
  }),
);

export const workflowSemanticModels = pgTable(
  "workflow_semantic_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id),
    synthesisRunId: uuid("synthesis_run_id").references(() => synthesisRuns.id),
    captureSessionIds: uuid("capture_session_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    evidencePackHash: text("evidence_pack_hash").notNull(),
    semanticModelHash: text("semantic_model_hash").notNull(),
    promptTemplateId: text("prompt_template_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    model: text("model").notNull(),
    llmRequestHash: text("llm_request_hash"),
    llmResponseHash: text("llm_response_hash"),
    sourceProcessVersionId: uuid("source_process_version_id").references(
      () => processVersions.id,
    ),
    cacheStatus: text("cache_status").notNull(),
    rawModelJson: jsonb("raw_model_json").default(sql`'{}'::jsonb`).notNull(),
    verifiedModelJson: jsonb("verified_model_json")
      .default(sql`'{}'::jsonb`)
      .notNull(),
    diagnosticsJson: jsonb("diagnostics_json")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    groundingJson: jsonb("grounding_json").default(sql`'{}'::jsonb`).notNull(),
    verifierConfidenceJson: jsonb("verifier_confidence_json")
      .default(sql`'{}'::jsonb`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgProcessHashIdx: uniqueIndex(
      "workflow_semantic_models_org_process_pack_hash_idx",
    ).on(table.orgId, table.workspaceId, table.processId, table.evidencePackHash),
    processIdx: index("workflow_semantic_models_process_id_idx").on(
      table.processId,
    ),
    synthesisRunIdx: index("workflow_semantic_models_synthesis_run_id_idx").on(
      table.synthesisRunId,
    ),
  }),
);

export const automationOpportunitySets = pgTable(
  "automation_opportunity_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    synthesisRunId: uuid("synthesis_run_id").references(() => synthesisRuns.id),
    evidencePackHash: text("evidence_pack_hash").notNull(),
    opportunitySetHash: text("opportunity_set_hash").notNull(),
    promptTemplateId: text("prompt_template_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    model: text("model").notNull(),
    llmRequestHash: text("llm_request_hash"),
    llmResponseHash: text("llm_response_hash"),
    generator: text("generator").notNull(),
    generatorVersion: integer("generator_version").default(1).notNull(),
    opportunitiesJson: jsonb("opportunities_json")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    diagnosticsJson: jsonb("diagnostics_json")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("automation_opportunity_sets_org_id_idx").on(table.orgId),
    versionIdx: index("automation_opportunity_sets_version_idx").on(
      table.versionId,
    ),
    versionPackIdx: uniqueIndex(
      "automation_opportunity_sets_version_pack_idx",
    ).on(table.versionId, table.evidencePackHash),
  }),
);

export const directorAutomationPlans = pgTable(
  "director_automation_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    synthesisRunId: uuid("synthesis_run_id").references(() => synthesisRuns.id),
    sourceCaptureSessionIds: uuid("source_capture_session_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    inventoryHash: text("inventory_hash").notNull(),
    planInputHash: text("plan_input_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    promptTemplateId: text("prompt_template_id").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    model: text("model").notNull(),
    llmRequestHash: text("llm_request_hash"),
    llmResponseHash: text("llm_response_hash"),
    generator: text("generator").notNull(),
    generatorVersion: integer("generator_version").default(1).notNull(),
    planJson: jsonb("plan_json").default(sql`'{}'::jsonb`).notNull(),
    diagnosticsJson: jsonb("diagnostics_json")
      .default(sql`'[]'::jsonb`)
      .notNull(),
    ...timestamps,
  },
  (table) => ({
    orgIdx: index("director_automation_plans_org_id_idx").on(table.orgId),
    workspaceCreatedIdx: index(
      "director_automation_plans_workspace_created_idx",
    ).on(table.workspaceId, table.createdAt),
    inputHashIdx: uniqueIndex(
      "director_automation_plans_workspace_input_hash_idx",
    ).on(table.workspaceId, table.planInputHash),
  }),
);

export const opportunityAssumptionOverrides = pgTable(
  "opportunity_assumption_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    versionId: uuid("version_id").references(() => processVersions.id).notNull(),
    opportunitySetKey: text("opportunity_set_key").notNull(),
    opportunityId: text("opportunity_id").notNull(),
    assumptionsJson: jsonb("assumptions_json").notNull(),
    editedByUserId: uuid("edited_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (table) => ({
    setOpportunityIdx: uniqueIndex("opportunity_override_set_opp_idx").on(
      table.versionId,
      table.opportunitySetKey,
      table.opportunityId,
    ),
  }),
);

export const workspaceRoiPrices = pgTable(
  "workspace_roi_prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    loadedHourlyCost: numeric("loaded_hourly_cost", {
      precision: 10,
      scale: 2,
    }).notNull(),
    costPerError: numeric("cost_per_error", {
      precision: 10,
      scale: 2,
    }).notNull(),
    delayCost: numeric("delay_cost", { precision: 10, scale: 2 }).notNull(),
    currency: text("currency").default("USD").notNull(),
    editedByUserId: uuid("edited_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (table) => ({
    workspaceIdx: uniqueIndex("workspace_roi_prices_workspace_idx").on(
      table.workspaceId,
    ),
  }),
);

export const agentDecisionLog = pgTable(
  "agent_decision_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    captureSessionId: uuid("capture_session_id").references(
      () => captureSessions.id,
    ),
    synthesisRunId: uuid("synthesis_run_id").references(() => synthesisRuns.id),
    turnIndex: integer("turn_index"),
    stageName: text("stage_name"),
    tsStart: timestamp("ts_start", { withTimezone: true }).notNull(),
    tsEnd: timestamp("ts_end", { withTimezone: true }),
    transcriptSegmentIds: uuid("transcript_segment_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    slotUpdates: jsonb("slot_updates"),
    rankedProbeIntents: jsonb("ranked_probe_intents"),
    chosenIntent: jsonb("chosen_intent"),
    sanitizedAgentUtterance: text("sanitized_agent_utterance"),
    promptTemplateId: text("prompt_template_id"),
    promptTemplateVersion: text("prompt_template_version"),
    toolCalls: jsonb("tool_calls"),
    deliveryJson: jsonb("delivery_json"),
    model: text("model"),
    tokenCountInput: integer("token_count_input"),
    tokenCountOutput: integer("token_count_output"),
    costCents: numeric("cost_cents", { precision: 10, scale: 3 }),
    latencyMs: integer("latency_ms"),
    cacheHit: boolean("cache_hit"),
    degradedQuality: boolean("degraded_quality").default(false).notNull(),
    degradedReasons: jsonb("degraded_reasons").default(sql`'[]'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => ({
    orgCreatedIdx: index("agent_decision_log_org_created_idx").on(
      table.orgId,
      table.createdAt,
    ),
    captureTsIdx: index("agent_decision_log_capture_ts_idx").on(
      table.captureSessionId,
      table.tsStart,
    ),
    captureTurnStageIdx: uniqueIndex("agent_decision_log_capture_turn_stage_idx")
      .on(table.captureSessionId, table.turnIndex, table.stageName)
      .where(sql`capture_session_id IS NOT NULL
        AND turn_index IS NOT NULL
        AND stage_name IS NOT NULL`),
    synthesisStageIdx: index("agent_decision_log_synthesis_stage_idx").on(
      table.synthesisRunId,
      table.stageName,
    ),
  }),
);

export const interviewState = pgTable(
  "interview_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    currentPhase: text("current_phase").default("orient").notNull(),
    focusCandidateProcessId: uuid("focus_candidate_process_id").references(
      () => candidateProcesses.id,
    ),
    focusProcessId: uuid("focus_process_id").references(() => processes.id),
    priorIntent: text("prior_intent"),
    lowInfoTurnCount: integer("low_info_turn_count").default(0).notNull(),
    lastNewSlotTurnIndex: integer("last_new_slot_turn_index"),
    phaseHistory: jsonb("phase_history").default(sql`'[]'::jsonb`).notNull(),
    ...timestamps,
  },
  (table) => ({
    captureIdx: uniqueIndex("interview_state_capture_session_id_idx").on(
      table.captureSessionId,
    ),
    orgIdx: index("interview_state_org_id_idx").on(table.orgId),
    workspaceIdx: index("interview_state_workspace_id_idx").on(table.workspaceId),
  }),
);

export const probeFirings = pgTable(
  "probe_firings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
    probeId: text("probe_id").notNull(),
    targetSlot: text("target_slot"),
    targetCandidateProcessId: uuid("target_candidate_process_id").references(
      () => candidateProcesses.id,
    ),
    turnIndex: integer("turn_index").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    styleHint: text("style_hint"),
    resolvedStatusAfter: text("resolved_status_after"),
    ...timestamps,
  },
  (table) => ({
    captureProbeIdx: index("probe_firings_capture_probe_idx").on(
      table.captureSessionId,
      table.probeId,
      table.firedAt,
    ),
    captureTurnProbeIdx: uniqueIndex("probe_firings_capture_turn_probe_idx").on(
      table.captureSessionId,
      table.turnIndex,
      table.probeId,
    ),
    orgIdx: index("probe_firings_org_id_idx").on(table.orgId),
    workspaceIdx: index("probe_firings_workspace_id_idx").on(table.workspaceId),
  }),
);

export const processSystems = pgTable(
  "process_systems",
  {
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    systemId: uuid("system_id").references(() => systems.id).notNull(),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.processId, table.systemId] }),
    orgIdx: index("process_systems_org_id_idx").on(table.orgId),
    workspaceIdx: index("process_systems_workspace_id_idx").on(table.workspaceId),
    systemIdx: index("process_systems_system_id_idx").on(table.systemId),
  }),
);

export const processRoles = pgTable(
  "process_roles",
  {
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    roleId: uuid("role_id").references(() => roles.id).notNull(),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.processId, table.roleId] }),
    orgIdx: index("process_roles_org_id_idx").on(table.orgId),
    workspaceIdx: index("process_roles_workspace_id_idx").on(table.workspaceId),
    roleIdx: index("process_roles_role_id_idx").on(table.roleId),
  }),
);

export const processPeople = pgTable(
  "process_people",
  {
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id).notNull(),
    personId: uuid("person_id").references(() => people.id).notNull(),
    evidenceIds: uuid("evidence_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.processId, table.personId] }),
    orgIdx: index("process_people_org_id_idx").on(table.orgId),
    workspaceIdx: index("process_people_workspace_id_idx").on(table.workspaceId),
    personIdx: index("process_people_person_id_idx").on(table.personId),
  }),
);
