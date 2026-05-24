import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const week5FollowUpId = "30303030-3030-5030-8030-303030303030";
const week5SynthesisRunId = "40404040-4040-5040-8040-404040404040";
const week5TranscriptId = "50505050-5050-5050-8050-505050505050";
const week5TranscriptEvidenceId = "60606060-6060-5060-8060-606060606060";
const week5DegradedDecisionId = "70707070-7070-5070-8070-707070707070";
const week5SynthesisCandidateId = "81818181-8181-5181-8181-818181818181";
const week5SynthesisEvidenceId = "82828282-8282-5282-8282-828282828282";
const week5LocalCaptureId = "83838383-8383-5383-8383-838383838383";
const week5LocalArtifactId = "84848484-8484-5484-8484-848484848484";

let connectionString = "";
let appClient: Client;

describe("Phase 1 database integration", () => {
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

      const interviewResponse = await interviewsRoute.POST(
        apiRequest("http://otto.test/api/director-interviews", {
          idempotencyKey: "api-interview",
          body: { workspace_id: apiWorkspaceId, language: "en" },
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

  test("Week 5 degraded director turns are re-extracted through the normal turn path", async () => {
    await seedWeek5DegradedTurnGraph(appClient);

    const { recoverDegradedDirectorTurnsForOrgs } = await import(
      "@/lib/inngest/functions"
    );
    const result = await recoverDegradedDirectorTurnsForOrgs([orgId]);

    expect(result.recovered).toBeGreaterThanOrEqual(1);
    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgId,
    ]);
    const rows = await appClient.query(
      `
        SELECT
          (SELECT count(*)::int FROM candidate_processes WHERE capture_session_id = $1 AND proposed_name = 'Renewal Review Weekly In Salesforce') AS recovered_candidates,
          (SELECT count(*)::int FROM slot_states WHERE capture_session_id = $1 AND slot_path = 'scope.boundaries' AND status = 'filled') AS recovered_slots,
          (SELECT count(*)::int FROM agent_decision_log WHERE stage_name = 're_extract_degraded_turns.recovered' AND tool_calls->>'source_agent_decision_log_id' = $2) AS recovered_markers
      `,
      [directorCaptureId, week5DegradedDecisionId],
    );

    expect(rows.rows[0]).toEqual({
      recovered_candidates: 1,
      recovered_slots: 1,
      recovered_markers: 1,
    });
  });
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
      ON CONFLICT (capture_session_id, slot_path) DO UPDATE SET
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
  execFileSync("docker", ["version"], { stdio: "ignore" });
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
