import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

export type ProbeIntent = {
  probeId: string;
  targetSlot: string;
  intent: string;
  phrasing: string;
  score: number;
  reason: string;
  cooldownSeconds: number;
  maxFires: number;
  expectedShape: string;
};

const defaultProbeLibrary: ProbeIntent[] = [
  {
    probeId: "scope-boundaries",
    targetSlot: "scope.boundaries",
    intent: "define_process_boundary",
    phrasing: "Which process should we focus on first?",
    score: 100,
    reason: "A named process with boundaries anchors the inventory.",
    cooldownSeconds: 75,
    maxFires: 2,
    expectedShape: "A named process plus start and end conditions.",
  },
  {
    probeId: "owner-role",
    targetSlot: "ownership.roles",
    intent: "capture_owner_roles",
    phrasing: "Who is accountable for that process?",
    score: 95,
    reason: "Ownership is required before follow-up routing is useful.",
    cooldownSeconds: 75,
    maxFires: 2,
    expectedShape: "Accountable role/team and participating teams.",
  },
  {
    probeId: "systems-of-record",
    targetSlot: "systems.systems_of_record",
    intent: "capture_systems",
    phrasing:
      "Which systems of record or spreadsheets does the team rely on for this?",
    score: 90,
    reason: "Systems expose integration and shadow-process risk.",
    cooldownSeconds: 75,
    maxFires: 2,
    expectedShape: "Systems of record, spreadsheets, and shadow tools.",
  },
  {
    probeId: "frequency-volume",
    targetSlot: "frequency.volume",
    intent: "quantify_frequency_volume",
    phrasing: "How often does this happen?",
    score: 80,
    reason: "Frequency and volume shape complexity.",
    cooldownSeconds: 75,
    maxFires: 2,
    expectedShape: "Cadence and rough transaction/person/team volume.",
  },
  {
    probeId: "pain-points",
    targetSlot: "friction.pain_points",
    intent: "capture_friction",
    phrasing:
      "Where does the work slow down, break, or require manual cleanup today?",
    score: 70,
    reason: "Pain points identify friction signals for the dashboard.",
    cooldownSeconds: 90,
    maxFires: 2,
    expectedShape: "Bottleneck, rework, exception, delay, or manual cleanup.",
  },
  {
    probeId: "spof-risk",
    targetSlot: "risk.spofs",
    intent: "capture_risk_spof",
    phrasing:
      "Is any part of this dependent on one person or one fragile workaround?",
    score: 60,
    reason: "Single points of failure are a Phase 1 dashboard metric.",
    cooldownSeconds: 120,
    maxFires: 2,
    expectedShape: "Named role/person dependency, fragile workaround, or tribal knowledge.",
  },
  {
    probeId: "documentation-maturity",
    targetSlot: "documentation.maturity",
    intent: "capture_documentation",
    phrasing: "Where does the source of truth live?",
    score: 55,
    reason: "Documentation maturity is part of coverage and complexity.",
    cooldownSeconds: 120,
    maxFires: 2,
    expectedShape: "SOP/runbook/wiki/source-of-truth signal.",
  },
  {
    probeId: "director-remit",
    targetSlot: "function.name",
    intent: "discover_function",
    phrasing: "What part of the business do you oversee?",
    score: 110,
    reason: "The director remit frames the process inventory.",
    cooldownSeconds: 45,
    maxFires: 3,
    expectedShape: "Function or remit name with business outcomes when available.",
  },
  {
    probeId: "process-inventory",
    targetSlot: "process.inventory",
    intent: "discover_processes",
    phrasing: "What are the main recurring processes your team owns?",
    score: 105,
    reason: "A process inventory comes before detailed drilldown.",
    cooldownSeconds: 60,
    maxFires: 3,
    expectedShape: "List of recurring processes or operating cadences.",
  },
  {
    probeId: "business-outcome",
    targetSlot: "outcomes.business_outcomes",
    intent: "capture_outcome",
    phrasing: "What outcome is this process supposed to produce for the business?",
    score: 85,
    reason: "Outcomes connect process coverage to business value.",
    cooldownSeconds: 75,
    maxFires: 2,
    expectedShape: "Business outcome, decision, or measurable result.",
  },
  {
    probeId: "process-metrics",
    targetSlot: "metrics.kpis",
    intent: "capture_metrics",
    phrasing: "How do you measure whether this process is working well?",
    score: 72,
    reason: "Metrics show how the director judges operational health.",
    cooldownSeconds: 90,
    maxFires: 2,
    expectedShape: "KPI, SLA, target, or reviewed metric.",
  },
  {
    probeId: "handoff-dependencies",
    targetSlot: "handoffs.dependencies",
    intent: "capture_dependencies",
    phrasing: "What upstream inputs does this depend on?",
    score: 74,
    reason: "Dependencies reveal how director-owned processes work together.",
    cooldownSeconds: 90,
    maxFires: 2,
    expectedShape: "Upstream input, downstream consumer, or handoff point.",
  },
];

type ProbeYamlProbe = {
  id?: unknown;
  intent?: unknown;
  target_slots?: unknown;
  cooldown_seconds?: unknown;
  max_fires?: unknown;
  expected_shape?: unknown;
  base_priority?: unknown;
  phrasings?: unknown;
};

type ProbeYamlDocument = {
  probes?: ProbeYamlProbe[];
};

export const probeLibrary: ProbeIntent[] = loadDirectorProbeLibrary();

export function loadDirectorProbeLibrary(): ProbeIntent[] {
  const path = sharedProbePath("director.yaml");
  if (!path) return defaultProbeLibrary;

  try {
    const document = parse(readFileSync(path, "utf8")) as ProbeYamlDocument;
    const probes = (document.probes ?? [])
      .map(probeFromYaml)
      .filter((probe): probe is ProbeIntent => probe !== undefined);
    return probes.length > 0 ? probes : defaultProbeLibrary;
  } catch {
    return defaultProbeLibrary;
  }
}

function probeFromYaml(probe: ProbeYamlProbe) {
  const targetSlots = Array.isArray(probe.target_slots) ? probe.target_slots : [];
  const phrasings = Array.isArray(probe.phrasings) ? probe.phrasings : [];
  const probeId = stringValue(probe.id);
  const intent = stringValue(probe.intent);
  const targetSlot = stringValue(targetSlots[0]);
  const phrasing = stringValue(phrasings[0]);
  if (!probeId || !intent || !targetSlot || !phrasing) return undefined;

  const expectedShape = stringValue(probe.expected_shape) || "Short evidence-backed answer.";
  return {
    probeId,
    targetSlot,
    intent,
    phrasing,
    score: numberValue(probe.base_priority, 10),
    reason: expectedShape,
    cooldownSeconds: numberValue(probe.cooldown_seconds, 90),
    maxFires: numberValue(probe.max_fires, 2),
    expectedShape,
  };
}

function sharedProbePath(filename: string) {
  const candidates = [
    join(process.cwd(), "..", "probes", filename),
    join(process.cwd(), "probes", filename),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function fallbackProbeForSlot(slotPath: string) {
  return (
    probeLibrary.find((probe) => probe.targetSlot === slotPath) ?? {
      probeId: `fill-${slotPath.replace(/[^a-z0-9]+/gi, "-")}`,
      targetSlot: slotPath,
      intent: `fill_${slotPath.replace(/[^a-z0-9]+/gi, "_")}`,
      phrasing: `What should I know about ${slotLabel(slotPath)}?`,
      score: 10,
      reason: "Fallback question for an uncovered director slot.",
      cooldownSeconds: 90,
      maxFires: 2,
      expectedShape: "Short evidence-backed answer.",
    }
  );
}

export function probeConfigForIntent(intentName: string, targetSlot?: string) {
  return (
    probeLibrary.find((probe) => probe.intent === intentName) ??
    (targetSlot ? fallbackProbeForSlot(targetSlot) : undefined)
  );
}

function slotLabel(slotPath: string) {
  return (
    directorSlotDefinitions.find((definition) => definition.path === slotPath)
      ?.label ?? slotPath
  ).toLowerCase();
}
