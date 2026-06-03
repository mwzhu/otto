import "server-only";

import { localUploadKeyFromUrl, readLocalUpload } from "@/lib/adapters/local-upload";
import { anthropicModelForPrompt } from "@/lib/ai/models";
import { getServerEnv } from "@/lib/env";

export type ScreenFrameVisionInput = {
  filename: string;
  mimeType: string;
  storageKey: string;
  storageUrl?: string | null;
  appName?: string | null;
  windowTitle?: string | null;
  uiStateLabel?: string | null;
  ocrText?: string | null;
  signalTags?: string[];
  diffScore?: number | null;
  bytes?: Buffer;
  forceMultimodal?: boolean;
  allowMultimodal?: boolean;
};

export type VisualObservationStructuredJson = {
  ui_state_label: string;
  ocr_text: string;
  systems: string[];
  visible_fields: string[];
  actions_observed: string[];
  errors_or_warnings: string[];
  decisions_or_approvals: string[];
  copied_values_or_artifacts: string[];
  confidence: number;
};

export type ScreenFrameVisionResult = {
  meaningfulStateChange: boolean;
  uiStateLabel: string;
  ocrText?: string;
  signalTags: string[];
  structuredJson: VisualObservationStructuredJson;
  confidence: number;
  provider: "deterministic-screen-vision" | "anthropic-vision";
  model: string;
  promptTemplateId: string;
  promptTemplateVersion: string;
  degradedReasons: string[];
};

export async function analyzeScreenFrame(
  input: ScreenFrameVisionInput,
): Promise<ScreenFrameVisionResult> {
  const deterministic = deterministicScreenVision(input);
  const env = getServerEnv();
  if (
    env.OTTO_OPERATOR_VISION_PROVIDER === "anthropic-vision" &&
    input.allowMultimodal !== false &&
    shouldRunMultimodal(input, deterministic.signalTags) &&
    env.ANTHROPIC_API_KEY
  ) {
    try {
      return await analyzeWithAnthropicVision(input, deterministic);
    } catch (error) {
      return {
        ...deterministic,
        degradedReasons: [
          ...deterministic.degradedReasons,
          "multimodal_vision_failed",
          error instanceof Error ? error.message : "Unknown vision error",
        ],
      };
    }
  }
  return deterministic;
}

function deterministicScreenVision(
  input: ScreenFrameVisionInput,
): ScreenFrameVisionResult {
  const text = [
    input.ocrText,
    input.uiStateLabel,
    input.appName,
    input.windowTitle,
    input.filename,
  ]
    .filter(Boolean)
    .join(" ");
  const signalTags = uniqueStrings([
    ...(input.signalTags ?? []),
    ...deriveScreenSignalTags(text),
  ]);
  const uiStateLabel =
    input.uiStateLabel?.trim() ||
    labelFromSignals(signalTags) ||
    labelFromWindow(input.windowTitle, input.appName) ||
    "Captured screenshare keyframe";
  const hasUsableText = Boolean(input.ocrText?.trim());
  const structuredJson: VisualObservationStructuredJson = {
    ui_state_label: uiStateLabel,
    ocr_text: input.ocrText?.trim() || "",
    systems: systemNamesFromText(text),
    visible_fields: [],
    actions_observed: actionLabelsFromSignals(signalTags),
    errors_or_warnings: /\b(error|warning|failed|exception)\b/i.test(text)
      ? [trimText(text, 160)]
      : [],
    decisions_or_approvals: /\b(approve|reject|decision)\b/i.test(text)
      ? [trimText(text, 160)]
      : [],
    copied_values_or_artifacts: /\b(copy|paste|csv|xlsx|download|export)\b/i.test(text)
      ? [trimText(text, 160)]
      : [],
    confidence: hasUsableText ? 0.76 : signalTags.length > 1 ? 0.66 : 0.58,
  };
  return {
    meaningfulStateChange:
      input.diffScore === undefined ||
      input.diffScore === null ||
      input.diffScore >= 0.08 ||
      signalTags.some((tag) => tag !== "screen_frame_sampled"),
    uiStateLabel,
    ocrText: input.ocrText?.trim() || undefined,
    signalTags,
    structuredJson,
    confidence: structuredJson.confidence,
    provider: "deterministic-screen-vision",
    model: "deterministic-local",
    promptTemplateId: "operator.screen_frame_vision",
    promptTemplateVersion: "1",
    degradedReasons: hasUsableText
      ? []
      : [
          localUploadKeyFromUrl(input.storageUrl)
            ? "local_frame_ocr_not_configured"
            : "frame_ocr_provider_not_configured",
        ],
  };
}

async function analyzeWithAnthropicVision(
  input: ScreenFrameVisionInput,
  fallback: ScreenFrameVisionResult,
): Promise<ScreenFrameVisionResult> {
  const env = getServerEnv();
  const promptTemplateId = "operator.screen_frame_vision";
  const model = anthropicModelForPrompt(env, promptTemplateId);
  const imageBytes = await resolveImageBytes(input);
  if (!imageBytes) {
    return {
      ...fallback,
      degradedReasons: [...fallback.degradedReasons, "vision_image_unavailable"],
    };
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Read this workflow screen frame. Return only JSON with keys:",
                "ui_state_label, ocr_text, systems, visible_fields, actions_observed,",
                "errors_or_warnings, decisions_or_approvals, copied_values_or_artifacts, confidence.",
                `Known OCR text: ${input.ocrText ?? ""}`,
                `Known window/app: ${[input.appName, input.windowTitle].filter(Boolean).join(" / ")}`,
              ].join("\n"),
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: input.mimeType || "image/jpeg",
                data: imageBytes.toString("base64"),
              },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic vision request failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = body.content?.find((block) => block.type === "text")?.text ?? "";
  const structuredJson = normalizeStructuredVisionJson(text, fallback.structuredJson);
  const signalTags = uniqueStrings([
    ...fallback.signalTags,
    ...deriveScreenSignalTags(
      [
        structuredJson.ui_state_label,
        structuredJson.ocr_text,
        structuredJson.actions_observed.join(" "),
        structuredJson.errors_or_warnings.join(" "),
      ].join(" "),
    ),
  ]);
  return {
    meaningfulStateChange: true,
    uiStateLabel: structuredJson.ui_state_label || fallback.uiStateLabel,
    ocrText: structuredJson.ocr_text || fallback.ocrText,
    signalTags,
    structuredJson,
    confidence: structuredJson.confidence,
    provider: "anthropic-vision",
    model,
    promptTemplateId,
    promptTemplateVersion: "1",
    degradedReasons: [],
  };
}

async function resolveImageBytes(input: ScreenFrameVisionInput) {
  if (input.bytes) return input.bytes;
  const localKey = localUploadKeyFromUrl(input.storageUrl);
  if (localKey) return (await readLocalUpload(localKey)).bytes;
  if (!input.storageUrl) return null;
  const response = await fetch(input.storageUrl);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

function shouldRunMultimodal(input: ScreenFrameVisionInput, signalTags: string[]) {
  if (input.forceMultimodal) return true;
  if ((input.diffScore ?? 0) >= 0.22) return true;
  if (signalTags.some((tag) => tag.startsWith("transcript_trigger_"))) return true;
  const text = [input.ocrText, input.uiStateLabel, input.windowTitle].filter(Boolean).join(" ");
  return /\b(error|warning|exception|approve|reject|table|spreadsheet|form|export|download|copy|paste)\b/i.test(text);
}

function normalizeStructuredVisionJson(
  text: string,
  fallback: VisualObservationStructuredJson,
): VisualObservationStructuredJson {
  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
  const record = parsed as Record<string, unknown>;
  return {
    ui_state_label: stringValue(record.ui_state_label) ?? fallback.ui_state_label,
    ocr_text: stringValue(record.ocr_text) ?? fallback.ocr_text,
    systems: stringArray(record.systems),
    visible_fields: stringArray(record.visible_fields),
    actions_observed: stringArray(record.actions_observed),
    errors_or_warnings: stringArray(record.errors_or_warnings),
    decisions_or_approvals: stringArray(record.decisions_or_approvals),
    copied_values_or_artifacts: stringArray(record.copied_values_or_artifacts),
    confidence: numberValue(record.confidence) ?? fallback.confidence,
  };
}

export function deriveScreenSignalTags(text: string) {
  const normalized = text.toLowerCase();
  const tags: string[] = [];
  if (/\b(copy|paste|clipboard)\b/.test(normalized)) {
    tags.push("copy_paste_between_systems");
  }
  if (/\b(excel|spreadsheet|google sheets|sheet|xlsx|csv)\b/.test(normalized)) {
    tags.push("alt_tab_to_spreadsheet", "left_system_of_record");
  }
  if (/\b(search|filter|lookup|find)\b/.test(normalized)) {
    tags.push("manual_search_or_filtering");
  }
  if (/\b(download|upload|export|import|attach|file)\b/.test(normalized)) {
    tags.push("file_download_upload");
  }
  if (/\b(refresh|loading|waiting|spinner|pending)\b/.test(normalized)) {
    tags.push("waiting_or_refreshing");
  }
  if (/\b(re-enter|re enter|duplicate|again|same value)\b/.test(normalized)) {
    tags.push("duplicate_data_entry");
  }
  if (/\b(comment|note|notes|remark)\b/.test(normalized)) {
    tags.push("comments_or_notes_as_state");
  }
  return uniqueStrings(tags);
}

function labelFromSignals(signalTags: string[]) {
  if (signalTags.includes("copy_paste_between_systems")) {
    return "Copy or paste between workflow systems";
  }
  if (signalTags.includes("alt_tab_to_spreadsheet")) {
    return "Spreadsheet used during workflow";
  }
  if (signalTags.includes("manual_search_or_filtering")) {
    return "Manual search or filtering on screen";
  }
  if (signalTags.includes("file_download_upload")) {
    return "File transfer step on screen";
  }
  if (signalTags.includes("duplicate_data_entry")) {
    return "Possible duplicate data entry";
  }
  if (signalTags.includes("comments_or_notes_as_state")) {
    return "Notes or comments used as workflow state";
  }
  return null;
}

function labelFromWindow(windowTitle?: string | null, appName?: string | null) {
  const value = [appName, windowTitle].filter(Boolean).join(" - ").trim();
  return value || null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function actionLabelsFromSignals(signalTags: string[]) {
  return signalTags
    .filter((tag) => tag !== "screen_frame_sampled")
    .map((tag) => tag.replace(/_/g, " "));
}

function systemNamesFromText(text: string) {
  return uniqueStrings(
    [
      ["Salesforce", /\bsalesforce\b/i],
      ["NetSuite", /\bnetsuite\b/i],
      ["SAP", /\bsap\b/i],
      ["Workday", /\bworkday\b/i],
      ["ServiceNow", /\bservice ?now\b/i],
      ["Zendesk", /\bzendesk\b/i],
      ["Excel", /\b(excel|spreadsheet|xlsx|csv)\b/i],
      ["Google Sheets", /\bgoogle sheets?\b/i],
      ["Gmail", /\bgmail\b/i],
      ["Slack", /\bslack\b/i],
    ]
      .filter(([, pattern]) => (pattern as RegExp).test(text))
      .map(([name]) => name as string),
  );
}

function trimText(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function safeJson(text: string) {
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  try {
    return JSON.parse(match?.[1] ?? text);
  } catch {
    return null;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}
