import "server-only";

import { getDb, setOrgContext } from "@/lib/db/client";
import { agentDecisionLog } from "@/lib/db/schema";
import { agentDecisionLogSchema, type AgentDecisionLogInput } from "@/lib/schemas/phase1";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";

export async function writeAgentDecision(input: AgentDecisionLogInput) {
  const parsed = agentDecisionLogSchema.parse(input);
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, parsed.orgId);
    return (
      await tx
        .insert(agentDecisionLog)
        .values({
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
          model: parsed.model,
          tokenCountInput: parsed.tokenCountInput,
          tokenCountOutput: parsed.tokenCountOutput,
          costCents:
            parsed.costCents === undefined ? undefined : String(parsed.costCents),
          latencyMs: parsed.latencyMs,
          cacheHit: parsed.cacheHit,
          degradedQuality: parsed.degradedQuality,
        })
        .returning()
    )[0];
  });
}
