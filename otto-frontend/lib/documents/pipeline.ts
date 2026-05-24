import "server-only";

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import {
  artifacts,
  auditLog,
  documentChunks,
  evidence,
  users,
} from "@/lib/db/schema";
import { parseDocument } from "@/lib/adapters/document-parser";
import { embedBatch } from "@/lib/adapters/vector";
import { structured } from "@/lib/adapters/llm";
import {
  createDocumentEvidence,
  recordPainPoint,
  recordRole,
  recordProcess,
  recordSpof,
  recordSystem,
  updateSlotState,
  type DirectorToolContext,
} from "@/lib/interview/director/tools";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { sanitizeForLogs } from "@/lib/security/sanitize";
import {
  chunkDocument as chunkDocumentInternal,
  type DocumentChunk,
} from "@/lib/documents/chunking";
import {
  normalizeProcessName,
  normalizeRoleName,
  normalizeSignalText,
  normalizeSystemName,
  uniqueNormalized,
} from "@/lib/documents/entity-normalization";
import {
  ownershipRolesValue,
  processBoundaryValue,
} from "@/lib/interview/director/slot-values";

export type ProcessDocumentArtifactInput = {
  artifactId: string;
  orgId: string;
  userId?: string;
  captureSessionId?: string;
  idempotencyKey?: string;
};

const documentInventoryExtractionSchema = z.object({
  candidate_processes: z
    .array(
      z.object({
        proposed_name: z.string().min(1),
        proposed_function: z.string().optional(),
        frequency: z.string().optional(),
        complexity_hint: z.string().optional(),
        systems: z.array(z.string()).default([]),
        roles: z.array(z.string()).default([]),
        pain_points: z.array(z.string()).default([]),
        risks: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1).default(0.75),
      }),
    )
    .default([]),
});

type DocumentInventoryExtraction = z.infer<
  typeof documentInventoryExtractionSchema
>;

export async function processDocumentArtifact(input: ProcessDocumentArtifactInput) {
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
  const captureSessionId = input.captureSessionId ?? artifact.captureSessionId;
  if (!captureSessionId) {
    return { ok: false as const, reason: "capture_session_not_found" };
  }
  const replayed = await existingDocumentPipelineResult(
    input.orgId,
    artifact.id,
    captureSessionId,
    artifact.status,
  );
  if (replayed) return replayed;

  const started = new Date();
  const actorUserId =
    input.userId ?? artifact.uploadedByUserId ?? (await firstOrgUserId(artifact.orgId));

  try {
    await markArtifactStatus(input.orgId, artifact.id, "processing");
    const parsed = await parseDocument({
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      storageKey: artifact.storageKey,
      storageUrl: artifact.storageUrl,
    });
    const chunks = chunkDocumentInternal(parsed.text);
    if (chunks.length === 0) {
      throw new Error("Document parser produced no non-empty text chunks.");
    }
    const embeddings = await embedBatch({
      prompt_template_id: "document.embed-chunks",
      texts: chunks.map((chunk) => chunk.text),
    });

    const insertedChunks = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
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

    if (!actorUserId) {
      throw new Error("Document pipeline requires an org user for claim audit writes.");
    }
    const context: DirectorToolContext = {
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      captureSessionId,
      userId: actorUserId,
    };
    const candidateIds = new Set<string>();
    const evidenceIds: string[] = [];
    const systems = new Set<string>();
    const roleNames = new Set<string>();
    let activeCandidateId: string | undefined;
    const scopedProcessNames = new Set<string>();
    const scopedRoleNames = new Set<string>();
    const scopeEvidenceIds = new Set<string>();
    const roleEvidenceIds = new Set<string>();

    for (const chunk of insertedChunks) {
      const evidenceRow = await getOrCreateDocumentEvidence({
        orgId: artifact.orgId,
        workspaceId: artifact.workspaceId,
        documentChunkId: chunk.id,
        quote: chunk.text,
        spanStart:
          typeof chunk.metadataJson === "object" &&
          chunk.metadataJson &&
          "start" in chunk.metadataJson
            ? Number(chunk.metadataJson.start)
            : 0,
        spanEnd:
          typeof chunk.metadataJson === "object" &&
          chunk.metadataJson &&
          "end" in chunk.metadataJson
            ? Number(chunk.metadataJson.end)
            : chunk.text.length,
        confidence: 0.86,
      });
      evidenceIds.push(evidenceRow.id);
      const extractedCandidates = await extractDocumentInventory(chunk.text);
      for (const extracted of extractedCandidates) {
        if (!extracted.processName) continue;
        const candidate = await recordProcess(context, {
          name: extracted.processName,
          proposedFunction: extracted.ownerRole,
          frequency: extracted.frequency,
          complexityHint: extracted.complexityHint,
          confidence: 0.82,
          evidenceIds: [evidenceRow.id],
        });
        activeCandidateId = candidate.id;
        candidateIds.add(candidate.id);
        scopedProcessNames.add(extracted.processName);
        scopeEvidenceIds.add(evidenceRow.id);
        for (const systemName of extracted.systems) {
          systems.add(systemName);
          await recordSystem(context, {
            name: systemName,
            evidenceIds: [evidenceRow.id],
            candidateProcessId: activeCandidateId,
          });
        }
        if (extracted.ownerRole) {
          roleNames.add(extracted.ownerRole);
          scopedRoleNames.add(extracted.ownerRole);
          roleEvidenceIds.add(evidenceRow.id);
          await recordRole(context, {
            name: extracted.ownerRole,
            evidenceIds: [evidenceRow.id],
            candidateProcessId: activeCandidateId,
          });
        }
        for (const painPoint of extracted.painPoints) {
          await recordPainPoint(context, {
            candidateProcessId: activeCandidateId,
            text: painPoint,
            evidenceIds: [evidenceRow.id],
          });
        }
        for (const risk of extracted.risks) {
          await recordSpof(context, {
            candidateProcessId: activeCandidateId,
            text: risk,
            evidenceIds: [evidenceRow.id],
          });
        }
      }
    }

    if (scopedProcessNames.size > 0) {
      await updateSlotState(context, {
        slotPath: "scope.boundaries",
        value: processBoundaryValue(Array.from(scopedProcessNames)),
        status: "filled",
        confidence: 0.82,
        evidenceIds: Array.from(scopeEvidenceIds),
      });
    }
    if (scopedRoleNames.size > 0) {
      await updateSlotState(context, {
        slotPath: "ownership.roles",
        value: ownershipRolesValue(Array.from(scopedRoleNames)),
        status: "filled",
        confidence: 0.78,
        evidenceIds: Array.from(roleEvidenceIds),
      });
    }

    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, artifact.orgId);
      await tx.insert(auditLog).values({
        orgId: artifact.orgId,
        workspaceId: artifact.workspaceId,
        userId: actorUserId,
        eventType: "artifact.parsed",
        subjectType: "artifact",
        subjectId: artifact.id,
        metadataJson: {
          parser: parsed.metadata.parser,
          parser_job_id: parsed.metadata.jobId,
          chunk_count: insertedChunks.length,
          candidate_process_count: candidateIds.size,
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
      captureSessionId,
      stageName: "week3_document_pipeline",
      tsStart: started,
      tsEnd: new Date(),
      promptTemplateId: "document.extract",
      promptTemplateVersion: "1",
      toolCalls: {
        chunks: insertedChunks.length,
        candidate_process_ids: Array.from(candidateIds),
        systems: Array.from(systems),
        roles: Array.from(roleNames),
        parser: parsed.metadata.parser,
        parser_job_id: parsed.metadata.jobId,
        embedding_providers: Array.from(
          new Set(embeddings.map((embedding) => embedding.provider)),
        ),
        embedding_lexical_fallback_count: embeddings.filter(
          (embedding) => embedding.lexicalFallback,
        ).length,
      },
      model: parsed.metadata.parser,
      tokenCountInput: Math.ceil(parsed.text.length / 4),
      tokenCountOutput: evidenceIds.length,
      costCents: 0,
      latencyMs: Date.now() - started.getTime(),
      cacheHit: false,
      degradedQuality: false,
    });

    return {
      ok: true as const,
      artifact_id: artifact.id,
      capture_session_id: captureSessionId,
      chunk_ids: insertedChunks.map((chunk) => chunk.id),
      evidence_ids: evidenceIds,
      candidate_process_ids: Array.from(candidateIds),
    };
  } catch (error) {
    await markArtifactFailed({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      artifactId: artifact.id,
      userId: actorUserId,
      idempotencyKey: input.idempotencyKey,
      error,
    });
    await writeAgentDecision({
      orgId: artifact.orgId,
      workspaceId: artifact.workspaceId,
      captureSessionId,
      stageName: "week3_document_pipeline.failed",
      tsStart: started,
      tsEnd: new Date(),
      promptTemplateId: "document.extract",
      promptTemplateVersion: "1",
      toolCalls: {
        artifact_id: artifact.id,
        error: error instanceof Error ? error.message : "Unknown document error",
      },
      model: "document-pipeline",
      tokenCountInput: 0,
      tokenCountOutput: 0,
      costCents: 0,
      latencyMs: Date.now() - started.getTime(),
      cacheHit: false,
      degradedQuality: true,
    });
    throw error;
  }
}

async function existingDocumentPipelineResult(
  orgId: string,
  artifactId: string,
  captureSessionId: string,
  artifactStatus: string,
) {
  if (artifactStatus !== "ready") return null;
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    const chunks = await tx
      .select({ id: documentChunks.id })
      .from(documentChunks)
      .where(
        and(eq(documentChunks.orgId, orgId), eq(documentChunks.artifactId, artifactId)),
      );
    const chunkIds = chunks.map((chunk) => chunk.id);
    if (chunkIds.length === 0) {
      return { chunkIds, evidenceIds: [] as string[], candidateProcessIds: [] as string[] };
    }
    const evidenceRows = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM evidence
      WHERE org_id = ${orgId}
        AND source_type = 'document_chunk'
        AND source_id = ANY(${uuidArraySql(chunkIds)})
    `);
    const evidenceIds = evidenceRows.rows.map((row) => row.id);
    const candidateRows =
      evidenceIds.length === 0
        ? { rows: [] as { id: string }[] }
        : await tx.execute<{ id: string }>(sql`
            SELECT id
            FROM candidate_processes
            WHERE org_id = ${orgId}
              AND capture_session_id = ${captureSessionId}
              AND evidence_ids && ${uuidArraySql(evidenceIds)}
          `);
    return {
      chunkIds,
      evidenceIds,
      candidateProcessIds: candidateRows.rows.map((row) => row.id),
    };
  });
  if (result.chunkIds.length === 0) return null;
  return {
    ok: true as const,
    replayed: true,
    artifact_id: artifactId,
    capture_session_id: captureSessionId,
    chunk_ids: result.chunkIds,
    evidence_ids: result.evidenceIds,
    candidate_process_ids: result.candidateProcessIds,
  };
}

async function getOrCreateDocumentEvidence(input: {
  orgId: string;
  workspaceId: string;
  documentChunkId: string;
  quote: string;
  spanStart: number;
  spanEnd: number;
  confidence: number;
}) {
  const existing = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return (
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
  });
  if (existing) return existing;
  return createDocumentEvidence(input);
}

async function firstOrgUserId(orgId: string) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.orgId, orgId))
      .limit(1);
  });
  return rows[0]?.id;
}

export function chunkDocument(
  text: string,
  targetChars?: number,
  overlapChars?: number,
): DocumentChunk[] {
  return chunkDocumentInternal(text, targetChars, overlapChars);
}

async function extractDocumentInventory(text: string) {
  const fallback = heuristicDocumentExtraction(text);
  const result = await structured<DocumentInventoryExtraction>({
    prompt_template_id: "document.extract-claims",
    prompt_template_version: "1",
    schema_name: "document-inventory-extraction",
    schema: documentInventoryExtractionSchema,
    static_input: buildDocumentExtractionStaticInput(),
    input: text,
    mock: fallback,
  });
  return result.value.candidate_processes
    .map((candidate) => ({
      processName: normalizeProcessName(candidate.proposed_name),
      ownerRole: normalizeRoleName(candidate.roles[0] ?? candidate.proposed_function),
      frequency: normalizeSignalText(candidate.frequency),
      systems: uniqueNormalized(candidate.systems ?? [], normalizeSystemName),
      painPoints: uniqueNormalized(candidate.pain_points ?? [], normalizeSignalText),
      risks: uniqueNormalized(candidate.risks ?? [], normalizeSignalText),
      complexityHint: normalizeSignalText(candidate.complexity_hint),
    }))
    .filter((candidate) => candidate.processName);
}

export function buildDocumentExtractionStaticInput() {
  return [
    "Extract director-layer process inventory from this document chunk.",
    "Return only evidence-backed candidates, systems, roles, pain points, and risks.",
    "Return only valid JSON matching the document inventory extraction schema.",
    documentExtractionStaticContract,
  ].join("\n\n");
}

const documentExtractionStaticContract = `
Document inventory JSON schema:
{
  "type": "object",
  "required": ["candidate_processes"],
  "properties": {
    "candidate_processes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["proposed_name", "confidence"],
        "properties": {
          "proposed_name": {"type": "string", "description": "Director-layer process or workflow name."},
          "proposed_function": {"type": "string", "description": "Business function, owner role, or department."},
          "frequency": {"type": "string", "description": "Cadence such as daily, weekly, monthly, or volume phrase."},
          "complexity_hint": {"type": "string", "description": "Manual handoffs, exception handling, fragmented systems, or unclear ownership."},
          "systems": {"type": "array", "items": {"type": "string"}},
          "roles": {"type": "array", "items": {"type": "string"}},
          "pain_points": {"type": "array", "items": {"type": "string"}},
          "risks": {"type": "array", "items": {"type": "string"}},
          "confidence": {"type": "number", "minimum": 0, "maximum": 1}
        }
      }
    }
  }
}
Extraction rules:
- Extract only process inventory evidence stated in the chunk.
- A candidate process should be a business workflow, operating process, approval process, intake process, reconciliation process, reporting process, or documented SOP.
- Systems include named SaaS tools, ERPs, CRMs, spreadsheets, shared drives, ticket queues, chat tools, data warehouses, and shadow systems.
- Roles include accountable owners, participating teams, approval roles, handoff targets, and named job titles.
- Pain points include manual cleanup, duplicate entry, approval delays, rework, unclear ownership, fragmented spreadsheets, missing data, and exception routing.
- Risks include single points of failure, one-person dependencies, tribal knowledge, compliance exposure, audit gaps, source-of-truth ambiguity, and fragile workarounds.
- If evidence is thin, return fewer candidates with lower confidence; do not fill gaps.
- Do not infer systems or roles from generic words unless a named system or explicit team appears.
- Preserve source wording as much as possible.
- Return JSON only. Do not include prose, markdown, comments, or citations outside the JSON.
`.repeat(5);

function heuristicDocumentExtraction(text: string): DocumentInventoryExtraction {
  const sections = text
    .split(/(?=^Process:\s*)/gim)
    .map((section) => section.trim())
    .filter(Boolean);
  if (sections.length > 1) {
    const candidateProcesses = sections
      .map(extractHeuristicCandidate)
      .filter((candidate): candidate is DocumentInventoryExtraction["candidate_processes"][number] =>
        Boolean(candidate),
      );
    if (candidateProcesses.length > 0) {
      return { candidate_processes: candidateProcesses };
    }
  }
  const candidate = extractHeuristicCandidate(text);
  return { candidate_processes: candidate ? [candidate] : [] };
}

function extractHeuristicCandidate(
  text: string,
): DocumentInventoryExtraction["candidate_processes"][number] | null {
  const processName =
    firstMatch(text, /Process:\s*([^\n.]+)/i) ??
    firstMatch(text, /(?:workflow|process)\s+(?:for|called|named)\s+([^.\n]+)/i);
  const ownerRole = firstMatch(text, /(?:Owner|Accountable role):\s*([^\n.]+)/i);
  const systems =
    extractList(text, /Systems:\s*([^\n.]+)/i).length > 0
      ? extractList(text, /Systems:\s*([^\n.]+)/i)
      : extractKnownSystems(text);
  if (!processName && systems.length === 0) {
    return null;
  }
  return {
    proposed_name: processName ?? "Documented Operational Process",
    proposed_function: ownerRole,
    frequency: firstMatch(text, /Frequency:\s*([^\n.]+)/i),
    systems,
    roles: ownerRole ? [ownerRole] : [],
    pain_points: [
      firstMatch(text, /Pain points?:\s*([^\n.]+)/i) ??
        (/manual|delay|cleanup|rework/i.test(text) ? text : undefined),
    ].filter(Boolean) as string[],
    risks: [
      firstMatch(text, /Risk:\s*([^\n.]+)/i) ??
        (/only one|single point|depends on/i.test(text) ? text : undefined),
    ].filter(Boolean) as string[],
    complexity_hint: /manual|delay|exception|spreadsheet/i.test(text)
      ? "manual work, delays, or exception rules documented"
      : undefined,
    confidence: 0.72,
  };
}

function firstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.trim();
}

function extractList(text: string, pattern: RegExp) {
  const value = firstMatch(text, pattern);
  return value
    ? value
        .split(/,|;|\band\b/i)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function extractKnownSystems(text: string) {
  return [
    "Salesforce",
    "NetSuite",
    "Workday",
    "ServiceNow",
    "Slack",
    "Excel",
    "Google Sheets",
    "Zendesk",
    "Jira",
    "Asana",
    "HubSpot",
  ].filter((system) => new RegExp(`\\b${system.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

async function markArtifactStatus(
  orgId: string,
  artifactId: string,
  status: "processing" | "ready" | "failed",
) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    await tx
      .update(artifacts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.orgId, orgId)));
  });
}

async function markArtifactFailed(input: {
  orgId: string;
  workspaceId: string;
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
      eventType: "artifact.failed",
      subjectType: "artifact",
      subjectId: input.artifactId,
      metadataJson: {
        message,
        idempotency_key: input.idempotencyKey,
      },
    });
  });
}
