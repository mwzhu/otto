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
const promoteCandidateId = stableUuid("visual_candidate", "promote_returns_follow_up");
const mergeCandidateId = stableUuid("visual_candidate", "merge_returns_duplicate");
const discardCandidateId = stableUuid("visual_candidate", "discard_returns_noise");
const redactionFailureFollowUpId = stableUuid(
  "visual_follow_up",
  "operator_redaction_failed_raw_sql",
);

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
    let operatorTurnSeen = false;
    await page.route(
      "**/api/operator-captures/visual-capture-session/turns",
      async (route) => {
        operatorTurnSeen = true;
        await new Promise((resolve) => setTimeout(resolve, 7000));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            planned_agent_utterance:
              "What decides which path you take at that point?",
          }),
        });
      },
    );
    await gotoClean(page, `/process/${graphProcessId}/capture/voice/live`);
    await expect(page.getByRole("heading", { name: "Operator voice interview" })).toBeVisible();
    await expect(page.getByText("Typed fallback is ready")).toBeVisible();
    await page
      .getByPlaceholder("Type the next operator step...")
      .fill("I check the RMA in ERP and queue the credit when policy matches.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByText("I check the RMA in ERP and queue the credit when policy matches."),
    ).toBeVisible();
    await expect(
      page.getByText("Operator notes are still updating."),
    ).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByText("What decides which path you take at that point?"),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByPlaceholder("Type the next operator step...")).toBeEnabled();
    expect(operatorTurnSeen).toBe(true);

    await gotoClean(page, `/process/${graphProcessId}/capture/screenshare`);
    await expect(page.getByRole("heading", { name: "Walk Otto through Visual Test Returns" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Screenshare Interview" })).toBeDisabled();

    await gotoClean(page, `/process/${graphProcessId}/capture/upload-video`);
    await expect(page.getByRole("heading", { name: "Upload a screen recording" })).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/capture/upload-document`);
    await expect(page.getByRole("heading", { name: "Upload an SOP or process document" })).toBeVisible();
  });

  test("validates and binds process upload artifacts", async ({ page }) => {
    const presigns: unknown[] = [];
    const bindings: unknown[] = [];

    await page.route(`**/api/workspaces/${workspaceId}/artifacts/presign`, async (route) => {
      const body = await route.request().postDataJSON();
      presigns.push(body);
      const artifactId =
        body.artifact_type === "video"
          ? "process-video-artifact"
          : "process-document-artifact";
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          artifact: { id: artifactId },
          upload_url: `https://upload.test/${artifactId}`,
        }),
      });
    });
    await page.route("https://upload.test/process-video-artifact", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route("https://upload.test/process-document-artifact", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route(`**/api/processes/${graphProcessId}/captures/uploads`, async (route) => {
      const body = await route.request().postDataJSON();
      bindings.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ capture_session: { id: `capture-${bindings.length}` } }),
      });
    });

    await gotoClean(page, `/process/${graphProcessId}/capture/upload-document`);
    const documentInput = page.locator('input[type="file"]');
    await documentInput.setInputFiles({
      name: "recording.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("video"),
    });
    await expect(page.getByText("Unsupported file type.")).toBeVisible();
    expect(presigns).toHaveLength(0);

    await documentInput.setInputFiles({
      name: "returns-sop.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("document"),
    });
    await expect(page.getByText("Ready")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to synthesis" })).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/capture/upload-video`);
    const videoInput = page.locator('input[type="file"]');
    await videoInput.setInputFiles({
      name: "sop.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("pdf"),
    });
    await expect(page.getByText("Unsupported file type.")).toBeVisible();

    await videoInput.setInputFiles({
      name: "returns-walkthrough.webm",
      mimeType: "video/webm",
      buffer: Buffer.from("video"),
    });
    await expect(page.getByText("Ready")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to synthesis" })).toBeVisible();

    expect(presigns).toEqual([
      expect.objectContaining({
        filename: "returns-sop.docx",
        artifact_type: "document",
      }),
      expect.objectContaining({
        filename: "returns-walkthrough.webm",
        artifact_type: "video",
      }),
    ]);
    expect(bindings).toEqual([
      expect.objectContaining({
        workspace_id: workspaceId,
        artifact_id: "process-document-artifact",
        upload_kind: "document",
      }),
      expect.objectContaining({
        workspace_id: workspaceId,
        artifact_id: "process-video-artifact",
        upload_kind: "screen_recording",
      }),
    ]);
  });

  test("renders empty and populated operator workflow graph states", async ({ page }) => {
    await gotoClean(page, `/process/${emptyProcessId}/workspace`);
    await expect(page.getByRole("heading", { name: "Build the workflow map" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start Voice Interview" })).toBeVisible();
    await expect(page.getByText("0")).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/workspace?tab=steps`);
    await expect(page.getByRole("heading", { name: "Current Process" })).toBeVisible();
    const workspaceHeader = page.locator("header").filter({
      has: page.getByRole("heading", { name: "Current Process" }),
    });
    await expect(workspaceHeader.getByText("draft", { exact: true })).toBeVisible();
    await expect(workspaceHeader.getByRole("button", { name: "Approve Draft" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Check return authorization" })).toBeVisible();
    await expect(page.getByText("Workflow step")).toHaveCount(0);
    await expect(page.getByText("No retained evidence rows are available for this step.")).toHaveCount(0);

    await page.getByRole("button", { name: "View evidence" }).click();
    const openDrawer = page.getByRole("complementary").filter({
      hasText: "Step Evidence",
    });
    await expect(openDrawer.getByText("Step Evidence")).toBeVisible();
    await expect(openDrawer.getByText("Check return authorization")).toBeVisible();
    await expect(openDrawer.getByText("observed")).toBeVisible();
    await expect(openDrawer.getByText("ERP · Return authorization")).toBeVisible();
    await expect(openDrawer.getByAltText("Captured screen evidence")).toBeVisible();
  });

  test("renders transformation and automation recommendations from the workflow graph", async ({ page }) => {
    await gotoClean(page, `/process/${graphProcessId}/workspace?tab=steps`);
    const topNavContainer = page
      .getByRole("navigation", { name: "Workspace sections" })
      .locator("xpath=..");
    await expect(topNavContainer.getByRole("button", { name: "Review Draft" })).toBeVisible();
    await expect(topNavContainer.getByRole("button", { name: "Approve Draft" })).toHaveCount(0);
    await expect(page.locator("header").getByRole("button", { name: "Approve Draft" })).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/workspace/transformation`);
    await expect(page.getByRole("heading", { name: "Current process vs target state" })).toBeVisible();
    await expect(
      page.getByText("Transformation proposals will appear after a real current-state graph"),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Current Process", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Transformation Proposal", exact: true })).toBeVisible();
    await expect(page.getByText("Check return authorization", { exact: true })).toBeVisible();
    await expect(page.getByText("Copy the RMA number into a legacy policy lookup.")).toBeVisible();
    await expect(page.getByText(/Connect ERP so the check happens in-flow/)).toBeVisible();
    await expect(page.getByText("1 linked evidence source").first()).toBeVisible();

    await gotoClean(page, `/process/${graphProcessId}/workspace/automation`);
    await expect(page.getByRole("heading", { name: "Ranked automation opportunities" })).toBeVisible();
    await expect(
      page.getByText("Automation opportunities will appear after real ROI assumptions"),
    ).toHaveCount(0);
    await expect(page.getByText("Rank #1")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Transform Check return authorization" })).toBeVisible();
    await expect(page.getByText("Problem.")).toBeVisible();
    await expect(page.getByText("Copy the RMA number into a legacy policy lookup.")).toBeVisible();
    await expect(page.getByText("Net score (annual)")).toBeVisible();
    await expect(page.getByText("ERP", { exact: true })).toBeVisible();
  });

  test("sanitizes redaction failure follow-up details in workspace tabs", async ({
    page,
  }) => {
    await gotoClean(page, `/process/${graphProcessId}/workspace`);

    await expect(page.getByText("Operator capture redaction failed").first()).toBeVisible();
    await expect(
      page.getByText(
        "Redaction could not complete. Retry redaction before using this capture, and review the capture before publishing.",
      ).first(),
    ).toBeVisible();
    await expect(page.getByText(/Failed query:/i)).toHaveCount(0);
    await expect(page.getByText(/UPDATE agent_decision_log/i)).toHaveCount(0);

    await page.getByRole("button", { name: /Risk & Vulnerabilities/ }).click();
    await expect(page.getByRole("heading", { name: "Risk follow-ups" })).toBeVisible();
    await expect(page.getByText("Operator capture redaction failed").first()).toBeVisible();
    await expect(
      page.getByText(
        "Redaction could not complete. Retry redaction before using this capture, and review the capture before publishing.",
      ).first(),
    ).toBeVisible();
    await expect(page.getByText(/Failed query:/i)).toHaveCount(0);
    await expect(page.getByText(/UPDATE agent_decision_log/i)).toHaveCount(0);
  });

  test("downloads a parseable admin JSON export scoped to the process graph evidence", async ({
    page,
  }) => {
    await gotoClean(page, "/admin/exports");
    await expect(page.getByRole("heading", { name: "Exports", exact: true })).toBeVisible();
    await expect(page.getByText("Available JSON exports")).toBeVisible();
    await expect(page.getByText("Visual Test Returns")).toBeVisible();
    await expect(page.getByText("1 evidence rows")).toBeVisible();

    const exportLink = page
      .locator(`a[href*="${graphProcessId}"]`)
      .filter({ hasText: "Download JSON" })
      .first();
    const href = await exportLink.getAttribute("href");
    expect(href).toContain("/api/admin/exports/process-json");

    const response = await page.request.get(href as string);
    expect(response.ok(), `HTTP ${response.status()} for ${href}`).toBe(true);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    const payload = await response.json();

    expect(payload).toMatchObject({
      export_type: "process_json",
      workspace: {
        id: workspaceId,
        name: "Operator Visual Workspace",
      },
      process: {
        id: graphProcessId,
        name: "Visual Test Returns",
      },
      version: {
        id: versionId,
        version_number: 1,
        status: "draft",
      },
    });
    expect(payload.graph.nodes.map((node: { data: { title: string } }) => node.data.title)).toEqual([
      "Return received",
      "Check return authorization",
      "Credit queued",
    ]);
    expect(payload.evidence).toEqual([
      expect.objectContaining({
        id: evidenceId,
        source_type: "screen_event",
        evidence_label: "observed",
        quote:
          "Operator checked the return authorization screen before approving the credit.",
        redacted: false,
      }),
    ]);
  });

  test("lets FDE promote, merge, and discard candidate processes from the variant queue", async ({
    page,
  }) => {
    const calls: Array<{ url: string; body: Record<string, unknown>; key: string | null }> = [];
    await page.route("**/api/candidate-processes/*/promote", async (route) => {
      calls.push({
        url: route.request().url(),
        body: await route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"] ?? null,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidate_process_id: promoteCandidateId,
          process_id: "promoted-process-id",
        }),
      });
    });
    await page.route("**/api/candidate-processes/*/merge", async (route) => {
      calls.push({
        url: route.request().url(),
        body: await route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"] ?? null,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidate_process_id: mergeCandidateId,
          target_process_id: graphProcessId,
          status: "merged",
        }),
      });
    });
    await page.route("**/api/candidate-processes/*/discard", async (route) => {
      calls.push({
        url: route.request().url(),
        body: await route.request().postDataJSON(),
        key: route.request().headers()["idempotency-key"] ?? null,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          candidate_process_id: discardCandidateId,
          status: "discarded",
        }),
      });
    });

    await gotoClean(page, "/admin/variants");
    await expect(page.getByRole("heading", { name: "Variant review queue" })).toBeVisible();

    const promoteCard = page.locator("article").filter({
      hasText: "Candidate Promote Returns Follow-up",
    });
    await promoteCard.getByRole("button", { name: "Promote to tracked process" }).click();
    await expect(promoteCard.getByText("Promoted to tracked process")).toBeVisible();

    const mergeCard = page.locator("article").filter({
      hasText: "Candidate Merge Duplicate Returns",
    });
    await mergeCard.locator("select").selectOption(graphProcessId);
    await mergeCard.getByRole("button", { name: "Merge" }).click();
    await expect(mergeCard.getByText("Merged into Visual Test Returns")).toBeVisible();

    const discardCard = page.locator("article").filter({
      hasText: "Candidate Discard Noise",
    });
    await discardCard.getByRole("button", { name: "Discard" }).click();
    await expect(discardCard.getByText("Discarded from queue")).toBeVisible();

    expect(calls).toEqual([
      expect.objectContaining({
        url: expect.stringContaining(`/api/candidate-processes/${promoteCandidateId}/promote`),
        body: { workspace_id: workspaceId },
        key: `admin-variant-promote-${promoteCandidateId}`,
      }),
      expect.objectContaining({
        url: expect.stringContaining(`/api/candidate-processes/${mergeCandidateId}/merge`),
        body: {
          workspace_id: workspaceId,
          target_process_id: graphProcessId,
        },
        key: `admin-variant-merge-${mergeCandidateId}`,
      }),
      expect.objectContaining({
        url: expect.stringContaining(`/api/candidate-processes/${discardCandidateId}/discard`),
        body: { workspace_id: workspaceId },
        key: `admin-variant-discard-${discardCandidateId}`,
      }),
    ]);
  });

  test("starts screenshare only after consent and exposes pause, redaction, and completion controls", async ({
    page,
  }) => {
    await installFakeScreenshareDevices(page, { animatedScreen: true });
    let captureBody: Record<string, unknown> | null = null;
    let roomBody: Record<string, unknown> | null = null;
    let firstFrameBody: Record<string, unknown> | null = null;
    let firstRedactionBody: Record<string, unknown> | null = null;
    let completeBody: Record<string, unknown> | null = null;
    let redactionRequests = 0;
    let framePresigns = 0;
    let frameSaveRequests = 0;

    await page.route(
      `**/api/processes/${graphProcessId}/operator-captures`,
      async (route) => {
        captureBody = await route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            capture_session: { id: "visual-screenshare-capture" },
          }),
        });
      },
    );
    await page.route("**/api/livekit/operator-room", async (route) => {
      roomBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "simulated",
          room: "operator-visual-screenshare",
          url: null,
          token: null,
          tokenExpiresAt: null,
          reason: "Visual test simulated screenshare runtime.",
        }),
      });
    });
    await page.route(`**/api/workspaces/${workspaceId}/artifacts/presign`, async (route) => {
      const body = await route.request().postDataJSON();
      if (body.artifact_type !== "screen_frame") {
        await route.fallback();
        return;
      }
      const artifactId = `screen-frame-artifact-${framePresigns++}`;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          artifact: { id: artifactId },
          upload_url: `https://upload.test/${artifactId}`,
        }),
      });
    });
    await page.route("https://upload.test/screen-frame-artifact-*", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route(
      `**/api/processes/${graphProcessId}/operator-captures/visual-screenshare-capture/screen-frames`,
      async (route) => {
        frameSaveRequests += 1;
        const body = await route.request().postDataJSON();
        if (!firstFrameBody) firstFrameBody = body;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            screen_event: { id: "visual-screen-event" },
            warning: {
              message:
                "Screen keyframe was saved, but vision analysis did not queue. Keep recording and retry the interview if visual grounding does not update.",
            },
          }),
        });
      },
    );
    await page.route(
      `**/api/processes/${graphProcessId}/operator-captures/visual-screenshare-capture/redactions`,
      async (route) => {
        redactionRequests += 1;
        const body = await route.request().postDataJSON();
        if (!firstRedactionBody) firstRedactionBody = body;
        await route.fulfill({
          status: redactionRequests === 1 ? 200 : 500,
          contentType: "application/json",
          body: JSON.stringify(
            redactionRequests === 1
              ? { redaction: { status: "running" } }
              : {
                  error: {
                    message: "Unexpected server error.",
                  },
                },
          ),
        });
      },
    );
    await page.route(
      `**/api/processes/${graphProcessId}/operator-captures/visual-screenshare-capture/complete`,
      async (route) => {
        completeBody = await route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ capture_session: { status: "completed" } }),
        });
      },
    );
    await page.route("**/api/synthesis/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          latest_run: { status: "completed", stage: "publishing" },
          overview: { process_count: 1, has_partial_synthesis: false },
          ready_for_overview: true,
          terminal: true,
        }),
      });
    });

    await gotoClean(page, `/process/${graphProcessId}/capture/screenshare`);
    await expect(
      page.getByRole("button", { name: "Start Screenshare Interview" }),
    ).toBeDisabled();
    await expect(
      page.evaluate(() =>
        window.localStorage.getItem("otto.operatorScreenshare.session"),
      ),
    ).resolves.toBeNull();

    await page.getByRole("button", { name: /English/ }).click();
    await page.getByRole("button", { name: /Español/ }).click();
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "Start Screenshare Interview" })
      .click();

    await expect(page.getByText("Capture session")).toBeVisible();
    await expect(page.getByText("visual-screenshare-capture")).toBeVisible();
    await expect(page.getByText("Voice runtime")).toBeVisible();
    await expect(page.getByText("simulated")).toBeVisible();
    await expect(page.getByLabel("Shared screen preview")).toBeVisible();
    await expect(page.getByText("Screen track publishing")).toBeVisible();
    await expect(page.getByText(/Screen keyframes captured\s+1/)).toBeVisible({
      timeout: 8000,
    });
    await expect(
      page.getByText("Screen keyframe was saved, but vision analysis did not queue."),
    ).toBeVisible();
    expect(firstFrameBody).toMatchObject({
      workspace_id: workspaceId,
      frame_index: 0,
      app_name: "screenshare",
      ui_state_label: "Screenshare keyframe candidate",
      signal_tags: ["screen_frame_sampled"],
    });

    await expect(
      page.evaluate(() =>
        JSON.parse(
          window.localStorage.getItem("otto.operatorScreenshare.session") ??
            "null",
        ),
      ),
    ).resolves.toMatchObject({
      workspaceId,
      processId: graphProcessId,
      captureSessionId: "visual-screenshare-capture",
      language: "es",
      mode: "operator_screenshare",
      liveKit: {
        mode: "simulated",
        reason: "Visual test simulated screenshare runtime.",
      },
    });
    expect(captureBody).toMatchObject({
      workspace_id: workspaceId,
      mode: "screenshare",
      language: "es",
      consent_acknowledged: true,
    });
    expect(roomBody).toMatchObject({
      workspace_id: workspaceId,
      capture_session_id: "visual-screenshare-capture",
    });

    await page.getByRole("button", { name: "Pause Interview" }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    const pausedFrameCount = await readScreenshareKeyframeCount(page);
    const pausedFrameRequests = frameSaveRequests;
    await page.waitForTimeout(1200);
    await expect(readScreenshareKeyframeCount(page)).resolves.toBe(
      pausedFrameCount,
    );
    expect(frameSaveRequests).toBe(pausedFrameRequests);

    await page.getByRole("button", { name: "Resume" }).click();
    await expect(
      page.getByRole("button", { name: "Pause Interview" }),
    ).toBeVisible();
    await expect
      .poll(() => frameSaveRequests, { timeout: 8000 })
      .toBeGreaterThan(pausedFrameRequests);
    await expect
      .poll(() => readScreenshareKeyframeCount(page), { timeout: 8000 })
      .toBeGreaterThan(pausedFrameCount);

    await page.getByRole("button", { name: "Redact last 30s" }).click();
    await expect(page.getByText("redacting the last 30 seconds")).toBeVisible();
    expect(firstRedactionBody).toMatchObject({
      workspace_id: workspaceId,
      last_seconds: 30,
      reason: "operator_requested_last_30_seconds",
    });

    await page.getByRole("button", { name: "Redact last 30s" }).click();
    await expect(
      page.getByText("Redaction failed; retry before using this capture."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Complete Interview" }).click();
    await page.waitForURL(/\/synthesis\?/);
    expect(completeBody).toMatchObject({ workspace_id: workspaceId });
    await expect(page).toHaveURL(
      new RegExp(
        `/synthesis\\?next=%2Fprocess%2F${graphProcessId}%2Fworkspace&workspace_id=${workspaceId}&capture_session_id=visual-screenshare-capture`,
      ),
    );
  });

  test("recovers when screenshare microphone permission stalls", async ({
    page,
  }) => {
    await installFakeScreenshareDevices(page, {
      hangMicrophone: true,
      mediaPermissionTimeoutMs: 250,
    });

    await gotoClean(page, `/process/${graphProcessId}/capture/screenshare`);
    await page.getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "Start Screenshare Interview" })
      .click();

    await expect(
      page.getByText(
        "Microphone permission did not finish. Allow microphone access in the browser prompt, then try again.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start Screenshare Interview" }),
    ).toBeEnabled();
    await expect(
      page.evaluate(() =>
        window.localStorage.getItem("otto.operatorScreenshare.session"),
      ),
    ).resolves.toBeNull();
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

async function readScreenshareKeyframeCount(page: Page) {
  const text = await page.getByText(/Screen keyframes captured\s+\d+/).textContent();
  const match = text?.match(/Screen keyframes captured\s+(\d+)/);
  return Number(match?.[1] ?? 0);
}

async function installFakeScreenshareDevices(
  page: Page,
  options: {
    hangScreen?: boolean;
    hangMicrophone?: boolean;
    mediaPermissionTimeoutMs?: number;
    animatedScreen?: boolean;
  } = {},
) {
  await page.addInitScript((mediaOptions) => {
    if (mediaOptions.mediaPermissionTimeoutMs) {
      (
        window as typeof window & {
          __OTTO_MEDIA_PERMISSION_TIMEOUT_MS__?: number;
        }
      ).__OTTO_MEDIA_PERMISSION_TIMEOUT_MS__ =
        mediaOptions.mediaPermissionTimeoutMs;
    }
    class UnavailableMediaRecorder {
      static isTypeSupported() {
        return false;
      }

      constructor() {
        throw new Error("MediaRecorder disabled for visual test.");
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: UnavailableMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getDisplayMedia: mediaOptions.hangScreen
          ? () => new Promise<MediaStream>(() => {})
          : async () =>
              mediaOptions.animatedScreen
                ? fakeAnimatedScreenStream()
                : new MediaStream(),
        getUserMedia: mediaOptions.hangMicrophone
          ? () => new Promise<MediaStream>(() => {})
          : async () => new MediaStream(),
      },
    });

    function fakeAnimatedScreenStream() {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d");
      let frame = 0;
      const draw = () => {
        if (context) {
          context.fillStyle = frame % 2 === 0 ? "#f8fafc" : "#e0f2fe";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#0f172a";
          context.font = "24px sans-serif";
          context.fillText(`Fake screenshare ${frame}`, 24, 88);
        }
        frame += 1;
        window.setTimeout(draw, 100);
      };
      draw();
      (
        window as typeof window & {
          __OTTO_FAKE_SCREENSHARE_CANVAS__?: HTMLCanvasElement;
        }
      ).__OTTO_FAKE_SCREENSHARE_CANVAS__ = canvas;
      return canvas.captureStream(10);
    }
  }, options);
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
    await client.query(
      `
        INSERT INTO candidate_processes (
          id, org_id, workspace_id, capture_session_id, proposed_name,
          proposed_function, frequency, complexity_hint, status, confidence, evidence_ids,
          promoted_process_id, updated_at
        )
        VALUES
          ($1, $4, $5, $6, 'Candidate Promote Returns Follow-up', 'Revenue Operations', 'weekly', 'Needs promotion review.', 'pending', 0.83, ARRAY[$7]::uuid[], NULL, now()),
          ($2, $4, $5, $6, 'Candidate Merge Duplicate Returns', 'Revenue Operations', 'weekly', 'Likely duplicate of Visual Test Returns.', 'pending', 0.74, ARRAY[$7]::uuid[], NULL, now()),
          ($3, $4, $5, $6, 'Candidate Discard Noise', 'Revenue Operations', 'one-off', 'Low-signal candidate from noise.', 'pending', 0.41, ARRAY[$7]::uuid[], NULL, now())
        ON CONFLICT (id)
        DO UPDATE SET
          proposed_name = EXCLUDED.proposed_name,
          proposed_function = EXCLUDED.proposed_function,
          frequency = EXCLUDED.frequency,
          complexity_hint = EXCLUDED.complexity_hint,
          status = EXCLUDED.status,
          confidence = EXCLUDED.confidence,
          evidence_ids = EXCLUDED.evidence_ids,
          promoted_process_id = NULL,
          updated_at = now()
      `,
      [
        promoteCandidateId,
        mergeCandidateId,
        discardCandidateId,
        orgId,
        workspaceId,
        captureSessionId,
        evidenceId,
      ],
    );
    await client.query(
      `
        INSERT INTO follow_up_tasks (
          id, org_id, workspace_id, process_id, capture_session_id, task_type,
          title, description, target_type, target_id, priority, status, context_json,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'redaction_failure',
          'Operator capture redaction failed',
          'Failed query: UPDATE agent_decision_log SET delivery_json = coalesce(delivery_json, ''{}''::jsonb) || jsonb_build_object(...) params: 7863036',
          'redaction', NULL, '1.0', 'open',
          '{"reason":"redaction_failed"}'::jsonb,
          now()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          task_type = EXCLUDED.task_type,
          status = EXCLUDED.status,
          context_json = EXCLUDED.context_json,
          updated_at = now()
      `,
      [
        redactionFailureFollowUpId,
        orgId,
        workspaceId,
        graphProcessId,
        captureSessionId,
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
