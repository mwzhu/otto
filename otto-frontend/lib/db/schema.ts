import {
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
]);
export const synthesisStageStatusEnum = pgEnum("synthesis_stage_status", [
  "queued",
  "running",
  "completed",
  "skipped",
  "failed",
]);

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

export const captureSessions = pgTable(
  "capture_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    processId: uuid("process_id").references(() => processes.id),
    participantPersonId: uuid("participant_person_id"),
    captureType: captureTypeEnum("capture_type").notNull(),
    frameEgressDir: text("frame_egress_dir"),
    recordingUrl: text("recording_url"),
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
          'upstream_dependency',
          'downstream_dependency',
          'used_in_process',
          'participates_in_process',
          'handoff_target'
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

export const slotStates = pgTable(
  "slot_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id).notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
    captureSessionId: uuid("capture_session_id")
      .references(() => captureSessions.id)
      .notNull(),
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
    captureSlotIdx: uniqueIndex("slot_states_capture_slot_idx").on(
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
