import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import type { EvidenceLabel, EvidenceSource } from "@/lib/types/evidence";

export type ProcessEvidenceSourceRow = {
  id: string;
  source_type: EvidenceSource;
  source_id: string | null;
  evidence_label: EvidenceLabel;
  quote: string;
  summary: string | null;
  observed_at: string;
  confidence: number;
  source_preview: string | null;
  speaker: string | null;
  screen_app_name: string | null;
  screen_window_title: string | null;
  screen_signal_tags: string[];
  screenshot_artifact_url: string | null;
  screenshot_artifact_expired: boolean;
  document_ordinal: number | null;
};

type EvidenceRow = {
  id: string;
  source_type: EvidenceSource;
  source_id: string | null;
  evidence_label: EvidenceLabel;
  quote: string | null;
  summary: string | null;
  observed_at: string | null;
  confidence: string | null;
  source_preview: string | null;
  speaker: string | null;
  screen_app_name: string | null;
  screen_window_title: string | null;
  screen_signal_tags: string[] | null;
  screenshot_artifact_url: string | null;
  screenshot_artifact_expired: boolean | null;
  document_ordinal: number | null;
};

export async function getProcessEvidenceRows(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId?: string;
  evidenceIds: string[];
}): Promise<ProcessEvidenceSourceRow[]> {
  if (input.evidenceIds.length === 0) return [];
  const uniqueEvidenceIds = [...new Set(input.evidenceIds)].slice(0, 50);
  const requestedVersionId = input.versionId ?? null;
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx.execute<EvidenceRow>(sql`
      WITH target_version AS (
        SELECT
          CASE
            WHEN ${requestedVersionId}::uuid IS NULL
            THEN COALESCE(p.current_draft_version_id, p.current_approved_version_id)
            ELSE pv.id
          END AS version_id
        FROM processes p
        LEFT JOIN process_versions pv
          ON pv.id = ${requestedVersionId}::uuid
         AND pv.process_id = p.id
         AND pv.org_id = p.org_id
         AND pv.workspace_id = p.workspace_id
        WHERE p.id = ${input.processId}
          AND p.org_id = ${input.orgId}
          AND p.workspace_id = ${input.workspaceId}
          AND (
            ${requestedVersionId}::uuid IS NULL
            OR p.current_draft_version_id = pv.id
            OR p.current_approved_version_id = pv.id
            OR EXISTS (
              SELECT 1
              FROM audit_log al
              WHERE al.org_id = ${input.orgId}
                AND al.workspace_id = ${input.workspaceId}
                AND al.event_type = 'synthesis.operator.draft_published'
                AND al.subject_type = 'process_version'
                AND al.subject_id = pv.id
            )
          )
        LIMIT 1
      ),
      allowed_evidence AS (
        SELECT DISTINCT unnest(n.top_evidence_ids) AS evidence_id
        FROM process_nodes n
        JOIN target_version tv ON tv.version_id = n.version_id
        WHERE n.org_id = ${input.orgId}
          AND n.workspace_id = ${input.workspaceId}
          AND n.process_id = ${input.processId}
        UNION
        SELECT DISTINCT unnest(pe.top_evidence_ids) AS evidence_id
        FROM process_edges pe
        JOIN target_version tv ON tv.version_id = pe.version_id
        WHERE pe.org_id = ${input.orgId}
          AND pe.workspace_id = ${input.workspaceId}
          AND pe.process_id = ${input.processId}
      )
      SELECT
        e.id,
        e.source_type::text,
        e.source_id,
        e.evidence_label::text,
        e.quote,
        e.summary,
        e.observed_at::text,
        e.confidence::text,
        COALESCE(ts.text, se.ocr_text, se.ui_state_label, dc.text, e.summary, e.quote) AS source_preview,
        ts.speaker,
        se.app_name AS screen_app_name,
        se.window_title AS screen_window_title,
        se.signal_tags AS screen_signal_tags,
        CASE
          WHEN a.id IS NOT NULL
           AND a.redacted_at IS NULL
           AND (a.ttl_at IS NULL OR a.ttl_at > now())
          THEN a.storage_url
          ELSE NULL
        END AS screenshot_artifact_url,
        CASE
          WHEN a.id IS NULL THEN false
          WHEN a.redacted_at IS NOT NULL THEN true
          WHEN a.ttl_at IS NOT NULL AND a.ttl_at <= now() THEN true
          ELSE false
        END AS screenshot_artifact_expired,
        dc.ordinal AS document_ordinal
      FROM evidence e
      JOIN allowed_evidence ae ON ae.evidence_id = e.id
      LEFT JOIN transcript_segments ts
        ON e.source_type = 'transcript_segment'
       AND ts.id = e.source_id
       AND ts.redacted_at IS NULL
      LEFT JOIN screen_events se
        ON e.source_type = 'screen_event'
       AND se.id = e.source_id
       AND se.deleted_at IS NULL
       AND se.redacted_at IS NULL
      LEFT JOIN artifacts a
        ON a.id = se.screenshot_artifact_id
       AND a.artifact_type = 'screen_frame'
      LEFT JOIN document_chunks dc
        ON e.source_type = 'document_chunk'
       AND dc.id = e.source_id
       AND dc.redacted_at IS NULL
      WHERE e.org_id = ${input.orgId}
        AND e.workspace_id = ${input.workspaceId}
        AND e.id = ANY(${uuidArraySql(uniqueEvidenceIds)})
        AND e.redacted_at IS NULL
        AND e.tombstoned_at IS NULL
      ORDER BY e.observed_at ASC NULLS LAST, e.created_at ASC
    `);
  });

  return result.rows.map((row) => ({
    id: row.id,
    source_type: row.source_type,
    source_id: row.source_id,
    evidence_label: row.evidence_label,
    quote: row.quote ?? row.summary ?? row.source_preview ?? "Evidence source",
    summary: row.summary,
    observed_at: row.observed_at ?? new Date().toISOString(),
    confidence: row.confidence !== null ? Number(row.confidence) : 1,
    source_preview: row.source_preview,
    speaker: row.speaker,
    screen_app_name: row.screen_app_name,
    screen_window_title: row.screen_window_title,
    screen_signal_tags: row.screen_signal_tags ?? [],
    screenshot_artifact_url: row.screenshot_artifact_url,
    screenshot_artifact_expired: Boolean(row.screenshot_artifact_expired),
    document_ordinal: row.document_ordinal,
  }));
}
