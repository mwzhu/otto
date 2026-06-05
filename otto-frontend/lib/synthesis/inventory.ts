import "server-only";

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import {
  auditLog,
  synthesisRuns,
  synthesisStageOutputs,
  users,
} from "@/lib/db/schema";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { writeClaim } from "@/lib/db/write-claim";
import { stableStringify } from "@/lib/http/json";
import { computeComplexityScore, type ComplexityScore } from "@/lib/synthesis/complexity";
import { generateCandidateNarrative, type CandidateNarrative } from "@/lib/synthesis/narrative";

export type InventorySynthesisInput = {
  orgId: string;
  workspaceId: string;
  captureSessionIds: string[];
  runType?: "document_inventory" | "director_inventory" | "combined_inventory";
  userId?: string;
  idempotencyKey?: string;
};

export type CandidateInventoryRow = {
  id: string;
  proposed_name: string;
  proposed_function: string | null;
  frequency: string | null;
  complexity_hint: string | null;
  evidence_ids: string[] | null;
  system_names: string[] | null;
  role_names: string[] | null;
  pain_points: Array<{ text?: string; evidence_ids?: string[] }> | null;
  risks: Array<{ text?: string; evidence_ids?: string[] }> | null;
  documented_evidence_count: number;
};

const genericCandidateProcessNames = [
  "a couple different things",
  "couple different things",
  "different things",
  "a few things",
  "several things",
  "some things",
  "multiple things",
  "things",
] as const;

export async function runInventorySynthesis(input: InventorySynthesisInput) {
  const actorUserId = input.userId ?? (await firstOrgUserId(input.orgId));
  if (!actorUserId) {
    throw new Error("Inventory synthesis requires an org user for generated claim audit writes.");
  }
  const started = new Date();
  const run = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const row = (
      await tx
        .insert(synthesisRuns)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          captureSessionIds: input.captureSessionIds,
          runType: input.runType ?? "combined_inventory",
          status: "running",
          stage: "stage-1-document-extraction",
          stageVersions: phase1StageVersions,
        })
        .returning()
    )[0];
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: actorUserId,
      eventType: "synthesis.inventory.started",
      subjectType: "synthesis_run",
      subjectId: row.id,
      metadataJson: {
        capture_session_ids: input.captureSessionIds,
        run_type: input.runType ?? "combined_inventory",
        idempotency_key: input.idempotencyKey,
      },
    });
    return row;
  });

  try {
    const candidates = await loadCandidateInventory(input.orgId, input.workspaceId, input.captureSessionIds);
    await recordStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "stage-1-document-extraction",
      inputRowRefs: input.captureSessionIds.map((id) => ({ table: "capture_sessions", id })),
      outputRowRefs: candidates.map((row) => ({ table: "candidate_processes", id: row.id })),
      status: "completed",
    });

    await recordStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "stage-2-process-inventory",
      inputRowRefs: input.captureSessionIds.map((id) => ({ table: "capture_sessions", id })),
      outputRowRefs: candidates.map((row) => ({ table: "candidate_processes", id: row.id })),
      status: "completed",
    });

    const ontologyRefs = await normalizeOntology(input.orgId, input.workspaceId, candidates);
    await recordStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "stage-4-ontology-normalization",
      inputRowRefs: candidates.map((row) => ({ table: "candidate_processes", id: row.id })),
      outputRowRefs: ontologyRefs,
      status: "completed",
    });

    const scored = await scoreCandidates({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: actorUserId,
      candidates,
      synthesisRunId: run.id,
    });
    await recordStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "stage-8-complexity-scoring",
      inputRowRefs: candidates.map((row) => ({ table: "candidate_processes", id: row.id })),
      outputRowRefs: scored.map((row) => ({
        table: "claims",
        candidate_process_id: row.candidateId,
        field: "complexity_score",
      })),
      status: "completed",
    });

    const narrated = await narrateCandidates({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: actorUserId,
      candidates,
      scores: scored,
      synthesisRunId: run.id,
    });
    await recordStage({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "stage-10-narrative-generation",
      inputRowRefs: scored.map((row) => ({
        table: "candidate_processes",
        id: row.candidateId,
      })),
      outputRowRefs: narrated.map((row) => ({
        table: "claims",
        candidate_process_id: row.candidateId,
        field: "narrative",
      })),
      status: "completed",
    });

    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
      await tx
        .update(synthesisRuns)
        .set({ status: "completed", stage: "publish-draft-inventory", updatedAt: new Date() })
        .where(eq(synthesisRuns.id, run.id));
      await tx.insert(auditLog).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: actorUserId,
        eventType: "synthesis.inventory.completed",
        subjectType: "synthesis_run",
        subjectId: run.id,
        metadataJson: {
          candidate_count: candidates.length,
          idempotency_key: input.idempotencyKey,
        },
      });
    });

    await writeAgentDecision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "publish-draft-inventory",
      tsStart: started,
      tsEnd: new Date(),
      promptTemplateId: "synthesis.inventory.phase1",
      promptTemplateVersion: "1",
      toolCalls: { candidate_count: candidates.length },
      model: "deterministic-phase1-synthesis",
      tokenCountInput: candidates.length,
      tokenCountOutput: scored.length + narrated.length,
      costCents: 0,
      latencyMs: Date.now() - started.getTime(),
      cacheHit: false,
      degradedQuality: false,
    });

    return {
      ok: true as const,
      synthesis_run_id: run.id,
      candidate_process_ids: candidates.map((candidate) => candidate.id),
    };
  } catch (error) {
    await getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
      const message =
        error instanceof Error ? error.message : "Unknown synthesis error";
      await tx
        .update(synthesisRuns)
        .set({
          status: "failed",
          stage: "failed",
          errorJson: { message },
          updatedAt: new Date(),
        })
        .where(eq(synthesisRuns.id, run.id));
      await tx.insert(auditLog).values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        userId: actorUserId,
        eventType: "synthesis.inventory.failed",
        subjectType: "synthesis_run",
        subjectId: run.id,
        metadataJson: {
          message,
          capture_session_ids: input.captureSessionIds,
          idempotency_key: input.idempotencyKey,
        },
      });
    });
    await writeAgentDecision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      stageName: "synthesis.inventory.failed",
      tsStart: started,
      tsEnd: new Date(),
      promptTemplateId: "synthesis.inventory.phase1",
      promptTemplateVersion: "1",
      toolCalls: {
        error: error instanceof Error ? error.message : "Unknown synthesis error",
      },
      model: "deterministic-phase1-synthesis",
      tokenCountInput: input.captureSessionIds.length,
      tokenCountOutput: 0,
      costCents: 0,
      latencyMs: Date.now() - started.getTime(),
      cacheHit: false,
      degradedQuality: true,
    });
    throw error;
  }
}

export async function loadCandidateInventory(
  orgId: string,
  workspaceId: string,
  captureSessionIds: string[],
) {
  const captureSessionIdArray = uuidArraySql(captureSessionIds);
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<CandidateInventoryRow>(sql`
      WITH candidate_claims AS (
        SELECT
          c.id AS candidate_id,
          cl.id AS claim_id,
          cl.field,
          cl.value,
          COALESCE(jsonb_agg(ce.evidence_id) FILTER (WHERE ce.evidence_id IS NOT NULL), '[]'::jsonb) AS claim_evidence_ids
        FROM candidate_processes c
        LEFT JOIN claims cl
          ON cl.org_id = c.org_id
         AND cl.workspace_id = c.workspace_id
         AND cl.subject_type = 'candidate_process'
         AND cl.subject_id = c.id
         AND cl.status = 'active'
         AND cl.superseded_by_claim_id IS NULL
        LEFT JOIN claim_evidence ce ON ce.claim_id = cl.id
        WHERE c.org_id = ${orgId}
          AND c.workspace_id = ${workspaceId}
          AND c.capture_session_id = ANY(${captureSessionIdArray})
          AND c.status = 'pending'
          AND lower(c.proposed_name) NOT IN ${genericCandidateNamesSql()}
        GROUP BY c.id, cl.id, cl.field, cl.value
      )
      SELECT
        c.id,
        c.proposed_name,
        c.proposed_function,
        c.frequency,
        c.complexity_hint,
        c.evidence_ids,
        COALESCE(array_agg(DISTINCT s.name) FILTER (WHERE s.name IS NOT NULL), '{}') AS system_names,
        COALESCE(
          array_agg(DISTINCT COALESCE(r.name, claimed_role.name))
            FILTER (WHERE COALESCE(r.name, claimed_role.name) IS NOT NULL),
          '{}'
        ) AS role_names,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('text', cc.value->>'text', 'evidence_ids', cc.claim_evidence_ids))
            FILTER (WHERE cc.field = 'pain_point'),
          '[]'::jsonb
        ) AS pain_points,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('text', COALESCE(cc.value->>'text', cc.value::text), 'evidence_ids', cc.claim_evidence_ids))
            FILTER (WHERE cc.field = 'risk'),
          '[]'::jsonb
        ) AS risks,
        COUNT(DISTINCT e.id) FILTER (WHERE e.evidence_label = 'documented')::int AS documented_evidence_count
      FROM candidate_processes c
      LEFT JOIN claims sc
        ON sc.org_id = c.org_id
       AND sc.workspace_id = c.workspace_id
       AND sc.field = 'used_in_process'
       AND sc.status = 'active'
       AND sc.superseded_by_claim_id IS NULL
       AND sc.value->>'candidate_process_id' = c.id::text
      LEFT JOIN systems s ON s.id = sc.subject_id AND sc.subject_type = 'system'
      LEFT JOIN roles r ON r.id = c.proposed_owner_role_id
      LEFT JOIN claims rc
        ON rc.org_id = c.org_id
       AND rc.workspace_id = c.workspace_id
       AND rc.subject_type = 'role'
       AND rc.field = 'used_in_process'
       AND rc.status = 'active'
       AND rc.superseded_by_claim_id IS NULL
       AND rc.value->>'candidate_process_id' = c.id::text
      LEFT JOIN roles claimed_role ON claimed_role.id = rc.subject_id
      LEFT JOIN evidence e ON e.id = ANY(c.evidence_ids)
      LEFT JOIN candidate_claims cc ON cc.candidate_id = c.id
      WHERE c.org_id = ${orgId}
        AND c.workspace_id = ${workspaceId}
        AND c.capture_session_id = ANY(${captureSessionIdArray})
        AND c.status = 'pending'
        AND lower(c.proposed_name) NOT IN ${genericCandidateNamesSql()}
      GROUP BY c.id
      ORDER BY c.created_at ASC
    `);
  });
  return result.rows;
}

function genericCandidateNamesSql() {
  return sql`(${sql.join(
    genericCandidateProcessNames.map((name) => sql`${name}`),
    sql`, `,
  )})`;
}

async function normalizeOntology(
  orgId: string,
  workspaceId: string,
  candidates: CandidateInventoryRow[],
) {
  const refs: Array<{ table: string; id: string; term: string; type: string }> = [];
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    for (const candidate of candidates) {
      const terms = [
        ...unique(candidate.system_names ?? []).map((term) => ({ term, type: "system" })),
        ...unique([
          ...(candidate.role_names ?? []),
          ...(candidate.proposed_function ? [candidate.proposed_function] : []),
        ]).map((term) => ({ term, type: "role" })),
        { term: candidate.proposed_name, type: "process" },
      ];
      for (const item of terms) {
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO ontology_terms (
            org_id,
            term,
            type,
            definition,
            source_evidence_ids,
            confidence
          )
          SELECT
            ${orgId},
            ${item.term},
            ${item.type}::ontology_term_type,
            ${`Phase 1 ${item.type} term from inventory synthesis.`},
            ${uuidArraySql(candidate.evidence_ids ?? [])},
            0.78
          WHERE NOT EXISTS (
            SELECT 1 FROM ontology_terms
            WHERE org_id = ${orgId}
              AND lower(term) = lower(${item.term})
              AND type = ${item.type}::ontology_term_type
          )
          RETURNING id
        `);
        const existing =
          inserted.rows[0] ??
          (
            await tx.execute<{ id: string }>(sql`
              SELECT id FROM ontology_terms
              WHERE org_id = ${orgId}
                AND lower(term) = lower(${item.term})
                AND type = ${item.type}::ontology_term_type
              LIMIT 1
            `)
          ).rows[0];
        if (existing) refs.push({ table: "ontology_terms", id: existing.id, term: item.term, type: item.type });
      }
    }
    await tx.insert(auditLog).values({
      orgId,
      workspaceId,
      eventType: "synthesis.ontology.normalized",
      subjectType: "workspace",
      subjectId: workspaceId,
      metadataJson: { term_count: refs.length },
    });
  });
  return refs;
}

async function scoreCandidates(input: {
  orgId: string;
  workspaceId: string;
  userId: string;
  candidates: CandidateInventoryRow[];
  synthesisRunId: string;
}) {
  const outputs: Array<{ candidateId: string; score: ComplexityScore }> = [];
  for (const candidate of input.candidates) {
    const score = computeComplexityScore({
      systemCount: candidate.system_names?.length ?? 0,
      roleCount: unique([
        ...(candidate.role_names ?? []),
        ...(candidate.proposed_function ? [candidate.proposed_function] : []),
      ]).length,
      frequency: candidate.frequency,
      painPoints: normalizeSignals(candidate.pain_points),
      risks: normalizeSignals(candidate.risks),
      documentationEvidenceCount: candidate.documented_evidence_count,
      evidenceIds: candidate.evidence_ids ?? [],
    });
    await writeClaim({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      subject: { type: "candidate_process", id: candidate.id },
      field: "complexity_score",
      value: score,
      evidenceIds: candidate.evidence_ids ?? [],
      confidence: 0.82,
      idempotencyKey: claimKey("synthesis", candidate.id, "complexity_score", score),
      requestHash: hash(score),
      route: "synthesis/inventory/complexity",
      metadata: { synthesis_run_id: input.synthesisRunId, source: "phase1_synthesis" },
    });
    outputs.push({ candidateId: candidate.id, score });
  }
  return outputs;
}

async function narrateCandidates(input: {
  orgId: string;
  workspaceId: string;
  userId: string;
  candidates: CandidateInventoryRow[];
  scores: Array<{ candidateId: string; score: ComplexityScore }>;
  synthesisRunId: string;
}) {
  const scoresByCandidate = new Map(input.scores.map((row) => [row.candidateId, row.score]));
  const outputs: Array<{ candidateId: string; narrative: CandidateNarrative }> = [];
  for (const candidate of input.candidates) {
    const complexity = scoresByCandidate.get(candidate.id);
    if (!complexity) continue;
    const narrative = generateCandidateNarrative({
      name: candidate.proposed_name,
      functionName: candidate.proposed_function,
      frequency: candidate.frequency,
      systems: candidate.system_names ?? [],
      roles: unique([
        ...(candidate.role_names ?? []),
        ...(candidate.proposed_function ? [candidate.proposed_function] : []),
      ]),
      painPoints: normalizeSignals(candidate.pain_points).map((signal) => signal.text),
      risks: normalizeSignals(candidate.risks).map((signal) => signal.text),
      evidenceIds: candidate.evidence_ids ?? [],
      complexity,
    });
    await writeClaim({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      subject: { type: "candidate_process", id: candidate.id },
      field: "narrative",
      value: narrative,
      evidenceIds: candidate.evidence_ids ?? [],
      confidence: narrative.inferred ? 0.62 : 0.8,
      idempotencyKey: claimKey("synthesis", candidate.id, "narrative", narrative),
      requestHash: hash(narrative),
      route: "synthesis/inventory/narrative",
      metadata: { synthesis_run_id: input.synthesisRunId, source: "phase1_synthesis" },
    });
    outputs.push({ candidateId: candidate.id, narrative });
  }
  return outputs;
}

async function recordStage(input: {
  orgId: string;
  workspaceId: string;
  synthesisRunId: string;
  stageName: string;
  inputRowRefs: unknown[];
  outputRowRefs: unknown[];
  status: "completed" | "failed" | "skipped";
  errorJson?: unknown;
}) {
  const started = new Date();
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.insert(synthesisStageOutputs).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName: input.stageName,
      inputRowRefs: input.inputRowRefs,
      outputRowRefs: input.outputRowRefs,
      status: input.status,
      errorJson: input.errorJson,
    });
    await tx
      .update(synthesisRuns)
      .set({ stage: input.stageName, updatedAt: new Date() })
      .where(eq(synthesisRuns.id, input.synthesisRunId));
  });
  await writeAgentDecision({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    synthesisRunId: input.synthesisRunId,
    stageName: input.stageName,
    tsStart: started,
    tsEnd: new Date(),
    promptTemplateId: `synthesis.inventory.${input.stageName}`,
    promptTemplateVersion: "1",
    toolCalls: {
      input_row_count: input.inputRowRefs.length,
      output_row_count: input.outputRowRefs.length,
      status: input.status,
    },
    model: "deterministic-phase1-synthesis",
    tokenCountInput: input.inputRowRefs.length,
    tokenCountOutput: input.outputRowRefs.length,
    costCents: 0,
    latencyMs: Date.now() - started.getTime(),
    cacheHit: false,
    degradedQuality: input.status === "failed",
  });
}

async function firstOrgUserId(orgId: string) {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.select({ id: users.id }).from(users).where(eq(users.orgId, orgId)).limit(1);
  });
  return rows[0]?.id;
}

function normalizeSignals(
  signals: Array<{ text?: string; evidence_ids?: string[] }> | null | undefined,
) {
  return (signals ?? [])
    .map((signal) => ({
      text: cleanJsonText(signal.text),
      evidenceIds: signal.evidence_ids ?? [],
    }))
    .filter((signal) => signal.text.length > 0);
}

function cleanJsonText(text: string | undefined) {
  if (!text) return "";
  return text.replace(/^"|"$/g, "").trim();
}

function claimKey(prefix: string, subjectId: string, field: string, value: unknown) {
  return `${prefix}:${subjectId}:${field}:${createHash("sha1")
    .update(stableStringify(value))
    .digest("hex")}`;
}

function hash(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

const phase1StageVersions = {
  "stage-1-document-extraction": 1,
  "stage-2-process-inventory": 1,
  "stage-4-ontology-normalization": 1,
  "stage-8-complexity-scoring": 1,
  "stage-10-narrative-generation": 1,
};
