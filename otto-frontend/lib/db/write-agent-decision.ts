import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { agentDecisionLog } from "@/lib/db/schema";
import { agentDecisionLogSchema, type AgentDecisionLogInput } from "@/lib/schemas/phase1";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";

export async function writeAgentDecision(input: AgentDecisionLogInput) {
  const parsed = agentDecisionLogSchema.parse(input);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, parsed.orgId);
    return writeAgentDecisionInTransaction(tx, parsed);
  });
}

export type AgentDecisionWriteTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export async function writeAgentDecisionInTransaction(
  tx: AgentDecisionWriteTx,
  input: AgentDecisionLogInput,
) {
  const parsed = agentDecisionLogSchema.parse(input);
  const values = {
    orgId: parsed.orgId,
    workspaceId: parsed.workspaceId,
    captureSessionId: parsed.captureSessionId,
    synthesisRunId: parsed.synthesisRunId,
    turnIndex: parsed.turnIndex,
    stageName: parsed.stageName,
    tsStart: parsed.tsStart,
    tsEnd: parsed.tsEnd,
    transcriptSegmentIds: parsed.transcriptSegmentIds,
    slotUpdates: sanitizeJsonForLogs(parsed.slotUpdates),
    rankedProbeIntents: sanitizeJsonForLogs(parsed.rankedProbeIntents),
    chosenIntent: sanitizeJsonForLogs(parsed.chosenIntent),
    sanitizedAgentUtterance: parsed.sanitizedAgentUtterance
      ? sanitizeForLogs(parsed.sanitizedAgentUtterance)
      : undefined,
    promptTemplateId: parsed.promptTemplateId,
    promptTemplateVersion: parsed.promptTemplateVersion,
    toolCalls: sanitizeJsonForLogs(parsed.toolCalls),
    deliveryJson: sanitizeJsonForLogs(parsed.deliveryJson),
    model: parsed.model,
    tokenCountInput: parsed.tokenCountInput,
    tokenCountOutput: parsed.tokenCountOutput,
    costCents:
      parsed.costCents === undefined ? undefined : String(parsed.costCents),
    latencyMs: parsed.latencyMs,
    cacheHit: parsed.cacheHit,
    degradedQuality: parsed.degradedQuality,
    degradedReasons: sanitizeJsonForLogs(parsed.degradedReasons),
  };
  return (
    await tx
      .insert(agentDecisionLog)
      .values(values)
      .onConflictDoUpdate({
        target: [
          agentDecisionLog.captureSessionId,
          agentDecisionLog.turnIndex,
          agentDecisionLog.stageName,
        ],
        targetWhere: sql`capture_session_id IS NOT NULL
            AND turn_index IS NOT NULL
            AND stage_name IS NOT NULL`,
        set: {
          tsStart: values.tsStart,
          tsEnd: values.tsEnd,
          transcriptSegmentIds: values.transcriptSegmentIds,
          slotUpdates: values.slotUpdates,
          rankedProbeIntents: values.rankedProbeIntents,
          chosenIntent: values.chosenIntent,
          sanitizedAgentUtterance: values.sanitizedAgentUtterance,
          promptTemplateId: values.promptTemplateId,
          promptTemplateVersion: values.promptTemplateVersion,
          toolCalls: values.toolCalls,
          deliveryJson: values.deliveryJson,
          model: values.model,
          tokenCountInput: values.tokenCountInput,
          tokenCountOutput: values.tokenCountOutput,
          costCents: values.costCents,
          latencyMs: values.latencyMs,
          cacheHit: values.cacheHit,
          degradedQuality: values.degradedQuality,
          degradedReasons: values.degradedReasons,
          updatedAt: new Date(),
        },
      })
      .returning()
  )[0];
}
