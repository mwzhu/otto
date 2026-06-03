import "server-only";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerEnv } from "@/lib/env";

export type OcrProvider =
  | "deterministic"
  | "tesseract-local"
  | "hosted-ocr"
  | "multimodal-vision";

export type OcrResult = {
  provider: OcrProvider;
  text: string;
  confidence: number;
  degradedReasons: string[];
};

let tesseractAvailable: boolean | null = null;

export async function extractOcrText(input: {
  imageBytes: Buffer;
  mimeType?: string;
  fallbackText?: string | null;
  provider?: OcrProvider;
}): Promise<OcrResult> {
  const requested = input.provider ?? getServerEnv().OTTO_OPERATOR_OCR_PROVIDER;
  if (requested === "deterministic") {
    return deterministicOcr(input.fallbackText, []);
  }
  if (requested !== "tesseract-local") {
    return deterministicOcr(input.fallbackText, [
      `${requested}_provider_not_configured`,
    ]);
  }
  if (!(await hasTesseractBinary())) {
    return deterministicOcr(input.fallbackText, [
      "tesseract_binary_missing",
      "keyframe_ocr_provider_not_configured",
    ]);
  }

  const dir = join(tmpdir(), `otto-ocr-${randomUUID()}`);
  const imagePath = join(dir, `frame${extensionForMime(input.mimeType)}`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(imagePath, input.imageBytes);
    const text = await runTesseract(imagePath);
    const normalized = normalizeOcrText(text);
    return {
      provider: "tesseract-local",
      text: normalized || input.fallbackText?.trim() || "",
      confidence: normalized ? 0.7 : 0.35,
      degradedReasons: normalized ? [] : ["tesseract_no_text_detected"],
    };
  } catch (error) {
    return deterministicOcr(input.fallbackText, [
      "tesseract_ocr_failed",
      error instanceof Error ? error.message : "Unknown OCR error",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function hasTesseractBinary() {
  if (tesseractAvailable !== null) return tesseractAvailable;
  try {
    await runProcess("tesseract", ["--version"], 5_000);
    tesseractAvailable = true;
  } catch {
    tesseractAvailable = false;
  }
  return tesseractAvailable;
}

async function runTesseract(imagePath: string) {
  return runProcess("tesseract", [imagePath, "stdout", "--psm", "6", "-l", "eng"], 20_000);
}

async function runProcess(command: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

function deterministicOcr(
  fallbackText: string | null | undefined,
  degradedReasons: string[],
): OcrResult {
  return {
    provider: "deterministic",
    text: fallbackText?.trim() || "",
    confidence: fallbackText?.trim() ? 0.45 : 0,
    degradedReasons,
  };
}

function normalizeOcrText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 8_000);
}

function extensionForMime(mimeType?: string) {
  if (mimeType?.includes("png")) return ".png";
  if (mimeType?.includes("webp")) return ".webp";
  return ".jpg";
}
