import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  agentDecisionLog,
  auditLog,
  automationOpportunitySets,
  synthesisStageOutputs,
} from "@/lib/db/schema";
import type { OpportunityExtraction } from "@/lib/processes/opportunity-extractor";
import type { GroundedOpportunity } from "@/lib/processes/opportunity-schema";
import { stableHash } from "@/lib/processes/opportunity-schema";

export async function persistCompletedAutomationOpportunityStage(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
  synthesisRunId: string;
  userId?: string | null;
  extraction: OpportunityExtraction;
  grounded: GroundedOpportunity[];
  diagnostics: Array<{ code: string; message: string }>;
  generator: "agent" | "heuristic_fallback";
  inputRowRefs: Array<{ table: string; id: string }>;
}) {
  const opportunitySetHash = stableHash(input.grounded);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const inserted = (
      await tx
        .insert(automationOpportunitySets)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          processId: input.processId,
          versionId: input.versionId,
          synthesisRunId: input.synthesisRunId,
          evidencePackHash: input.extraction.evidencePackHash,
          opportunitySetHash,
          promptTemplateId: input.extraction.promptTemplateId,
          promptTemplateVersion: input.extraction.promptTemplateVersion,
          model: input.extraction.modelId,
          llmRequestHash: input.extraction.llmRequestHash,
          llmResponseHash: input.extraction.llmResponseHash,
          generator: input.generator,
          generatorVersion: 1,
          opportunitiesJson: input.grounded,
          diagnosticsJson: [
            ...input.extraction.diagnostics,
            ...input.diagnostics,
          ],
        })
        .onConflictDoNothing({
          target: [
            automationOpportunitySets.versionId,
            automationOpportunitySets.evidencePackHash,
          ],
        })
        .returning()
    )[0];
    const set =
      inserted ??
      (
        await tx
          .select()
          .from(automationOpportunitySets)
          .where(sql`
            version_id = ${input.versionId}
            AND evidence_pack_hash = ${input.extraction.evidencePackHash}
          `)
          .limit(1)
      )[0];
    if (!set) {
      throw new Error("Failed to persist or load automation opportunity set.");
    }

    if (inserted) {
      await tx.insert(auditLog).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        eventType: "synthesis.opportunities.generated",
        subjectType: "automation_opportunity_set",
        subjectId: set.id,
        metadataJson: {
          process_id: input.processId,
          version_id: input.versionId,
          synthesis_run_id: input.synthesisRunId,
          evidence_pack_hash: input.extraction.evidencePackHash,
          opportunity_set_hash: opportunitySetHash,
          opportunity_count: input.grounded.length,
        },
      });
      await tx.insert(agentDecisionLog).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: input.synthesisRunId,
        stageName: "stage-9-opportunity-synthesis",
        tsStart: new Date(
          Date.now() - Math.max(1, input.extraction.metadata.latency_ms),
        ),
        tsEnd: new Date(),
        promptTemplateId: input.extraction.promptTemplateId,
        promptTemplateVersion: input.extraction.promptTemplateVersion,
        model: input.extraction.modelId,
        tokenCountInput: input.extraction.metadata.token_count_input,
        tokenCountOutput: input.extraction.metadata.token_count_output,
        costCents: String(input.extraction.metadata.cost_cents),
        latencyMs: input.extraction.metadata.latency_ms,
        cacheHit: input.extraction.metadata.cache_hit,
        degradedQuality: input.grounded.length === 0,
        degradedReasons:
          input.grounded.length === 0 ? ["no_valid_opportunities"] : [],
        deliveryJson: {
          opportunity_set_id: set.id,
          diagnostics: input.diagnostics,
        },
      });
    }
    await tx.insert(synthesisStageOutputs).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName: "stage-9-opportunity-synthesis",
      inputRowRefs: input.inputRowRefs,
      outputRowRefs: [{ table: "automation_opportunity_sets", id: set.id }],
      status: "completed",
    });
    return set;
  });
}

export async function loadCompletedAutomationOpportunitySetForEvidencePack(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  versionId: string;
  evidencePackHash: string;
}): Promise<{ id: string } | null> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx.execute<{ id: string }>(sql`
      SELECT aos.id
      FROM automation_opportunity_sets aos
      WHERE aos.org_id = ${input.orgId}
        AND aos.workspace_id = ${input.workspaceId}
        AND aos.process_id = ${input.processId}
        AND aos.version_id = ${input.versionId}
        AND aos.evidence_pack_hash = ${input.evidencePackHash}
        AND EXISTS (
          SELECT 1
          FROM synthesis_stage_outputs sso,
            jsonb_array_elements(sso.output_row_refs) AS ref
          WHERE sso.org_id = ${input.orgId}
            AND sso.workspace_id = ${input.workspaceId}
            AND sso.stage_name = 'stage-9-opportunity-synthesis'
            AND sso.status = 'completed'
            AND ref->>'table' = 'automation_opportunity_sets'
            AND ref->>'id' = aos.id::text
        )
      LIMIT 1
    `);
  });
  return result.rows[0] ?? null;
}
