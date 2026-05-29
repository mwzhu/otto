import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import {
  artifacts,
  auditLog,
  claimEvidence,
  claims,
  documentChunks,
  evidence,
  followUpTasks,
  provisionalSteps,
} from "@/lib/db/schema";
import { parseDocument } from "@/lib/adapters/document-parser";
import { embedBatch } from "@/lib/adapters/vector";
import { chunkDocument } from "@/lib/documents/chunking";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { sanitizeForLogs, sanitizeJsonForLogs } from "@/lib/security/sanitize";

export type ProcessSpecificDocumentInput = {
  artifactId: string;
  orgId: string;
  userId?: string;
  captureSessionId: string;
  processId: string;
  idempotencyKey?: string;
};

export async function processSpecificDocumentArtifact(
  input: ProcessSpecificDocumentInput,
) {
  const artifact = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return (
      await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.orgId, input.orgId)))
        .limit(1)
    )[0];
  });
  if (!artifact) return { ok: false as const, reason: "artifact_not_found" };
  if (artifact.captureSessionId !== input.captureSessionId) {
    return { ok: false as const, reason: "artifact_capture_mismatch" };
  }
  if (artifact.artifactType !== "document") {
    return { ok: false as const, reason: "artifact_not_document" };
  }

  const started = new Date();
  try {
    const preflight = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`process-document.process:${artifact.id}`}))
      `);
      const lockedArtifact = (
        await tx
          .select({ status: artifacts.status })
          .from(artifacts)
          .where(and(eq(artifacts.id, artifact.id), eq(artifacts.orgId, artifact.orgId)))
          .limit(1)
      )[0];
      if (lockedArtifact?.status === "ready") {
        const replayed = await findExistingProcessDocumentExtraction(tx, {
          orgId: artifact.orgId,
          artifactId: artifact.id,
        });
        if (replayed) return { replayed };
      }
      await tx
        .update(artifacts)
        .set({ status: "processing", updatedAt: new Date() })
        .where(and(eq(artifacts.id, artifact.id), eq(artifacts.orgId, artifact.orgId)));
      return { replayed: null };
    });
    if (preflight.replayed) return preflight.replayed;

    const parsed = await parseDocument({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      storageKey: artifact.storageKey,
      storageUrl: artifact.storageUrl,
    });
    const chunks = chunkDocument(parsed.text);
    if (chunks.length === 0) {
      throw new Error("Process document parser produced no non-empty text chunks.");
    }
    const embeddings = await embedBatch({
      prompt_template_id: "process-document.embed-chunks",
      texts: chunks.map((chunk) => chunk.text),
    });

    const insertedChunks = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      return tx
        .insert(documentChunks)
        .values(
          chunks.map((chunk, index) => ({
            orgId: artifact.orgId,
            workspaceId: artifact.workspaceId,
            artifactId: artifact.id,
            ordinal: chunk.ordinal,
            text: chunk.text,
            embedding: embeddings[index].embedding,
            metadataJson: {
              parser: parsed.metadata.parser,
              parser_job_id: parsed.metadata.jobId,
              page_count: parsed.metadata.pageCount,
              start: chunk.start,
              end: chunk.end,
              process_id: input.processId,
              extraction_scope: "process_sop",
              embedding_provider: embeddings[index].provider,
              embedding_lexical_fallback: embeddings[index].lexicalFallback,
              embedding_provider_errors: embeddings[index].providerErrors ?? [],
            },
          })),
        )
        .onConflictDoUpdate({
          target: [documentChunks.artifactId, documentChunks.ordinal],
          set: {
            text: sql`excluded.text`,
            embedding: sql`excluded.embedding`,
            metadataJson: sql`excluded.metadata_json`,
            updatedAt: new Date(),
          },
        })
        .returning();
    });

    const evidenceRows: Array<typeof evidence.$inferSelect> = [];
    for (const chunk of insertedChunks) {
      evidenceRows.push(
        await getOrCreateProcessDocumentEvidence({
          orgId: artifact.orgId,
          workspaceId: artifact.workspaceId,
          documentChunkId: chunk.id,
          quote: chunk.text,
          spanStart: typeof chunk.metadataJson === "object" && chunk.metadataJson && "start" in chunk.metadataJson
            ? Number(chunk.metadataJson.start)
            : 0,
          spanEnd: typeof chunk.metadataJson === "object" && chunk.metadataJson && "end" in chunk.metadataJson
            ? Number(chunk.metadataJson.end)
            : chunk.text.length,
        }),
      );
    }

    const stepHypotheses = documentStepHypotheses(
      insertedChunks.map((chunk, index) => ({
        id: chunk.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        evidenceId: evidenceRows[index].id,
      })),
    );
    const provisionalStepRows = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      if (stepHypotheses.length === 0) {
        await tx.insert(followUpTasks).values({
          orgId: artifact.orgId,
          workspaceId: artifact.workspaceId,
          processId: input.processId,
          captureSessionId: input.captureSessionId,
          taskType: "open_question",
          title: "Review SOP upload for workflow steps",
          description:
            "The uploaded SOP was parsed as documented evidence, but no clear step hypotheses were extracted.",
          targetType: "artifact",
          targetId: artifact.id,
          priority: "0.7",
          status: "open",
          assignedToUserId: input.userId ?? artifact.uploadedByUserId,
          contextJson: sanitizeJsonForLogs({
            artifact_id: artifact.id,
            process_id: input.processId,
            chunk_ids: insertedChunks.map((chunk) => chunk.id),
            evidence_ids: evidenceRows.map((row) => row.id),
            reason: "no_document_step_hypotheses",
          }),
        });
        return [];
      }
      return tx
        .insert(provisionalSteps)
        .values(
          stepHypotheses.map((step, index) => ({
            orgId: artifact.orgId,
            workspaceId: artifact.workspaceId,
            captureSessionId: input.captureSessionId,
            processId: input.processId,
            tsStartMs: step.ordinal * 10_000,
            tsEndMs: step.ordinal * 10_000 + 1_000,
            ordinalHint: index,
            actionVerb: step.actionVerb,
            actionObject: step.actionObject,
            source: "document_hypothesis",
            sourceEventId: `document-chunk:${step.chunkId}`,
            idempotencyKey: `document:${artifact.id}:step:${index}`,
            confidence: "0.450",
            metadataJson: sanitizeJsonForLogs({
              title: step.title,
              artifact_id: artifact.id,
              process_id: input.processId,
              document_chunk_id: step.chunkId,
              evidence_ids: [step.evidenceId],
              source_evidence_label: "documented",
            }),
          })),
        )
        .onConflictDoNothing()
        .returning();
    });
    const documentClaimIds = await materializeProcessDocumentClaims({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      artifactId: artifact.id,
      userId: input.userId ?? artifact.uploadedByUserId,
      parser: parsed.metadata.parser,
      chunks: insertedChunks.map((chunk, index) => ({
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        evidenceId: evidenceRows[index].id,
      })),
      stepHypothesisCount: stepHypotheses.length,
    });

    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      await tx.insert(auditLog).values({
        orgId: artifact.orgId,
        workspaceId: artifact.workspaceId,
        userId: input.userId ?? artifact.uploadedByUserId,
        eventType: "process.document.parsed",
        subjectType: "artifact",
        subjectId: artifact.id,
        metadataJson: {
          process_id: input.processId,
          capture_session_id: input.captureSessionId,
          parser: parsed.metadata.parser,
          parser_job_id: parsed.metadata.jobId,
          chunk_count: insertedChunks.length,
          provisional_step_count: provisionalStepRows.length,
          document_claim_ids: documentClaimIds,
          candidate_process_count: 0,
          idempotency_key: input.idempotencyKey,
        },
      });
      await tx
        .update(artifacts)
        .set({ status: "ready", updatedAt: new Date() })
        .where(eq(artifacts.id, artifact.id));
    });

    await writeAgentDecision({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      captureSessionId: input.captureSessionId,
      stageName: "process_document_pipeline",
      tsStart: started,
      tsEnd: new Date(),
      promptTemplateId: "process-document.extract",
      promptTemplateVersion: "1",
      toolCalls: {
        artifact_id: artifact.id,
        process_id: input.processId,
        chunks: insertedChunks.length,
        evidence_ids: evidenceRows.map((row) => row.id),
        provisional_step_ids: provisionalStepRows.map((row) => row.id),
        document_claim_ids: documentClaimIds,
        candidate_process_ids: [],
        parser: parsed.metadata.parser,
      },
      model: parsed.metadata.parser,
      tokenCountInput: Math.ceil(parsed.text.length / 4),
      tokenCountOutput: evidenceRows.length,
      costCents: 0,
      latencyMs: Date.now() - started.getTime(),
      cacheHit: false,
      degradedQuality: false,
    });

    return {
      ok: true as const,
      artifact_id: artifact.id,
      capture_session_id: input.captureSessionId,
      process_id: input.processId,
      chunk_ids: insertedChunks.map((chunk) => chunk.id),
      evidence_ids: evidenceRows.map((row) => row.id),
      provisional_step_ids: provisionalStepRows.map((row) => row.id),
      document_claim_ids: documentClaimIds,
      candidate_process_ids: [] as string[],
    };
  } catch (error) {
    await markArtifactFailed({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      artifactId: artifact.id,
      userId: input.userId ?? artifact.uploadedByUserId ?? undefined,
      idempotencyKey: input.idempotencyKey,
      error,
    });
    throw error;
  }
}

async function findExistingProcessDocumentExtraction(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: { orgId: string; artifactId: string },
) {
  const chunks = await tx
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.orgId, input.orgId),
        eq(documentChunks.artifactId, input.artifactId),
      ),
    );
  const chunkIds = chunks.map((chunk) => chunk.id);
  if (chunkIds.length === 0) return null;
  const evidenceRows = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM evidence
    WHERE org_id = ${input.orgId}
      AND source_type = 'document_chunk'
      AND source_id = ANY(${uuidArraySql(chunkIds)})
      AND evidence_label = 'documented'
  `);
  const stepRows = await tx
    .select({ id: provisionalSteps.id })
    .from(provisionalSteps)
    .where(
      and(
        eq(provisionalSteps.orgId, input.orgId),
        eq(provisionalSteps.source, "document_hypothesis"),
        sql`${provisionalSteps.metadataJson}->>'artifact_id' = ${input.artifactId}`,
      ),
    );
  const claimRows = await tx.execute<{ id: string }>(sql`
    SELECT id
    FROM claims
    WHERE org_id = ${input.orgId}
      AND subject_type = 'process'
      AND metadata_json->>'artifact_id' = ${input.artifactId}
      AND status = 'active'
      AND redacted_at IS NULL
      AND tombstoned_at IS NULL
  `);
  return {
    ok: true as const,
    replayed: true,
    artifact_id: input.artifactId,
    chunk_ids: chunkIds,
    evidence_ids: evidenceRows.rows.map((row) => row.id),
    provisional_step_ids: stepRows.map((row) => row.id),
    document_claim_ids: claimRows.rows.map((row) => row.id),
    candidate_process_ids: [] as string[],
  };
}

type ProcessDocumentClaimChunk = {
  chunkId: string;
  ordinal: number;
  text: string;
  evidenceId: string;
};

async function materializeProcessDocumentClaims(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  artifactId: string;
  userId?: string | null;
  parser: string;
  chunks: ProcessDocumentClaimChunk[];
  stepHypothesisCount: number;
}) {
  const evidenceIds = input.chunks.map((chunk) => chunk.evidenceId);
  const combinedText = input.chunks.map((chunk) => chunk.text).join("\n");
  const controlChunks = input.chunks.filter((chunk) =>
    /\b(approval|approve|review|verify|reconcile|audit|control|compliance|sign[- ]?off)\b/i.test(chunk.text),
  );
  const riskChunks = input.chunks.filter((chunk) =>
    /\b(error|exception|manual|delay|rework|missing|required|must|fallback|escalate)\b/i.test(chunk.text),
  );
  const claimInputs: Array<{
    field: "documentation_maturity" | "control" | "risk";
    value: unknown;
    confidence: string;
    evidenceIds: string[];
    singleActive: boolean;
    documentChunkId?: string;
  }> = [
    {
      field: "documentation_maturity",
      value: {
        level: "sop_uploaded",
        chunk_count: input.chunks.length,
        documented_step_hypothesis_count: input.stepHypothesisCount,
        documented_systems: documentedSystems(combinedText),
        documented_roles: documentedRoles(combinedText),
        parser: input.parser,
      },
      confidence: "0.720",
      evidenceIds,
      singleActive: true,
    },
  ];
  if (controlChunks.length > 0) {
    claimInputs.push({
      field: "control",
      value: {
        source: "process_document",
        controls: controlChunks.slice(0, 8).map((chunk) => ({
          ordinal: chunk.ordinal,
          description: trimText(firstSentence(chunk.text), 220),
          evidence_ids: [chunk.evidenceId],
        })),
      },
      confidence: "0.680",
      evidenceIds: controlChunks.map((chunk) => chunk.evidenceId),
      singleActive: true,
    });
  }
  for (const chunk of riskChunks.slice(0, 6)) {
    claimInputs.push({
      field: "risk",
      value: {
        source: "process_document",
        description: trimText(firstSentence(chunk.text), 220),
        document_chunk_id: chunk.chunkId,
      },
      confidence: "0.560",
      evidenceIds: [chunk.evidenceId],
      singleActive: false,
      documentChunkId: chunk.chunkId,
    });
  }

  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${`process-document.claims:${input.artifactId}`}))
    `);
    const existingSingletonRows = await tx.execute<{ field: string }>(sql`
      SELECT field
      FROM claims
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND subject_type = 'process'
        AND subject_id = ${input.processId}
        AND field IN ('documentation_maturity', 'control')
        AND status = 'active'
        AND superseded_by_claim_id IS NULL
        AND redacted_at IS NULL
        AND tombstoned_at IS NULL
    `);
    const existingSingletonFields = new Set(
      existingSingletonRows.rows.map((row) => row.field),
    );
    const existingRiskRows = await tx.execute<{ document_chunk_id: string }>(sql`
      SELECT value->>'document_chunk_id' AS document_chunk_id
      FROM claims
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND subject_type = 'process'
        AND subject_id = ${input.processId}
        AND field = 'risk'
        AND metadata_json->>'source' = 'process_document'
        AND metadata_json->>'artifact_id' = ${input.artifactId}
        AND value->>'document_chunk_id' IS NOT NULL
        AND status = 'active'
        AND superseded_by_claim_id IS NULL
        AND redacted_at IS NULL
        AND tombstoned_at IS NULL
    `);
    const existingRiskChunkIds = new Set(
      existingRiskRows.rows.map((row) => row.document_chunk_id),
    );
    const claimIds: string[] = [];
    const materializedFields: string[] = [];
    for (const claimInput of claimInputs) {
      if (claimInput.singleActive && existingSingletonFields.has(claimInput.field)) {
        continue;
      }
      if (
        claimInput.field === "risk" &&
        claimInput.documentChunkId &&
        existingRiskChunkIds.has(claimInput.documentChunkId)
      ) {
        continue;
      }
      const claimId = randomUUID();
      await tx.insert(claims).values({
        id: claimId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        subjectType: "process",
        subjectId: input.processId,
        field: claimInput.field,
        value: claimInput.value,
        confidence: claimInput.confidence,
        status: "active",
        metadataJson: sanitizeJsonForLogs({
          source: "process_document",
          capture_session_id: input.captureSessionId,
          artifact_id: input.artifactId,
        }),
      });
      const linkedEvidenceIds = uniqueStrings(claimInput.evidenceIds);
      if (linkedEvidenceIds.length > 0) {
        await tx
          .insert(claimEvidence)
          .values(
            linkedEvidenceIds.map((evidenceId) => ({
              claimId,
              evidenceId,
            })),
          )
          .onConflictDoNothing();
      }
      claimIds.push(claimId);
      materializedFields.push(claimInput.field);
    }
    if (claimIds.length > 0) {
      await tx.insert(auditLog).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: input.userId ?? null,
        eventType: "process.document.claims_materialized",
        subjectType: "process",
        subjectId: input.processId,
        metadataJson: sanitizeJsonForLogs({
          capture_session_id: input.captureSessionId,
          artifact_id: input.artifactId,
          claim_ids: claimIds,
          fields: materializedFields,
        }),
      });
    }
    return claimIds;
  });
}

type DocumentChunkForHypothesis = {
  id: string;
  ordinal: number;
  text: string;
  evidenceId: string;
};

function documentStepHypotheses(chunks: DocumentChunkForHypothesis[]) {
  return chunks
    .flatMap((chunk) =>
      splitDocumentStepSentences(chunk.text).map((sentence) => ({
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        evidenceId: chunk.evidenceId,
        title: titleCase(trimText(sentence, 72)),
        actionVerb: firstVerb(sentence),
        actionObject: trimText(sentence, 160),
      })),
    )
    .slice(0, 24);
}

function splitDocumentStepSentences(text: string) {
  return text
    .split(/(?:\n+|(?<=[.!?])\s+)/)
    .map((part) => part.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((part) => part.length >= 12)
    .filter((part) =>
      /\b(open|review|check|copy|paste|enter|submit|approve|send|download|upload|update|create|verify|select|attach|export|import|notify|assign|route|close)\b/i.test(part),
    )
    .slice(0, 3);
}

function documentedSystems(text: string) {
  return uniqueStrings(
    [
      ["Salesforce", /\bsalesforce\b/i],
      ["NetSuite", /\bnetsuite\b/i],
      ["SAP", /\bsap\b/i],
      ["Workday", /\bworkday\b/i],
      ["ServiceNow", /\bservice ?now\b/i],
      ["Zendesk", /\bzendesk\b/i],
      ["Excel", /\b(excel|spreadsheet|xlsx|csv)\b/i],
      ["Google Sheets", /\bgoogle sheets?\b/i],
    ]
      .filter(([, pattern]) => (pattern as RegExp).test(text))
      .map(([name]) => name as string),
  );
}

function documentedRoles(text: string) {
  return uniqueStrings(
    [
      ["Approver", /\bapprover\b/i],
      ["Manager", /\bmanager\b/i],
      ["Finance", /\bfinance\b/i],
      ["Operations", /\boperations?\b/i],
      ["Customer Support", /\bcustomer support\b/i],
      ["Sales", /\bsales\b/i],
      ["Legal", /\blegal\b/i],
    ]
      .filter(([, pattern]) => (pattern as RegExp).test(text))
      .map(([name]) => name as string),
  );
}

function firstVerb(text: string) {
  return (
    text.match(
      /\b(open|review|check|copy|paste|enter|submit|approve|send|download|upload|update|create|verify|select|attach|export|import|notify|assign|route|close)\b/i,
    )?.[1]?.toLowerCase() ?? "review"
  );
}

function firstSentence(text: string) {
  return text.split(/(?<=[.!?])\s+/)[0] ?? text;
}

function trimText(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function titleCase(text: string) {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

async function getOrCreateProcessDocumentEvidence(input: {
  orgId: string;
  workspaceId: string;
  documentChunkId: string;
  quote: string;
  spanStart: number;
  spanEnd: number;
}) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const existing = (
      await tx
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.orgId, input.orgId),
            eq(evidence.workspaceId, input.workspaceId),
            eq(evidence.sourceType, "document_chunk"),
            eq(evidence.sourceId, input.documentChunkId),
            eq(evidence.evidenceLabel, "documented"),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return existing;
    return (
      await tx
        .insert(evidence)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          sourceType: "document_chunk",
          sourceId: input.documentChunkId,
          evidenceLabel: "documented",
          spanStart: input.spanStart,
          spanEnd: input.spanEnd,
          quote: input.quote,
          observedAt: new Date(),
          confidence: "0.86",
        })
        .returning()
    )[0];
  });
}

async function markArtifactFailed(input: {
  orgId: string;
  workspaceId: string;
  processId: string;
  captureSessionId: string;
  artifactId: string;
  userId?: string;
  idempotencyKey?: string;
  error: unknown;
}) {
  const message = sanitizeForLogs(
    input.error instanceof Error ? input.error.message : "Unknown document error",
  );
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .update(artifacts)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.orgId, input.orgId)));
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      eventType: "process.document.failed",
      subjectType: "artifact",
      subjectId: input.artifactId,
      metadataJson: {
        message,
        idempotency_key: input.idempotencyKey,
      },
    });
    await tx.insert(followUpTasks).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      processId: input.processId,
      captureSessionId: input.captureSessionId,
      taskType: "open_question",
      title: "Review failed SOP upload",
      description:
        "The uploaded process document could not be parsed into documented evidence. Re-upload the SOP or capture the workflow live before approving a draft.",
      targetType: "artifact",
      targetId: input.artifactId,
      priority: "0.82",
      status: "open",
      assignedToUserId: input.userId,
      contextJson: sanitizeJsonForLogs({
        artifact_id: input.artifactId,
        reason: "process_document_upload_failed",
        message,
        idempotency_key: input.idempotencyKey,
      }),
    });
  });
}
