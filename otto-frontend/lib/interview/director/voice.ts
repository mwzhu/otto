import { fallbackProbeForSlot, type ProbeIntent } from "@/lib/interview/director/probe-library";

export function phraseProbe(intent: ProbeIntent) {
  return intent.phrasing || fallbackProbeForSlot(intent.targetSlot).phrasing;
}
