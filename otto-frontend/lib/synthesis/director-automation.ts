import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import {
  StructuredOutputError,
  preflightAnthropicModelForPrompt,
  structured,
  type Generation,
} from "@/lib/adapters/llm";
import { anthropicModelForPrompt } from "@/lib/ai/models";
import { getDb, setOrgContext } from "@/lib/db/client";
import {
  agentDecisionLog,
  auditLog,
  directorAutomationPlans,
  synthesisRuns,
  synthesisStageOutputs,
} from "@/lib/db/schema";
import { writeAgentDecision } from "@/lib/db/write-agent-decision";
import { getServerEnv } from "@/lib/env";
import {
  DIRECTOR_AUTOMATION_PATTERN_CATALOG,
  DIRECTOR_AUTOMATION_PROMPT_ID,
  DIRECTOR_AUTOMATION_PROMPT_VERSION,
  directorAutomationAnthropicToolSchema,
  directorAutomationExtractionSchema,
  directorAutomationPlanHash,
  directorAutomationPlanPayloadSchema,
  type DirectorAutomationPlanPayload,
} from "@/lib/processes/director-automation-schema";
import { assertNoForbiddenOpportunityKeys, stableHash } from "@/lib/processes/opportunity-schema";
import {
  loadCandidateInventory,
  type CandidateInventoryRow,
} from "@/lib/synthesis/inventory";

export type DirectorAutomationPlanRunResult =
  | {
      ok: true;
      synthesis_run_id: string;
      director_automation_plan_id: string;
      reused: boolean;
    }
  | {
      ok: false;
      synthesis_run_id: string;
      reason: string;
    };

type DirectorAutomationExtraction = {
  plan: DirectorAutomationPlanPayload;
  diagnostics: Array<{ code: string; message: string }>;
  metadata: Generation;
  promptTemplateId: string;
  promptTemplateVersion: string;
  modelId: string;
  llmRequestHash: string;
  llmResponseHash: string;
  inventoryHash: string;
  planInputHash: string;
};

type DirectorAutomationPromptContext = {
  promptTemplateId: string;
  promptTemplateVersion: string;
  modelId: string;
  staticInput: string;
  promptInput: string;
  inventoryHash: string;
  planInputHash: string;
};

const stageName = "stage-11-director-automation-plan";
const stageVersions = { [stageName]: 1 };

export type DirectorAutomationPlanRecord = {
  id: string;
  orgId: string;
  workspaceId: string;
  synthesisRunId: string | null;
  sourceCaptureSessionIds: string[];
  planJson: DirectorAutomationPlanPayload;
  createdAt: Date;
  updatedAt: Date;
};

export type DirectorAutomationPlanStatus = {
  run_state: "none" | "pending" | "running" | "completed" | "failed";
  has_completed_plan: boolean;
  updated_at: Date | null;
};

export async function runDirectorAutomationPlan(input: {
  orgId: string;
  workspaceId: string;
  captureSessionIds: string[];
  userId?: string | null;
  idempotencyKey?: string | null;
  mock?: unknown;
}): Promise<DirectorAutomationPlanRunResult> {
  const env = getServerEnv();
  const run = await createDirectorAutomationRun(input);
  if (!env.DIRECTOR_AUTOMATION_PLAN_GENERATION_ENABLED) {
    await completeRunWithoutPlan({
      ...input,
      synthesisRunId: run.id,
      reason: "director_automation_plan_generation_disabled",
    });
    return {
      ok: false,
      synthesis_run_id: run.id,
      reason: "director_automation_plan_generation_disabled",
    };
  }

  try {
    const candidates = await loadCandidateInventory(
      input.orgId,
      input.workspaceId,
      input.captureSessionIds,
    );
    if (candidates.length === 0) {
      await completeRunWithoutPlan({
        ...input,
        synthesisRunId: run.id,
        reason: "no_candidate_inventory",
      });
      return { ok: false, synthesis_run_id: run.id, reason: "no_candidate_inventory" };
    }

    const promptContext = await buildDirectorAutomationPromptContext({
      ...input,
      candidates,
    });
    const existing = await loadCompletedDirectorAutomationPlanForInputHash({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      planInputHash: promptContext.planInputHash,
    });
    if (existing) {
      await recordDirectorAutomationStage({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        synthesisRunId: run.id,
        inputRowRefs: input.captureSessionIds.map((id) => ({
          table: "capture_sessions",
          id,
        })),
        outputRowRefs: [{ table: "director_automation_plans", id: existing.id }],
        status: "skipped",
        errorJson: { reason: "unchanged_plan_input_hash" },
      });
      await markRunCompleted(input.orgId, run.id);
      return {
        ok: true,
        synthesis_run_id: run.id,
        director_automation_plan_id: existing.id,
        reused: true,
      };
    }

    const extraction = await extractDirectorAutomationPlan({
      ...input,
      promptContext,
      mock: input.mock,
    });
    const plan = await persistCompletedDirectorAutomationPlan({
      ...input,
      synthesisRunId: run.id,
      extraction,
    });
    return {
      ok: true,
      synthesis_run_id: run.id,
      director_automation_plan_id: plan.id,
      reused: false,
    };
  } catch (error) {
    await markRunFailed({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: run.id,
      message: error instanceof Error ? error.message : "Director automation plan failed.",
    });
    return {
      ok: false,
      synthesis_run_id: run.id,
      reason:
        error instanceof StructuredOutputError
          ? "structured_output_error"
          : "director_automation_plan_failed",
    };
  }
}

async function buildDirectorAutomationPromptContext(input: {
  orgId: string;
  workspaceId: string;
  captureSessionIds: string[];
  candidates: CandidateInventoryRow[];
}): Promise<DirectorAutomationPromptContext> {
  const promptTemplateId = DIRECTOR_AUTOMATION_PROMPT_ID;
  const promptTemplateVersion = DIRECTOR_AUTOMATION_PROMPT_VERSION;
  const preflightModelId = await preflightAnthropicModelForPrompt(promptTemplateId);
  const env = getServerEnv();
  const modelId =
    preflightModelId || anthropicModelForPrompt(env, promptTemplateId);
  const inventory = directorAutomationInventoryToPrompt(input.candidates);
  const inventoryHash = stableHash({
    workspaceId: input.workspaceId,
    captureSessionIds: input.captureSessionIds,
    inventory,
  });
  const staticInput = directorAutomationStaticInput();
  const promptInput = JSON.stringify(
    {
      workspace_id: input.workspaceId,
      capture_session_ids: input.captureSessionIds,
      inventory,
      pattern_catalog: DIRECTOR_AUTOMATION_PATTERN_CATALOG,
    },
    null,
    2,
  );
  const planInputHash = stableHash({
    promptTemplateId,
    promptTemplateVersion,
    modelId,
    inventory,
  });
  return {
    promptTemplateId,
    promptTemplateVersion,
    modelId,
    staticInput,
    promptInput,
    inventoryHash,
    planInputHash,
  };
}

async function extractDirectorAutomationPlan(input: {
  promptContext: DirectorAutomationPromptContext;
  mock?: unknown;
}): Promise<DirectorAutomationExtraction> {
  const context = input.promptContext;
  const { value, metadata } = await structured({
    prompt_template_id: context.promptTemplateId,
    prompt_template_version: context.promptTemplateVersion,
    schema_name: "DirectorAutomationPlan",
    schema: directorAutomationExtractionSchema,
    static_input: context.staticInput,
    input: context.promptInput,
    anthropic_tool: {
      name: "emit_director_automation_plan",
      description:
        "Emit a director-level automation plan with operational ranges and no dollar values.",
      input_schema: directorAutomationAnthropicToolSchema,
      strict: true,
    },
    mock: input.mock,
  });
  assertNoForbiddenOpportunityKeys(value);
  const plan = {
    department_name: value.department_name,
    audit: value.audit,
    processes: value.processes,
  };
  return {
    plan,
    diagnostics: value.diagnostics,
    metadata,
    promptTemplateId: context.promptTemplateId,
    promptTemplateVersion: context.promptTemplateVersion,
    modelId: context.modelId,
    llmRequestHash: stableHash({
      staticInput: context.staticInput,
      promptInput: context.promptInput,
    }),
    llmResponseHash: stableHash(value),
    inventoryHash: context.inventoryHash,
    planInputHash: context.planInputHash,
  };
}

function directorAutomationInventoryToPrompt(candidates: CandidateInventoryRow[]) {
  return candidates.map((candidate) => ({
    candidate_process_id: candidate.id,
    process_name: candidate.proposed_name,
    function: candidate.proposed_function,
    frequency: candidate.frequency,
    complexity_hint: candidate.complexity_hint,
    systems: candidate.system_names ?? [],
    roles: candidate.role_names ?? [],
    pain_points: normalizeSignals(candidate.pain_points),
    risks: normalizeSignals(candidate.risks),
    evidence_ids: candidate.evidence_ids ?? [],
    documented_evidence_count: candidate.documented_evidence_count,
  }));
}

function normalizeSignals(
  signals: Array<{ text?: string; evidence_ids?: string[] }> | null | undefined,
) {
  return (signals ?? [])
    .map((signal) => ({
      text: signal.text?.trim() ?? "",
      evidence_ids: signal.evidence_ids ?? [],
    }))
    .filter((signal) => signal.text.length > 0);
}

function directorAutomationStaticInput() {
  return [
    "You are Otto's director-level automation strategist.",
    "Return an executive automation plan for the department based on director interview inventory evidence.",
    "Write audit.problem as the core department operating problem.",
    "Write at least 3 audit.patterns with metric_basis and evidence_ids where available.",
    "For each process, implementation_plan must describe how automation agent(s) work: triggers, inputs, systems, controls, exception handling, and human review.",
    "For each process, expected_result must describe business impact using cycle-time, hours, error, exception, SLA, capacity, or working-capital metrics.",
    "Estimate operational assumptions only as low/base/high ranges: annual_volume, minutes_saved_per_case, error_rate, exception_rate.",
    "If an assumption is inferred, set confidence <= 0.45.",
    "Never output dollars, savings, net_score, gross_value, annual_*_value, hourly costs, prices, or currency fields.",
    "Prefer fewer high-confidence processes over broad weak ideas. Max 12 processes.",
  ].join("\n");
}

async function createDirectorAutomationRun(input: {
  orgId: string;
  workspaceId: string;
  captureSessionIds: string[];
}) {
  return getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return (
      await tx
        .insert(synthesisRuns)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          captureSessionIds: input.captureSessionIds,
          runType: "director_automation_plan",
          status: "running",
          stage: stageName,
          stageVersions,
        })
        .returning()
    )[0];
  });
}

async function loadCompletedDirectorAutomationPlanForInputHash(input: {
  orgId: string;
  workspaceId: string;
  planInputHash: string;
}) {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx.execute<{ id: string }>(sql`
      SELECT id
      FROM director_automation_plans
      WHERE org_id = ${input.orgId}
        AND workspace_id = ${input.workspaceId}
        AND plan_input_hash = ${input.planInputHash}
      LIMIT 1
    `);
  });
  return result.rows[0] ?? null;
}

export async function loadLatestDirectorAutomationPlan(input: {
  orgId: string;
  workspaceId: string;
  captureSessionId?: string | null;
}): Promise<DirectorAutomationPlanRecord | null> {
  const rows = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    return tx
      .select()
      .from(directorAutomationPlans)
      .where(
        and(
          eq(directorAutomationPlans.orgId, input.orgId),
          eq(directorAutomationPlans.workspaceId, input.workspaceId),
          input.captureSessionId
            ? sql`${directorAutomationPlans.sourceCaptureSessionIds} @> ARRAY[${input.captureSessionId}]::uuid[]`
            : undefined,
        ),
      )
      .orderBy(
        desc(directorAutomationPlans.updatedAt),
        desc(directorAutomationPlans.createdAt),
      )
      .limit(1);
  });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    synthesisRunId: row.synthesisRunId,
    sourceCaptureSessionIds: row.sourceCaptureSessionIds,
    planJson: directorAutomationPlanPayloadSchema.parse(row.planJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getDirectorAutomationPlanStatus(input: {
  orgId: string;
  workspaceId: string;
  captureSessionId?: string | null;
  completedPlan?: DirectorAutomationPlanRecord | null;
}): Promise<DirectorAutomationPlanStatus> {
  const [plan, runs] = await Promise.all([
    input.completedPlan === undefined
      ? loadLatestDirectorAutomationPlan(input)
      : Promise.resolve(input.completedPlan),
    getDb().transaction(async (tx) => {
      await setOrgContext(tx, input.orgId);
      return tx
        .select({
          status: synthesisRuns.status,
          updatedAt: synthesisRuns.updatedAt,
          createdAt: synthesisRuns.createdAt,
        })
        .from(synthesisRuns)
        .where(
          and(
            eq(synthesisRuns.orgId, input.orgId),
            eq(synthesisRuns.workspaceId, input.workspaceId),
            eq(synthesisRuns.runType, "director_automation_plan"),
            input.captureSessionId
              ? sql`${synthesisRuns.captureSessionIds} @> ARRAY[${input.captureSessionId}]::uuid[]`
              : undefined,
          ),
        )
        .orderBy(desc(synthesisRuns.updatedAt), desc(synthesisRuns.createdAt))
        .limit(1);
    }),
  ]);
  const latestRun = runs[0] ?? null;
  return {
    run_state: normalizeDirectorAutomationRunState(latestRun?.status ?? null),
    has_completed_plan: Boolean(plan),
    updated_at: latestRun?.updatedAt ?? plan?.updatedAt ?? null,
  };
}

function normalizeDirectorAutomationRunState(
  status: string | null,
): DirectorAutomationPlanStatus["run_state"] {
  if (status === "queued") return "pending";
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  if (status === "partial_synthesis") return "running";
  return "none";
}

async function persistCompletedDirectorAutomationPlan(input: {
  orgId: string;
  workspaceId: string;
  captureSessionIds: string[];
  synthesisRunId: string;
  userId?: string | null;
  extraction: DirectorAutomationExtraction;
}) {
  const planHash = directorAutomationPlanHash(input.extraction.plan);
  const inserted = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    const row = (
      await tx
        .insert(directorAutomationPlans)
        .values({
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          synthesisRunId: input.synthesisRunId,
          sourceCaptureSessionIds: input.captureSessionIds,
          inventoryHash: input.extraction.inventoryHash,
          planInputHash: input.extraction.planInputHash,
          planHash,
          promptTemplateId: input.extraction.promptTemplateId,
          promptTemplateVersion: input.extraction.promptTemplateVersion,
          model: input.extraction.modelId,
          llmRequestHash: input.extraction.llmRequestHash,
          llmResponseHash: input.extraction.llmResponseHash,
          generator: "director-agent",
          generatorVersion: 1,
          planJson: input.extraction.plan,
          diagnosticsJson: input.extraction.diagnostics,
        })
        .onConflictDoNothing({
          target: [
            directorAutomationPlans.workspaceId,
            directorAutomationPlans.planInputHash,
          ],
        })
        .returning()
    )[0];
    const plan =
      row ??
      (
        await tx
          .select()
          .from(directorAutomationPlans)
          .where(sql`
            org_id = ${input.orgId}
            AND workspace_id = ${input.workspaceId}
            AND plan_input_hash = ${input.extraction.planInputHash}
          `)
          .limit(1)
      )[0];
    if (!plan) throw new Error("Failed to persist director automation plan.");
    await tx.insert(auditLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      eventType: "synthesis.director_automation_plan.generated",
      subjectType: "director_automation_plan",
      subjectId: plan.id,
      metadataJson: {
        capture_session_ids: input.captureSessionIds,
        synthesis_run_id: input.synthesisRunId,
        inventory_hash: input.extraction.inventoryHash,
        plan_input_hash: input.extraction.planInputHash,
        plan_hash: planHash,
        process_count: input.extraction.plan.processes.length,
      },
    });
    await tx.insert(agentDecisionLog).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName,
      tsStart: new Date(Date.now() - Math.max(1, input.extraction.metadata.latency_ms)),
      tsEnd: new Date(),
      promptTemplateId: input.extraction.promptTemplateId,
      promptTemplateVersion: input.extraction.promptTemplateVersion,
      model: input.extraction.modelId,
      tokenCountInput: input.extraction.metadata.token_count_input,
      tokenCountOutput: input.extraction.metadata.token_count_output,
      costCents: String(input.extraction.metadata.cost_cents),
      latencyMs: input.extraction.metadata.latency_ms,
      cacheHit: input.extraction.metadata.cache_hit,
      degradedQuality: input.extraction.plan.processes.length === 0,
      degradedReasons:
        input.extraction.plan.processes.length === 0 ? ["no_processes"] : [],
      deliveryJson: {
        director_automation_plan_id: plan.id,
        diagnostics: input.extraction.diagnostics,
      },
    });
    await tx.insert(synthesisStageOutputs).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName,
      inputRowRefs: input.captureSessionIds.map((id) => ({
        table: "capture_sessions",
        id,
      })),
      outputRowRefs: [{ table: "director_automation_plans", id: plan.id }],
      status: "completed",
    });
    await tx
      .update(synthesisRuns)
      .set({ status: "completed", stage: stageName, updatedAt: new Date() })
      .where(eq(synthesisRuns.id, input.synthesisRunId));
    return plan;
  });
  return inserted;
}

async function recordDirectorAutomationStage(input: {
  orgId: string;
  workspaceId: string;
  synthesisRunId: string;
  inputRowRefs: unknown[];
  outputRowRefs: unknown[];
  status: "completed" | "failed" | "skipped";
  errorJson?: unknown;
}) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx.insert(synthesisStageOutputs).values({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      synthesisRunId: input.synthesisRunId,
      stageName,
      inputRowRefs: input.inputRowRefs,
      outputRowRefs: input.outputRowRefs,
      status: input.status,
      errorJson: input.errorJson,
    });
    await tx
      .update(synthesisRuns)
      .set({ stage: stageName, updatedAt: new Date() })
      .where(eq(synthesisRuns.id, input.synthesisRunId));
  });
}

async function completeRunWithoutPlan(input: {
  orgId: string;
  workspaceId: string;
  captureSessionIds: string[];
  synthesisRunId: string;
  reason: string;
}) {
  await recordDirectorAutomationStage({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    synthesisRunId: input.synthesisRunId,
    inputRowRefs: input.captureSessionIds.map((id) => ({
      table: "capture_sessions",
      id,
    })),
    outputRowRefs: [],
    status: "skipped",
    errorJson: { reason: input.reason },
  });
  await markRunCompleted(input.orgId, input.synthesisRunId);
}

async function markRunCompleted(orgId: string, synthesisRunId: string) {
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    await tx
      .update(synthesisRuns)
      .set({ status: "completed", stage: stageName, updatedAt: new Date() })
      .where(eq(synthesisRuns.id, synthesisRunId));
  });
}

async function markRunFailed(input: {
  orgId: string;
  workspaceId: string;
  synthesisRunId: string;
  message: string;
}) {
  await recordDirectorAutomationStage({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    synthesisRunId: input.synthesisRunId,
    inputRowRefs: [],
    outputRowRefs: [],
    status: "failed",
    errorJson: { message: input.message },
  });
  await getDb().transaction(async (tx) => {
    await setOrgContext(tx, input.orgId);
    await tx
      .update(synthesisRuns)
      .set({
        status: "failed",
        stage: stageName,
        errorJson: { message: input.message },
        updatedAt: new Date(),
      })
      .where(eq(synthesisRuns.id, input.synthesisRunId));
  });
  await writeAgentDecision({
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    synthesisRunId: input.synthesisRunId,
    stageName: `${stageName}.failed`,
    tsStart: new Date(),
    tsEnd: new Date(),
    promptTemplateId: DIRECTOR_AUTOMATION_PROMPT_ID,
    promptTemplateVersion: DIRECTOR_AUTOMATION_PROMPT_VERSION,
    toolCalls: { error: input.message },
    degradedQuality: true,
  });
}
