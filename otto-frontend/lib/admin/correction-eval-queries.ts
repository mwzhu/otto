import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";

export type CorrectionEvalFixture = {
  version: 1;
  description: string;
  cases: Array<{
    id: string;
    evidence_id: string;
    target_agent: string;
    target_metric: string;
    expected_behavior: string;
    prompt_template_id?: string;
    prompt_template_version?: string;
    affected_subject_type?: string;
    affected_subject_id?: string;
    quote?: string;
    summary?: string;
    created_at: string;
  }>;
};

type CorrectionEvalRow = {
  id: string;
  evidence_id: string;
  metadata_json: {
    quote?: string | null;
    summary?: string | null;
    correction_eval?: {
      target_agent?: string;
      target_metric?: string;
      expected_behavior?: string;
      fixture_id?: string;
      prompt_template_id?: string;
      prompt_template_version?: string;
      affected_subject_type?: string;
      affected_subject_id?: string;
    };
  };
  created_at: Date;
};

export async function buildCorrectionEvalFixture(input: {
  orgId: string;
  workspaceId: string;
  targetAgent?: string;
}): Promise<CorrectionEvalFixture> {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const rows = (
      await tx.execute<CorrectionEvalRow>(sql`
        SELECT id, subject_id AS evidence_id, metadata_json, created_at
        FROM audit_log
        WHERE org_id = ${input.orgId}
          AND workspace_id = ${input.workspaceId}
          AND event_type = 'eval.correction_example.created'
          AND (
            ${input.targetAgent ?? null}::text IS NULL
            OR metadata_json #>> '{correction_eval,target_agent}' = ${input.targetAgent ?? null}
          )
        ORDER BY created_at ASC
      `)
    ).rows;
    return {
      version: 1,
      description:
        "Labeled FDE correction examples exported from workspace audit events for eval regression fixtures.",
      cases: rows.flatMap((row) => {
        const correction = row.metadata_json.correction_eval;
        if (
          !correction?.target_agent ||
          !correction.target_metric ||
          !correction.expected_behavior
        ) {
          return [];
        }
        return [
          {
            id: correction.fixture_id ?? row.id,
            evidence_id: row.evidence_id,
            target_agent: correction.target_agent,
            target_metric: correction.target_metric,
            expected_behavior: correction.expected_behavior,
            prompt_template_id: correction.prompt_template_id,
            prompt_template_version: correction.prompt_template_version,
            affected_subject_type: correction.affected_subject_type,
            affected_subject_id: correction.affected_subject_id,
            quote: row.metadata_json.quote ?? undefined,
            summary: row.metadata_json.summary ?? undefined,
            created_at: row.created_at.toISOString(),
          },
        ];
      }),
    };
  });
}
