import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getServerEnv } from "@/lib/env";
import {
  localUploadKeyFromUrl,
  readLocalUpload,
} from "@/lib/adapters/local-upload";
import { extractOcrText } from "@/lib/adapters/ocr";
import { stepCandidatesFromTranscript } from "@/lib/interview/operator/segmenter";

export type ScreenRecordingTranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
};

export type ScreenRecordingKeyframeCandidate = {
  tsMs: number;
  label: string;
  perceptualHash?: string;
  bytes?: Buffer;
  mimeType?: "image/png";
  ocrText?: string;
  ocrProvider?: string;
  confidence?: number;
  signalTags: string[];
  degradedReasons?: string[];
};

export type ScreenRecordingStepCandidate = {
  tsStartMs: number;
  tsEndMs?: number;
  title: string;
  actionVerb?: string;
  actionObject?: string;
  confidence: number;
};

export type ScreenRecordingAnalysis = {
  transcriptSegments: ScreenRecordingTranscriptSegment[];
  keyframes: ScreenRecordingKeyframeCandidate[];
  provisionalSteps: ScreenRecordingStepCandidate[];
  provider:
    | "deepgram-prerecorded"
    | "deepgram-prerecorded-local-audio"
    | "deterministic-video-sampler";
  degradedReasons: string[];
  providerErrors: string[];
};

const TRANSCRIPT_TRIGGER_WORDS = [
  "click",
  "submit",
  "approve",
  "reject",
  "error",
  "exception",
  "wait",
  "export",
  "download",
  "upload",
  "copy",
  "paste",
  "spreadsheet",
  "reconcile",
  "override",
];

export async function analyzeScreenRecording(input: {
  filename: string;
  mimeType: string;
  storageKey: string;
  storageUrl?: string | null;
  durationSeconds?: number | null;
}): Promise<ScreenRecordingAnalysis> {
  const providerErrors: string[] = [];
  const durationMs = Math.max(1_000, (input.durationSeconds ?? 90) * 1000);
  let transcriptSegments: ScreenRecordingTranscriptSegment[] = [];
  let provider: ScreenRecordingAnalysis["provider"] =
    "deterministic-video-sampler";

  if (canUseDeepgramUrl(input.storageUrl)) {
    try {
      transcriptSegments = await transcribeWithDeepgram(input.storageUrl!);
      provider = "deepgram-prerecorded";
    } catch (error) {
      providerErrors.push(errorMessage(error));
    }
  } else if (canUseDeepgramLocalAudio(input.storageUrl)) {
    try {
      const audio = await demuxLocalUploadAudio(
        input.storageUrl!,
        input.mimeType,
      );
      transcriptSegments = await transcribeWithDeepgramAudioBytes(audio);
      provider = "deepgram-prerecorded-local-audio";
    } catch (error) {
      providerErrors.push(errorMessage(error));
    }
  }

  const keyframeResult = await extractKeyframes({
    ...input,
    durationMs,
    transcriptSegments,
  }).catch((error) => ({
    keyframes: deterministicKeyframes(durationMs, input.filename).map(
      (keyframe) => ({
        ...keyframe,
        degradedReasons: [
          "ffmpeg_frame_extraction_failed",
          errorMessage(error),
        ],
      }),
    ),
    degradedReasons: ["ffmpeg_frame_extraction_failed", errorMessage(error)],
    providerErrors: [errorMessage(error)],
  }));
  providerErrors.push(...keyframeResult.providerErrors);
  const keyframes = keyframeResult.keyframes;
  const transcriptSteps = stepCandidatesFromTranscript(transcriptSegments);
  const provisionalSteps =
    transcriptSteps.length > 0
      ? transcriptSteps
      : weakStepCandidatesFromKeyframes(keyframes);
  const degradedReasons = [
    ...(transcriptSegments.length === 0
      ? [
          providerErrors.some((error) => /ffmpeg|demux/i.test(error))
            ? "audio_demux_failed"
            : "video_transcription_unavailable",
        ]
      : []),
    ...keyframeResult.degradedReasons,
  ];

  return {
    transcriptSegments,
    keyframes,
    provisionalSteps,
    provider,
    degradedReasons,
    providerErrors,
  };
}

async function extractKeyframes(input: {
  filename: string;
  mimeType: string;
  storageKey: string;
  storageUrl?: string | null;
  durationMs: number;
  transcriptSegments: ScreenRecordingTranscriptSegment[];
}): Promise<{
  keyframes: ScreenRecordingKeyframeCandidate[];
  degradedReasons: string[];
  providerErrors: string[];
}> {
  if (!operatorFrameExtractionEnabled()) {
    return {
      keyframes: deterministicKeyframes(input.durationMs, input.filename),
      degradedReasons: ["keyframe_ocr_provider_not_configured"],
      providerErrors: [],
    };
  }

  const dir = join(tmpdir(), `otto-screen-frames-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const source = await materializeVideoSource(input, dir);
    const providerErrors: string[] = [];
    const durationMs = await probeVideoDurationMs(source).catch((error) => {
      providerErrors.push(errorMessage(error));
      return input.durationMs;
    });
    const sceneTimestamps = await detectSceneChangeTimestamps(
      source,
      dir,
    ).catch(() => []);
    const timestamps = selectedTimestamps({
      durationMs,
      sceneTimestamps,
      transcriptSegments: input.transcriptSegments,
    });
    const candidates: ScreenRecordingKeyframeCandidate[] = [];
    const seenHashes = new Set<string>();
    for (const [index, tsMs] of timestamps.entries()) {
      const outputPath = join(
        dir,
        `frame-${String(index).padStart(5, "0")}.png`,
      );
      const seconds = (tsMs / 1000).toFixed(3);
      const extracted = await extractFrameWithHash({
        source,
        outputPath,
        seconds,
      }).catch((error) => {
        providerErrors.push(errorMessage(error));
        return null;
      });
      if (!extracted) continue;
      const { bytes, perceptualHash } = extracted;
      if (isDuplicateFrame(perceptualHash, seenHashes)) continue;
      seenHashes.add(perceptualHash);
      const ocr = await extractOcrText({
        imageBytes: bytes,
        mimeType: "image/png",
        fallbackText: labelForTimestamp(tsMs, input.filename),
      });
      candidates.push({
        tsMs,
        label: labelForTimestamp(tsMs, input.filename, ocr.text),
        perceptualHash,
        bytes,
        mimeType: "image/png",
        ocrText: ocr.text || undefined,
        ocrProvider: ocr.provider,
        confidence: ocr.confidence,
        signalTags: uniqueStrings([
          "screen_recording_upload",
          "video_keyframe_candidate",
          "ffmpeg_frame_extracted",
          ocr.text ? "ocr_extracted" : "ocr_pending",
          ...triggerTagsNearTimestamp(input.transcriptSegments, tsMs),
        ]),
        degradedReasons: ocr.degradedReasons,
      });
    }
    const allDegradedReasons = uniqueStrings(
      candidates.flatMap((candidate) => candidate.degradedReasons ?? []),
    );
    if (candidates.length > 0) {
      return {
        keyframes: candidates,
        degradedReasons: allDegradedReasons,
        providerErrors,
      };
    }
    return {
      keyframes: deterministicKeyframes(durationMs, input.filename),
      degradedReasons: [
        "ffmpeg_frame_extraction_empty",
        "keyframe_ocr_provider_not_configured",
        ...providerErrors,
      ],
      providerErrors,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function materializeVideoSource(
  input: { storageUrl?: string | null; mimeType: string },
  dir: string,
) {
  const localKey = localUploadKeyFromUrl(input.storageUrl);
  const inputPath = join(
    dir,
    `recording${extensionForMimeType(input.mimeType)}`,
  );
  if (!localKey) {
    if (!input.storageUrl) throw new Error("Video storage URL is unavailable.");
    const response = await fetch(input.storageUrl);
    if (!response.ok) {
      throw new Error(
        `Could not download video for frame extraction: ${response.status}`,
      );
    }
    await writeFile(inputPath, Buffer.from(await response.arrayBuffer()));
    return inputPath;
  }
  const upload = await readLocalUpload(localKey);
  await writeFile(inputPath, upload.bytes);
  return inputPath;
}

async function detectSceneChangeTimestamps(source: string, dir: string) {
  const markerPath = join(dir, "scene-scan.txt");
  const result = await runFfmpegWithOutput(
    [
      "-i",
      source,
      "-vf",
      "select='gt(scene,0.4)',showinfo",
      "-an",
      "-f",
      "null",
      "-",
    ],
    "scene-change detection",
  );
  await writeFile(markerPath, result.stderr);
  const timestamps = [...result.stderr.matchAll(/pts_time:([0-9.]+)/g)]
    .map((match) => Math.round(Number(match[1]) * 1000))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return uniqueNumbers(timestamps);
}

function selectedTimestamps(input: {
  durationMs: number;
  sceneTimestamps: number[];
  transcriptSegments: ScreenRecordingTranscriptSegment[];
}) {
  const floorIntervalMs = 8_000;
  const floor = Array.from(
    { length: Math.max(1, Math.ceil(input.durationMs / floorIntervalMs)) },
    (_, index) => Math.min(input.durationMs - 1, index * floorIntervalMs),
  );
  const triggerFrames = input.transcriptSegments
    .filter((segment) => containsTranscriptTrigger(segment.text))
    .flatMap((segment) => [
      segment.startMs,
      Math.round((segment.startMs + segment.endMs) / 2),
      segment.endMs,
    ]);
  const candidates = uniqueNumbers([
    0,
    ...input.sceneTimestamps,
    ...floor,
    ...triggerFrames,
    Math.max(0, input.durationMs - 1),
  ])
    .filter((value) => value >= 0 && value < input.durationMs + 1_000)
    .sort((left, right) => left - right);
  return spreadSample(candidates, 120);
}

async function probeVideoDurationMs(source: string) {
  const result = await runFfprobeWithOutput([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    source,
  ]);
  const seconds = Number(result.stdout.toString("utf8").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("ffprobe duration unavailable.");
  }
  return Math.max(1_000, Math.round(seconds * 1000));
}

async function extractFrameWithHash(input: {
  source: string;
  outputPath: string;
  seconds: string;
}) {
  await runFfmpeg(
    [
      "-y",
      "-ss",
      input.seconds,
      "-i",
      input.source,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale='min(960,iw)':-2,format=rgb24",
      "-update",
      "1",
      input.outputPath,
    ],
    "frame extraction",
  );
  const hashResult = await runFfmpegWithOutput(
    [
      "-y",
      "-ss",
      input.seconds,
      "-i",
      input.source,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=16:9,format=gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    "frame hash extraction",
  );
  const bytes = await readFile(input.outputPath);
  const perceptualHash =
    hashResult.stdout.length > 0
      ? perceptualHashFromRawBytes(hashResult.stdout)
      : createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return { bytes, perceptualHash };
}

function perceptualHashFromRawBytes(bytes: Buffer) {
  const averageValue =
    bytes.reduce((sum, value) => sum + value, 0) / Math.max(1, bytes.length);
  return [...bytes]
    .map((value) => (value >= averageValue ? "1" : "0"))
    .join("");
}

function isDuplicateFrame(hash: string, seen: Set<string>) {
  for (const existing of seen) {
    if (
      hash.length === existing.length &&
      hammingDistance(hash, existing) <= 8
    ) {
      return true;
    }
    if (hash === existing) return true;
  }
  return false;
}

function hammingDistance(left: string, right: string) {
  let distance = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) distance += 1;
  }
  return distance + Math.abs(left.length - right.length);
}

function weakStepCandidatesFromKeyframes(
  keyframes: ScreenRecordingKeyframeCandidate[],
): ScreenRecordingStepCandidate[] {
  return keyframes.slice(0, 8).map((keyframe, index) => ({
    tsStartMs: keyframe.tsMs,
    tsEndMs: keyframes[index + 1]?.tsMs ?? keyframe.tsMs + 15_000,
    title: titleCase(trimText(keyframe.label, 72)),
    actionVerb: "review",
    actionObject: trimText(keyframe.ocrText || keyframe.label, 160),
    confidence: 0.32,
  }));
}

function canUseDeepgramUrl(storageUrl?: string | null) {
  const env = getServerEnv();
  return Boolean(
    env.DEEPGRAM_API_KEY && storageUrl && !localUploadKeyFromUrl(storageUrl),
  );
}

function canUseDeepgramLocalAudio(storageUrl?: string | null) {
  const env = getServerEnv();
  return Boolean(env.DEEPGRAM_API_KEY && localUploadKeyFromUrl(storageUrl));
}

async function transcribeWithDeepgram(
  storageUrl: string,
): Promise<ScreenRecordingTranscriptSegment[]> {
  const env = getServerEnv();
  const response = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true",
    {
      method: "POST",
      headers: {
        authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: storageUrl }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Deepgram prerecorded transcription failed: ${response.status}${body ? ` ${body}` : ""}`,
    );
  }
  const payload = (await response.json()) as DeepgramPrerecordedResponse;
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim();
  if (!transcript) return [];
  const words = alternative?.words ?? [];
  if (words.length === 0) {
    return [
      {
        startMs: 0,
        endMs: Math.max(1_000, transcript.length * 45),
        text: transcript,
      },
    ];
  }
  return segmentWords(words);
}

async function demuxLocalUploadAudio(storageUrl: string, mimeType: string) {
  const key = localUploadKeyFromUrl(storageUrl);
  if (!key) throw new Error("Local upload key missing for audio demux.");
  const upload = await readLocalUpload(key);
  const dir = join(tmpdir(), `otto-screen-audio-${randomUUID()}`);
  const inputExt = extensionForMimeType(mimeType);
  const inputPath = join(dir, `recording${inputExt}`);
  const outputPath = join(dir, "audio.wav");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(inputPath, upload.bytes);
    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribeWithDeepgramAudioBytes(
  audio: Buffer,
): Promise<ScreenRecordingTranscriptSegment[]> {
  const env = getServerEnv();
  const body = new ArrayBuffer(audio.byteLength);
  new Uint8Array(body).set(audio);
  const response = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true",
    {
      method: "POST",
      headers: {
        authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        "content-type": "audio/wav",
      },
      body,
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Deepgram local audio transcription failed: ${response.status}${body ? ` ${body}` : ""}`,
    );
  }
  return transcriptSegmentsFromDeepgramResponse(
    (await response.json()) as DeepgramPrerecordedResponse,
  );
}

function transcriptSegmentsFromDeepgramResponse(
  payload: DeepgramPrerecordedResponse,
) {
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim();
  if (!transcript) return [];
  const words = alternative?.words ?? [];
  if (words.length === 0) {
    return [
      {
        startMs: 0,
        endMs: Math.max(1_000, transcript.length * 45),
        text: transcript,
      },
    ];
  }
  return segmentWords(words);
}

async function runFfmpeg(args: string[], label = "ffmpeg") {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg ${label} timed out.`));
    }, 60_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg ${label} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg ${label} failed with exit ${code}: ${stderr}`),
        );
    });
  });
}

async function runFfmpegWithOutput(args: string[], label = "ffmpeg") {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg ${label} timed out.`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg ${label} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else
        reject(
          new Error(`ffmpeg ${label} failed with exit ${code}: ${stderr}`),
        );
    });
  });
}

async function runFfprobeWithOutput(args: string[]) {
  return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffprobe timed out."));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`ffprobe failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else reject(new Error(`ffprobe failed with exit ${code}: ${stderr}`));
    });
  });
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("quicktime")) return ".mov";
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("mp4")) return ".mp4";
  return ".video";
}

function segmentWords(words: DeepgramWord[]) {
  const segments: ScreenRecordingTranscriptSegment[] = [];
  let current: DeepgramWord[] = [];
  for (const word of words) {
    current.push(word);
    const first = current[0];
    const currentDuration = (word.end - first.start) * 1000;
    const shouldFlush =
      currentDuration >= 20_000 ||
      /[.!?]$/.test(word.punctuated_word ?? word.word);
    if (shouldFlush) {
      segments.push(wordsToSegment(current));
      current = [];
    }
  }
  if (current.length > 0) segments.push(wordsToSegment(current));
  return segments;
}

function wordsToSegment(
  words: DeepgramWord[],
): ScreenRecordingTranscriptSegment {
  const text = words.map((word) => word.punctuated_word || word.word).join(" ");
  return {
    startMs: Math.max(0, Math.round(words[0].start * 1000)),
    endMs: Math.max(1_000, Math.round(words[words.length - 1].end * 1000)),
    text,
    confidence: average(words.map((word) => word.confidence).filter(isNumber)),
  };
}

function deterministicKeyframes(durationMs: number, filename: string) {
  const count = Math.min(6, Math.max(3, Math.ceil(durationMs / 60_000) + 2));
  return Array.from(
    { length: count },
    (_, index): ScreenRecordingKeyframeCandidate => {
      const ratio = count === 1 ? 0 : index / (count - 1);
      const tsMs = Math.round(durationMs * ratio);
      return {
        tsMs,
        label: `Keyframe candidate ${index + 1} from ${filename}`,
        signalTags: [
          "screen_recording_upload",
          "video_keyframe_candidate",
          "ocr_pending",
        ],
      };
    },
  );
}

function operatorFrameExtractionEnabled() {
  return process.env.OTTO_OPERATOR_FRAME_EXTRACTION_ENABLED !== "false";
}

function labelForTimestamp(tsMs: number, filename: string, ocrText?: string) {
  const seconds = Math.round(tsMs / 1000);
  const ocrLabel = ocrText ? trimText(ocrText, 96) : null;
  return ocrLabel ?? `Extracted keyframe at ${seconds}s from ${filename}`;
}

function containsTranscriptTrigger(text: string) {
  const normalized = text.toLowerCase();
  return TRANSCRIPT_TRIGGER_WORDS.some((word) =>
    new RegExp(`\\b${word}\\b`, "i").test(normalized),
  );
}

function triggerTagsNearTimestamp(
  segments: ScreenRecordingTranscriptSegment[],
  tsMs: number,
) {
  const nearbyText = segments
    .filter(
      (segment) =>
        segment.startMs <= tsMs + 5_000 && segment.endMs >= tsMs - 5_000,
    )
    .map((segment) => segment.text)
    .join(" ");
  if (!nearbyText) return [];
  return TRANSCRIPT_TRIGGER_WORDS.filter((word) =>
    new RegExp(`\\b${word}\\b`, "i").test(nearbyText),
  ).map((word) => `transcript_trigger_${word}`);
}

function uniqueNumbers(values: number[]) {
  return [
    ...new Set(
      values.map((value) => Math.round(value)).filter(Number.isFinite),
    ),
  ];
}

function spreadSample(values: number[], max: number) {
  if (values.length <= max) return values;
  if (max <= 1) return values.slice(0, Math.max(0, max));
  const sampled: number[] = [];
  const lastIndex = values.length - 1;
  for (let index = 0; index < max; index += 1) {
    sampled.push(values[Math.round((index * lastIndex) / (max - 1))]);
  }
  return uniqueNumbers(sampled).sort((left, right) => left - right);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function trimText(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function titleCase(text: string) {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function average(values: number[]) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type DeepgramPrerecordedResponse = {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[];
      }>;
    }>;
  };
};

type DeepgramWord = {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
};
