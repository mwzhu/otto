import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, type Page } from "@playwright/test";

test.describe("document and process upload flows", () => {
  test("validates director uploads and gates synthesis until files complete", async ({
    page,
  }) => {
    let workspaceCalls = 0;
    let presignCalls = 0;
    let completeCalls = 0;

    await page.route("**/api/workspaces", async (route) => {
      workspaceCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspace: { id: "upload-flow-workspace" },
        }),
      });
    });
    await page.route("**/api/workspaces/upload-flow-workspace/artifacts/presign", async (route) => {
      presignCalls += 1;
      const body = await route.request().postDataJSON();
      expect(body).toMatchObject({
        filename: "director-notes.txt",
        mime_type: "text/plain",
        artifact_type: "document",
      });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          artifact: { id: "director-upload-artifact" },
          upload_url: "https://upload.test/director-upload-artifact",
        }),
      });
    });
    await page.route("https://upload.test/director-upload-artifact", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });
    await page.route("**/api/artifacts/director-upload-artifact/complete", async (route) => {
      completeCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ artifact: { id: "director-upload-artifact" } }),
      });
    });

    await gotoClean(page, "/onboarding/upload");
    const input = page.locator('input[type="file"]');

    await input.setInputFiles({
      name: "malware.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("not a doc"),
    });
    await expect(page.getByText("Unsupported file type.")).toBeVisible();
    expect(workspaceCalls).toBe(0);
    expect(presignCalls).toBe(0);
    await expect(page.getByRole("button", { name: /Continue/ })).toHaveCount(0);

    const tempDir = await mkdtemp(join(tmpdir(), "otto-upload-"));
    const tooLargePath = join(tempDir, "too-large.pdf");
    await writeFile(tooLargePath, "");
    await truncate(tooLargePath, 51 * 1024 * 1024);
    await input.setInputFiles(tooLargePath);
    await rm(tempDir, { recursive: true, force: true });
    await expect(page.getByText("files must be 50 MB or smaller")).toBeVisible();
    expect(workspaceCalls).toBe(0);
    expect(presignCalls).toBe(0);
    await expect(page.getByRole("button", { name: /Continue/ })).toHaveCount(0);

    await gotoClean(page, "/onboarding/upload");
    await page.locator('input[type="file"]').setInputFiles({
      name: "director-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Process: Returns\nOwner: Support Ops"),
    });
    await expect(page.getByText("Done")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue → Synthesize" })).toBeVisible();
    expect(workspaceCalls).toBe(1);
    expect(presignCalls).toBe(1);
    expect(completeCalls).toBe(1);
  });
});

async function gotoClean(page: Page, path: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console.error: ${message.text()}`);
    }
  });

  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response?.ok(), `HTTP ${response?.status()} for ${path}`).toBeTruthy();
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const realErrors = errors.filter(
    (error) =>
      !error.includes("Download the React DevTools") &&
      !error.includes("hydration mismatch") &&
      !error.includes("aria-controls"),
  );
  expect(realErrors, `errors at ${path}: ${realErrors.join(" | ")}`).toEqual([]);
}
