import "server-only";

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getServerEnv } from "@/lib/env";
import { localUploadKeyFromUrl, readLocalUpload } from "@/lib/adapters/local-upload";
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
  ocrText?: string;
  signalTags: string[];
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
  let provider: ScreenRecordingAnalysis["provider"] = "deterministic-video-sampler";

  if (canUseDeepgramUrl(input.storageUrl)) {
    try {
      transcriptSegments = await transcribeWithDeepgram(input.storageUrl!);
      provider = "deepgram-prerecorded";
    } catch (error) {
      providerErrors.push(errorMessage(error));
    }
  } else if (canUseDeepgramLocalAudio(input.storageUrl)) {
    try {
      const audio = await demuxLocalUploadAudio(input.storageUrl!, input.mimeType);
      transcriptSegments = await transcribeWithDeepgramAudioBytes(audio);
      provider = "deepgram-prerecorded-local-audio";
    } catch (error) {
      providerErrors.push(errorMessage(error));
    }
  }

  const keyframes = deterministicKeyframes(durationMs, input.filename);
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
    "keyframe_ocr_provider_not_configured",
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
    env.DEEPGRAM_API_KEY &&
      storageUrl &&
      !localUploadKeyFromUrl(storageUrl),
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
    throw new Error(`Deepgram prerecorded transcription failed: ${response.status}${body ? ` ${body}` : ""}`);
  }
  const payload = (await response.json()) as DeepgramPrerecordedResponse;
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alternative?.transcript?.trim();
  if (!transcript) return [];
  const words = alternative?.words ?? [];
  if (words.length === 0) {
    return [{ startMs: 0, endMs: Math.max(1_000, transcript.length * 45), text: transcript }];
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
    throw new Error(`Deepgram local audio transcription failed: ${response.status}${body ? ` ${body}` : ""}`);
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
    return [{ startMs: 0, endMs: Math.max(1_000, transcript.length * 45), text: transcript }];
  }
  return segmentWords(words);
}

async function runFfmpeg(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg audio demux timed out."));
    }, 60_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk).slice(0, 2_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg audio demux failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg audio demux failed with exit ${code}: ${stderr}`));
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
    const shouldFlush = currentDuration >= 20_000 || /[.!?]$/.test(word.punctuated_word ?? word.word);
    if (shouldFlush) {
      segments.push(wordsToSegment(current));
      current = [];
    }
  }
  if (current.length > 0) segments.push(wordsToSegment(current));
  return segments;
}

function wordsToSegment(words: DeepgramWord[]): ScreenRecordingTranscriptSegment {
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
  return Array.from({ length: count }, (_, index): ScreenRecordingKeyframeCandidate => {
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
  });
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
