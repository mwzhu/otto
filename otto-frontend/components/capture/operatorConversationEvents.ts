import type { CaptureConversationMessage } from "@/components/capture/ConversationPanel";

export function appendCaptureMessage(
  current: CaptureConversationMessage[],
  next: CaptureConversationMessage,
) {
  if (current.some((message) => message.id === next.id)) return current;
  return [...current, next].slice(-80);
}

export function captureMessageFromDataEvent(
  args: unknown[],
): CaptureConversationMessage | null {
  const payload = args.find(isDataPayload);
  if (!payload) return null;
  const decoded =
    typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  let event: unknown;
  try {
    event = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const data = event as {
    event?: unknown;
    payload?: unknown;
    capture_session_id?: unknown;
  };
  if (typeof data.event !== "string") return null;
  const eventPayload =
    data.payload && typeof data.payload === "object"
      ? (data.payload as Record<string, unknown>)
      : {};
  const timestamp =
    typeof eventPayload.sent_at === "string"
      ? eventPayload.sent_at
      : new Date().toISOString();
  const baseId = `${data.event}-${String(
    eventPayload.turn_index ?? eventPayload.notice_type ?? Date.now(),
  )}`;

  if (data.event === "operator.turn.ingested") {
    const text = stringValue(eventPayload.transcript);
    if (!text) return null;
    return {
      id: `${baseId}-operator`,
      speaker: "operator",
      text,
      timestamp,
    };
  }
  if (
    data.event === "operator.turn.dispatched" ||
    data.event === "operator.turn.delivery_updated"
  ) {
    const text = stringValue(eventPayload.agent_utterance);
    if (!text) return null;
    return {
      id: `${baseId}-agent`,
      speaker: "agent",
      text,
      timestamp,
    };
  }
  if (
    data.event === "operator.session.notice" ||
    data.event === "operator.control.updated" ||
    data.event === "operator.session.completed"
  ) {
    return {
      id: `${baseId}-system`,
      speaker: "system",
      text: systemNoticeText(data.event, eventPayload),
      timestamp,
    };
  }
  return null;
}

function isDataPayload(value: unknown): value is Uint8Array | string {
  return typeof value === "string" || value instanceof Uint8Array;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function systemNoticeText(event: string, payload: Record<string, unknown>) {
  const noticeType = stringValue(payload.notice_type);
  const message = stringValue(payload.message);
  if (message) return message;
  if (noticeType === "operator_agent_ready") return "Otto is ready.";
  if (noticeType === "worker_startup_failed") {
    return "The voice worker could not start. Typed fallback remains available.";
  }
  if (event === "operator.session.completed") return "Capture completed.";
  if (event === "operator.control.updated") {
    const action = stringValue(payload.action) ?? "updated";
    return `Capture control ${action.replaceAll("_", " ")}.`;
  }
  return noticeType
    ? noticeType.replaceAll("_", " ")
    : event.replaceAll(".", " ");
}
