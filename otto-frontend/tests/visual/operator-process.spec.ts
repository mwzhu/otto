import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";

const connectionString =
  process.env.DATABASE_SERVICE_URL ?? process.env.DATABASE_URL ?? "";

const orgId = stableUuid("workos_org", "dev_org");
const userId = stableUuid("visual_user", "dev_user");
const workspaceId = stableUuid("visual_workspace", "operator_capture");
const emptyProcessId = stableUuid("visual_process", "operator_capture_empty");
const graphProcessId = stableUuid("visual_process", "operator_capture_graph");
const versionId = stableUuid("visual_version", "operator_capture_graph_v1");
const captureSessionId = stableUuid("visual_capture", "operator_capture_graph");
const artifactId = stableUuid("visual_artifact", "operator_capture_screen_frame");
const screenEventId = stableUuid("visual_screen_event", "operator_capture_step");
const evidenceId = stableUuid("visual_evidence", "operator_capture_screen");
const startNodeId = stableUuid("visual_node", "operator_capture_start");
const taskNodeId = stableUuid("visual_node", "operator_capture_task");
const endNodeId = stableUuid("visual_node", "operator_capture_end");
const startEdgeId = stableUuid("visual_edge", "operator_capture_start_task");
const endEdgeId = stableUuid("visual_edge", "operator_capture_task_end");

test.skip(!connectionString, "DATABASE_URL is required for seeded operator visual routes.");

test.beforeAll(async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await seedOperatorVisualProcess(client);
  } finally {
    await client.end();
  }
});

test.describe("operator process capture surfaces", () => {
  test("renders four capture modes and each capture shell", async ({ page }) => {
    await gotoClean(page, `/process/${graphProcessId}/capture`);
    await expect(page.getByRole("heading", { name: /Capture Visual Test Returns process/ })).toBeVisible();
    await expect(page.getByText("Voice-only interview")).toBeVisible();
    await expect(page.getByText("Screen-share + voice")).toBeVisible();
    await expect(page.getByText("Upload screen recording")).toBeVisible();
    await expect(page.getByText("Upload SOP document")).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/capture/voice`);
    await expect(page.getByRole("heading", { name: "Voice-only operator interview" })).toBeVisible();
    await expect(page.getByText("Talk through Visual Test Returns")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Voice Interview" })).toBeDisabled();

    await page.addInitScript(
      ({ processId }) => {
        window.localStorage.setItem(
          "otto.operatorInterview.session",
          JSON.stringify({
            workspaceId: "visual-workspace",
            processId,
            captureSessionId: "visual-capture-session",
            language: "en",
            mode: "operator_voice",
            startedAt: new Date().toISOString(),
            liveKit: {
              mode: "simulated",
              room: "operator-visual-capture-session",
              url: null,
              token: null,
              tokenExpiresAt: null,
              reason: "Visual test simulated voice runtime.",
            },
          }),
        );
      },
      { processId: graphProcessId },
    );
    await gotoClean(page, `/process/${graphProcessId}/capture/voice/live`);
    await expect(page.getByRole("heading", { name: "Operator voice interview" })).toBeVisible();
    await expect(page.getByText("Typed fallback is ready")).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/capture/screenshare`);
    await expect(page.getByRole("heading", { name: "Walk Otto through Visual Test Returns" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Screenshare Interview" })).toBeDisabled();

    await gotoClean(page, `/process/${graphProcessId}/capture/upload-video`);
    await expect(page.getByRole("heading", { name: "Upload a screen recording" })).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/capture/upload-document`);
    await expect(page.getByRole("heading", { name: "Upload an SOP or process document" })).toBeVisible();
  });

  test("renders empty and populated operator workflow graph states", async ({ page }) => {
    await gotoClean(page, `/process/${emptyProcessId}/workspace`);
    await expect(page.getByRole("heading", { name: "Build the workflow map" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start Voice Interview" })).toBeVisible();
    await expect(page.getByText("0")).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/workspace?tab=steps`);
    await expect(page.getByText("Current Process")).toBeVisible();
    await expect(page.getByText("draft")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve Draft" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Check return authorization" })).toBeVisible();

    await page.getByRole("button", { name: "View evidence" }).click();
    await expect(page.getByText("Step Evidence")).toBeVisible();
    await expect(page.getByText("Check return authorization")).toBeVisible();
    await expect(page.getByText("observed")).toBeVisible();
    await expect(page.getByText("ERP · Return authorization")).toBeVisible();
    await expect(page.getByAltText("Captured screen evidence")).toBeVisible();
  });
});

async function gotoClean(page: Page, path: string) {
  const consoleErrors: string[] = [];
  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`);
  });

  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response?.ok(), `HTTP ${response?.status()} for ${path}`).toBeTruthy();
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await expect(
    page.locator("[data-nextjs-dialog-overlay], [data-nextjs-error-overlay]"),
  ).toHaveCount(0);
  const realErrors = consoleErrors.filter(
    (error) =>
      !error.includes("Download the React DevTools") &&
      !error.includes("hydration mismatch") &&
      !error.includes("aria-controls"),
  );
  expect(realErrors, `errors at ${path}: ${realErrors.join(" | ")}`).toEqual([]);
}

async function seedOperatorVisualProcess(client: Client) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await client.query(
      `
        INSERT INTO organizations (id, workos_organization_id, name)
        VALUES ($1, 'dev_org', 'Development Org')
        ON CONFLICT (workos_organization_id)
        DO UPDATE SET name = EXCLUDED.name, updated_at = now()
      `,
      [orgId],
    );
    const userResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (id, org_id, workos_user_id, email, name, org_role)
        VALUES ($1, $2, 'dev_user', 'dev@otto.local', 'Dev User', 'org_admin')
        ON CONFLICT (workos_user_id)
        DO UPDATE SET org_id = EXCLUDED.org_id, name = EXCLUDED.name, org_role = EXCLUDED.org_role, updated_at = now()
        RETURNING id
      `,
      [userId, orgId],
    );
    const devUserId = userResult.rows[0]?.id ?? userId;
    await client.query(
      `
        INSERT INTO workspaces (id, org_id, name, function_name, data_tier, status, created_by_user_id, updated_at)
        VALUES ($1, $2, 'Operator Visual Workspace', 'Revenue Operations', 'trial', 'active', $3, now())
        ON CONFLICT (id)
        DO UPDATE SET name = EXCLUDED.name, function_name = EXCLUDED.function_name, updated_at = now()
      `,
      [workspaceId, orgId, devUserId],
    );
    await client.query(
      `
        INSERT INTO processes (id, org_id, workspace_id, name, description, status, updated_at)
        VALUES
          ($1, $3, $4, 'Visual Test Empty Process', 'Seeded process without an operator graph.', 'draft', now()),
          ($2, $3, $4, 'Visual Test Returns', 'Seeded process with an operator draft graph.', 'draft', now())
        ON CONFLICT (id)
        DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status, updated_at = now()
      `,
      [emptyProcessId, graphProcessId, orgId, workspaceId],
    );
    await client.query(
      `
        INSERT INTO capture_sessions (id, org_id, workspace_id, process_id, capture_type, capture_mode, started_at)
        VALUES ($1, $2, $3, $4, 'operator_interview', 'operator_screenshare', now())
        ON CONFLICT (id) DO UPDATE SET process_id = EXCLUDED.process_id, updated_at = now()
      `,
      [captureSessionId, orgId, workspaceId, graphProcessId],
    );
    await client.query(
      `
        INSERT INTO artifacts (
          id, org_id, workspace_id, capture_session_id, uploaded_by_user_id, artifact_type,
          status, storage_key, storage_url, filename, mime_type, size_bytes, ttl_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'screen_frame', 'ready', 'visual/operator-frame.png',
          $6, 'operator-frame.png', 'image/svg+xml', 512, now() + interval '7 days'
        )
        ON CONFLICT (id)
        DO UPDATE SET storage_url = EXCLUDED.storage_url, ttl_at = EXCLUDED.ttl_at, redacted_at = NULL, updated_at = now()
      `,
      [
        artifactId,
        orgId,
        workspaceId,
        captureSessionId,
        devUserId,
        screenEvidenceDataUri(),
      ],
    );
    await client.query(
      `
        INSERT INTO screen_events (
          id, org_id, workspace_id, capture_session_id, ts_ms, event_type,
          app_name, window_title, ocr_text, ui_state_label, screenshot_artifact_id, signal_tags
        )
        VALUES (
          $1, $2, $3, $4, 12000, 'frame_sampled', 'ERP', 'Return authorization',
          'Return ID RMA-1042 is open with policy status visible.',
          'Return authorization review', $5, ARRAY['return', 'approval']::text[]
        )
        ON CONFLICT (id)
        DO UPDATE SET app_name = EXCLUDED.app_name, window_title = EXCLUDED.window_title, screenshot_artifact_id = EXCLUDED.screenshot_artifact_id, updated_at = now()
      `,
      [screenEventId, orgId, workspaceId, captureSessionId, artifactId],
    );
    await client.query(
      `
        INSERT INTO evidence (
          id, org_id, workspace_id, source_type, source_id, evidence_label,
          quote, summary, observed_at, confidence, redacted_at, tombstoned_at
        )
        VALUES (
          $1, $2, $3, 'screen_event', $4, 'observed',
          'Operator checked the return authorization screen before approving the credit.',
          'Screen evidence for return authorization check.', now(), 0.94, NULL, NULL
        )
        ON CONFLICT (id)
        DO UPDATE SET source_id = EXCLUDED.source_id, quote = EXCLUDED.quote, redacted_at = NULL, tombstoned_at = NULL, updated_at = now()
      `,
      [evidenceId, orgId, workspaceId, screenEventId],
    );
    await client.query(
      `
        INSERT INTO process_versions (
          id, org_id, workspace_id, process_id, version_number, status, summary, graph_json
        )
        VALUES ($1, $2, $3, $4, 1, 'draft', 'Draft map from operator visual evidence.', $5::jsonb)
        ON CONFLICT (id)
        DO UPDATE SET status = EXCLUDED.status, summary = EXCLUDED.summary, graph_json = EXCLUDED.graph_json, updated_at = now()
      `,
      [versionId, orgId, workspaceId, graphProcessId, JSON.stringify(operatorGraphJson())],
    );
    await client.query(
      `
        UPDATE processes
        SET current_draft_version_id = $1, current_approved_version_id = NULL, updated_at = now()
        WHERE id = $2
      `,
      [versionId, graphProcessId],
    );
    await client.query(
      `
        INSERT INTO process_nodes (
          id, org_id, workspace_id, process_id, version_id, ordinal, level, node_type,
          title, description, confidence, position_json, evidence_count, top_evidence_ids
        )
        VALUES
          ($1, $4, $5, $6, $7, 0, 'L4', 'start', 'Return received', 'Return request enters the queue.', 0.9, '{"x": 40, "y": 90}'::jsonb, 0, ARRAY[]::uuid[]),
          ($2, $4, $5, $6, $7, 1, 'L4', 'task', 'Check return authorization', 'Operator checks RMA status and policy match in the ERP.', 0.94, '{"x": 320, "y": 90}'::jsonb, 1, ARRAY[$8]::uuid[]),
          ($3, $4, $5, $6, $7, 2, 'L4', 'end', 'Credit queued', 'Approved return credit is queued.', 0.86, '{"x": 640, "y": 90}'::jsonb, 0, ARRAY[]::uuid[])
        ON CONFLICT (id)
        DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, top_evidence_ids = EXCLUDED.top_evidence_ids, updated_at = now()
      `,
      [
        startNodeId,
        taskNodeId,
        endNodeId,
        orgId,
        workspaceId,
        graphProcessId,
        versionId,
        evidenceId,
      ],
    );
    await client.query(
      `
        INSERT INTO process_edges (
          id, org_id, workspace_id, process_id, version_id, source_node_id, target_node_id,
          edge_type, evidence_count, top_evidence_ids
        )
        VALUES
          ($1, $3, $4, $5, $6, $7, $8, 'seq', 0, ARRAY[]::uuid[]),
          ($2, $3, $4, $5, $6, $8, $9, 'seq', 0, ARRAY[]::uuid[])
        ON CONFLICT (id) DO UPDATE SET updated_at = now()
      `,
      [
        startEdgeId,
        endEdgeId,
        orgId,
        workspaceId,
        graphProcessId,
        versionId,
        startNodeId,
        taskNodeId,
        endNodeId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function operatorGraphJson() {
  return {
    version_id: versionId,
    process_id: graphProcessId,
    version_number: 1,
    status: "draft",
    summary: "Draft map from operator visual evidence.",
    warnings: [],
    nodes: [
      {
        id: startNodeId,
        type: "start",
        position: { x: 40, y: 90 },
        data: { title: "Return received", description: "Return request enters the queue." },
      },
      {
        id: taskNodeId,
        type: "task",
        position: { x: 320, y: 90 },
        data: {
          title: "Check return authorization",
          description: "Operator checks RMA status and policy match in the ERP.",
          role: "Returns specialist",
          systems: ["ERP"],
          confidence: 0.94,
          evidence_ids: [evidenceId],
          inputs: [{ name: "RMA", evidence_ids: [evidenceId] }],
          outputs: [{ name: "Authorization decision", evidence_ids: [evidenceId] }],
          workarounds: [
            {
              description: "Copy the RMA number into a legacy policy lookup.",
              why_it_exists: "ERP policy flags are not always current.",
              evidence_ids: [evidenceId],
            },
          ],
        },
      },
      {
        id: endNodeId,
        type: "end",
        position: { x: 640, y: 90 },
        data: { title: "Credit queued", description: "Approved return credit is queued." },
      },
    ],
    edges: [
      { id: startEdgeId, source: startNodeId, target: taskNodeId, edge_type: "seq" },
      { id: endEdgeId, source: taskNodeId, target: endNodeId, edge_type: "seq" },
    ],
  };
}

function screenEvidenceDataUri() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="#f8fafc"/>
      <rect x="40" y="44" width="560" height="272" rx="12" fill="#ffffff" stroke="#cbd5e1"/>
      <text x="68" y="86" font-family="Arial" font-size="22" font-weight="700" fill="#0f172a">Return authorization</text>
      <rect x="68" y="118" width="220" height="38" rx="6" fill="#e2e8f0"/>
      <rect x="68" y="174" width="504" height="32" rx="6" fill="#dbeafe"/>
      <rect x="68" y="222" width="148" height="44" rx="6" fill="#0f172a"/>
      <text x="92" y="250" font-family="Arial" font-size="15" fill="#ffffff">Approve credit</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function stableUuid(scope: string, value: string) {
  const chars = createHash("sha256")
    .update(`${scope}:${value}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const id = chars.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
