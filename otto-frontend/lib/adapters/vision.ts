import "server-only";

import { localUploadKeyFromUrl } from "@/lib/adapters/local-upload";

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
};

export type ScreenFrameVisionResult = {
  meaningfulStateChange: boolean;
  uiStateLabel: string;
  ocrText?: string;
  signalTags: string[];
  confidence: number;
  provider: "deterministic-screen-vision";
  degradedReasons: string[];
};

export async function analyzeScreenFrame(
  input: ScreenFrameVisionInput,
): Promise<ScreenFrameVisionResult> {
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
  return {
    meaningfulStateChange:
      input.diffScore === undefined ||
      input.diffScore === null ||
      input.diffScore >= 0.08 ||
      signalTags.some((tag) => tag !== "screen_frame_sampled"),
    uiStateLabel,
    ocrText: input.ocrText?.trim() || undefined,
    signalTags,
    confidence: hasUsableText ? 0.76 : signalTags.length > 1 ? 0.66 : 0.58,
    provider: "deterministic-screen-vision",
    degradedReasons: hasUsableText
      ? []
      : [
          localUploadKeyFromUrl(input.storageUrl)
            ? "local_frame_ocr_not_configured"
            : "frame_ocr_provider_not_configured",
        ],
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
