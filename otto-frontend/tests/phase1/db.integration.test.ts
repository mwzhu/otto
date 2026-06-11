import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

const root = process.cwd();
const image = "pgvector/pgvector:pg16";
const container = `otto-phase1-test-${process.pid}`;
const orgId = "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb";
const workspaceId = "cccccccc-cccc-5ccc-8ccc-cccccccccccc";
const directorCaptureId = "dddddddd-dddd-5ddd-8ddd-dddddddddddd";
const documentCaptureId = "eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee";
const artifactId = "ffffffff-ffff-5fff-8fff-ffffffffffff";
const candidateProcessId = "12121212-1212-5121-8121-121212121212";
const evidenceId = "34343434-3434-5343-8343-343434343434";
const week4CandidateId = "56565656-5656-5565-8565-565656565656";
const week4EvidenceAId = "78787878-7878-5787-8787-787878787878";
const week4EvidenceBId = "89898989-8989-5898-8989-898989898989";
const week4SystemId = "90909090-9090-5909-8909-909090909090";
const week4OwnerRoleId = "abababab-abab-5aba-8aba-abababababab";
const week4PersonRoleId = "bcbcbcbc-bcbc-5bcb-8bcb-bcbcbcbcbcbc";
const week4PersonId = "cdcdcdcd-cdcd-5cdc-8cdc-cdcdcdcdcdcd";
const week4SystemClaimId = "dededede-dede-5ded-8ded-dededededede";
const week4PersonClaimId = "efefefef-efef-5efe-8efe-efefefefefef";
const week4RiskClaimAId = "10101010-1010-5010-8010-101010101010";
const week4RiskClaimBId = "20202020-2020-5020-8020-202020202020";
const week4MergeCandidateId = "21212121-2121-5121-8121-212121212121";
const week4MergeEvidenceId = "23232323-2323-5232-8232-232323232323";
const week4MergeRiskClaimId = "24242424-2424-5242-8242-242424242424";
const week4MergeTargetProcessId = "25252525-2525-5252-8252-252525252525";
const week5FollowUpId = "30303030-3030-5030-8030-303030303030";
const week5SynthesisRunId = "40404040-4040-5040-8040-404040404040";
const week5TranscriptId = "50505050-5050-5050-8050-505050505050";
const week5TranscriptEvidenceId = "60606060-6060-5060-8060-606060606060";
const week5DegradedDecisionId = "70707070-7070-5070-8070-707070707070";
const week5SynthesisCandidateId = "81818181-8181-5181-8181-818181818181";
const week5SynthesisEvidenceId = "82828282-8282-5282-8282-828282828282";
const week5LocalCaptureId = "83838383-8383-5383-8383-838383838383";
const week5LocalArtifactId = "84848484-8484-5484-8484-848484848484";
const recoveredVerificationCaptureId = "85858585-8585-5585-8585-858585858585";
const recoveredVerificationDecisionId = "86868686-8686-5686-8686-868686868686";
const recoveredVerificationMarkerId = "87878787-8787-5787-8787-878787878787";
const asrVerificationCaptureId = "88888888-8888-5888-8888-888888888888";
const bareAsrTranscriptId = "89898989-8989-5898-8989-898989898990";
const livekitDeepgramTranscriptId = "90909090-9090-5909-8909-909090909091";
const livekitDeepgramTranscriptContinuationId = "94949494-9494-5949-8949-949494949494";
const ttsVerificationCaptureId = "91919191-9191-5919-8919-919191919191";
const bareTtsDecisionId = "92929292-9292-5929-8929-929292929292";
const livekitCartesiaDecisionId = "93939393-9393-5939-8939-939393939393";
const targetedClaimCaptureId = "96969696-9696-5969-8969-969696969696";
const hardRequiredToolCaptureId = "97979797-9797-5979-8979-979797979797";
const hardRequiredClaimCaptureId = "98989898-9898-5989-8989-989898989898";
const softMalformedClaimCaptureId = "9a9a9a9a-9a9a-5a9a-8a9a-9a9a9a9a9a9a";
const softMalformedClaimCandidateId = "9b9b9b9b-9b9b-5b9b-8b9b-9b9b9b9b9b9b";
const invalidSlotPathCaptureId = "9c9c9c9c-9c9c-5c9c-8c9c-9c9c9c9c9c9c";
const sanitizedDecisionCaptureId = "9d9d9d9d-9d9d-5d9d-8d9d-9d9d9d9d9d9d";
const sanitizedTranscriptMetadataCaptureId =
  "9d1d9d1d-9d1d-5d1d-8d1d-9d1d9d1d9d1d";
const mismatchedTurnIndexCaptureId = "9e9e9e9e-9e9e-5e9e-8e9e-9e9e9e9e9e9e";
const pendingOpeningResumeCaptureId = "9f9f9f9f-9f9f-5f9f-8f9f-9f9f9f9f9f9f";
const priorityCoverageCaptureId = "99999999-9999-5999-8999-999999999999";
const unknownDeliveryCompletionCaptureId = "a1a1a1a1-a1a1-5a1a-8a1a-a1a1a1a1a1a1";
const duplicateVendorAuditCaptureId = "a2a2a2a2-a2a2-5a2a-8a2a-a2a2a2a2a2a2";
const recentConversationContextCaptureId = "a3a3a3a3-a3a3-5a3a-8a3a-a3a3a3a3a3a3";
const recentConversationTranscriptId = "a4a4a4a4-a4a4-5a4a-8a4a-a4a4a4a4a4a4";
const recentConversationDecisionId = "a5a5a5a5-a5a5-5a5a-8a5a-a5a5a5a5a5a5";
const duplicateProcessCaptureId = "a6a6a6a6-a6a6-5a6a-8a6a-a6a6a6a6a6a6";
const duplicateProcessEvidenceAId = "a7a7a7a7-a7a7-5a7a-8a7a-a7a7a7a7a7a7";
const duplicateProcessEvidenceBId = "a8a8a8a8-a8a8-5a8a-8a8a-a8a8a8a8a8a8";
const duplicateCandidateVerificationCaptureId =
  "a9a9a9a9-a9a9-5a9a-8a9a-a9a9a9a9a9a9";
const duplicateCandidateVerificationIdA =
  "b1b1b1b1-b1b1-5b1b-8b1b-b1b1b1b1b1b1";
const duplicateCandidateVerificationIdB =
  "b2b2b2b2-b2b2-5b2b-8b2b-b2b2b2b2b2b2";
const missingTurnEvidenceCaptureId = "b3b3b3b3-b3b3-5b3b-8b3b-b3b3b3b3b3b3";
const missingTurnEvidenceDecisionId = "b4b4b4b4-b4b4-5b4b-8b4b-b4b4b4b4b4b4";
const badDeliveryFidelityCaptureId =
  "b5b5b5b5-b5b5-5b5b-8b5b-b5b5b5b5b5b5";
const badDeliveryFidelityTranscriptId =
  "b6b6b6b6-b6b6-5b6b-8b6b-b6b6b6b6b6b6";
const badDeliveryFidelityEvidenceId =
  "b7b7b7b7-b7b7-5b7b-8b7b-b7b7b7b7b7b7";
const badDeliveryFidelityDecisionId =
  "b8b8b8b8-b8b8-5b8b-8b8b-b8b8b8b8b8b8";
const badPromptFidelityCaptureId = "b9b9b9b9-b9b9-5b9b-8b9b-b9b9b9b9b9b9";
const badPromptFidelityDecisionId = "c1c1c1c1-c1c1-5c1c-8c1c-c1c1c1c1c1c1";
const badCompletionDeliveryFidelityCaptureId =
  "c2c2c2c2-c2c2-5c2c-8c2c-c2c2c2c2c2c2";
const staleBrowserCompletionCaptureId =
  "c0c0c0c0-c0c0-5c0c-8c0c-c0c0c0c0c0c0";
const staleBrowserCompletionDecisionId =
  "c9c9c9c9-c9c9-5c9c-8c9c-c9c9c9c9c9c9";
const completedTurnIngestCaptureId =
  "d0d0d0d0-d0d0-5d0d-8d0d-d0d0d0d0d0d0";
const completedInternalWriteCaptureId =
  "d1d1d1d1-d1d1-5d1d-8d1d-d1d1d1d1d1d1";
const completedIdempotentReplayCaptureId =
  "d2d2d2d2-d2d2-5d2d-8d2d-d2d2d2d2d2d2";
const completionLockCaptureId = "d3d3d3d3-d3d3-5d3d-8d3d-d3d3d3d3d3d3";
const badDeliveryUpdateCaptureId =
  "d4d4d4d4-d4d4-5d4d-8d4d-d4d4d4d4d4d4";
const badDeliveryUpdateDecisionId =
  "d5d5d5d5-d5d5-5d5d-8d5d-d5d5d5d5d5d5";
const fullTruncatedDeliveryCaptureId =
  "d6d6d6d6-d6d6-5d6d-8d6d-d6d6d6d6d6d6";
const fullTruncatedDeliveryDecisionId =
  "d7d7d7d7-d7d7-5d7d-8d7d-d7d7d7d7d7d7";
const twoCallCostCaptureId = "c3c3c3c3-c3c3-5c3c-8c3c-c3c3c3c3c3c3";
const twoCallCostDecisionId = "c4c4c4c4-c4c4-5c4c-8c4c-c4c4c4c4c4c4";
const cacheHitRateCaptureId = "c5c5c5c5-c5c5-5c5c-8c5c-c5c5c5c5c5c5";
const voiceTimeoutFallbackCaptureId =
  "c5f5c5f5-c5f5-55c5-85c5-c5f5c5f5c5f5";
const voiceTimeoutFallbackDecisionId =
  "c5e5c5e5-c5e5-55e5-85e5-c5e5c5e5c5e5";
const streamedVoiceCaptureId = "c8c8c8c8-c8c8-5c8c-8c8c-c8c8c8c8c8c8";
const streamedVoiceDecisionId = "c9c8c9c8-c9c8-59c8-89c8-c9c8c9c8c9c8";
const requiredSlotEvidenceCaptureId =
  "c6c6c6c6-c6c6-5c6c-8c6c-c6c6c6c6c6c6";
const requiredClaimEvidenceCaptureId =
  "c7c7c7c7-c7c7-5c7c-8c7c-c7c7c7c7c7c7";
const slotSatisfiedInvalidSubjectCaptureId =
  "c8d8c8d8-c8d8-58d8-88d8-c8d8c8d8c8d8";
const demoClaimReplayCaptureId = "e0e0e0e0-e0e0-5e0e-8e0e-e0e0e0e0e0e0";
const demoClaimReplayEvidenceId = "e1e1e1e1-e1e1-5e1e-8e1e-e1e1e1e1e1e1";
const drainRetryCaptureId = "e2e2e2e2-e2e2-5e2e-8e2e-e2e2e2e2e2e2";
const drainRetryEvidenceId = "e3e3e3e3-e3e3-5e3e-8e3e-e3e3e3e3e3e3";
const functionNameClobberCaptureId = "e4e4e4e4-e4e4-5e4e-8e4e-e4e4e4e4e4e4";
const functionNameClobberEvidenceId = "e5e5e5e5-e5e5-5e5e-8e5e-e5e5e5e5e5e5";

let connectionString = "";
let appClient: Client;
const hasDocker = canUseDocker();
const requiresDocker = process.env.CI === "true" || process.env.OTTO_REQUIRE_DOCKER_TESTS === "true";

if (requiresDocker && !hasDocker) {
  throw new Error("Docker is required for database integration tests in CI.");
}

describe.skipIf(!hasDocker)("Phase 1 database integration", () => {
  beforeAll(async () => {
    ensureDocker();
    cleanupContainer();
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=otto_test",
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    waitForPostgres();

    applyMigration("0000_phase0_foundations.sql");
    applyMigration("0001_phase1_director_intake.sql");
    applyMigration("0002_workspace_data_tier_real.sql");
    applyMigration("0003_director_voice_m1.sql");
    applyMigration("0004_director_process_slots_and_degraded_reasons.sql");
    applyMigration("0005_operator_graph.sql");
    applyMigration("0006_capture_evidence.sql");
    applyMigration("0007_redactions.sql");
    applyMigration("0008_director_voice_decoupling.sql");
    applyMigration("0009_provisional_step_sources.sql");
    applyMigration("0010_operator_visual_comprehension.sql");
    applyMigration("0011_workflow_semantic_models.sql");
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "otto_test",
      ],
      {
        input: `
          CREATE ROLE otto_app LOGIN PASSWORD 'otto_app';
          GRANT USAGE ON SCHEMA public TO otto_app;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO otto_app;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO otto_app;
        `,
      },
    );

    const port = dockerPort();
    connectionString = `postgres://otto_app:otto_app@127.0.0.1:${port}/otto_test`;
    process.env.DATABASE_URL = connectionString;
    process.env.DATABASE_SERVICE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/otto_test`;
    process.env.OTTO_DEV_AUTH_BYPASS = "true";
    appClient = new Client({ connectionString });
    await appClient.connect();
  }, 120_000);

  afterAll(async () => {
    await appClient?.end().catch(() => undefined);
    const { closeDb } = await import("@/lib/db/client");
    await closeDb();
    cleanupContainer();
  });

  test("Week 2 objects roundtrip through RLS-protected tables", async () => {
    await seedWeek2Graph(appClient);

    const { writeClaim } = await import("@/lib/db/write-claim");
    const result = await writeClaim({
      orgId,
      workspaceId,
      userId,
      subject: { type: "candidate_process", id: candidateProcessId },
      field: "summary",
      value: {
        text: "Promotion management has frequent system handoffs.",
      },
      evidenceIds: [evidenceId],
      confidence: 0.82,
      idempotencyKey: "phase1-candidate-summary",
      requestHash: "phase1-candidate-summary-hash",
      route: "integration/phase1/write-claim",
      metadata: { test: "phase1" },
    });

    expect(result.statusCode).toBe(201);
    expect(result.body.claim.subject_type).toBe("candidate_process");

    const counts = await appClient.query(`
      SELECT
        (SELECT count(*)::int FROM workspaces) AS workspaces,
        (SELECT count(*)::int FROM capture_sessions WHERE capture_type = 'director_interview') AS director_captures,
        (SELECT count(*)::int FROM capture_sessions WHERE capture_type = 'document_upload') AS document_captures,
        (SELECT count(*)::int FROM artifacts WHERE capture_session_id = '${documentCaptureId}') AS artifacts,
        (SELECT count(*)::int FROM claims WHERE subject_type = 'candidate_process') AS candidate_claims,
        (SELECT count(*)::int FROM claim_evidence) AS claim_evidence
    `);
    expect(counts.rows[0]).toEqual({
      workspaces: 1,
      director_captures: 1,
      document_captures: 1,
      artifacts: 1,
      candidate_claims: 1,
      claim_evidence: 1,
    });
  });

  test("Phase 1 tables force RLS", async () => {
    const ownerClient = new Client({
      connectionString: connectionString.replace(
        "otto_app:otto_app",
        "postgres:postgres",
      ),
    });
    await ownerClient.connect();
    const result = await ownerClient.query(`
      SELECT bool_and(relforcerowsecurity) AS forced
      FROM pg_class
      WHERE relname IN (
        'slot_states',
        'candidate_processes',
        'capture_process_links',
        'follow_up_tasks',
        'synthesis_runs',
        'synthesis_stage_outputs',
        'agent_decision_log',
        'process_systems',
        'process_roles',
        'process_people'
      )
    `);
    await ownerClient.end();
    expect(result.rows[0].forced).toBe(true);
  });

  test("Week 4 candidate promotion creates process draft, projections, and exact evidence links", async () => {
    await seedWeek4PromotionGraph(appClient);

    const { promoteCandidateProcess } = await import(
      "@/lib/candidate-processes/promotion"
    );
    const promoted = await promoteCandidateProcess(
      { orgId, workspaceId, userId, idempotencyKey: "week4-promote" },
      week4CandidateId,
    );

    expect(promoted.process_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
      SELECT
        (SELECT count(*)::int FROM processes WHERE id = $1 AND status = 'draft') AS processes,
        (SELECT count(*)::int FROM process_versions WHERE process_id = $1 AND status = 'draft') AS versions,
        (SELECT count(*)::int FROM capture_process_links WHERE process_id = $1 AND link_type = 'created') AS capture_links,
        (SELECT count(*)::int FROM process_systems WHERE process_id = $1 AND system_id = $2) AS systems,
        (SELECT count(*)::int FROM process_roles WHERE process_id = $1) AS roles,
        (SELECT count(*)::int FROM process_people WHERE process_id = $1 AND person_id = $3) AS people,
        (SELECT value #>> '{}' FROM claims WHERE subject_type = 'process' AND subject_id = $1 AND field = 'frequency' AND status = 'active') AS frequency,
        (SELECT count(DISTINCT ce.evidence_id)::int
           FROM claims c
           JOIN claim_evidence ce ON ce.claim_id = c.id
          WHERE c.subject_type = 'process'
            AND c.subject_id = $1
            AND c.field = 'risk') AS risk_evidence_count,
        (SELECT bool_and(evidence_count = 1)
           FROM (
             SELECT c.id, count(ce.evidence_id)::int AS evidence_count
             FROM claims c
             JOIN claim_evidence ce ON ce.claim_id = c.id
             WHERE c.subject_type = 'process'
               AND c.subject_id = $1
               AND c.field = 'risk'
             GROUP BY c.id
           ) risk_rows) AS exact_risk_evidence
      `,
      [promoted.process_id, week4SystemId, week4PersonId],
    );

    expect(rows.rows[0]).toEqual({
      processes: 1,
      versions: 1,
      capture_links: 1,
      systems: 1,
      roles: 2,
      people: 1,
      frequency: "weekly",
      risk_evidence_count: 2,
      exact_risk_evidence: true,
    });
  });

  test("Week 4 candidate merge preserves candidate evidence on the target process", async () => {
    await seedWeek4MergeCandidate(appClient);

    const { mergeCandidateProcess } = await import(
      "@/lib/candidate-processes/promotion"
    );

    const merged = await mergeCandidateProcess(
      { orgId, workspaceId, userId, idempotencyKey: "week4-merge-candidate" },
      week4MergeCandidateId,
      week4MergeTargetProcessId,
    );

    expect(merged).toMatchObject({
      candidate_process_id: week4MergeCandidateId,
      target_process_id: week4MergeTargetProcessId,
      status: "merged",
    });

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
        SELECT
          (SELECT status FROM candidate_processes WHERE id = $1) AS candidate_status,
          (SELECT promoted_process_id::text FROM candidate_processes WHERE id = $1) AS target_process_id,
          (SELECT count(*)::int
             FROM capture_process_links
            WHERE process_id = $2
              AND capture_session_id = $3
              AND link_type = 'enriched') AS enriched_links,
          (SELECT count(*)::int
             FROM claims c
             JOIN claim_evidence ce ON ce.claim_id = c.id
            WHERE c.subject_type = 'process'
              AND c.subject_id = $2
              AND c.field IN ('frequency', 'risk')
              AND ce.evidence_id = $4) AS preserved_process_evidence,
          (SELECT count(*)::int
             FROM audit_log
            WHERE event_type = 'candidate_process.merged'
              AND subject_id = $1) AS audit_rows
      `,
      [
        week4MergeCandidateId,
        week4MergeTargetProcessId,
        directorCaptureId,
        week4MergeEvidenceId,
      ],
    );

    expect(rows.rows[0]).toEqual({
      candidate_status: "merged",
      target_process_id: week4MergeTargetProcessId,
      enriched_links: 1,
      preserved_process_evidence: 2,
      audit_rows: 1,
    });
  });

  test("Week 5 coverage query reads slot states and telemetry for FDE admin", async () => {
    await seedWeek5CoverageGraph(appClient);

    const { getDirectorCoverage } = await import("@/lib/admin/coverage-queries");
    const coverage = await getDirectorCoverage(orgId, workspaceId, directorCaptureId);

    expect(coverage.captureSessionId).toBe(directorCaptureId);
    expect(coverage.summary.filled).toBe(1);
    expect(coverage.summary.partial).toBe(1);
    expect(coverage.summary.conflicting).toBe(1);
    expect(coverage.summary.missing).toBeGreaterThan(0);
    expect(coverage.summary.openFollowUps).toBe(1);
    expect(coverage.summary.evidenceCount).toBe(2);
    expect(
      coverage.slots.find((slot) => slot.slotPath === "systems.systems_of_record"),
    ).toMatchObject({
      status: "conflicting",
      openFollowUps: 1,
    });
    expect(coverage.telemetry).toMatchObject({
      decisionCount: 2,
      degradedTurns: 1,
      totalCostCents: 1.25,
      cacheHitRate: 50,
      synthesisRunCount: 1,
      partialSynthesisRuns: 1,
      latestSynthesisStatus: "partial_synthesis",
    });
    expect(coverage.telemetry.p95LatencyMs).toBeGreaterThan(100);
  });

  test("Week 5 RLS blocks cross-org reads from Phase 1 admin data", async () => {
    await seedWeek5CoverageGraph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      "99999999-9999-5999-8999-999999999999",
    ]);

    const rows = await appClient.query(`
      SELECT
        (SELECT count(*)::int FROM slot_states WHERE workspace_id = '${workspaceId}') AS slots,
        (SELECT count(*)::int FROM agent_decision_log WHERE workspace_id = '${workspaceId}') AS decisions,
        (SELECT count(*)::int FROM synthesis_runs WHERE workspace_id = '${workspaceId}') AS synthesis_runs
    `);

    expect(rows.rows[0]).toEqual({
      slots: 0,
      decisions: 0,
      synthesis_runs: 0,
    });
  });

  test("Week 5 document pipeline failure marks artifact failed and audits it", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query(
      "UPDATE artifacts SET status = 'uploaded', storage_url = NULL WHERE id = $1",
      [artifactId],
    );
    process.env.LLAMAPARSE_API_KEY = "phase1-parser-key";

    const { processDocumentArtifact } = await import("@/lib/documents/pipeline");
    try {
      await expect(
        processDocumentArtifact({
          artifactId,
          orgId,
          userId,
          captureSessionId: documentCaptureId,
          idempotencyKey: "week5-parser-failure",
        }),
      ).rejects.toThrow(/LlamaParse requires a public storage URL/);
    } finally {
      delete process.env.LLAMAPARSE_API_KEY;
    }

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
        SELECT
          (SELECT status FROM artifacts WHERE id = $1) AS artifact_status,
          (SELECT count(*)::int FROM audit_log WHERE subject_id = $1 AND event_type = 'artifact.failed') AS failed_audits,
          (SELECT count(*)::int FROM agent_decision_log WHERE workspace_id = $2 AND capture_session_id = $3 AND stage_name = 'week3_document_pipeline.failed' AND degraded_quality = true) AS degraded_logs
      `,
      [artifactId, workspaceId, documentCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      artifact_status: "failed",
      failed_audits: 1,
      degraded_logs: 1,
    });
  });

  test("Week 5 inventory synthesis accepts capture session UUID arrays", async () => {
    await seedWeek5SynthesisGraph(appClient);

    const { runInventorySynthesis } = await import("@/lib/synthesis/inventory");
    const result = await runInventorySynthesis({
      orgId,
      workspaceId,
      userId,
      captureSessionIds: [directorCaptureId],
      runType: "director_inventory",
      idempotencyKey: "week5-synthesis-array-binding",
    });

    expect(result.ok).toBe(true);
    expect(result.candidate_process_ids).toContain(week5SynthesisCandidateId);

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
        SELECT
          (SELECT status FROM synthesis_runs WHERE id = $1) AS synthesis_status,
          (SELECT count(*)::int FROM synthesis_stage_outputs WHERE synthesis_run_id = $1 AND status = 'completed') AS completed_stages,
          (SELECT count(*)::int FROM claims WHERE subject_id = $2 AND field = 'complexity_score' AND status = 'active') AS complexity_claims,
          (SELECT count(*)::int FROM claims WHERE subject_id = $2 AND field = 'narrative' AND status = 'active') AS narrative_claims,
          (SELECT count(*)::int FROM audit_log WHERE subject_id = $1 AND event_type = 'synthesis.inventory.completed') AS completed_audits
      `,
      [result.synthesis_run_id, week5SynthesisCandidateId],
    );

    expect(rows.rows[0]).toEqual({
      synthesis_status: "completed",
      completed_stages: 5,
      complexity_claims: 1,
      narrative_claims: 1,
      completed_audits: 1,
    });

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: directorCaptureId,
      userId,
      language: "en",
    });

    expect(verification.synthesis.run_count).toBeGreaterThanOrEqual(1);
    expect(verification.synthesis.terminal_run_count).toBeGreaterThanOrEqual(1);
    expect(verification.synthesis.completed_run_count).toBeGreaterThanOrEqual(1);
    expect(verification.overview.process_cards).toBeGreaterThan(0);
    expect(verification.overview.evidence_linked_cards).toBeGreaterThan(0);
    expect(verification.acceptance.has_synthesis_run_for_capture).toBe(true);
    expect(verification.acceptance.synthesis_terminal_for_capture).toBe(true);
    expect(verification.acceptance.overview_ready).toBe(true);
    expect(verification.acceptance.overview_has_evidence_linked_card).toBe(true);
  });

  test("Week 5 local document pipeline reads uploaded text and creates multiple normalized candidates", async () => {
    await seedWeek2Graph(appClient);
    const { localUploadUrl, writeLocalUpload } = await import(
      "@/lib/adapters/local-upload"
    );
    const storageKey = "tests/week5/local-multi-process.txt";
    await writeLocalUpload({
      key: storageKey,
      contentType: "text/plain",
      bytes: new TextEncoder().encode(
        [
          "Process: Renewal Review",
          "Owner: revenue operations",
          "Systems: SFDC, G Sheets",
          "Frequency: weekly",
          "Pain points: manual spreadsheet cleanup.",
          "Risk: only one analyst knows the exception rules.",
          "",
          "Process: Customer Escalation Intake",
          "Owner: support operations",
          "Systems: Service Now, Slack",
          "Frequency: daily",
          "Pain points: duplicate entry and approval delays.",
          "Risk: fragile handoff between teams.",
        ].join("\n"),
      ).buffer,
    });
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'document_upload', now()) ON CONFLICT (id) DO NOTHING",
      [week5LocalCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO artifacts (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          uploaded_by_user_id,
          artifact_type,
          status,
          storage_key,
          storage_url,
          filename,
          mime_type,
          size_bytes
        )
        VALUES ($1, $2, $3, $4, $5, 'document', 'uploaded', $6, $7, 'local-multi-process.txt', 'text/plain', 512)
        ON CONFLICT (id) DO UPDATE SET
          status = 'uploaded',
          storage_key = excluded.storage_key,
          storage_url = excluded.storage_url,
          mime_type = excluded.mime_type,
          updated_at = now()
      `,
      [
        week5LocalArtifactId,
        orgId,
        workspaceId,
        week5LocalCaptureId,
        userId,
        storageKey,
        localUploadUrl(storageKey),
      ],
    );

    const { processDocumentArtifact } = await import("@/lib/documents/pipeline");
    const result = await processDocumentArtifact({
      artifactId: week5LocalArtifactId,
      orgId,
      userId,
      captureSessionId: week5LocalCaptureId,
      idempotencyKey: "week5-local-real-upload",
    });

    expect(result.ok).toBe(true);
    expect(result.candidate_process_ids).toHaveLength(2);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int FROM candidate_processes WHERE capture_session_id = $1) AS candidates,
          (SELECT count(*)::int FROM systems WHERE org_id = $2 AND name IN ('Salesforce', 'Google Sheets', 'ServiceNow', 'Slack')) AS normalized_systems,
          (SELECT count(*)::int FROM roles WHERE org_id = $2 AND name IN ('Revenue Operations', 'Support Operations')) AS normalized_roles,
          (SELECT count(*)::int FROM people WHERE org_id = $2 AND name IN ('Revenue Operations', 'Support Operations')) AS team_people,
          (SELECT value FROM slot_states WHERE capture_session_id = $1 AND slot_path = 'scope.boundaries') AS scope_value,
          (SELECT value FROM slot_states WHERE capture_session_id = $1 AND slot_path = 'ownership.roles') AS role_value,
          (SELECT metadata_json->>'parser' FROM audit_log WHERE subject_id = $3 AND event_type = 'artifact.parsed' ORDER BY created_at DESC LIMIT 1) AS parser
      `,
      [week5LocalCaptureId, orgId, week5LocalArtifactId],
    );

    expect(rows.rows[0]).toEqual({
      candidates: 2,
      normalized_systems: 4,
      normalized_roles: 2,
      team_people: 0,
      scope_value: {
        process_names: ["Renewal Review", "Customer Escalation Intake"],
      },
      role_value: {
        roles: ["Revenue Operations", "Support Operations"],
      },
      parser: "local-text",
    });
  });

  test("Week 5 director and document writers keep slot value shapes aligned", async () => {
    await seedWeek2Graph(appClient);
    const { runDirectorTurn } = await import("@/lib/interview/director/brain");
    await runDirectorTurn({
      orgId,
      workspaceId,
      captureSessionId: directorCaptureId,
      userId,
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 1,
      latestUtterance:
        "We run renewal review weekly. The owner is Revenue Operations. Salesforce is involved.",
    });

    const { localUploadUrl, writeLocalUpload } = await import(
      "@/lib/adapters/local-upload"
    );
    const storageKey = "tests/week5/slot-shape-sequence.txt";
    await writeLocalUpload({
      key: storageKey,
      contentType: "text/plain",
      bytes: new TextEncoder().encode(
        [
          "Process: Customer Escalation Intake",
          "Owner: Support Operations",
          "Systems: ServiceNow",
          "Frequency: daily",
        ].join("\n"),
      ).buffer,
    });
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'document_upload', now()) ON CONFLICT (id) DO NOTHING",
      [week5LocalCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO artifacts (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          uploaded_by_user_id,
          artifact_type,
          status,
          storage_key,
          storage_url,
          filename,
          mime_type,
          size_bytes
        )
        VALUES ($1, $2, $3, $4, $5, 'document', 'uploaded', $6, $7, 'slot-shape-sequence.txt', 'text/plain', 256)
        ON CONFLICT (id) DO UPDATE SET
          status = 'uploaded',
          storage_key = excluded.storage_key,
          storage_url = excluded.storage_url,
          updated_at = now()
      `,
      [
        week5LocalArtifactId,
        orgId,
        workspaceId,
        week5LocalCaptureId,
        userId,
        storageKey,
        localUploadUrl(storageKey),
      ],
    );

    const { processDocumentArtifact } = await import("@/lib/documents/pipeline");
    await processDocumentArtifact({
      artifactId: week5LocalArtifactId,
      orgId,
      userId,
      captureSessionId: week5LocalCaptureId,
      idempotencyKey: "week5-slot-shape-sequence",
    });

    const rows = await appClient.query(
      `
        SELECT capture_session_id, slot_path, value
        FROM slot_states
        WHERE org_id = $1
          AND workspace_id = $2
          AND slot_path IN ('scope.boundaries', 'ownership.roles')
        ORDER BY capture_session_id, slot_path
      `,
      [orgId, workspaceId],
    );

    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capture_session_id: directorCaptureId,
          slot_path: "scope.boundaries",
          value: { process_names: ["Renewal Review Weekly"] },
        }),
        expect.objectContaining({
          capture_session_id: directorCaptureId,
          slot_path: "ownership.roles",
          value: { roles: ["Revenue Operations"] },
        }),
        expect.objectContaining({
          capture_session_id: week5LocalCaptureId,
          slot_path: "scope.boundaries",
          value: { process_names: ["Customer Escalation Intake"] },
        }),
        expect.objectContaining({
          capture_session_id: week5LocalCaptureId,
          slot_path: "ownership.roles",
          value: { roles: ["Support Operations"] },
        }),
      ]),
    );
  });

  test("director turn dispatch writes targeted candidate-process claims", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [targetedClaimCaptureId, orgId, workspaceId],
    );

    const { runDirectorTurn } = await import("@/lib/interview/director/brain");
    const result = await runDirectorTurn({
      orgId,
      workspaceId,
      captureSessionId: targetedClaimCaptureId,
      userId,
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 12,
      latestUtterance:
        "I run rev ops. We own forecasting and quote approvals. Quote approvals are painful because finance gets pulled in late. Quote approvals are tracked by approval cycle time.",
    });

    expect(result.candidate_process_ids.length).toBeGreaterThanOrEqual(2);
    const rows = await appClient.query(
      `
        SELECT cp.proposed_name, c.field, c.value
        FROM candidate_processes cp
        JOIN claims c
          ON c.subject_type = 'candidate_process'
         AND c.subject_id = cp.id
        WHERE cp.capture_session_id = $1
          AND cp.proposed_name = 'Quote Approvals'
          AND c.field IN ('upstream_dependency', 'kpi')
          AND c.status = 'active'
        ORDER BY c.field
      `,
      [targetedClaimCaptureId],
    );

    expect(rows.rows).toEqual([
      {
        proposed_name: "Quote Approvals",
        field: "kpi",
        value: { name: "approval cycle time" },
      },
      {
        proposed_name: "Quote Approvals",
        field: "upstream_dependency",
        value: { name: "finance" },
      },
    ]);
  });

  test("director dispatch preserves the turn when chosen-intent enrichment degrades", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [hardRequiredToolCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "capture_metrics",
      target_slot: "metrics.kpis",
      target_process: "Quote Approvals",
      score: 100,
      reason: "The metric answer is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: hardRequiredToolCaptureId,
      userId,
      latestUtterance: "Quote approvals are measured by approval cycle time.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 44,
      plannedAgentUtterance: "What target cycle time do you manage toward?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [],
        claims: [],
        tool_calls: [
          {
            name: "recordProcess",
            arguments: { name: "Quote Approvals", confidence: 0.9 },
          },
          {
            name: "recordCandidateProcessClaim",
            arguments: {
              targetProcess: "Quote Approvals",
              field: "metric_not_in_allowlist",
              value: { name: "approval cycle time" },
              confidence: 0.8,
            },
          },
        ],
        contradiction_signals: [],
        current_phase: "expand",
        proposed_next_phase: "enrich",
        phase_transition_ready: true,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "What target cycle time do you manage toward?",
      },
    });

    expect(result.degraded_quality).toBe(true);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM candidate_processes
            WHERE capture_session_id = $1) AS candidates,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1) AS decisions,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1) AS follow_ups
      `,
      [hardRequiredToolCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      candidates: 1,
      decisions: 1,
      follow_ups: 2,
    });
  });

  test("recordProcess serializes duplicate candidate creation and merges evidence", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [duplicateProcessCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote)
        VALUES
          ($1, $3, $4, 'transcript_segment', 'stated_director', 'Quote approvals are weekly.'),
          ($2, $3, $4, 'transcript_segment', 'stated_director', 'Quote approvals also use Salesforce.')
        ON CONFLICT (id) DO NOTHING
      `,
      [
        duplicateProcessEvidenceAId,
        duplicateProcessEvidenceBId,
        orgId,
        workspaceId,
      ],
    );

    const lockClient = new Client({ connectionString });
    await lockClient.connect();
    const { recordProcess } = await import("@/lib/interview/director/tools");
    let settled = false;
    let creation: Promise<unknown> | null = null;
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 13))",
        [`${duplicateProcessCaptureId}:candidate_process:quote approvals`],
      );

      creation = recordProcess({
        orgId,
        workspaceId,
        captureSessionId: duplicateProcessCaptureId,
        userId,
      }, {
        name: "Quote Approvals",
        frequency: "weekly",
        evidenceIds: [duplicateProcessEvidenceAId],
      }).then((candidate) => {
        settled = true;
        return candidate;
      });
      await delay(150);
      expect(settled).toBe(false);

      await lockClient.query("COMMIT");
      const candidate = await creation;
      expect((candidate as { proposedName: string }).proposedName).toBe(
        "Quote Approvals",
      );
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      await lockClient.end().catch(() => undefined);
    }

    await recordProcess({
      orgId,
      workspaceId,
      captureSessionId: duplicateProcessCaptureId,
      userId,
    }, {
      name: "quote approvals",
      proposedFunction: "Revenue Operations",
      evidenceIds: [duplicateProcessEvidenceBId],
    });

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
        SELECT count(DISTINCT cp.id)::int AS candidates,
               max(proposed_name) AS proposed_name,
               max(proposed_function) AS proposed_function,
               array_agg(DISTINCT evidence_id ORDER BY evidence_id) AS evidence_ids
        FROM candidate_processes cp
        CROSS JOIN LATERAL unnest(cp.evidence_ids) AS evidence_id
        WHERE cp.capture_session_id = $1
          AND lower(cp.proposed_name) = 'quote approvals'
      `,
      [duplicateProcessCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      candidates: 1,
      proposed_name: "Quote Approvals",
      proposed_function: "Revenue Operations",
      evidence_ids: [duplicateProcessEvidenceAId, duplicateProcessEvidenceBId].sort(),
    });
  }, 30_000);

  test("director dispatch preserves slot data when chosen-intent claims are malformed", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [hardRequiredClaimCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "capture_metrics",
      target_slot: "metrics.kpis",
      target_process: "Quote Approvals",
      score: 100,
      reason: "The metric claim is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: hardRequiredClaimCaptureId,
      userId,
      latestUtterance: "Quote approvals are measured by approval cycle time.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 45,
      plannedAgentUtterance: "What target cycle time do you manage toward?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [
          {
            slot_path: "metrics.kpis",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [evidenceId],
            priority: 70,
            value: { metrics: ["approval cycle time"] },
          },
        ],
        claims: [
          {
            subject_type: "candidate_process",
            subject_id: candidateProcessId,
            field: "metric_not_in_allowlist",
            value: { name: "approval cycle time" },
            confidence: 0.8,
            evidence_ids: [evidenceId],
          },
        ],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "expand",
        proposed_next_phase: "enrich",
        phase_transition_ready: true,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "What target cycle time do you manage toward?",
      },
    });

    expect(result.degraded_quality).toBe(true);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM slot_states
            WHERE capture_session_id = $1
              AND status <> 'empty') AS slots,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1) AS decisions,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1) AS follow_ups
      `,
      [hardRequiredClaimCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      slots: 1,
      decisions: 1,
      follow_ups: 2,
    });
  });

  test("director dispatch drops stale-evidence slot updates without blocking the turn", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [requiredSlotEvidenceCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "capture_metrics",
      target_slot: "metrics.kpis",
      target_process: "Quote Approvals",
      score: 100,
      reason: "The metric slot is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: requiredSlotEvidenceCaptureId,
      userId,
      latestUtterance: "Quote approvals are measured by approval cycle time.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 48,
      plannedAgentUtterance: "What target cycle time do you manage toward?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [
          {
            slot_path: "metrics.kpis",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [week4EvidenceAId],
            priority: 70,
            value: { metrics: ["approval cycle time"] },
          },
        ],
        claims: [],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "expand",
        proposed_next_phase: "enrich",
        phase_transition_ready: true,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "What target cycle time do you manage toward?",
      },
    });

    expect(result.degraded_quality).toBe(true);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM slot_states
            WHERE capture_session_id = $1
              AND status <> 'empty') AS slots,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1) AS decisions,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1) AS follow_ups
      `,
      [requiredSlotEvidenceCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      slots: 0,
      decisions: 1,
      follow_ups: 2,
    });
  });

  test("director dispatch drops claims with missing evidence without blocking the turn", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [requiredClaimEvidenceCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "capture_metrics",
      target_slot: "metrics.kpis",
      target_process: "Quote Approvals",
      score: 100,
      reason: "The metric claim is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: requiredClaimEvidenceCaptureId,
      userId,
      latestUtterance: "Quote approvals are measured by approval cycle time.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 49,
      plannedAgentUtterance: "What target cycle time do you manage toward?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [],
        claims: [
          {
            subject_type: "candidate_process",
            subject_id: candidateProcessId,
            field: "kpi",
            value: { name: "approval cycle time" },
            confidence: 0.8,
            evidence_ids: [],
          },
        ],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "expand",
        proposed_next_phase: "enrich",
        phase_transition_ready: true,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "What target cycle time do you manage toward?",
      },
    });

    expect(result.degraded_quality).toBe(true);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM claims
            WHERE subject_type = 'candidate_process'
              AND field = 'kpi'
              AND subject_id = $2) AS claims,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1) AS decisions,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1) AS follow_ups
      `,
      [requiredClaimEvidenceCaptureId, candidateProcessId],
    );

    expect(rows.rows[0]).toEqual({
      claims: 0,
      decisions: 1,
      follow_ups: 2,
    });
  });

  test("director dispatch preserves valid turn data when optional claims degrade", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [softMalformedClaimCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      "INSERT INTO candidate_processes (id, org_id, workspace_id, capture_session_id, proposed_name, confidence, evidence_ids) VALUES ($1, $2, $3, $4, 'Quote Approvals', 0.91, ARRAY[$5]::uuid[]) ON CONFLICT (id) DO NOTHING",
      [
        softMalformedClaimCandidateId,
        orgId,
        workspaceId,
        softMalformedClaimCaptureId,
        evidenceId,
      ],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "capture_outcome",
      target_slot: "outcomes.business_outcomes",
      target_process: "Quote Approvals",
      score: 100,
      reason: "The outcome claim is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: softMalformedClaimCaptureId,
      userId,
      latestUtterance:
        "Quote approvals protect margin, and the team also mentioned an unknown metric tag.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 46,
      plannedAgentUtterance: "What margin outcome matters most for that approval flow?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [
          {
            slot_path: "outcomes.business_outcomes",
            status: "filled",
            confidence: 0.82,
            evidence_ids: [evidenceId],
            priority: 65,
            value: { outcomes: ["protect margin"] },
          },
        ],
        claims: [
          {
            subject_type: "candidate_process",
            subject_id: softMalformedClaimCandidateId,
            field: "business_outcome",
            value: { name: "protect margin" },
            confidence: 0.82,
            evidence_ids: [evidenceId],
          },
          {
            subject_type: "candidate_process",
            subject_id: softMalformedClaimCandidateId,
            field: "metric_not_in_allowlist",
            value: { name: "unknown metric tag" },
            confidence: 0.4,
            evidence_ids: [evidenceId],
          },
        ],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "expand",
        proposed_next_phase: "enrich",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "What margin outcome matters most for that approval flow?",
      },
    });

    expect(result.degraded_quality).toBe(true);
    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM slot_states
            WHERE capture_session_id = $1
              AND slot_path = 'outcomes.business_outcomes'
              AND status = 'filled') AS slots,
          (SELECT count(*)::int
             FROM claims
            WHERE subject_type = 'candidate_process'
              AND subject_id = $2
              AND field = 'business_outcome'
              AND status = 'active') AS valid_claims,
          (SELECT count(*)::int
             FROM claims
            WHERE subject_type = 'candidate_process'
              AND subject_id = $2
              AND field = 'metric_not_in_allowlist') AS invalid_claims,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1
              AND turn_index = 46
              AND stage_name = 'director.turn'
              AND degraded_quality = true) AS degraded_decisions,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1
              AND task_type = 'low_confidence_claim'
              AND title = 'Review unsupported director claim: candidate_process.metric_not_in_allowlist') AS unsupported_follow_ups,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1
              AND task_type = 'low_confidence_claim'
              AND title = 'Re-extract degraded director turn') AS recovery_follow_ups
      `,
      [softMalformedClaimCaptureId, softMalformedClaimCandidateId],
    );

    expect(rows.rows[0]).toEqual({
      slots: 1,
      valid_claims: 1,
      invalid_claims: 0,
      degraded_decisions: 1,
      unsupported_follow_ups: 1,
      recovery_follow_ups: 1,
    });
  });

  test("director dispatch preserves chosen slot data when required claim subject degrades", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [slotSatisfiedInvalidSubjectCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "capture_outcome",
      target_slot: "outcomes.business_outcomes",
      target_process: "Payroll",
      score: 100,
      reason: "The outcome answer is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: slotSatisfiedInvalidSubjectCaptureId,
      userId,
      latestUtterance:
        "For payroll, success is making sure everyone gets paid with no errors.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 50,
      plannedAgentUtterance: "What metric tells you payroll is healthy?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [
          {
            slot_path: "outcomes.business_outcomes",
            status: "filled",
            confidence: 0.84,
            evidence_ids: [evidenceId],
            priority: 65,
            value: {
              outcomes: ["everyone gets paid with no errors"],
            },
          },
        ],
        claims: [
          {
            subject_type: "process",
            subject_id: evidenceId,
            field: "business_outcome",
            value: { name: "everyone gets paid with no errors" },
            confidence: 0.84,
            evidence_ids: [evidenceId],
          },
        ],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "expand",
        proposed_next_phase: "enrich",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "What metric tells you payroll is healthy?",
      },
    });

    expect(result.degraded_quality).toBe(true);
    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM slot_states
            WHERE capture_session_id = $1
              AND slot_path = 'outcomes.business_outcomes'
              AND status = 'filled') AS slots,
          (SELECT count(*)::int
             FROM claims
            WHERE subject_type = 'process'
              AND subject_id = $2
              AND field = 'business_outcome') AS invalid_claims,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1
              AND title = 'Review invalid director claim subject: process.business_outcome') AS invalid_subject_follow_ups,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1
              AND turn_index = 50
              AND degraded_quality = true) AS degraded_decisions
      `,
      [slotSatisfiedInvalidSubjectCaptureId, evidenceId],
    );

    expect(rows.rows[0]).toEqual({
      slots: 1,
      invalid_claims: 0,
      invalid_subject_follow_ups: 1,
      degraded_decisions: 1,
    });
  });

  test("director dispatch writes same-turn claims via name resolution, find-or-create, and phase remap", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [demoClaimReplayCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote)
        VALUES ($1, $2, $3, 'transcript_segment', 'stated_director', 'Order intake, order picking, shipping, invoicing, purchasing, and vendor payments. Marcus owns picking.')
        ON CONFLICT (id) DO NOTHING
      `,
      [demoClaimReplayEvidenceId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "discover_processes",
      target_slot: "process.inventory",
      score: 100,
      reason: "The process inventory is the selected intent for this turn.",
    };
    const processNames = [
      "Order Intake",
      "Order Picking",
      "Shipping",
      "Invoicing",
      "Purchasing",
      "Vendor Payments",
    ];
    const hallucinatedProcessId = "f8f8f8f8-f8f8-5f8f-8f8f-f8f8f8f8f8f8";
    const hallucinatedEvidenceId = "f9f9f9f9-f9f9-5f9f-8f9f-f9f9f9f9f9f9";

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: demoClaimReplayCaptureId,
      userId,
      latestUtterance:
        "We run order intake, order picking, shipping, invoicing, purchasing, and vendor payments. Marcus owns picking. A week of delay loses about ten percent of customers.",
      transcriptSegmentIds: [],
      evidenceIds: [demoClaimReplayEvidenceId],
      turnIndex: 51,
      plannedAgentUtterance: "Which of those should we map first?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [],
        claims: [
          // 6x candidate_process.proposed_name referencing same-turn
          // candidates by NAME (lowercased to prove normalized matching).
          ...processNames.map((name) => ({
            subject_type: "candidate_process",
            subject_id: name.toLowerCase(),
            field: "proposed_name",
            value: name,
            confidence: 0.85,
            evidence_ids: [demoClaimReplayEvidenceId],
          })),
          {
            subject_type: "candidate_process",
            subject_id: "Order   Intake",
            field: "process_relationship",
            value:
              "Order intake → Order picking → Shipping → Invoicing (sequential end-to-end); Purchasing and Vendor payments are parallel",
            confidence: 0.86,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          {
            subject_type: "person",
            subject_id: "Marcus",
            field: "role",
            value: "Warehouse picking lead",
            confidence: 0.82,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          {
            subject_type: "person",
            subject_id: "Marcus",
            field: "single_point_of_failure",
            value: true,
            confidence: 0.8,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          {
            subject_type: "process",
            subject_id: hallucinatedProcessId,
            field: "business_outcome",
            value: { name: "a week of delay loses roughly 10% of customers" },
            confidence: 0.8,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          {
            subject_type: "process",
            subject_id: "Order intake",
            field: "kpi",
            value: { name: "hundreds of thousands lost per delayed week" },
            confidence: 0.78,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          {
            subject_type: "system",
            subject_id: "Gmail",
            field: "used_in_process",
            value: "Order Intake",
            confidence: 0.8,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          {
            subject_type: "system",
            subject_id: "Google Sheets",
            field: "used_in_process",
            value: "Order Picking",
            confidence: 0.8,
            evidence_ids: [demoClaimReplayEvidenceId],
          },
          // 14th synthetic claim with a hallucinated evidence id must reject.
          {
            subject_type: "candidate_process",
            subject_id: "Order Intake",
            field: "kpi",
            value: { name: "fabricated metric" },
            confidence: 0.9,
            evidence_ids: [hallucinatedEvidenceId],
          },
        ],
        tool_calls: processNames.map((name) => ({
          name: "recordProcess",
          arguments: { name, confidence: 0.85 },
        })),
        contradiction_signals: [],
        current_phase: "inventory",
        proposed_next_phase: "expand",
        phase_transition_ready: true,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance: "Which of those should we map first?",
      },
    });

    expect(result.degraded_quality).toBe(true);
    expect(result.degraded_reasons).toContain("invalid_evidence_reference");
    expect(result.degraded_reasons).not.toContain("claim_subject_validation_failed");
    expect(result.degraded_reasons).not.toContain("claim_validation_failed");
    expect(result.degraded_reasons).not.toContain("claim_dispatch_failed");
    expect(result.candidate_process_ids).toHaveLength(6);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM candidate_processes
            WHERE capture_session_id = $1) AS candidates,
          (SELECT count(*)::int
             FROM claims c
             JOIN candidate_processes cp ON cp.id = c.subject_id
            WHERE cp.capture_session_id = $1
              AND c.subject_type = 'candidate_process'
              AND c.field = 'proposed_name'
              AND c.status = 'active') AS proposed_name_claims,
          (SELECT count(*)::int
             FROM claims c
             JOIN candidate_processes cp ON cp.id = c.subject_id
            WHERE cp.capture_session_id = $1
              AND cp.proposed_name = 'Order Intake'
              AND c.field = 'process_relationship'
              AND c.status = 'active') AS relationship_claims,
          (SELECT count(*)::int
             FROM claims c
             JOIN people p ON p.id = c.subject_id
            WHERE c.subject_type = 'person'
              AND lower(p.name) = 'marcus'
              AND c.field IN ('role', 'single_point_of_failure')
              AND c.status = 'active') AS marcus_claims,
          (SELECT count(*)::int
             FROM people
            WHERE org_id = $2
              AND lower(name) = 'marcus'
              AND source = 'director_interview') AS marcus_people,
          (SELECT count(*)::int
             FROM claims c
             JOIN candidate_processes cp ON cp.id = c.subject_id
            WHERE cp.capture_session_id = $1
              AND cp.proposed_name = 'Order Intake'
              AND c.field IN ('business_outcome', 'kpi')
              AND c.status = 'active'
              AND c.metadata_json->'remapped_from'->>'subject_type' = 'process') AS remapped_claims,
          (SELECT count(*)::int
             FROM claims c
            WHERE c.subject_type = 'process'
              AND c.field IN ('business_outcome', 'kpi')) AS canonical_process_claims,
          (SELECT count(*)::int
             FROM claims c
             JOIN systems s ON s.id = c.subject_id
             JOIN candidate_processes cp
               ON cp.id = (c.value->>'candidate_process_id')::uuid
            WHERE c.subject_type = 'system'
              AND c.field = 'used_in_process'
              AND c.status = 'active'
              AND s.name IN ('Gmail', 'Google Sheets')
              AND cp.capture_session_id = $1) AS coerced_system_claims,
          (SELECT count(*)::int
             FROM claims c
             JOIN candidate_processes cp ON cp.id = c.subject_id
            WHERE cp.capture_session_id = $1
              AND c.field = 'kpi'
              AND c.value->>'name' = 'fabricated metric') AS hallucinated_claims,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1
              AND title LIKE 'Review stale director evidence%') AS stale_evidence_follow_ups,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1) AS follow_ups
      `,
      [demoClaimReplayCaptureId, orgId],
    );

    expect(rows.rows[0]).toEqual({
      candidates: 6,
      proposed_name_claims: 6,
      relationship_claims: 1,
      marcus_claims: 2,
      marcus_people: 1,
      remapped_claims: 2,
      canonical_process_claims: 0,
      coerced_system_claims: 2,
      hallucinated_claims: 0,
      stale_evidence_follow_ups: 1,
      follow_ups: 2,
    });
  });

  test("director dispatch drains queued retry-claim tasks when their entity is created", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [drainRetryCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote)
        VALUES ($1, $2, $3, 'transcript_segment', 'stated_director', 'Priya runs inventory restock end to end.')
        ON CONFLICT (id) DO NOTHING
      `,
      [drainRetryEvidenceId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO follow_up_tasks (org_id, workspace_id, capture_session_id, task_type, title, description, target_type, priority, status, context_json)
        VALUES
          ($1, $2, $3, 'low_confidence_claim', 'Retry director claim: person.role', 'Person not found.', 'person', 2, 'open', $4::jsonb),
          ($1, $2, $3, 'low_confidence_claim', 'Review invalid director claim subject: candidate_process.kpi', 'Candidate not found.', 'candidate_process', 2, 'open', $5::jsonb)
      `,
      [
        orgId,
        workspaceId,
        drainRetryCaptureId,
        JSON.stringify({
          subject_type: "person",
          subject_id: "Priya",
          field: "role",
          value: "Operations Manager",
          confidence: 0.74,
          evidence_ids: [drainRetryEvidenceId],
        }),
        JSON.stringify({
          subject_type: "candidate_process",
          subject_id: "Inventory Restock",
          field: "kpi",
          value: { name: "stockout rate" },
          confidence: 0.8,
          evidence_ids: [drainRetryEvidenceId],
        }),
      ],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "discover_processes",
      target_slot: "process.inventory",
      score: 100,
      reason: "The process inventory is the selected intent for this turn.",
    };

    const result = await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: drainRetryCaptureId,
      userId,
      latestUtterance: "Priya runs inventory restock end to end.",
      transcriptSegmentIds: [],
      evidenceIds: [drainRetryEvidenceId],
      turnIndex: 52,
      plannedAgentUtterance: "What does success look like for inventory restock?",
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [],
        claims: [],
        tool_calls: [
          {
            name: "recordProcess",
            arguments: { name: "Inventory Restock", confidence: 0.8 },
          },
          { name: "recordPerson", arguments: { name: "Priya" } },
        ],
        contradiction_signals: [],
        current_phase: "inventory",
        proposed_next_phase: "expand",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance:
          "What does success look like for inventory restock?",
      },
    });

    expect(result.degraded_quality).toBe(false);

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1
              AND status = 'resolved'
              AND resolved_at IS NOT NULL) AS resolved_tasks,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1
              AND status = 'open') AS open_tasks,
          (SELECT count(*)::int
             FROM claims c
             JOIN people p ON p.id = c.subject_id
            WHERE c.subject_type = 'person'
              AND lower(p.name) = 'priya'
              AND c.field = 'role'
              AND c.value = '"Operations Manager"'::jsonb
              AND c.status = 'active'
              AND c.metadata_json->>'source' = 'director_claim_retry_drain') AS drained_person_claims,
          (SELECT count(*)::int
             FROM claims c
             JOIN candidate_processes cp ON cp.id = c.subject_id
            WHERE cp.capture_session_id = $1
              AND cp.proposed_name = 'Inventory Restock'
              AND c.field = 'kpi'
              AND c.value->>'name' = 'stockout rate'
              AND c.status = 'active'
              AND c.metadata_json->>'source' = 'director_claim_retry_drain') AS drained_candidate_claims
      `,
      [drainRetryCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      resolved_tasks: 2,
      open_tasks: 0,
      drained_person_claims: 1,
      drained_candidate_claims: 1,
    });
  });

  test("director dispatch rejects model-invented slot paths before commit", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [invalidSlotPathCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "discover_function",
      target_slot: "function.name",
      score: 100,
      reason: "The director remit is the selected intent for this turn.",
    };

    await expect(
      dispatchDirectorTurnPlan({
        orgId,
        workspaceId,
        captureSessionId: invalidSlotPathCaptureId,
        userId,
        latestUtterance: "The outcome is margin protection.",
        transcriptSegmentIds: [],
        evidenceIds: [evidenceId],
        turnIndex: 47,
        plannedAgentUtterance: "What part of the business do you oversee?",
        plan: {
          utterance_type: "substantive_answer",
          slot_updates: [
            {
              slot_path: "outcomes.business",
              status: "filled",
              confidence: 0.8,
              evidence_ids: [evidenceId],
              priority: 98,
              value: { outcome: "margin protection" },
            },
          ],
          claims: [],
          tool_calls: [],
          contradiction_signals: [],
          current_phase: "orient",
          proposed_next_phase: "inventory",
          phase_transition_ready: true,
          ranked_intents: [chosenIntent],
          chosen_intent: chosenIntent,
          planned_agent_utterance: "What part of the business do you oversee?",
        },
      }),
    ).rejects.toThrow("Unknown director slot path: outcomes.business");

    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int
             FROM slot_states
            WHERE capture_session_id = $1) AS slots,
          (SELECT count(*)::int
             FROM agent_decision_log
            WHERE capture_session_id = $1) AS decisions,
          (SELECT count(*)::int
             FROM follow_up_tasks
            WHERE capture_session_id = $1) AS follow_ups
      `,
      [invalidSlotPathCaptureId],
    );

    expect(rows.rows[0]).toEqual({
      slots: 0,
      decisions: 0,
      follow_ups: 0,
    });
  });

  test("director dispatch sanitizes agent-derived decision and follow-up logs", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [sanitizedDecisionCaptureId, orgId, workspaceId],
    );

    const { dispatchDirectorTurnPlan } = await import("@/lib/interview/director/brain");
    const chosenIntent = {
      intent: "discover_processes",
      target_slot: "process.inventory",
      score: 100,
      reason: "The process inventory is the selected intent for this turn.",
    };

    await dispatchDirectorTurnPlan({
      orgId,
      workspaceId,
      captureSessionId: sanitizedDecisionCaptureId,
      userId,
      latestUtterance: "Email me at jane@example.com or call 415-555-1212.",
      transcriptSegmentIds: [],
      evidenceIds: [evidenceId],
      turnIndex: 48,
      plannedAgentUtterance:
        "Email jane@example.com or call 415-555-1212 before we map processes.",
      deliveredAgentUtterance:
        "Email jane@example.com and SSN 123-45-6789 are not needed.",
      deliveryStatus: "completed",
      spokenFraction: 1,
      plan: {
        utterance_type: "substantive_answer",
        slot_updates: [
          {
            slot_path: "process.inventory",
            status: "partial",
            confidence: 0.7,
            evidence_ids: [evidenceId],
            priority: 105,
            value: { note: "Call 415-555-1212 about process inventory" },
          },
        ],
        claims: [],
        tool_calls: [
          {
            name: "createFollowUpTask",
            arguments: {
              taskType: "open_question",
              title: "Email jane@example.com for process list",
              description: "Call 415-555-1212 before next interview.",
              targetType: "capture_session",
              targetId: sanitizedDecisionCaptureId,
              priority: 2,
            },
          },
        ],
        contradiction_signals: [],
        current_phase: "inventory",
        proposed_next_phase: "inventory",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
        planned_agent_utterance:
          "Email jane@example.com or call 415-555-1212 before we map processes.",
      },
    });

    const rows = await appClient.query(
      `
        SELECT
          d.sanitized_agent_utterance,
          d.delivery_json,
          d.tool_calls,
          d.slot_updates,
          f.title AS follow_up_title,
          f.description AS follow_up_description,
          f.context_json AS follow_up_context
        FROM agent_decision_log d
        JOIN follow_up_tasks f
          ON f.capture_session_id = d.capture_session_id
        WHERE d.capture_session_id = $1
          AND d.turn_index = 48
          AND d.stage_name = 'director.turn'
          AND f.task_type = 'open_question'
      `,
      [sanitizedDecisionCaptureId],
    );

    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0];
    const serialized = JSON.stringify(row);
    expect(serialized).toContain("[PII:email]");
    expect(serialized).toContain("[PII:phone]");
    expect(serialized).toContain("[PII:ssn]");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("415-555-1212");
    expect(serialized).not.toContain("123-45-6789");
    expect(row.sanitized_agent_utterance).toBe(
      "Email [PII:email] or call [PII:phone] before we map processes.",
    );
    expect(row.follow_up_title).toBe("Email [PII:email] for process list");
    expect(row.follow_up_description).toBe(
      "Call [PII:phone] before next interview.",
    );
    expect(row.tool_calls[0].execution).toMatchObject({
      tool_index: 0,
      tool_name: "createFollowUpTask",
      status: "succeeded",
    });
    expect(row.tool_calls[0].execution.idempotency_key).toMatch(/^director-tool:/);
    expect(row.tool_calls[0].execution.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("director ingest sanitizes ASR metadata without dropping timing metrics", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [sanitizedTranscriptMetadataCaptureId, orgId, workspaceId],
    );

    const { resolveDirectorSessionContext, ingestDirectorTurn } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const context = await resolveDirectorSessionContext(
      sanitizedTranscriptMetadataCaptureId,
    );

    const ingest = await ingestDirectorTurn({
      context,
      transcriptSegments: [
        {
          speaker: "director",
          speaker_role: "director",
          start_ms: 1200,
          end_ms: 2600,
          text: "Forecasting happens weekly.",
          confidence: 0.94,
          timing_source: "asr_metrics",
          metadata_json: {
            source: "livekit_agents",
            provider: "deepgram",
            metrics: {
              transcription_delay: 0.24,
              end_of_turn_delay: 0.41,
            },
            raw_debug: {
              email: "director@example.com",
              phone: "415-555-1212",
              ssn: "123-45-6789",
            },
          },
        },
      ],
    });

    const rows = await appClient.query(
      `
        SELECT metadata_json
          FROM transcript_segments
         WHERE id = $1
      `,
      [ingest.transcript_segment_ids[0]],
    );

    expect(rows.rowCount).toBe(1);
    const metadata = rows.rows[0].metadata_json;
    expect(metadata).toMatchObject({
      source: "livekit_agents",
      provider: "deepgram",
      metrics: {
        transcription_delay: 0.24,
        end_of_turn_delay: 0.41,
      },
      raw_debug: {
        email: "[PII:email]",
        phone: "[PII:phone]",
        ssn: "[PII:ssn]",
      },
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("director@example.com");
    expect(serialized).not.toContain("415-555-1212");
    expect(serialized).not.toContain("123-45-6789");
  });

  test("director internal turn references reject mismatched turn indexes", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [mismatchedTurnIndexCaptureId, orgId, workspaceId],
    );

    const { assertDirectorTurnReferences, ingestDirectorTurn } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const context = {
      orgId,
      workspaceId,
      captureSessionId: mismatchedTurnIndexCaptureId,
      userId,
      language: "en",
    };
    const ingested = await ingestDirectorTurn({
      context,
      transcriptSegments: [
        {
          speaker: "director",
          speaker_role: "director",
          start_ms: 1000,
          end_ms: 2200,
          text: "Quote approvals are weekly.",
          timing_source: "asr_metrics",
          metadata_json: {
            source: "livekit_agents",
            provider: "deepgram",
            timing: "started_stopped_speaking_at",
          },
        },
      ],
    });

    await expect(
      assertDirectorTurnReferences({
        context,
        transcriptSegmentIds: ingested.transcript_segment_ids,
        evidenceIds: ingested.evidence_ids,
        expectedTurnIndex: ingested.turn_index + 1,
      }),
    ).rejects.toThrow(
      "Director turn_index must match the ingested transcript segment turn_index.",
    );
    await expect(
      assertDirectorTurnReferences({
        context,
        transcriptSegmentIds: ingested.transcript_segment_ids,
        evidenceIds: ingested.evidence_ids,
        expectedTurnIndex: ingested.turn_index,
      }),
    ).resolves.toBeUndefined();
  });

  test("director planning context distinguishes pending and terminal opening prompts", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [pendingOpeningResumeCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES (
          $1,
          $2,
          $3,
          0,
          'director.opening',
          now(),
          now(),
          'What part of the business do you oversee?',
          'director.opening',
          '1',
          '{"delivery_status":"pending","spoken_fraction":0}'::jsonb
        )
        ON CONFLICT (capture_session_id, turn_index, stage_name)
        WHERE capture_session_id IS NOT NULL
          AND turn_index IS NOT NULL
          AND stage_name IS NOT NULL
        DO UPDATE SET delivery_json = excluded.delivery_json
      `,
      [orgId, workspaceId, pendingOpeningResumeCaptureId],
    );

    const { readDirectorPlanningContext } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const context = {
      orgId,
      workspaceId,
      captureSessionId: pendingOpeningResumeCaptureId,
      userId,
      language: "en",
    };
    const pendingContext = await readDirectorPlanningContext(context);
    expect(pendingContext.has_opening_prompt).toBe(true);
    expect(pendingContext.has_terminal_opening_prompt).toBe(false);
    expect(pendingContext.opening_prompt_delivery_status).toBe("pending");

    await appClient.query(
      `
        UPDATE agent_decision_log
        SET delivery_json = '{"delivery_status":"completed","spoken_fraction":1}'::jsonb
        WHERE capture_session_id = $1
          AND turn_index = 0
          AND stage_name = 'director.opening'
      `,
      [pendingOpeningResumeCaptureId],
    );
    const terminalContext = await readDirectorPlanningContext(context);
    expect(terminalContext.has_opening_prompt).toBe(true);
    expect(terminalContext.has_terminal_opening_prompt).toBe(true);
    expect(terminalContext.opening_prompt_delivery_status).toBe("completed");
  });

  test("Week 5 API routes accept real requests for intake and artifact completion", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { inngest } = await import("@/lib/inngest/client");
    const sendSpy = vi
      .spyOn(inngest, "send")
      .mockResolvedValue({ ids: [] } as Awaited<ReturnType<typeof inngest.send>>);
    try {
      const workspacesRoute = await import("@/app/api/workspaces/route");
      const interviewsRoute = await import("@/app/api/director-interviews/route");
      const turnsRoute = await import(
        "@/app/api/director-interviews/[captureSessionId]/turns/route"
      );
      const completeRoute = await import(
        "@/app/api/director-interviews/[captureSessionId]/complete/route"
      );
      const coverageRoute = await import(
        "@/app/api/director-interviews/[captureSessionId]/coverage/route"
      );
      const presignRoute = await import(
        "@/app/api/workspaces/[workspaceId]/artifacts/presign/route"
      );
      const artifactUploadRoute = await import(
        "@/app/api/artifacts/[artifactId]/upload/route"
      );
      const artifactCompleteRoute = await import(
        "@/app/api/artifacts/[artifactId]/complete/route"
      );
      const evidenceRoute = await import(
        "@/app/api/workspaces/[workspaceId]/evidence/route"
      );

      const workspaceResponse = await workspacesRoute.POST(
        apiRequest("http://otto.test/api/workspaces", {
          idempotencyKey: "api-workspace",
          body: {
            name: "API Commercial Ops",
            function_name: "Commercial",
            starter_process_name: "Starter",
          },
        }),
      );
      expect(workspaceResponse.status).toBe(201);
      const workspaceJson = await workspaceResponse.json();
      const apiWorkspaceId = workspaceJson.workspace.id as string;
      const apiOrgId = workspaceJson.workspace.orgId as string;

      const forgedInterviewResponse = await interviewsRoute.POST(
        apiRequest("http://otto.test/api/director-interviews", {
          idempotencyKey: "api-interview-forged-context",
          body: {
            workspace_id: apiWorkspaceId,
            language: "en",
            consent_acknowledged: true,
            consent_text_version: "director_voice_v1",
            org_id: "11111111-1111-4111-8111-111111111111",
            user_id: "33333333-3333-4333-8333-333333333333",
          },
        }),
      );
      expect(forgedInterviewResponse.status).toBe(400);
      const forgedInterviewJson = await forgedInterviewResponse.json();
      expect(forgedInterviewJson.error.issues[0].code).toBe("unrecognized_keys");

      const interviewResponse = await interviewsRoute.POST(
        apiRequest("http://otto.test/api/director-interviews", {
          idempotencyKey: "api-interview",
          body: {
            workspace_id: apiWorkspaceId,
            language: "en",
            consent_acknowledged: true,
            consent_text_version: "director_voice_v1",
          },
        }),
      );
      expect(interviewResponse.status).toBe(201);
      const interviewJson = await interviewResponse.json();
      const captureSessionId = interviewJson.capture_session.id as string;

      const turnResponse = await turnsRoute.POST(
        apiRequest(
          `http://otto.test/api/director-interviews/${captureSessionId}/turns`,
          {
            idempotencyKey: "api-turn",
            body: {
              workspace_id: apiWorkspaceId,
              utterance:
                "We run renewal review weekly in Salesforce. The owner is Revenue Operations, and only Pat knows the exception rules.",
            },
          },
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(turnResponse.status).toBe(201);
      const turnJson = await turnResponse.json();
      expect(turnJson.transcript_segments).toHaveLength(1);
      expect(turnJson.evidence).toHaveLength(1);
      expect(turnJson.candidate_process_ids.length).toBeGreaterThan(0);
      const apiEvidenceId = turnJson.evidence[0].id as string;

      await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
        apiOrgId,
      ]);
      await appClient.query(
        `
          INSERT INTO agent_decision_log (
            id,
            org_id,
            workspace_id,
            capture_session_id,
            turn_index,
            stage_name,
            ts_start,
            sanitized_agent_utterance,
            prompt_template_id,
            prompt_template_version,
            delivery_json
          )
          VALUES
            (
              'e4e4e4e4-e4e4-5e4e-8e4e-e4e4e4e4e4e4',
              $1,
              $2,
              $3,
              88,
              'director.turn',
              now() - interval '50 seconds',
              'Planned completed line.',
              'director.turn.plan',
              '1',
              '{"planned_utterance":"Planned completed line.","delivered_utterance":"Delivered completed line.","delivery_status":"completed","spoken_fraction":1}'::jsonb
            ),
            (
              'e5e5e5e5-e5e5-5e5e-8e5e-e5e5e5e5e5e5',
              $1,
              $2,
              $3,
              89,
              'director.notice.asr_stall',
              now() - interval '40 seconds',
              'Pending reload line.',
              'director.notice.asr_stall',
              '1',
              '{"planned_utterance":"Pending reload line.","delivery_status":"pending","spoken_fraction":0}'::jsonb
            ),
            (
              'e6e6e6e6-e6e6-5e6e-8e6e-e6e6e6e6e6e6',
              $1,
              $2,
              $3,
              90,
              'director.turn',
              now() - interval '30 seconds',
              'Full interrupted reload line.',
              'director.turn.plan',
              '1',
              '{"planned_utterance":"Full interrupted reload line.","delivered_utterance":"","delivery_status":"truncated","spoken_fraction":0}'::jsonb
            ),
            (
              'e7e7e7e7-e7e7-5e7e-8e7e-e7e7e7e7e7e7',
              $1,
              $2,
              $3,
              91,
              'director.turn',
              now() - interval '20 seconds',
              'Full partial reload line.',
              'director.turn.plan',
              '1',
              '{"planned_utterance":"Partial reload line continues after the interruption.","delivered_utterance":"Partial reload line...","delivery_status":"truncated","spoken_fraction":0.3}'::jsonb
            )
          ON CONFLICT (id) DO UPDATE SET delivery_json = excluded.delivery_json
        `,
        [apiOrgId, apiWorkspaceId, captureSessionId],
      );

      const turnsHistoryResponse = await turnsRoute.GET(
        new Request(
          `http://otto.test/api/director-interviews/${captureSessionId}/turns?workspace_id=${apiWorkspaceId}`,
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(turnsHistoryResponse.status).toBe(200);
      const turnsHistoryJson = await turnsHistoryResponse.json();
      const transcriptTexts = turnsHistoryJson.messages.map(
        (message: { text: string }) => message.text,
      );
      expect(transcriptTexts).toContain(
        "We run renewal review weekly in Salesforce. The owner is Revenue Operations, and only Pat knows the exception rules.",
      );
      expect(transcriptTexts).toContain("Delivered completed line.");
      expect(transcriptTexts).toContain("Partial reload line...");
      expect(transcriptTexts).not.toContain("Planned completed line.");
      expect(transcriptTexts).not.toContain("Pending reload line.");
      expect(transcriptTexts).not.toContain("Full interrupted reload line.");
      expect(transcriptTexts).not.toContain(
        "Partial reload line continues after the interruption.",
      );
      await appClient.query(
        `DELETE FROM agent_decision_log
          WHERE id IN (
            'e4e4e4e4-e4e4-5e4e-8e4e-e4e4e4e4e4e4',
            'e5e5e5e5-e5e5-5e5e-8e5e-e5e5e5e5e5e5',
            'e6e6e6e6-e6e6-5e6e-8e6e-e6e6e6e6e6e6',
            'e7e7e7e7-e7e7-5e7e-8e7e-e7e7e7e7e7e7'
          )`,
      );

      const forgedTurnResponse = await turnsRoute.POST(
        apiRequest(
          `http://otto.test/api/director-interviews/${captureSessionId}/turns`,
          {
            idempotencyKey: "api-turn-forged-context",
            body: {
              workspace_id: apiWorkspaceId,
              utterance: "This should not be accepted with forged context.",
              org_id: "11111111-1111-4111-8111-111111111111",
              user_id: "33333333-3333-4333-8333-333333333333",
            },
          },
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(forgedTurnResponse.status).toBe(400);
      const forgedTurnJson = await forgedTurnResponse.json();
      expect(forgedTurnJson.error.issues[0].code).toBe("unrecognized_keys");

      const coverageResponse = await coverageRoute.GET(
        new Request(
          `http://otto.test/api/director-interviews/${captureSessionId}/coverage?workspace_id=${apiWorkspaceId}`,
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(coverageResponse.status).toBe(200);
      const coverageJson = await coverageResponse.json();
      expect(coverageJson.slots.length).toBeGreaterThan(0);

      const evidenceResponse = await evidenceRoute.GET(
        new Request(
          `http://otto.test/api/workspaces/${apiWorkspaceId}/evidence?evidence_id=${apiEvidenceId}`,
        ),
        { params: Promise.resolve({ workspaceId: apiWorkspaceId }) },
      );
      expect(evidenceResponse.status).toBe(200);
      const evidenceJson = await evidenceResponse.json();
      expect(evidenceJson.evidence.id).toBe(apiEvidenceId);

      const forgedCompleteResponse = await completeRoute.POST(
        apiRequest(
          `http://otto.test/api/director-interviews/${captureSessionId}/complete`,
          {
            idempotencyKey: "api-complete-forged-context",
            body: {
              workspace_id: apiWorkspaceId,
              org_id: "11111111-1111-4111-8111-111111111111",
              user_id: "33333333-3333-4333-8333-333333333333",
            },
          },
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(forgedCompleteResponse.status).toBe(400);
      const forgedCompleteJson = await forgedCompleteResponse.json();
      expect(forgedCompleteJson.error.issues[0].code).toBe("unrecognized_keys");

      const completeResponse = await completeRoute.POST(
        apiRequest(
          `http://otto.test/api/director-interviews/${captureSessionId}/complete`,
          {
            idempotencyKey: "api-complete",
            body: { workspace_id: apiWorkspaceId },
          },
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(completeResponse.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);

      const repeatedCompleteResponse = await completeRoute.POST(
        apiRequest(
          `http://otto.test/api/director-interviews/${captureSessionId}/complete`,
          {
            idempotencyKey: "api-complete-after-completed",
            body: { workspace_id: apiWorkspaceId },
          },
        ),
        { params: Promise.resolve({ captureSessionId }) },
      );
      expect(repeatedCompleteResponse.status).toBe(200);
      expect(sendSpy).toHaveBeenCalledTimes(1);

      const presignResponse = await presignRoute.POST(
        apiRequest(
          `http://otto.test/api/workspaces/${apiWorkspaceId}/artifacts/presign`,
          {
            idempotencyKey: "api-presign",
            body: {
              filename: "sample.txt",
              mime_type: "text/plain",
              size_bytes: 128,
              artifact_type: "document",
            },
          },
        ),
        { params: Promise.resolve({ workspaceId: apiWorkspaceId }) },
      );
      expect(presignResponse.status).toBe(201);
      const presignJson = await presignResponse.json();
      const apiArtifactId = presignJson.artifact.id as string;
      expect(presignJson.proxy_upload_url).toBe(
        `/api/artifacts/${apiArtifactId}/upload`,
      );

      const artifactUploadResponse = await artifactUploadRoute.PUT(
        new Request(`http://otto.test/api/artifacts/${apiArtifactId}/upload`, {
          method: "PUT",
          headers: {
            "content-type": "text/plain",
            "content-length": "46",
          },
          body: "Process: Returns\nOwner: Support Ops\nCadence: weekly",
        }),
        { params: Promise.resolve({ artifactId: apiArtifactId }) },
      );
      expect(artifactUploadResponse.status).toBe(200);
      const artifactUploadJson = await artifactUploadResponse.json();
      expect(artifactUploadJson).toMatchObject({
        ok: true,
        artifact_id: apiArtifactId,
        storage: "local",
      });

      const artifactCompleteResponse = await artifactCompleteRoute.POST(
        apiRequest(`http://otto.test/api/artifacts/${apiArtifactId}/complete`, {
          idempotencyKey: "api-artifact-complete",
          body: { workspace_id: apiWorkspaceId },
        }),
        { params: Promise.resolve({ artifactId: apiArtifactId }) },
      );
      expect(artifactCompleteResponse.status).toBe(200);
      const artifactCompleteJson = await artifactCompleteResponse.json();
      expect(artifactCompleteJson.capture_session_id).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(sendSpy).toHaveBeenCalled();

      await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
        apiOrgId,
      ]);
      const auditRows = await appClient.query(
        "SELECT count(*)::int AS opened FROM audit_log WHERE event_type = 'evidence.opened' AND subject_id = $1",
        [apiEvidenceId],
      );
      expect(auditRows.rows[0].opened).toBe(1);
    } finally {
      sendSpy.mockRestore();
      if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
    }
  });

  test("LiveKit room route is idempotent across start retries and token refreshes", async () => {
    const workspacesRoute = await import("@/app/api/workspaces/route");
    const interviewsRoute = await import("@/app/api/director-interviews/route");
    const workspaceResponse = await workspacesRoute.POST(
      apiRequest("http://otto.test/api/workspaces", {
        idempotencyKey: "livekit-room-workspace",
        body: {
          name: "LiveKit Room Retry Workspace",
          function_name: "Commercial",
          create_starter_process: false,
        },
      }),
    );
    expect(workspaceResponse.status).toBe(201);
    const workspaceJson = await workspaceResponse.json();
    const apiWorkspaceId = workspaceJson.workspace.id as string;
    const apiOrgId = workspaceJson.workspace.orgId as string;

    const interviewResponse = await interviewsRoute.POST(
      apiRequest("http://otto.test/api/director-interviews", {
        idempotencyKey: "livekit-room-interview",
        body: {
          workspace_id: apiWorkspaceId,
          language: "en",
          consent_acknowledged: true,
          consent_text_version: "director_voice_v1",
        },
      }),
    );
    expect(interviewResponse.status).toBe(201);
    const interviewJson = await interviewResponse.json();
    const captureSessionId = interviewJson.capture_session.id as string;

    const roomPayload = {
      mode: "livekit" as const,
      room: `director-${captureSessionId}`,
      url: "wss://otto.livekit.cloud",
      token: "join-token",
      tokenExpiresAt: "2026-05-25T12:00:00.000Z",
      agentName: "otto-director",
      agentParticipantIdentity: `otto-director-agent-${captureSessionId}`,
      dispatchId: "dispatch-1",
    };
    const createDirectorRoomToken = vi.fn(async () => roomPayload);
    vi.doMock("@/lib/adapters/livekit", () => ({
      createDirectorRoomToken,
      directorVoiceReadiness: vi.fn(() => ({
        mode: "livekit",
        requiresMicrophone: true,
        missing: [],
        reason: null,
      })),
      DirectorVoiceConfigurationError: class DirectorVoiceConfigurationError extends Error {
        constructor(public readonly missing: string[]) {
          super("LiveKit voice is not fully configured.");
        }
      },
    }));

    try {
      const roomRoute = await import("@/app/api/livekit/director-room/route");
      const body = {
        workspace_id: apiWorkspaceId,
        capture_session_id: captureSessionId,
      };
      const first = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-start-retry",
          body,
        }),
      );
      expect(first.status).toBe(200);
      const firstJson = await first.json();

      const repeated = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-start-retry",
          body,
        }),
      );
      expect(repeated.status).toBe(200);
      const repeatedJson = await repeated.json();

      expect(repeatedJson).toEqual(firstJson);
      expect(createDirectorRoomToken).toHaveBeenCalledTimes(1);
      const participantIdentity = (
        createDirectorRoomToken as unknown as {
          mock: { calls: Array<[{ participantIdentity: string }]> };
        }
      ).mock.calls[0][0].participantIdentity;
      expect(participantIdentity).toEqual(expect.any(String));
      expect(createDirectorRoomToken).toHaveBeenCalledWith({
        captureSessionId,
        participantIdentity,
        language: "en",
      });

      const refreshed = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-refresh-new-token",
          body,
        }),
      );
      expect(refreshed.status).toBe(200);
      const refreshedJson = await refreshed.json();
      expect(refreshedJson).toEqual(firstJson);
      expect(createDirectorRoomToken).toHaveBeenCalledTimes(2);

      await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
        apiOrgId,
      ]);
      await appClient.query(
        `
          UPDATE audit_log
          SET metadata_json = metadata_json - 'agent_participant_identity'
          WHERE event_type = 'capture.director_voice.vendor_export'
            AND subject_id = $1
        `,
        [captureSessionId],
      );
      const repaired = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-refresh-repair-agent-identity",
          body,
        }),
      );
      expect(repaired.status).toBe(200);
      expect(createDirectorRoomToken).toHaveBeenCalledTimes(3);

      const forgedContext = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-forged-context",
          body: {
            ...body,
            org_id: "11111111-1111-4111-8111-111111111111",
            user_id: "33333333-3333-4333-8333-333333333333",
          },
        }),
      );
      expect(forgedContext.status).toBe(400);
      const forgedJson = await forgedContext.json();
      expect(forgedJson.error.issues[0].code).toBe("unrecognized_keys");
      expect(forgedJson.error.issues[0].keys).toEqual(
        expect.arrayContaining(["org_id", "user_id"]),
      );

      const auditRows = await appClient.query(
        `
          SELECT
            count(*)::int AS vendor_exports,
            max(metadata_json #>> '{consent,consent_text_version}') AS consent_text_version,
            bool_or((metadata_json #>> '{consent,consent_acknowledged}')::boolean) AS consent_acknowledged,
            max(metadata_json #>> '{retention_policy,audio_recording_default}') AS audio_recording_default,
            bool_or((metadata_json #>> '{retention_policy,audio_recording_enabled}')::boolean) AS audio_recording_enabled,
            max(metadata_json #>> '{retention_policy,raw_payload_logging}') AS raw_payload_logging,
            max(metadata_json->>'agent_participant_identity') AS agent_participant_identity,
            max(metadata_json->>'director_user_id') AS director_user_id,
            (
              SELECT metadata_json->>'director_user_id'
                FROM capture_sessions
               WHERE id = $1
            ) AS capture_director_user_id
          FROM audit_log
          WHERE event_type = 'capture.director_voice.vendor_export'
            AND subject_id = $1
        `,
        [captureSessionId],
      );
      expect(auditRows.rows[0]).toMatchObject({
        vendor_exports: 1,
        consent_text_version: "director_voice_v1",
        consent_acknowledged: true,
        audio_recording_default: "off",
        audio_recording_enabled: false,
        raw_payload_logging: "off",
        agent_participant_identity: `otto-director-agent-${captureSessionId}`,
        director_user_id: participantIdentity,
        capture_director_user_id: participantIdentity,
      });

      await appClient.query(
        `
          UPDATE capture_sessions
          SET metadata_json = metadata_json || '{"audio_retention_enabled": true, "audio_retention_days": 45}'::jsonb
          WHERE id = $1
        `,
        [captureSessionId],
      );
      const retained = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-retention-enabled",
          body,
        }),
      );
      expect(retained.status).toBe(200);
      expect(createDirectorRoomToken).toHaveBeenCalledTimes(4);
      const retentionRows = await appClient.query(
        `
          SELECT
            count(*) FILTER (
              WHERE event_type = 'capture.director_voice.audio_retention_enabled'
            )::int AS retention_audits,
            max(metadata_json #>> '{retention_policy,audio_recording_enabled}') FILTER (
              WHERE event_type = 'capture.director_voice.vendor_export'
            ) AS vendor_audio_retention_enabled,
            max(metadata_json #>> '{retention_policy,audio_retention_days}') FILTER (
              WHERE event_type = 'capture.director_voice.audio_retention_enabled'
            ) AS retention_days
          FROM audit_log
          WHERE subject_id = $1
            AND event_type IN (
              'capture.director_voice.vendor_export',
              'capture.director_voice.audio_retention_enabled'
            )
        `,
        [captureSessionId],
      );
      expect(retentionRows.rows[0]).toMatchObject({
        retention_audits: 1,
        vendor_audio_retention_enabled: "true",
        retention_days: "45",
      });

      await appClient.query(
        `
          UPDATE capture_sessions
          SET metadata_json = metadata_json || jsonb_build_object(
            'raw_payload_logging_enabled', true,
            'raw_payload_logging_expires_at', '2026-05-24T00:00:00.000Z'
          )
          WHERE id = $1
        `,
        [captureSessionId],
      );
      const rawLogging = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-raw-payload-logging-enabled",
          body,
        }),
      );
      expect(rawLogging.status).toBe(200);
      expect(createDirectorRoomToken).toHaveBeenCalledTimes(5);
      const rawLoggingRows = await appClient.query(
        `
          SELECT
            count(*) FILTER (
              WHERE event_type = 'capture.director_voice.raw_payload_logging_enabled'
            )::int AS raw_payload_logging_audits,
            max(metadata_json #>> '{retention_policy,raw_payload_logging}') FILTER (
              WHERE event_type = 'capture.director_voice.vendor_export'
            ) AS vendor_raw_payload_logging,
            max(metadata_json #>> '{retention_policy,raw_payload_logging_expires_at}') FILTER (
              WHERE event_type = 'capture.director_voice.raw_payload_logging_enabled'
            ) AS raw_payload_logging_expires_at
          FROM audit_log
          WHERE subject_id = $1
            AND event_type IN (
              'capture.director_voice.vendor_export',
              'capture.director_voice.raw_payload_logging_enabled'
            )
        `,
        [captureSessionId],
      );
      expect(rawLoggingRows.rows[0]).toMatchObject({
        raw_payload_logging_audits: 1,
        vendor_raw_payload_logging: "debug_window_enabled",
        raw_payload_logging_expires_at: "2026-05-24T00:00:00.000Z",
      });

      await appClient.query(
        "UPDATE capture_sessions SET completed_at = now(), updated_at = now() WHERE id = $1",
        [captureSessionId],
      );
      const completedRoom = await roomRoute.POST(
        apiRequest("http://otto.test/api/livekit/director-room", {
          idempotencyKey: "livekit-room-completed-capture",
          body,
        }),
      );
      expect(completedRoom.status).toBe(409);
      const completedJson = await completedRoom.json();
      expect(completedJson.error.message).toBe(
        "Director interview is already completed.",
      );
      expect(createDirectorRoomToken).toHaveBeenCalledTimes(5);
    } finally {
      vi.doUnmock("@/lib/adapters/livekit");
    }
  });

  test("director session verification flags duplicate vendor export audits", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [duplicateVendorAuditCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO audit_log (
          org_id,
          workspace_id,
          user_id,
          event_type,
          subject_type,
          subject_id,
          metadata_json
        )
        SELECT
          $1,
          $2,
          $3,
          'capture.director_voice.vendor_export',
          'capture_session',
          $4,
          jsonb_build_object(
            'room_mode', 'livekit',
            'vendors', jsonb_build_array('livekit', 'deepgram', 'cartesia', 'anthropic'),
            'vendor_privacy_controls', jsonb_build_object(
              'vendor_privacy_ack', true,
              'deepgram_no_store_ack', true,
              'cartesia_no_retention_ack', true,
              'anthropic_raw_logging_off_ack', true
            )
          )
        FROM generate_series(1, 2)
      `,
      [orgId, workspaceId, userId, duplicateVendorAuditCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: duplicateVendorAuditCaptureId,
      userId,
      language: "en",
    });

    expect(verification.vendor_privacy).toMatchObject({
      vendor_export_audits: 2,
      livekit_vendor_export_audits: 2,
      anthropic_vendor_export_audits: 2,
      privacy_ack_vendor_export_audits: 2,
    });
    expect(verification.acceptance.has_vendor_export_audit).toBe(true);
    expect(verification.acceptance.no_duplicate_vendor_export_audits).toBe(false);
    expect(verification.failed_acceptance_checks).toContain(
      "no_duplicate_vendor_export_audits",
    );
  });

  test("director session verification flags duplicate candidate process names", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [duplicateCandidateVerificationCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO candidate_processes (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          proposed_name,
          proposed_function
        )
        VALUES
          ($1, $3, $4, $5, 'Quote   Approvals', 'Revenue Operations'),
          ($2, $3, $4, $5, 'quote approvals', 'Revenue Operations')
        ON CONFLICT (id) DO NOTHING
      `,
      [
        duplicateCandidateVerificationIdA,
        duplicateCandidateVerificationIdB,
        orgId,
        workspaceId,
        duplicateCandidateVerificationCaptureId,
      ],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: duplicateCandidateVerificationCaptureId,
      userId,
      language: "en",
    });

    expect(verification.candidate_process_count).toBe(2);
    expect(verification.duplicate_candidate_process_name_groups).toBe(1);
    expect(verification.duplicate_candidate_process_names).toEqual([
      {
        normalized_name: "quote approvals",
        proposed_names: ["Quote   Approvals", "quote approvals"],
      },
    ]);
    expect(verification.acceptance.has_candidate_processes).toBe(true);
    expect(verification.acceptance.no_duplicate_candidate_process_names).toBe(
      false,
    );
    expect(verification.failed_acceptance_checks).toContain(
      "no_duplicate_candidate_process_names",
    );
  });

  test("director session verification requires decision transcript evidence backing", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [missingTurnEvidenceCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          transcript_segment_ids,
          delivery_json,
          model
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '1 minute',
          now(),
          '{}'::uuid[],
          '{"delivery_status":"completed","spoken_fraction":1}'::jsonb,
          'claude-haiku-4-5'
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        missingTurnEvidenceDecisionId,
        orgId,
        workspaceId,
        missingTurnEvidenceCaptureId,
      ],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: missingTurnEvidenceCaptureId,
      userId,
      language: "en",
    });

    expect(verification.decision_turns).toBe(1);
    expect(verification.turn_contract).toEqual({
      decision_turns_with_transcript_segments: 0,
      decision_turns_with_matching_transcript_segments: 0,
      decision_turns_with_transcript_evidence: 0,
    });
    expect(
      verification.acceptance.all_decisions_have_ingested_transcript_evidence,
    ).toBe(false);
    expect(verification.failed_acceptance_checks).toContain(
      "all_decisions_have_ingested_transcript_evidence",
    );
  });

  test("director session verification requires terminal delivery spoken evidence", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [badDeliveryFidelityCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO transcript_segments (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          speaker,
          speaker_role,
          text,
          start_ms,
          end_ms,
          turn_index,
          timing_source,
          metadata_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'director',
          'director',
          'We run quote approvals weekly.',
          1000,
          2400,
          1,
          'asr_metrics',
          '{"source":"livekit_agents","provider":"deepgram","timing":"started_stopped_speaking_at"}'::jsonb
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        badDeliveryFidelityTranscriptId,
        orgId,
        workspaceId,
        badDeliveryFidelityCaptureId,
      ],
    );
    await appClient.query(
      `
        INSERT INTO evidence (
          id,
          org_id,
          workspace_id,
          source_type,
          source_id,
          evidence_label,
          quote
        )
        VALUES (
          $1,
          $2,
          $3,
          'transcript_segment',
          $4,
          'stated_director',
          'We run quote approvals weekly.'
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [badDeliveryFidelityEvidenceId, orgId, workspaceId, badDeliveryFidelityTranscriptId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          transcript_segment_ids,
          delivery_json,
          model
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '1 minute',
          now(),
          ARRAY[$5]::uuid[],
          jsonb_build_object(
            'planned_utterance', 'Where does quote approval start?',
            'delivered_utterance', 'A different sentence.',
            'delivery_status', 'completed',
            'spoken_fraction', 1,
            'latency_ms', jsonb_build_object('turn_total_ms', 900, 'tts_playout_ms', 250),
            'audio_metadata', jsonb_build_object(
              'source', 'livekit_agents',
              'provider', 'cartesia',
              'playout', 'session.say.wait_for_playout'
            )
          ),
          'claude-haiku-4-5'
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        badDeliveryFidelityDecisionId,
        orgId,
        workspaceId,
        badDeliveryFidelityCaptureId,
        badDeliveryFidelityTranscriptId,
      ],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: badDeliveryFidelityCaptureId,
      userId,
      language: "en",
    });

    expect(verification.delivery).toMatchObject({
      completed_turns: 1,
      terminal_delivery_turns: 1,
      delivery_fidelity_turns: 0,
    });
    expect(verification.acceptance.all_delivery_terminal).toBe(true);
    expect(verification.acceptance.has_audible_tts_delivery).toBe(true);
    expect(verification.acceptance.all_terminal_delivery_has_spoken_evidence).toBe(
      false,
    );
    expect(verification.failed_acceptance_checks).toContain(
      "all_terminal_delivery_has_spoken_evidence",
    );
  });

  test("director session verification requires voice prompt spoken evidence", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [badPromptFidelityCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          transcript_segment_ids,
          delivery_json,
          model
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          0,
          'director.opening',
          now() - interval '1 minute',
          now(),
          '{}'::uuid[],
          jsonb_build_object(
            'planned_utterance', 'Hi. What part of the business do you oversee?',
            'delivered_utterance', 'This was not the opening.',
            'delivery_status', 'completed',
            'spoken_fraction', 1,
            'latency_ms', jsonb_build_object('turn_total_ms', 700, 'tts_playout_ms', 700),
            'audio_metadata', jsonb_build_object(
              'source', 'livekit_agents',
              'provider', 'cartesia',
              'playout', 'session.say.wait_for_playout'
            )
          ),
          'claude-haiku-4-5'
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [badPromptFidelityDecisionId, orgId, workspaceId, badPromptFidelityCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: badPromptFidelityCaptureId,
      userId,
      language: "en",
    });

    expect(verification.voice_prompts).toMatchObject({
      prompt_turns: 1,
      opening_prompt_turns: 1,
      terminal_prompt_delivery_turns: 1,
      prompt_delivery_fidelity_turns: 0,
      configured_tts_runtime_prompt_turns: 0,
      privacy_configured_tts_runtime_prompt_turns: 0,
    });
    expect(verification.acceptance.all_voice_prompts_delivery_terminal).toBe(true);
    expect(verification.acceptance.opening_prompt_has_tts_playout).toBe(true);
    expect(verification.acceptance.voice_prompts_have_configured_tts_runtime).toBe(
      false,
    );
    expect(
      verification.acceptance.voice_prompts_have_privacy_configured_tts_runtime,
    ).toBe(false);
    expect(verification.acceptance.all_voice_prompts_have_spoken_evidence).toBe(
      false,
    );
    expect(verification.failed_acceptance_checks).toContain(
      "all_voice_prompts_have_spoken_evidence",
    );
    expect(verification.failed_acceptance_checks).toContain(
      "voice_prompts_have_configured_tts_runtime",
    );
    expect(verification.failed_acceptance_checks).toContain(
      "voice_prompts_have_privacy_configured_tts_runtime",
    );
  });

  test("internal director context resolves identity from capture session only", async () => {
    const previousServiceToken = process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
    process.env.LIVEKIT_AGENT_SERVICE_TOKEN = "service-token";
    const workspacesRoute = await import("@/app/api/workspaces/route");
    const interviewsRoute = await import("@/app/api/director-interviews/route");
    const contextRoute = await import(
      "@/app/api/internal/director-turns/context/route"
    );

    try {
      const workspaceResponse = await workspacesRoute.POST(
        apiRequest("http://otto.test/api/workspaces", {
          idempotencyKey: "internal-context-boundary-workspace",
          body: {
            name: "Internal Context Boundary Workspace",
            function_name: "Operations",
            create_starter_process: false,
          },
        }),
      );
      expect(workspaceResponse.status).toBe(201);
      const workspaceJson = await workspaceResponse.json();
      const apiWorkspaceId = workspaceJson.workspace.id as string;
      const apiOrgId = workspaceJson.workspace.orgId as string;

      const interviewResponse = await interviewsRoute.POST(
        apiRequest("http://otto.test/api/director-interviews", {
          idempotencyKey: "internal-context-boundary-interview",
          body: {
            workspace_id: apiWorkspaceId,
            language: "en-US",
            consent_acknowledged: true,
            consent_text_version: "director_voice_v1",
          },
        }),
      );
      expect(interviewResponse.status).toBe(201);
      const interviewJson = await interviewResponse.json();
      const captureSessionId = interviewJson.capture_session.id as string;

      const response = await contextRoute.POST(
        serviceRequest("http://otto.test/api/internal/director-turns/context", {
          capture_session_id: captureSessionId,
        }),
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.context).toMatchObject({
        org_id: apiOrgId,
        workspace_id: apiWorkspaceId,
        capture_session_id: captureSessionId,
        language: "en-US",
      });

      const forgedResponse = await contextRoute.POST(
        serviceRequest("http://otto.test/api/internal/director-turns/context", {
          capture_session_id: captureSessionId,
          org_id: "11111111-1111-4111-8111-111111111111",
          workspace_id: "22222222-2222-4222-8222-222222222222",
          user_id: "33333333-3333-4333-8333-333333333333",
        }),
      );
      expect(forgedResponse.status).toBe(400);
      const forgedJson = await forgedResponse.json();
      expect(forgedJson.error.issues[0].code).toBe("unrecognized_keys");
      expect(forgedJson.error.issues[0].keys).toEqual(
        expect.arrayContaining(["org_id", "workspace_id", "user_id"]),
      );
    } finally {
      if (previousServiceToken === undefined) {
        delete process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
      } else {
        process.env.LIVEKIT_AGENT_SERVICE_TOKEN = previousServiceToken;
      }
    }
  });

  test("director completion rejects unknown voice delivery states", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO UPDATE SET completed_at = null, updated_at = now()",
      [unknownDeliveryCompletionCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      "DELETE FROM agent_decision_log WHERE capture_session_id = $1",
      [unknownDeliveryCompletionCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES ($1, $2, $3, 1, 'director.turn', now(), 'What systems are involved?', 'director.turn.extract', '1', '{"delivery_status":"mystery"}'::jsonb)
      `,
      [orgId, workspaceId, unknownDeliveryCompletionCaptureId],
    );

    const { getDb, setOrgContext } = await import("@/lib/db/client");
    const { completeDirectorInterviewInTransaction } = await import(
      "@/lib/interview/director/completion"
    );
    await expect(
      getDb().transaction(async (tx) => {
        await setOrgContext(tx, orgId);
        return completeDirectorInterviewInTransaction(tx, {
          orgId,
          workspaceId,
          captureSessionId: unknownDeliveryCompletionCaptureId,
          userId,
          idempotencyKey: "unknown-delivery-complete",
          source: "livekit_agent",
        });
      }),
    ).rejects.toThrow("pending, unknown, or inconsistent voice delivery evidence");

    const completed = await appClient.query(
      "SELECT completed_at FROM capture_sessions WHERE id = $1",
      [unknownDeliveryCompletionCaptureId],
    );
    expect(completed.rows[0].completed_at).toBeNull();
  });

  test("director completion rejects inconsistent terminal delivery evidence", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO UPDATE SET completed_at = null, updated_at = now()",
      [badCompletionDeliveryFidelityCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      "DELETE FROM agent_decision_log WHERE capture_session_id = $1",
      [badCompletionDeliveryFidelityCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES (
          $1,
          $2,
          $3,
          1,
          'director.turn',
          now(),
          'What systems are involved?',
          'director.turn.extract',
          '1',
          jsonb_build_object(
            'delivery_status',
            'completed',
            'planned_utterance',
            'What systems are involved?',
            'delivered_utterance',
            'What metrics are involved?',
            'spoken_fraction',
            1
          )
        )
      `,
      [orgId, workspaceId, badCompletionDeliveryFidelityCaptureId],
    );

    const { getDb, setOrgContext } = await import("@/lib/db/client");
    const { completeDirectorInterviewInTransaction } = await import(
      "@/lib/interview/director/completion"
    );
    await expect(
      getDb().transaction(async (tx) => {
        await setOrgContext(tx, orgId);
        return completeDirectorInterviewInTransaction(tx, {
          orgId,
          workspaceId,
          captureSessionId: badCompletionDeliveryFidelityCaptureId,
          userId,
          idempotencyKey: "bad-delivery-fidelity-complete",
          source: "livekit_agent",
        });
      }),
    ).rejects.toThrow("inconsistent voice delivery evidence");

    const completed = await appClient.query(
      "SELECT completed_at FROM capture_sessions WHERE id = $1",
      [badCompletionDeliveryFidelityCaptureId],
    );
    expect(completed.rows[0].completed_at).toBeNull();
  });

  test("internal delivery update rejects completed playout that differs from planned utterance", async () => {
    const previousServiceToken = process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
    process.env.LIVEKIT_AGENT_SERVICE_TOKEN = "service-token";
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      `
        INSERT INTO capture_sessions (
          id,
          org_id,
          workspace_id,
          capture_type,
          started_at,
          metadata_json
        )
        VALUES (
          $1,
          $2,
          $3,
          'director_interview',
          now(),
          '{"language":"en","director_user_id":"bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb"}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE
          SET completed_at = null,
              metadata_json = excluded.metadata_json,
              updated_at = now()
      `,
      [badDeliveryUpdateCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      "DELETE FROM agent_decision_log WHERE capture_session_id = $1",
      [badDeliveryUpdateCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now(),
          'Which systems are involved?',
          'director.turn.plan',
          '1',
          jsonb_build_object(
            'planned_utterance',
            'Which systems are involved?',
            'delivery_status',
            'pending',
            'spoken_fraction',
            0
          )
        )
      `,
      [
        badDeliveryUpdateDecisionId,
        orgId,
        workspaceId,
        badDeliveryUpdateCaptureId,
      ],
    );

    const deliveryRoute = await import(
      "@/app/api/internal/director-turns/[turnIndex]/delivery/route"
    );
    try {
      const response = await deliveryRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/1/delivery",
          {
            capture_session_id: badDeliveryUpdateCaptureId,
            decision_log_id: badDeliveryUpdateDecisionId,
            delivery_status: "completed",
            delivered_utterance: "Which metrics are involved?",
            spoken_fraction: 1,
          },
          "bad-delivery-update",
        ),
        { params: Promise.resolve({ turnIndex: "1" }) },
      );

      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json.error.message).toContain("planned utterance");
      const persisted = await appClient.query(
        "SELECT delivery_json FROM agent_decision_log WHERE id = $1",
        [badDeliveryUpdateDecisionId],
      );
      expect(persisted.rows[0].delivery_json).toMatchObject({
        delivery_status: "pending",
        spoken_fraction: 0,
      });
    } finally {
      if (previousServiceToken === undefined) {
        delete process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
      } else {
        process.env.LIVEKIT_AGENT_SERVICE_TOKEN = previousServiceToken;
      }
    }
  });

  test("internal delivery update preserves full text for truncated playout with speech", async () => {
    const previousServiceToken = process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
    process.env.LIVEKIT_AGENT_SERVICE_TOKEN = "service-token";
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      `
        INSERT INTO capture_sessions (
          id,
          org_id,
          workspace_id,
          capture_type,
          started_at,
          metadata_json
        )
        VALUES (
          $1,
          $2,
          $3,
          'director_interview',
          now(),
          '{"language":"en","director_user_id":"bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb"}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE
          SET completed_at = null,
              metadata_json = excluded.metadata_json,
              updated_at = now()
      `,
      [fullTruncatedDeliveryCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      "DELETE FROM agent_decision_log WHERE capture_session_id = $1",
      [fullTruncatedDeliveryCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.opening',
          now(),
          'Hi. I''m going to build a high-level map of the processes your team owns.',
          'director.opening',
          '1',
          jsonb_build_object(
            'planned_utterance',
            'Hi. I''m going to build a high-level map of the processes your team owns.',
            'delivery_status',
            'pending',
            'spoken_fraction',
            0
          )
        )
      `,
      [
        fullTruncatedDeliveryDecisionId,
        orgId,
        workspaceId,
        fullTruncatedDeliveryCaptureId,
      ],
    );

    const deliveryRoute = await import(
      "@/app/api/internal/director-turns/[turnIndex]/delivery/route"
    );
    try {
      const fullText =
        "Hi. I'm going to build a high-level map of the processes your team owns.";
      const response = await deliveryRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/1/delivery",
          {
            capture_session_id: fullTruncatedDeliveryCaptureId,
            decision_log_id: fullTruncatedDeliveryDecisionId,
            delivery_status: "truncated",
            delivered_utterance: fullText,
            spoken_fraction: 0.5,
          },
          "full-truncated-delivery-update",
        ),
        { params: Promise.resolve({ turnIndex: "1" }) },
      );

      expect(response.status).toBe(200);
      const persisted = await appClient.query(
        "SELECT delivery_json FROM agent_decision_log WHERE id = $1",
        [fullTruncatedDeliveryDecisionId],
      );
      expect(persisted.rows[0].delivery_json).toMatchObject({
        delivery_status: "truncated",
        delivered_utterance: fullText,
        planned_utterance: fullText,
        spoken_fraction: 0.5,
      });
    } finally {
      if (previousServiceToken === undefined) {
        delete process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
      } else {
        process.env.LIVEKIT_AGENT_SERVICE_TOKEN = previousServiceToken;
      }
    }
  });

  test("browser completion recovers stale pending voice delivery after LiveKit loss", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO UPDATE SET completed_at = null, updated_at = now()",
      [staleBrowserCompletionCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      "DELETE FROM agent_decision_log WHERE capture_session_id = $1",
      [staleBrowserCompletionCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          created_at,
          updated_at,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '10 seconds',
          now() - interval '10 seconds',
          now() - interval '10 seconds',
          'Which systems are involved?',
          'director.turn.plan',
          '1',
          jsonb_build_object(
            'planned_utterance',
            'Which systems are involved?',
            'delivery_status',
            'pending',
            'spoken_fraction',
            0
          )
        )
      `,
      [
        staleBrowserCompletionDecisionId,
        orgId,
        workspaceId,
        staleBrowserCompletionCaptureId,
      ],
    );

    const { getDb, setOrgContext } = await import("@/lib/db/client");
    const { completeDirectorInterviewInTransaction } = await import(
      "@/lib/interview/director/completion"
    );
    const result = await getDb().transaction(async (tx) => {
      await setOrgContext(tx, orgId);
      return completeDirectorInterviewInTransaction(tx, {
        orgId,
        workspaceId,
        captureSessionId: staleBrowserCompletionCaptureId,
        userId,
        idempotencyKey: "stale-browser-complete",
        source: "browser",
      });
    });

    expect(result.statusCode).toBe(200);
    const rows = await appClient.query(
      `
        SELECT
          completed_at IS NOT NULL AS completed,
          (
            SELECT delivery_json
            FROM agent_decision_log
            WHERE id = $2
          ) AS delivery_json,
          (
            SELECT count(*)::int
            FROM audit_log
            WHERE subject_id = $1
              AND event_type = 'capture.director_voice.stale_delivery_recovered'
          ) AS recovery_audits
        FROM capture_sessions
        WHERE id = $1
      `,
      [staleBrowserCompletionCaptureId, staleBrowserCompletionDecisionId],
    );
    expect(rows.rows[0].completed).toBe(true);
    expect(rows.rows[0].delivery_json).toMatchObject({
      delivery_status: "failed_text_fallback",
      delivered_utterance: "Which systems are involved?",
      spoken_fraction: 0,
      browser_completion_recovery: true,
    });
    expect(rows.rows[0].recovery_audits).toBe(1);
  });

  test("director completion waits for the shared turn sequence lock", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO UPDATE SET completed_at = null, updated_at = now()",
      [completionLockCaptureId, orgId, workspaceId],
    );

    const lockClient = new Client({ connectionString });
    await lockClient.connect();
    const { getDb, setOrgContext } = await import("@/lib/db/client");
    const { completeDirectorInterviewInTransaction } = await import(
      "@/lib/interview/director/completion"
    );
    let settled = false;
    let completion: Promise<unknown> | null = null;
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [completionLockCaptureId],
      );

      completion = getDb().transaction(async (tx) => {
        await setOrgContext(tx, orgId);
        return completeDirectorInterviewInTransaction(tx, {
          orgId,
          workspaceId,
          captureSessionId: completionLockCaptureId,
          userId,
          idempotencyKey: "completion-lock",
          source: "livekit_agent",
        });
      }).then((result) => {
        settled = true;
        return result;
      });
      await delay(150);
      expect(settled).toBe(false);

      await lockClient.query("COMMIT");
      const result = await completion;
      expect((result as { statusCode: number }).statusCode).toBe(200);
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      await lockClient.end().catch(() => undefined);
    }

    const completed = await appClient.query(
      "SELECT completed_at FROM capture_sessions WHERE id = $1",
      [completionLockCaptureId],
    );
    expect(completed.rows[0].completed_at).not.toBeNull();
  });

  test("director turn ingest rejects completed capture sessions", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      `
        INSERT INTO capture_sessions (
          id,
          org_id,
          workspace_id,
          capture_type,
          started_at,
          completed_at
        )
        VALUES ($1, $2, $3, 'director_interview', now() - interval '5 minutes', now())
        ON CONFLICT (id) DO UPDATE SET completed_at = now(), updated_at = now()
      `,
      [completedTurnIngestCaptureId, orgId, workspaceId],
    );

    const { getDb, setOrgContext } = await import("@/lib/db/client");
    const { ingestDirectorTurn } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    await expect(
      getDb().transaction(async (tx) => {
        await setOrgContext(tx, orgId);
        return ingestDirectorTurn({
          context: {
            orgId,
            workspaceId,
            captureSessionId: completedTurnIngestCaptureId,
            userId,
            language: "en",
          },
          utterance: "This late answer should not be accepted.",
          tx,
        });
      }),
    ).rejects.toThrow("already completed");

    const rows = await appClient.query(
      "SELECT count(*)::int AS transcript_count FROM transcript_segments WHERE capture_session_id = $1",
      [completedTurnIngestCaptureId],
    );
    expect(rows.rows[0].transcript_count).toBe(0);
  });

  test("internal director worker write routes reject completed capture sessions", async () => {
    const previousServiceToken = process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
    process.env.LIVEKIT_AGENT_SERVICE_TOKEN = "service-token";
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      `
        INSERT INTO capture_sessions (
          id,
          org_id,
          workspace_id,
          capture_type,
          started_at,
          completed_at,
          metadata_json
        )
        VALUES (
          $1,
          $2,
          $3,
          'director_interview',
          now() - interval '5 minutes',
          now(),
          '{"language":"en","director_user_id":"bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb"}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE
          SET completed_at = now(),
              metadata_json = excluded.metadata_json,
              updated_at = now()
      `,
      [completedInternalWriteCaptureId, orgId, workspaceId],
    );

    const openingRoute = await import("@/app/api/internal/director-turns/opening/route");
    const noticeRoute = await import("@/app/api/internal/director-turns/notice/route");
    const respondRoute = await import("@/app/api/internal/director-turns/respond/route");
    const requests = [
      openingRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/opening",
          {
            capture_session_id: completedInternalWriteCaptureId,
            planned_agent_utterance: "What part of the business do you oversee?",
          },
          "completed-opening",
        ),
      ),
      noticeRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/notice",
          {
            capture_session_id: completedInternalWriteCaptureId,
            stage_name: "director.notice.asr_stall",
            turn_index: 1,
            planned_agent_utterance: "I lost your audio. Could you repeat that?",
          },
          "completed-notice",
        ),
      ),
      respondRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/respond",
          {
            capture_session_id: completedInternalWriteCaptureId,
            latest_utterance: "We run forecasting.",
            transcript_segment_ids: [],
            evidence_ids: [],
            turn_index: 1,
          },
          "completed-respond",
        ),
      ),
    ];

    try {
      const responses = await Promise.all(requests);
      for (const response of responses) {
        expect(response.status).toBe(409);
        const json = await response.json();
        expect(json.error.message).toContain("already completed");
      }
      const rows = await appClient.query(
        `
          SELECT
            (SELECT count(*)::int
               FROM agent_decision_log
              WHERE capture_session_id = $1) AS decisions,
            (SELECT count(*)::int
               FROM idempotency_keys
              WHERE org_id = $2
                AND key IN (
                  'completed-opening',
                  'completed-notice',
                  'completed-respond'
                )) AS idempotency_rows
        `,
        [completedInternalWriteCaptureId, orgId],
      );
      expect(rows.rows[0]).toEqual({
        decisions: 0,
        idempotency_rows: 0,
      });
    } finally {
      if (previousServiceToken === undefined) {
        delete process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
      } else {
        process.env.LIVEKIT_AGENT_SERVICE_TOKEN = previousServiceToken;
      }
    }
  });

  test("internal director worker write routes replay cached responses after completion", async () => {
    const previousServiceToken = process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
    process.env.LIVEKIT_AGENT_SERVICE_TOKEN = "service-token";
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      `
        INSERT INTO capture_sessions (
          id,
          org_id,
          workspace_id,
          capture_type,
          started_at,
          metadata_json
        )
        VALUES (
          $1,
          $2,
          $3,
          'director_interview',
          now() - interval '5 minutes',
          '{"language":"en","director_user_id":"bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb"}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE
          SET completed_at = null,
              metadata_json = excluded.metadata_json,
              updated_at = now()
      `,
      [completedIdempotentReplayCaptureId, orgId, workspaceId],
    );

    const openingRoute = await import("@/app/api/internal/director-turns/opening/route");
    const body = {
      capture_session_id: completedIdempotentReplayCaptureId,
      planned_agent_utterance: "What part of the business do you oversee?",
    };

    try {
      const first = await openingRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/opening",
          body,
          "completed-replay-opening",
        ),
      );
      expect(first.status).toBe(201);
      const firstJson = await first.json();

      await appClient.query(
        "UPDATE capture_sessions SET completed_at = now(), updated_at = now() WHERE id = $1",
        [completedIdempotentReplayCaptureId],
      );

      const replay = await openingRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/opening",
          body,
          "completed-replay-opening",
        ),
      );
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(firstJson);

      const newWrite = await openingRoute.POST(
        serviceRequest(
          "http://otto.test/api/internal/director-turns/opening",
          body,
          "completed-replay-new-opening",
        ),
      );
      expect(newWrite.status).toBe(409);

      const rows = await appClient.query(
        `
          SELECT
            (SELECT count(*)::int
               FROM agent_decision_log
              WHERE capture_session_id = $1) AS decisions,
            (SELECT count(*)::int
               FROM idempotency_keys
              WHERE org_id = $2
                AND key IN (
                  'completed-replay-opening',
                  'completed-replay-new-opening'
                )) AS idempotency_rows
        `,
        [completedIdempotentReplayCaptureId, orgId],
      );
      expect(rows.rows[0]).toEqual({
        decisions: 1,
        idempotency_rows: 1,
      });
    } finally {
      if (previousServiceToken === undefined) {
        delete process.env.LIVEKIT_AGENT_SERVICE_TOKEN;
      } else {
        process.env.LIVEKIT_AGENT_SERVICE_TOKEN = previousServiceToken;
      }
    }
  });

  test("director planning context includes recent Otto and director turns", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [recentConversationContextCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '2 minutes',
          'Which systems does forecasting rely on?',
          'director.turn.plan',
          '1',
          '{"planned_utterance":"Which systems does forecasting rely on?","delivery_status":"completed","spoken_fraction":1}'::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET delivery_json = excluded.delivery_json
      `,
      [
        recentConversationDecisionId,
        orgId,
        workspaceId,
        recentConversationContextCaptureId,
      ],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          sanitized_agent_utterance,
          prompt_template_id,
          prompt_template_version,
          delivery_json
        )
        VALUES
          (
            'd1d1d1d1-d1d1-5d1d-8d1d-d1d1d1d1d1d1',
            $1,
            $2,
            $3,
            2,
            'director.notice.asr_stall',
            now() - interval '90 seconds',
            'This pending prompt should not enter context.',
            'director.notice.asr_stall',
            '1',
            '{"planned_utterance":"This pending prompt should not enter context.","delivery_status":"pending","spoken_fraction":0}'::jsonb
          ),
          (
            'd2d2d2d2-d2d2-5d2d-8d2d-d2d2d2d2d2d2',
            $1,
            $2,
            $3,
            3,
            'director.turn',
            now() - interval '80 seconds',
            'This full interrupted prompt should not enter context.',
            'director.turn.plan',
            '1',
            '{"planned_utterance":"This full interrupted prompt should not enter context.","delivered_utterance":"","delivery_status":"truncated","spoken_fraction":0}'::jsonb
          ),
          (
            'd3d3d3d3-d3d3-5d3d-8d3d-d3d3d3d3d3d3',
            $1,
            $2,
            $3,
            4,
            'director.turn',
            now() - interval '70 seconds',
            'This full prompt should be replaced by the heard fragment.',
            'director.turn.plan',
            '1',
            '{"planned_utterance":"This full prompt should be replaced by the heard fragment.","delivered_utterance":"This was partly heard...","delivery_status":"truncated","spoken_fraction":0.42}'::jsonb
          )
        ON CONFLICT (id) DO UPDATE SET delivery_json = excluded.delivery_json
      `,
      [orgId, workspaceId, recentConversationContextCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO transcript_segments (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          speaker,
          speaker_role,
          start_ms,
          end_ms,
          turn_index,
          text,
          confidence
        )
        VALUES ($1, $2, $3, $4, 'director', 'director', 1000, 2400, 2, 'Forecasting is in Salesforce and Sheets.', 0.94)
        ON CONFLICT (id) DO UPDATE SET text = excluded.text
      `,
      [
        recentConversationTranscriptId,
        orgId,
        workspaceId,
        recentConversationContextCaptureId,
      ],
    );

    const { readDirectorPlanningContext } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const context = await readDirectorPlanningContext({
      orgId,
      workspaceId,
      captureSessionId: recentConversationContextCaptureId,
      userId,
      language: "en",
    });

    expect(context.recent_turns).toEqual([
      "Otto: Which systems does forecasting rely on?",
      "Otto: This was partly heard...",
      "Director: Forecasting is in Salesforce and Sheets.",
    ]);
    expect(context.next_turn_index).toBe(5);
  });

  test("Week 5 degraded director turns wait for real Anthropic recovery", async () => {
    await seedWeek5DegradedTurnGraph(appClient);
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const { recoverDegradedDirectorTurnsForOrgs } = await import(
        "@/lib/inngest/functions"
      );
      const result = await recoverDegradedDirectorTurnsForOrgs([orgId]);

      expect(result.recovered).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
        orgId,
      ]);
      const rows = await appClient.query(
        `
        SELECT
          (SELECT count(*)::int FROM candidate_processes WHERE capture_session_id = $1 AND proposed_name = 'Renewal Review Weekly In Salesforce') AS recovered_candidates,
          (SELECT count(*)::int FROM agent_decision_log WHERE stage_name = 're_extract_degraded_turns.recovered' AND tool_calls->>'source_agent_decision_log_id' = $2) AS recovered_markers,
          (SELECT count(*)::int FROM agent_decision_log WHERE stage_name = 're_extract_degraded_turns.skipped' AND tool_calls->>'source_agent_decision_log_id' = $2 AND tool_calls->>'reason' = 'missing_anthropic_api_key') AS skipped_markers
      `,
        [directorCaptureId, week5DegradedDecisionId],
      );

      expect(rows.rows[0]).toEqual({
        recovered_candidates: 0,
        recovered_markers: 0,
        skipped_markers: 1,
      });
    } finally {
      if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
    }
  });

  test("director session verification treats recovered degraded turns as resolved", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [recoveredVerificationCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          delivery_json,
          model,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '5 minutes',
          now() - interval '4 minutes',
          'director.turn.plan',
          '1',
          '{"delivery_status":"completed","spoken_fraction":1,"latency_ms":{"turn_total_ms":900,"tts_playout_ms":250}}'::jsonb,
          'deterministic-director-fallback',
          true
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        recoveredVerificationDecisionId,
        orgId,
        workspaceId,
        recoveredVerificationCaptureId,
      ],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          tool_calls,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          're_extract_degraded_turns.recovered',
          now() - interval '3 minutes',
          now() - interval '2 minutes',
          'director.turn.re-extract-degraded',
          '1',
          jsonb_build_object('source_agent_decision_log_id', $5::text),
          false
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        recoveredVerificationMarkerId,
        orgId,
        workspaceId,
        recoveredVerificationCaptureId,
        recoveredVerificationDecisionId,
      ],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: recoveredVerificationCaptureId,
      userId,
      language: "en",
    });

    expect(verification.brain).toMatchObject({
      degraded_turns: 1,
      recovered_degraded_turns: 1,
      unresolved_degraded_turns: 0,
    });
    expect(verification.telemetry).toMatchObject({
      degraded_turns: 1,
      recovered_degraded_turns: 1,
      unresolved_degraded_turns: 0,
    });
    expect(verification.acceptance.no_degraded_turns).toBe(true);
  });

  test("director session verification counts both brain and voice model cost", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [twoCallCostCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          model,
          token_count_input,
          token_count_output,
          cost_cents,
          latency_ms,
          cache_hit,
          delivery_json,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '1 minute',
          now(),
          'director.turn.plan',
          '1',
          'claude-haiku-4-5',
          100,
          20,
          0.50,
          400,
          true,
          jsonb_build_object(
            'delivery_status', 'completed',
            'planned_utterance', 'What part of the business do you oversee?',
            'delivered_utterance', 'What part of the business do you oversee?',
            'spoken_fraction', 1,
            'latency_ms', jsonb_build_object('turn_total_ms', 900, 'tts_playout_ms', 250),
            'voice_metadata', jsonb_build_object(
              'model', 'claude-sonnet-4-6',
              'prompt_template_id', 'director.voice.phrase-intent',
              'prompt_template_version', '1',
              'token_count_input', 80,
              'token_count_output', 15,
              'cost_cents', 0.75,
              'latency_ms', 300,
              'cache_hit', false
            )
          ),
          false
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [twoCallCostDecisionId, orgId, workspaceId, twoCallCostCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: twoCallCostCaptureId,
      userId,
      language: "en",
    });

    expect(verification.telemetry.total_cost_cents).toBeCloseTo(1.25);
    expect(verification.acceptance.total_cost_within_2x_baseline).toBe(true);
  });

  test("director session verification reports voice timeout separately from extraction degradation", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [voiceTimeoutFallbackCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          model,
          delivery_json,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '1 minute',
          now(),
          'director.turn.plan',
          '1',
          'claude-haiku-4-5',
          jsonb_build_object(
            'delivery_status', 'completed',
            'planned_utterance', 'Before we wrap, can we cover the biggest gap?',
            'delivered_utterance', 'Before we wrap, can we cover the biggest gap?',
            'spoken_fraction', 1,
            'latency_ms', jsonb_build_object('turn_total_ms', 900, 'tts_playout_ms', 250),
            'voice_metadata', jsonb_build_object(
              'model', 'deterministic-python-voice',
              'prompt_template_id', 'director.voice.phrase-intent',
              'voice_timeout_fallback', true,
              'voice_degraded', true,
              'voice_timeout_ms', 1,
              'attempted_model', 'claude-sonnet-4-6'
            )
          ),
          false
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        voiceTimeoutFallbackDecisionId,
        orgId,
        workspaceId,
        voiceTimeoutFallbackCaptureId,
      ],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: voiceTimeoutFallbackCaptureId,
      userId,
      language: "en",
    });

    expect(verification.brain.unresolved_degraded_turns).toBe(0);
    expect(verification.acceptance.no_degraded_turns).toBe(true);
    expect(verification.voice).toMatchObject({
      voice_timeout_fallback_turns: 1,
      voice_degraded_turns: 1,
    });
    expect(verification.telemetry).toMatchObject({
      voice_timeout_fallback_turns: 1,
      voice_degraded_turns: 1,
    });
  });

  test("director session verification enforces prompt cache hit-rate target", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [cacheHitRateCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          model,
          token_count_input,
          token_count_output,
          cost_cents,
          latency_ms,
          cache_hit,
          delivery_json,
          degraded_quality
        )
        SELECT
          gen_random_uuid(),
          $1,
          $2,
          $3,
          turn_index,
          'director.turn',
          now() - ((4 - turn_index) || ' minutes')::interval,
          now() - ((4 - turn_index) || ' minutes')::interval + interval '1 second',
          'director.turn.plan',
          '1',
          'claude-haiku-4-5',
          100,
          20,
          0.25,
          400,
          turn_index IN (2, 3),
          jsonb_build_object(
            'delivery_status', 'completed',
            'planned_utterance', 'Question ' || turn_index,
            'delivered_utterance', 'Question ' || turn_index,
            'spoken_fraction', 1,
            'latency_ms', jsonb_build_object('turn_total_ms', 900, 'tts_playout_ms', 250),
            'voice_metadata', jsonb_build_object(
              'model', 'claude-sonnet-4-6',
              'prompt_template_id', 'director.voice.phrase-intent',
              'prompt_template_version', '1',
              'token_count_input', 80,
              'token_count_output', 15,
              'cost_cents', 0.25,
              'latency_ms', 300,
              'cache_hit', turn_index IN (2, 3),
              'cache_read_input_tokens', CASE WHEN turn_index IN (2, 3) THEN 120 ELSE 0 END,
              'cache_creation_input_tokens', CASE WHEN turn_index = 1 THEN 120 ELSE 0 END
            ),
            'brain_metadata', jsonb_build_object(
              'cache_read_input_tokens', CASE WHEN turn_index IN (2, 3) THEN 240 ELSE 0 END,
              'cache_creation_input_tokens', CASE WHEN turn_index = 1 THEN 240 ELSE 0 END
            )
          ),
          false
        FROM generate_series(1, 3) AS turn_index
      `,
      [orgId, workspaceId, cacheHitRateCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: cacheHitRateCaptureId,
      userId,
      language: "en",
    });

    expect(verification.telemetry).toMatchObject({
      llm_cache_hits: 2,
      llm_cache_observed_turns: 3,
      llm_cache_hit_rate: 67,
      voice_cache_hits: 2,
      voice_cache_observed_turns: 3,
      voice_cache_hit_rate: 67,
    });
    expect(verification.acceptance.llm_cache_hit_rate_target).toBe(true);
    expect(verification.acceptance.voice_cache_hit_rate_target).toBe(true);
  });

  test("director session verification requires first-question streamed voice evidence", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [streamedVoiceCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          model,
          token_count_input,
          token_count_output,
          cost_cents,
          latency_ms,
          cache_hit,
          delivery_json,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '1 minute',
          now(),
          'director.turn.plan',
          '1',
          'claude-haiku-4-5',
          100,
          20,
          0.50,
          400,
          true,
          jsonb_build_object(
            'delivery_status', 'completed',
            'planned_utterance', 'What part of the business do you oversee?',
            'delivered_utterance', 'What part of the business do you oversee?',
            'spoken_fraction', 1,
            'latency_ms', jsonb_build_object('turn_total_ms', 900, 'tts_playout_ms', 250),
            'voice_metadata', jsonb_build_object(
              'model', 'claude-sonnet-4-6',
              'prompt_template_id', 'director.voice.phrase-intent',
              'prompt_template_version', '1',
              'streaming', true,
              'stream_cutoff', 'message_stop',
              'token_count_input', 80,
              'token_count_output', 15,
              'cost_cents', 0.75,
              'latency_ms', 300,
              'cache_hit', true
            )
          ),
          false
        )
        ON CONFLICT (id) DO UPDATE SET delivery_json = excluded.delivery_json
      `,
      [streamedVoiceDecisionId, orgId, workspaceId, streamedVoiceCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const before = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: streamedVoiceCaptureId,
      userId,
      language: "en",
    });
    expect(before.voice.streamed_voice_turns).toBe(0);
    expect(before.acceptance.has_streamed_voice_turn).toBe(false);

    await appClient.query(
      `
        UPDATE agent_decision_log
        SET delivery_json = jsonb_set(
          delivery_json,
          '{voice_metadata,stream_cutoff}',
          '"first_question"'::jsonb
        )
        WHERE id = $1
      `,
      [streamedVoiceDecisionId],
    );
    const after = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: streamedVoiceCaptureId,
      userId,
      language: "en",
    });
    expect(after.voice.streamed_voice_turns).toBe(1);
    expect(after.acceptance.has_streamed_voice_turn).toBe(true);
  });

  test("director session verification requires LiveKit Deepgram metadata for real ASR timing", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [asrVerificationCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO transcript_segments (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          speaker,
          speaker_role,
          start_ms,
          end_ms,
          turn_index,
          text,
          timing_source,
          metadata_json,
          confidence
        )
        VALUES ($1, $2, $3, $4, 'director', 'director', 1000, 2400, 1, 'Forecasting is weekly.', 'asr_metrics', '{"source":"livekit_agents","provider":"deepgram"}'::jsonb, 0.94)
        ON CONFLICT (id) DO NOTHING
      `,
      [bareAsrTranscriptId, orgId, workspaceId, asrVerificationCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const beforeMetadata = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: asrVerificationCaptureId,
      userId,
      language: "en",
    });
    expect(beforeMetadata.asr_timing).toMatchObject({
      asr_metrics_turns: 1,
      asr_metrics_segments: 1,
      livekit_deepgram_asr_metrics_turns: 0,
      livekit_deepgram_asr_metrics_segments: 0,
      configured_asr_runtime_turns: 0,
      configured_asr_runtime_segments: 0,
      privacy_configured_asr_runtime_turns: 0,
      privacy_configured_asr_runtime_segments: 0,
    });
    expect(beforeMetadata.transcript_turns).toBe(1);
    expect(beforeMetadata.transcript_segments).toBe(1);
    expect(beforeMetadata.acceptance.has_real_asr_timing).toBe(false);
    expect(beforeMetadata.acceptance.has_configured_asr_runtime).toBe(false);
    expect(beforeMetadata.acceptance.has_privacy_configured_asr_runtime).toBe(false);

    await appClient.query(
      `
        INSERT INTO transcript_segments (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          speaker,
          speaker_role,
          start_ms,
          end_ms,
          turn_index,
          text,
          timing_source,
          metadata_json,
          confidence
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'director',
          'director',
          2500,
          4200,
          2,
          'Quote approvals are painful.',
          'asr_metrics',
          '{"source":"livekit_agents","provider":"deepgram","timing":"started_stopped_speaking_at","model":"nova-3","language":"en","transport":"direct_plugin","vendor_privacy_ack":true,"privacy_no_store_ack":true,"mip_opt_out":true}'::jsonb,
          0.93
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [livekitDeepgramTranscriptId, orgId, workspaceId, asrVerificationCaptureId],
    );
    await appClient.query(
      `
        INSERT INTO transcript_segments (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          speaker,
          speaker_role,
          start_ms,
          end_ms,
          turn_index,
          text,
          timing_source,
          metadata_json,
          confidence
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'director',
          'director',
          4200,
          5100,
          2,
          'Finance gets pulled in late.',
          'asr_metrics',
          '{"source":"livekit_agents","provider":"deepgram","timing":"started_stopped_speaking_at","model":"nova-3","language":"en","transport":"direct_plugin","vendor_privacy_ack":true,"privacy_no_store_ack":true,"mip_opt_out":true}'::jsonb,
          0.91
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        livekitDeepgramTranscriptContinuationId,
        orgId,
        workspaceId,
        asrVerificationCaptureId,
      ],
    );

    const afterMetadata = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: asrVerificationCaptureId,
      userId,
      language: "en",
    });
    expect(afterMetadata.asr_timing).toMatchObject({
      asr_metrics_turns: 2,
      asr_metrics_segments: 3,
      livekit_deepgram_asr_metrics_turns: 1,
      livekit_deepgram_asr_metrics_segments: 2,
      configured_asr_runtime_turns: 1,
      configured_asr_runtime_segments: 2,
      privacy_configured_asr_runtime_turns: 1,
      privacy_configured_asr_runtime_segments: 2,
    });
    expect(afterMetadata.transcript_turns).toBe(2);
    expect(afterMetadata.transcript_segments).toBe(3);
    expect(afterMetadata.acceptance.has_real_asr_timing).toBe(true);
    expect(afterMetadata.acceptance.has_configured_asr_runtime).toBe(true);
    expect(afterMetadata.acceptance.has_privacy_configured_asr_runtime).toBe(true);
  });

  test("director session verification counts missing priority slots from the schema", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [priorityCoverageCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO slot_states (
          org_id,
          workspace_id,
          capture_session_id,
          slot_path,
          status,
          confidence,
          priority
        )
        VALUES ($1, $2, $3, 'function.name', 'filled', 0.92, 100)
        ON CONFLICT (capture_session_id, slot_path)
          WHERE candidate_process_id IS NULL
            AND provisional_step_id IS NULL
        DO UPDATE SET status = 'filled', confidence = 0.92, priority = 100
      `,
      [orgId, workspaceId, priorityCoverageCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const verification = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: priorityCoverageCaptureId,
      userId,
      language: "en",
    });
    const priority1DefinitionCount = directorSlotDefinitions.filter(
      (definition) => definition.priority >= 90,
    ).length;

    expect(verification.priority_1_slots).toBe(priority1DefinitionCount);
    expect(verification.priority_1_covered_slots).toBe(1);
    expect(verification.priority_1_coverage_ratio).toBe(1 / priority1DefinitionCount);
    expect(verification.acceptance.priority_1_progress).toBe(false);
  });

  test("director session verification requires LiveKit Cartesia metadata for TTS playout", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [ttsVerificationCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          delivery_json,
          model,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          1,
          'director.turn',
          now() - interval '5 minutes',
          now() - interval '4 minutes',
          'director.turn.plan',
          '1',
          '{"delivery_status":"completed","spoken_fraction":1,"latency_ms":{"turn_total_ms":900,"tts_playout_ms":250},"audio_metadata":{"source":"livekit_agents","provider":"cartesia"}}'::jsonb,
          'claude-haiku-4-5',
          false
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [bareTtsDecisionId, orgId, workspaceId, ttsVerificationCaptureId],
    );

    const { readDirectorSessionVerification } = await import(
      "@/lib/interview/director/turn-transaction"
    );
    const beforeMetadata = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: ttsVerificationCaptureId,
      userId,
      language: "en",
    });
    expect(beforeMetadata.delivery_timing).toMatchObject({
      tts_playout_turns: 0,
      audible_tts_turns: 0,
      configured_tts_runtime_turns: 0,
      privacy_configured_tts_runtime_turns: 0,
    });
    expect(beforeMetadata.acceptance.has_tts_playout_timing).toBe(false);
    expect(beforeMetadata.acceptance.has_audible_tts_delivery).toBe(false);
    expect(beforeMetadata.acceptance.has_configured_tts_runtime).toBe(false);
    expect(beforeMetadata.acceptance.has_privacy_configured_tts_runtime).toBe(false);

    await appClient.query(
      `
        INSERT INTO agent_decision_log (
          id,
          org_id,
          workspace_id,
          capture_session_id,
          turn_index,
          stage_name,
          ts_start,
          ts_end,
          prompt_template_id,
          prompt_template_version,
          delivery_json,
          model,
          degraded_quality
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          2,
          'director.turn',
          now() - interval '3 minutes',
          now() - interval '2 minutes',
          'director.turn.plan',
          '1',
          '{"delivery_status":"completed","spoken_fraction":1,"latency_ms":{"turn_total_ms":850,"tts_playout_ms":220},"audio_metadata":{"source":"livekit_agents","provider":"cartesia","model":"sonic-2","voice_id":"voice-id","language":"en","transport":"direct_plugin","playout":"session.say.wait_for_playout","vendor_privacy_ack":true,"privacy_no_retention_ack":true}}'::jsonb,
          'claude-haiku-4-5',
          false
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [livekitCartesiaDecisionId, orgId, workspaceId, ttsVerificationCaptureId],
    );

    const afterMetadata = await readDirectorSessionVerification({
      orgId,
      workspaceId,
      captureSessionId: ttsVerificationCaptureId,
      userId,
      language: "en",
    });
    expect(afterMetadata.delivery_timing).toMatchObject({
      tts_playout_turns: 1,
      audible_tts_turns: 1,
      configured_tts_runtime_turns: 1,
      privacy_configured_tts_runtime_turns: 1,
    });
    expect(afterMetadata.acceptance.has_tts_playout_timing).toBe(true);
    expect(afterMetadata.acceptance.has_audible_tts_delivery).toBe(true);
    expect(afterMetadata.acceptance.has_configured_tts_runtime).toBe(true);
    expect(afterMetadata.acceptance.has_privacy_configured_tts_runtime).toBe(true);
  });

  // Task 9: replaying session 83fdd5a6's two function.name turns — the good
  // "VP of operations" answer followed by the garbled deflection "those
  // employees I just mentioned" — must leave the stored slot value as
  // "VP of operations" (the deflection is blocked by the downgrade guard).
  test("a non-answer does not clobber a filled function.name slot", async () => {
    await seedWeek2Graph(appClient);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    await appClient.query(
      "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
      [functionNameClobberCaptureId, orgId, workspaceId],
    );
    await appClient.query(
      `
        INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote)
        VALUES ($1, $2, $3, 'transcript_segment', 'stated_director', 'I am the VP of operations.')
        ON CONFLICT (id) DO NOTHING
      `,
      [functionNameClobberEvidenceId, orgId, workspaceId],
    );

    const { updateSlotState } = await import("@/lib/interview/director/tools");
    const toolContext = {
      orgId,
      workspaceId,
      captureSessionId: functionNameClobberCaptureId,
      userId,
    };

    // Turn 1: the correct answer lands filled.
    await updateSlotState(toolContext, {
      slotPath: "function.name",
      value: { function_name: "VP of operations" },
      status: "filled",
      confidence: 0.9,
      evidenceIds: [functionNameClobberEvidenceId],
    });

    // Turn 2: the garbled deflection tries to overwrite it.
    await updateSlotState(toolContext, {
      slotPath: "function.name",
      value: { function_name: "Those Peep Those Employees I Just Mentioned" },
      status: "filled",
      confidence: 0.78,
      evidenceIds: [functionNameClobberEvidenceId],
    });

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
        SELECT value, status, confidence
        FROM slot_states
        WHERE capture_session_id = $1
          AND slot_path = 'function.name'
          AND candidate_process_id IS NULL
      `,
      [functionNameClobberCaptureId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].value).toEqual({ function_name: "VP of operations" });
    expect(rows.rows[0].status).toBe("filled");
    expect(Number(rows.rows[0].confidence)).toBe(0.9);
  }, 30_000);
});

async function seedWeek2Graph(client: Client) {
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [
    orgId,
  ]);
  await client.query(
    "INSERT INTO organizations (id, workos_organization_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    [orgId, "phase1_org", "Phase 1 Org"],
  );
  await client.query(
    "INSERT INTO users (id, org_id, workos_user_id, email, org_role) VALUES ($1, $2, $3, $4, 'org_admin') ON CONFLICT (id) DO NOTHING",
    [userId, orgId, "phase1_user", "phase1@example.com"],
  );
  await client.query(
    "INSERT INTO workspaces (id, org_id, name, function_name, created_by_user_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
    [workspaceId, orgId, "Commercial Ops", "Commercial", userId],
  );
  await client.query(
    "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'director_interview', now()) ON CONFLICT (id) DO NOTHING",
    [directorCaptureId, orgId, workspaceId],
  );
  await client.query(
    "INSERT INTO capture_sessions (id, org_id, workspace_id, capture_type, started_at) VALUES ($1, $2, $3, 'document_upload', now()) ON CONFLICT (id) DO NOTHING",
    [documentCaptureId, orgId, workspaceId],
  );
  await client.query(
    "INSERT INTO artifacts (id, org_id, workspace_id, capture_session_id, uploaded_by_user_id, artifact_type, status, storage_key, filename, mime_type) VALUES ($1, $2, $3, $4, $5, 'document', 'uploaded', $6, $7, $8) ON CONFLICT (id) DO NOTHING",
    [
      artifactId,
      orgId,
      workspaceId,
      documentCaptureId,
      userId,
      "org/phase1/artifacts/sample.pdf",
      "sample.pdf",
      "application/pdf",
    ],
  );
  await client.query(
    "INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote) VALUES ($1, $2, $3, 'document_chunk', 'documented', $4) ON CONFLICT (id) DO NOTHING",
    [evidenceId, orgId, workspaceId, "Document says promotions require review."],
  );
  await client.query(
    "INSERT INTO candidate_processes (id, org_id, workspace_id, capture_session_id, proposed_name, confidence, evidence_ids) VALUES ($1, $2, $3, $4, $5, 0.82, ARRAY[$6]::uuid[]) ON CONFLICT (id) DO NOTHING",
    [
      candidateProcessId,
      orgId,
      workspaceId,
      directorCaptureId,
      "Promotion Management",
      evidenceId,
    ],
  );
}

async function seedWeek4PromotionGraph(client: Client) {
  await seedWeek2Graph(client);
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [
    orgId,
  ]);
  await client.query(
    "INSERT INTO roles (id, org_id, name, canonical_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [week4OwnerRoleId, orgId, "Category Manager", "category_manager"],
  );
  await client.query(
    "INSERT INTO roles (id, org_id, name, canonical_key) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [week4PersonRoleId, orgId, "Pricing Analyst", "pricing_analyst"],
  );
  await client.query(
    "INSERT INTO people (id, org_id, name, title, source) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    [week4PersonId, orgId, "Pat Price", "Pricing Analyst", "director_interview"],
  );
  await client.query(
    "INSERT INTO systems (id, org_id, name, type, canonical_key) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    [week4SystemId, orgId, "Salesforce", "business_system", "salesforce"],
  );
  await client.query(
    "INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote) VALUES ($1, $2, $3, 'document_chunk', 'documented', $4) ON CONFLICT DO NOTHING",
    [week4EvidenceAId, orgId, workspaceId, "Promotions are reviewed weekly in Salesforce."],
  );
  await client.query(
    "INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote) VALUES ($1, $2, $3, 'transcript_segment', 'stated_director', $4) ON CONFLICT DO NOTHING",
    [week4EvidenceBId, orgId, workspaceId, "Only Pat can resolve pricing exceptions."],
  );
  await client.query(
    `
      INSERT INTO candidate_processes (
        id,
        org_id,
        workspace_id,
        capture_session_id,
        proposed_name,
        proposed_function,
        proposed_owner_role_id,
        frequency,
        complexity_hint,
        confidence,
        evidence_ids
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'weekly', $8, 0.84, ARRAY[$9, $10]::uuid[])
      ON CONFLICT DO NOTHING
    `,
    [
      week4CandidateId,
      orgId,
      workspaceId,
      directorCaptureId,
      "Promotion Exception Review",
      "Category Manager",
      week4OwnerRoleId,
      "Manual exception review and spreadsheet cleanup.",
      week4EvidenceAId,
      week4EvidenceBId,
    ],
  );
  await client.query(
    `
      INSERT INTO claims (id, org_id, workspace_id, subject_type, subject_id, field, value, confidence, metadata_json)
      VALUES ($1, $2, $3, 'system', $4, 'used_in_process', $5::jsonb, 0.82, '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [
      week4SystemClaimId,
      orgId,
      workspaceId,
      week4SystemId,
      JSON.stringify({
        candidate_process_id: week4CandidateId,
        system_name: "Salesforce",
      }),
    ],
  );
  await client.query(
    `
      INSERT INTO claims (id, org_id, workspace_id, subject_type, subject_id, field, value, confidence, metadata_json)
      VALUES ($1, $2, $3, 'person', $4, 'role', $5::jsonb, 0.82, $6::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [
      week4PersonClaimId,
      orgId,
      workspaceId,
      week4PersonId,
      JSON.stringify("Pricing Analyst"),
      JSON.stringify({ role_id: week4PersonRoleId }),
    ],
  );
  await client.query(
    `
      INSERT INTO claims (id, org_id, workspace_id, subject_type, subject_id, field, value, confidence, metadata_json)
      VALUES
        ($1, $2, $3, 'candidate_process', $4, 'risk', $5::jsonb, 0.82, '{}'::jsonb),
        ($6, $2, $3, 'candidate_process', $4, 'risk', $7::jsonb, 0.79, '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `,
    [
      week4RiskClaimAId,
      orgId,
      workspaceId,
      week4CandidateId,
      JSON.stringify({ type: "single_point_of_failure", text: "Only Pat resolves pricing exceptions." }),
      week4RiskClaimBId,
      JSON.stringify({ type: "audit_gap", text: "Approval trail is spread across email." }),
    ],
  );
  for (const [claimId, evidence] of [
    [week4SystemClaimId, week4EvidenceAId],
    [week4PersonClaimId, week4EvidenceBId],
    [week4RiskClaimAId, week4EvidenceBId],
    [week4RiskClaimBId, week4EvidenceAId],
  ]) {
    await client.query(
      "INSERT INTO claim_evidence (claim_id, evidence_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [claimId, evidence],
    );
  }
}

async function seedWeek4MergeCandidate(client: Client) {
  await seedWeek2Graph(client);
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [
    orgId,
  ]);
  await client.query(
    `
      INSERT INTO processes (
        id,
        org_id,
        workspace_id,
        name,
        description,
        status
      )
      VALUES ($1, $2, $3, 'Promotion Exception Merge Target', 'Existing tracked process for candidate merge testing.', 'draft')
      ON CONFLICT (id)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        updated_at = now()
    `,
    [week4MergeTargetProcessId, orgId, workspaceId],
  );
  await client.query(
    `
      INSERT INTO evidence (
        id,
        org_id,
        workspace_id,
        source_type,
        evidence_label,
        quote
      )
      VALUES ($1, $2, $3, 'transcript_segment', 'stated_director', $4)
      ON CONFLICT (id)
      DO UPDATE SET quote = EXCLUDED.quote, redacted_at = NULL, tombstoned_at = NULL
    `,
    [
      week4MergeEvidenceId,
      orgId,
      workspaceId,
      "Renewal discount exceptions are the same queue as promotion exceptions.",
    ],
  );
  await client.query(
    `
      INSERT INTO candidate_processes (
        id,
        org_id,
        workspace_id,
        capture_session_id,
        proposed_name,
        proposed_function,
        frequency,
        complexity_hint,
        status,
        confidence,
        evidence_ids,
        promoted_process_id
      )
      VALUES ($1, $2, $3, $4, 'Promotion Exception Duplicate', 'Category Manager', 'daily', $5, 'pending', 0.76, ARRAY[$6]::uuid[], NULL)
      ON CONFLICT (id)
      DO UPDATE SET
        status = 'pending',
        proposed_name = EXCLUDED.proposed_name,
        frequency = EXCLUDED.frequency,
        complexity_hint = EXCLUDED.complexity_hint,
        confidence = EXCLUDED.confidence,
        evidence_ids = EXCLUDED.evidence_ids,
        promoted_process_id = NULL
    `,
    [
      week4MergeCandidateId,
      orgId,
      workspaceId,
      directorCaptureId,
      "Duplicate candidate should merge into the existing promotion review process.",
      week4MergeEvidenceId,
    ],
  );
  await client.query(
    `
      INSERT INTO claims (
        id,
        org_id,
        workspace_id,
        subject_type,
        subject_id,
        field,
        value,
        confidence,
        metadata_json
      )
      VALUES ($1, $2, $3, 'candidate_process', $4, 'risk', $5::jsonb, 0.76, '{}'::jsonb)
      ON CONFLICT (id)
      DO UPDATE SET value = EXCLUDED.value, confidence = EXCLUDED.confidence
    `,
    [
      week4MergeRiskClaimId,
      orgId,
      workspaceId,
      week4MergeCandidateId,
      JSON.stringify({
        type: "duplicate_candidate",
        text: "This candidate overlaps the promotion exception queue.",
      }),
    ],
  );
  await client.query(
    `
      INSERT INTO claim_evidence (claim_id, evidence_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
    [week4MergeRiskClaimId, week4MergeEvidenceId],
  );
}

async function seedWeek5CoverageGraph(client: Client) {
  await seedWeek2Graph(client);
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [
    orgId,
  ]);
  await client.query(
    `
      INSERT INTO slot_states (
        org_id,
        workspace_id,
        capture_session_id,
        slot_path,
        value,
        status,
        confidence,
        evidence_ids,
        last_asked_at,
        priority
      )
      VALUES
        ($1, $2, $3, 'scope.boundaries', $4::jsonb, 'filled', 0.91, ARRAY[$5]::uuid[], now(), 100),
        ($1, $2, $3, 'frequency.volume', $6::jsonb, 'partial', 0.55, ARRAY[$5]::uuid[], now(), 80),
        ($1, $2, $3, 'systems.systems_of_record', $7::jsonb, 'conflicting', 0.42, ARRAY[]::uuid[], now(), 85)
      ON CONFLICT (capture_session_id, slot_path)
        WHERE candidate_process_id IS NULL
          AND provisional_step_id IS NULL
      DO UPDATE SET
        value = excluded.value,
        status = excluded.status,
        confidence = excluded.confidence,
        evidence_ids = excluded.evidence_ids,
        last_asked_at = excluded.last_asked_at,
        priority = excluded.priority,
        updated_at = now()
    `,
    [
      orgId,
      workspaceId,
      directorCaptureId,
      JSON.stringify({ text: "Promotion exception review" }),
      evidenceId,
      JSON.stringify({ cadence: "weekly", volume: "unknown" }),
      JSON.stringify({ candidates: ["Salesforce", "Sheets"] }),
    ],
  );
  await client.query(
    `
      INSERT INTO follow_up_tasks (
        id,
        org_id,
        workspace_id,
        capture_session_id,
        task_type,
        title,
        target_type,
        status,
        context_json
      )
      VALUES ($1, $2, $3, $4, 'conflicting_slot', 'Resolve system of record conflict', 'slot_state', 'open', $5::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      week5FollowUpId,
      orgId,
      workspaceId,
      directorCaptureId,
      JSON.stringify({ slot_path: "systems.systems_of_record" }),
    ],
  );
  await client.query(
    "DELETE FROM agent_decision_log WHERE org_id = $1 AND workspace_id = $2 AND capture_session_id = $3 AND stage_name = 'director.turn'",
    [orgId, workspaceId, directorCaptureId],
  );
  await client.query(
    `
      INSERT INTO agent_decision_log (
        org_id,
        workspace_id,
        capture_session_id,
        stage_name,
        ts_start,
        ts_end,
        sanitized_agent_utterance,
        prompt_template_id,
        prompt_template_version,
        model,
        token_count_input,
        token_count_output,
        cost_cents,
        latency_ms,
        cache_hit,
        degraded_quality
      )
      VALUES
        ($1, $2, $3, 'director.turn', now() - interval '2 minutes', now() - interval '119 seconds', 'What systems are involved?', 'director.turn.extract', '1', 'mock', 100, 20, 0.50, 100, true, false),
        ($1, $2, $3, 'director.turn', now() - interval '1 minute', now() - interval '59 seconds', 'Who is the backup?', 'director.turn.extract', '1', 'mock', 120, 30, 0.75, 250, false, true)
    `,
    [orgId, workspaceId, directorCaptureId],
  );
  await client.query(
    `
      INSERT INTO synthesis_runs (
        id,
        org_id,
        workspace_id,
        capture_session_ids,
        run_type,
        status,
        stage,
        stage_versions
      )
      VALUES ($1, $2, $3, ARRAY[$4]::uuid[], 'director_inventory', 'partial_synthesis', 'stage-10-narrative-generation', '{"stage-8-complexity-scoring":"v1"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status,
        stage = excluded.stage,
        updated_at = now()
    `,
    [week5SynthesisRunId, orgId, workspaceId, directorCaptureId],
  );
}

async function seedWeek5SynthesisGraph(client: Client) {
  await seedWeek2Graph(client);
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [
    orgId,
  ]);
  await client.query(
    `
      INSERT INTO evidence (
        id,
        org_id,
        workspace_id,
        source_type,
        evidence_label,
        quote,
        confidence
      )
      VALUES ($1, $2, $3, 'document_chunk', 'documented', $4, 0.91)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      week5SynthesisEvidenceId,
      orgId,
      workspaceId,
      "Renewal review happens weekly in Salesforce and depends on Revenue Operations.",
    ],
  );
  await client.query(
    `
      INSERT INTO candidate_processes (
        id,
        org_id,
        workspace_id,
        capture_session_id,
        proposed_name,
        proposed_function,
        frequency,
        complexity_hint,
        confidence,
        evidence_ids
      )
      VALUES ($1, $2, $3, $4, $5, 'Revenue Operations', 'weekly', $6, 0.86, ARRAY[$7]::uuid[])
      ON CONFLICT (id) DO UPDATE SET
        status = 'pending',
        proposed_name = excluded.proposed_name,
        proposed_function = excluded.proposed_function,
        frequency = excluded.frequency,
        complexity_hint = excluded.complexity_hint,
        confidence = excluded.confidence,
        evidence_ids = excluded.evidence_ids
    `,
    [
      week5SynthesisCandidateId,
      orgId,
      workspaceId,
      directorCaptureId,
      "Renewal Review",
      "Manual exception rules and Salesforce updates.",
      week5SynthesisEvidenceId,
    ],
  );
}

async function seedWeek5DegradedTurnGraph(client: Client) {
  await seedWeek2Graph(client);
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [
    orgId,
  ]);
  await client.query(
    `
      INSERT INTO transcript_segments (
        id,
        org_id,
        workspace_id,
        capture_session_id,
        speaker,
        speaker_role,
        start_ms,
        end_ms,
        text,
        confidence
      )
      VALUES ($1, $2, $3, $4, 'director', 'director', 0, 4200, $5, 0.92)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      week5TranscriptId,
      orgId,
      workspaceId,
      directorCaptureId,
      "We run renewal review weekly in Salesforce. The owner is Revenue Operations, and only Pat knows the exception rules.",
    ],
  );
  await client.query(
    `
      INSERT INTO evidence (
        id,
        org_id,
        workspace_id,
        source_type,
        source_id,
        evidence_label,
        quote,
        confidence
      )
      VALUES ($1, $2, $3, 'transcript_segment', $4, 'stated_director', $5, 0.92)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      week5TranscriptEvidenceId,
      orgId,
      workspaceId,
      week5TranscriptId,
      "We run renewal review weekly in Salesforce. The owner is Revenue Operations, and only Pat knows the exception rules.",
    ],
  );
  await client.query(
    `
      INSERT INTO agent_decision_log (
        id,
        org_id,
        workspace_id,
        capture_session_id,
        turn_index,
        stage_name,
        ts_start,
        ts_end,
        transcript_segment_ids,
        prompt_template_id,
        prompt_template_version,
        model,
        degraded_quality
      )
      VALUES ($1, $2, $3, $4, 7, 'director.turn.extract-and-rank', now() - interval '10 minutes', now() - interval '9 minutes', ARRAY[$5]::uuid[], 'director.turn.extract-and-rank', '1', 'structured-extraction-failed', true)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      week5DegradedDecisionId,
      orgId,
      workspaceId,
      directorCaptureId,
      week5TranscriptId,
    ],
  );
}

function apiRequest(
  url: string,
  input: { idempotencyKey: string; body: unknown },
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
    },
    body: JSON.stringify(input.body),
  });
}

function serviceRequest(url: string, body: unknown, idempotencyKey?: string) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer service-token",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyMigration(filename: string) {
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "otto_test",
    ],
    { input: readFileSync(join(root, "migrations", filename)) },
  );
}

function ensureDocker() {
  if (!hasDocker) {
    throw new Error("Docker is required for database integration tests.");
  }
}

function canUseDocker() {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      execFileSync(
        "docker",
        [
          "exec",
          container,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          "otto_test",
          "-c",
          "SELECT 1",
        ],
        { stdio: "ignore" },
      );
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error("Postgres container did not become ready.");
}

function dockerPort() {
  const output = execFileSync("docker", ["port", container, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const match = output.match(/:(\d+)$/);
  if (!match) throw new Error(`Could not parse docker port: ${output}`);
  return match[1];
}

function cleanupContainer() {
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  } catch {
    // Best effort cleanup.
  }
}
