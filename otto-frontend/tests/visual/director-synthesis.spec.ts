import { test, expect, type Page } from "@playwright/test";

test.describe("director pre-start and synthesis routing", () => {
  test("blocks director voice when LiveKit readiness is unconfigured", async ({
    page,
  }) => {
    await page.route("**/api/livekit/director-room", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "unconfigured",
          requiresMicrophone: false,
          missing: ["LIVEKIT_API_KEY"],
          reason: "LiveKit voice is not fully configured.",
        }),
      });
    });

    await gotoClean(page, "/onboarding/voice");
    const start = page.getByRole("button", { name: "Start Interview" });
    await expect(start).toBeDisabled();

    await page.getByRole("checkbox").check();
    await expect(start).toBeEnabled();
    await start.click();

    await expect(
      page.getByText("LiveKit voice is not fully configured."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding\/voice$/);
    await expect(
      page.evaluate(() =>
        window.localStorage.getItem("otto.directorInterview.session"),
      ),
    ).resolves.toBeNull();
  });

  test("starts simulated director voice with consent, language, and persisted session", async ({
    page,
  }) => {
    await installFakeMicrophone(page);
    await page.route("**/api/livekit/director-room", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "simulated",
          requiresMicrophone: true,
          missing: [],
          reason: "Visual test simulated director runtime.",
        }),
      });
    });
    await page.route("**/api/workspaces", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspace: { id: "visual-director-workspace" },
        }),
      });
    });
    await page.route("**/api/director-interviews", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          capture_session: { id: "visual-director-capture" },
        }),
      });
    });

    await gotoClean(page, "/onboarding/voice");
    await page.getByRole("button", { name: /English/ }).click();
    await page.getByRole("button", { name: /Français/ }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Start Interview" }).click();

    await page.waitForURL("**/onboarding/voice/live");
    await expect(
      page.evaluate(() => ({
        workspaceId: window.localStorage.getItem("otto.phase0.workspaceId"),
        session: JSON.parse(
          window.localStorage.getItem("otto.directorInterview.session") ??
            "null",
        ) as {
          workspaceId?: string;
          captureSessionId?: string;
          language?: string;
          roomMode?: string;
          roomReason?: string;
        } | null,
      })),
    ).resolves.toMatchObject({
      workspaceId: "visual-director-workspace",
      session: {
        workspaceId: "visual-director-workspace",
        captureSessionId: "visual-director-capture",
        language: "fr",
        roomMode: "simulated",
        roomReason: "Visual test simulated director runtime.",
      },
    });
  });

  test("keeps typed director turn visible while a slow response is pending", async ({
    page,
  }) => {
    test.setTimeout(20_000);
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const captureSessionId = "22222222-2222-4222-8222-222222222222";
    const typedAnswer =
      "I oversee retail revenue operations and handle promotion setup.";
    let postSeen = false;

    await page.route(
      `**/api/director-interviews/${captureSessionId}/coverage**`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ slots: [] }),
        });
      },
    );
    await page.route(
      `**/api/director-interviews/${captureSessionId}/turns**`,
      async (route) => {
        if (route.request().method() === "GET") {
          await page.waitForTimeout(1500);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              capture_session_id: captureSessionId,
              messages: [],
            }),
          });
          return;
        }
        postSeen = true;
        await page.waitForTimeout(7000);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            next_prompt: "Which process should we zoom into first?",
            chosen_intent: {
              intent: "inventory_processes",
              target_slot: "process_inventory",
              priority: 100,
              reason: "User named a process.",
            },
            ranked_intents: [],
            utterance_type: "process_inventory",
            current_phase: "discovery",
            proposed_next_phase: "discovery",
            slot_updates: [],
            candidate_process_ids: [],
            coverage_slots: [],
            degraded_quality: false,
            degraded_reasons: [],
            metadata: {
              model: "visual-test",
              token_count_input: 1,
              token_count_output: 1,
              cost_cents: 0,
              latency_ms: 7000,
              cache_hit: false,
            },
          }),
        });
      },
    );

    await page.addInitScript(
      ({ workspaceId, captureSessionId }) => {
        window.localStorage.setItem(
          "otto.directorInterview.session",
          JSON.stringify({
            workspaceId,
            captureSessionId,
            language: "en",
            roomMode: "simulated",
            roomName: `director-${captureSessionId}`,
            roomUrl: null,
            roomToken: null,
            roomTokenExpiresAt: null,
            roomReason: "Visual test simulated director runtime.",
            startedAt: new Date().toISOString(),
          }),
        );
      },
      { workspaceId, captureSessionId },
    );

    await gotoClean(page, "/onboarding/voice/live");
    await page
      .getByPlaceholder("Type an answer or correction...")
      .fill(typedAnswer);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(typedAnswer)).toBeVisible();
    await expect(
      page.getByText("Operations Notes are still updating."),
    ).toBeVisible({ timeout: 8000 });
    await expect(
      page.getByText("Which process should we zoom into first?"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder("Type an answer or correction...")).toBeEnabled();
    expect(postSeen).toBe(true);
  });

  test("does not route terminal overview synthesis when readiness is false", async ({
    page,
  }) => {
    await page.route("**/api/synthesis/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          latest_run: { status: "failed", stage: "publishing" },
          overview: { process_count: 0, has_partial_synthesis: true },
          ready_for_overview: false,
          terminal: true,
        }),
      });
    });

    await gotoClean(
      page,
      "/synthesis?next=%2Foverview&workspace_id=visual-director-workspace",
    );

    await expect(
      page.getByRole("heading", { name: "Synthesis needs attention" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "The latest synthesis run finished without an overview. Check the run before opening the process map.",
      ),
    ).toBeVisible();
    await page.waitForTimeout(1200);
    await expect(page).toHaveURL(/\/synthesis\?/);
  });

  test("preserves existing overview query params when synthesis is ready", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.route("**/api/synthesis/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          latest_run: { status: "completed", stage: "publishing" },
          overview: { process_count: 3, has_partial_synthesis: false },
          ready_for_overview: true,
          terminal: true,
        }),
      });
    });

    await gotoClean(
      page,
      "/synthesis?next=%2Foverview%3Ftab%3Dinventory&workspace_id=visual-director-workspace&capture_session_id=visual-director-capture",
    );

    await page.waitForURL(
      "**/overview?tab=inventory&capture_session_id=visual-director-capture&workspace_id=visual-director-workspace",
      { timeout: 12_000 },
    );
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

async function installFakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => new MediaStream(),
      },
    });
  });
}
