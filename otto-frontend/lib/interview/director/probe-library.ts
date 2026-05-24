import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

export type ProbeIntent = {
  probeId: string;
  targetSlot: string;
  phrasing: string;
  score: number;
  reason: string;
};

export const probeLibrary: ProbeIntent[] = [
  {
    probeId: "scope-boundaries",
    targetSlot: "scope.boundaries",
    phrasing:
      "What process should we focus on first, and where does it begin and end?",
    score: 100,
    reason: "A named process with boundaries anchors the inventory.",
  },
  {
    probeId: "owner-role",
    targetSlot: "ownership.roles",
    phrasing: "Who is accountable for that process, and which teams participate?",
    score: 95,
    reason: "Ownership is required before follow-up routing is useful.",
  },
  {
    probeId: "systems-of-record",
    targetSlot: "systems.systems_of_record",
    phrasing:
      "Which systems of record or spreadsheets does the team rely on for this?",
    score: 90,
    reason: "Systems expose integration and shadow-process risk.",
  },
  {
    probeId: "frequency-volume",
    targetSlot: "frequency.volume",
    phrasing: "How often does this happen, and what volume does the team handle?",
    score: 80,
    reason: "Frequency and volume shape complexity.",
  },
  {
    probeId: "pain-points",
    targetSlot: "friction.pain_points",
    phrasing:
      "Where does the work slow down, break, or require manual cleanup today?",
    score: 70,
    reason: "Pain points identify friction signals for the dashboard.",
  },
  {
    probeId: "spof-risk",
    targetSlot: "risk.spofs",
    phrasing:
      "Is any part of this dependent on one person or one fragile workaround?",
    score: 60,
    reason: "Single points of failure are a Phase 1 dashboard metric.",
  },
  {
    probeId: "documentation-maturity",
    targetSlot: "documentation.maturity",
    phrasing: "How well is this documented, and where does the source of truth live?",
    score: 55,
    reason: "Documentation maturity is part of coverage and complexity.",
  },
];

export function fallbackProbeForSlot(slotPath: string) {
  return (
    probeLibrary.find((probe) => probe.targetSlot === slotPath) ?? {
      probeId: `fill-${slotPath.replace(/[^a-z0-9]+/gi, "-")}`,
      targetSlot: slotPath,
      phrasing: `What should I know about ${slotLabel(slotPath)}?`,
      score: 10,
      reason: "Fallback question for an uncovered director slot.",
    }
  );
}

function slotLabel(slotPath: string) {
  return (
    directorSlotDefinitions.find((definition) => definition.path === slotPath)
      ?.label ?? slotPath
  ).toLowerCase();
}
