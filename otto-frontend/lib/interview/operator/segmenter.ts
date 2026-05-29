import "server-only";

export type OperatorSegmenterTranscriptSegment = {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
};

export type OperatorSegmenterScreenEvent = {
  id?: string;
  tsMs: number;
  eventType: string;
  appName?: string | null;
  windowTitle?: string | null;
  uiStateLabel?: string | null;
  ocrText?: string | null;
  signalTags: string[];
};

export type OperatorSegmenterStepCandidate = {
  tsStartMs: number;
  tsEndMs?: number;
  title: string;
  actionVerb?: string;
  actionObject?: string;
  confidence: number;
  metadata?: Record<string, unknown>;
};

const screenSignalLabels: Record<
  string,
  { title: string; actionVerb: string; confidence: number }
> = {
  copy_paste_between_systems: {
    title: "Copy data between systems",
    actionVerb: "copy",
    confidence: 0.7,
  },
  alt_tab_to_spreadsheet: {
    title: "Check or update spreadsheet outside system",
    actionVerb: "update",
    confidence: 0.68,
  },
  manual_search_or_filtering: {
    title: "Manually search or filter records",
    actionVerb: "search",
    confidence: 0.66,
  },
  file_download_upload: {
    title: "Download or upload workflow file",
    actionVerb: "upload",
    confidence: 0.66,
  },
  waiting_or_refreshing: {
    title: "Wait for system refresh or processing",
    actionVerb: "wait",
    confidence: 0.58,
  },
  duplicate_data_entry: {
    title: "Enter duplicate data manually",
    actionVerb: "enter",
    confidence: 0.72,
  },
  comments_or_notes_as_state: {
    title: "Use comments or notes as workflow state",
    actionVerb: "review",
    confidence: 0.64,
  },
  left_system_of_record: {
    title: "Leave system of record for supporting work",
    actionVerb: "open",
    confidence: 0.68,
  },
};

export function stepCandidatesFromTranscript(
  segments: OperatorSegmenterTranscriptSegment[],
): OperatorSegmenterStepCandidate[] {
  return segments.flatMap((segment) =>
    splitActionSentences(segment.text).map((sentence, index) => ({
      tsStartMs: segment.startMs + index * 1000,
      tsEndMs: Math.min(segment.endMs, segment.startMs + (index + 1) * 3000),
      title: titleCase(trimText(sentence, 80)),
      actionVerb: firstVerb(sentence),
      actionObject: trimText(sentence, 180),
      confidence: segment.confidence ? Math.min(0.75, segment.confidence) : 0.58,
      metadata: {
        segment_text: trimText(sentence, 240),
        segmenter: "transcript_action_sentence",
      },
    })),
  ).slice(0, 24);
}

export function stepCandidateFromScreenEvent(
  event: OperatorSegmenterScreenEvent,
): OperatorSegmenterStepCandidate | null {
  const signal = event.signalTags.find((tag) => screenSignalLabels[tag]);
  if (!signal) {
    if (event.eventType !== "screen_recording_keyframe" && event.uiStateLabel) {
      return {
        tsStartMs: event.tsMs,
        tsEndMs: event.tsMs + 1000,
        title: titleCase(trimText(event.uiStateLabel, 80)),
        actionObject: trimText(
          [event.uiStateLabel, event.appName, event.windowTitle]
            .filter(Boolean)
            .join(" | "),
          180,
        ),
        confidence: 0.5,
        metadata: {
          segmenter: "screen_ui_state_label",
          screen_event_id: event.id,
        },
      };
    }
    return null;
  }

  const label = screenSignalLabels[signal];
  return {
    tsStartMs: event.tsMs,
    tsEndMs: event.tsMs + 1000,
    title: label.title,
    actionVerb: label.actionVerb,
    actionObject: trimText(
      [
        event.uiStateLabel,
        event.appName,
        event.windowTitle,
        event.ocrText,
        `signal:${signal}`,
      ]
        .filter(Boolean)
        .join(" | "),
      220,
    ),
    confidence: label.confidence,
    metadata: {
      segmenter: "screen_signal_tag",
      screen_event_id: event.id,
      signal_tag: signal,
      all_signal_tags: event.signalTags,
    },
  };
}

function splitActionSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) =>
      /\b(I|we|then|next|after|before|open|check|copy|paste|enter|submit|approve|review|send|download|upload|update|create|look|go|export|import|save|select|click)\b/i.test(part),
    )
    .slice(0, 6);
}

function firstVerb(text: string) {
  const match = text.match(/\b(open|check|copy|paste|enter|submit|approve|review|send|download|upload|update|create|look|go|export|import|save|select|click)\b/i);
  return match?.[1]?.toLowerCase();
}

export function trimText(text: string, max: number) {
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
