import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

export type ProbeIntent = {
  probeId: string;
  targetSlot: string;
  intent: string;
  phrasing: string;
  /** All canonical phrasings for this probe (anchor examples for the phraser). */
  phrasings: string[];
  /** Imperative instruction telling the phraser exactly what to ask. */
  directive: string;
  score: number;
  reason: string;
  cooldownSeconds: number;
  maxFires: number;
  expectedShape: string;
};

type ProbeSeed = Omit<ProbeIntent, "phrasings" | "directive"> & {
  phrasings?: string[];
  directive?: string;
};

/**
 * Imperative per-intent instructions for the voice phraser. The spoken
 * question MUST target the chosen intent; these tell the phraser what to ask
 * (not how the coverage currently looks). Probes without a curated or YAML
 * directive get one derived from their metadata automatically.
 */
const curatedProbeDirectives: Record<string, string> = {
  discover_function:
    "Ask the director what part of the business they oversee. Stay at the function/remit level; do not drill into any single process.",
  discover_processes:
    "Ask the director what other recurring processes their team owns. Collect a breadth-first list of process names. Do not drill into the steps of a single process.",
  define_process_boundary:
    "Ask the director where the focus process starts and ends — what kicks it off and what counts as done. Do not ask for step-by-step detail.",
  capture_owner_roles:
    "Ask the director which role or team is accountable for the focus process and who else participates.",
  capture_systems:
    "Ask the director which systems of record, spreadsheets, or shadow tools the team relies on for the focus process.",
  quantify_frequency_volume:
    "Ask the director how often the focus process runs and at roughly what volume.",
  capture_outcome:
    "Ask the director what business outcome or decision the focus process is supposed to produce.",
  capture_metrics:
    "Ask the director how they measure whether the focus process is working well (KPI, SLA, or reviewed metric).",
  capture_dependencies:
    "Ask the director what upstream inputs the focus process depends on or where the important handoffs are.",
  capture_friction:
    "Ask the director where the focus process slows down, breaks, or requires manual cleanup today.",
  capture_risk_spof:
    "Ask the director whether any part of the focus process depends on one person, tribal knowledge, or a fragile workaround.",
  capture_documentation:
    "Ask the director where the source of truth for the focus process lives (SOP, runbook, wiki, or tribal knowledge).",
};

function derivedProbeDirective(seed: {
  intent: string;
  targetSlot: string;
  expectedShape: string;
}): string {
  return (
    `Ask the director one question that fills the "${seed.targetSlot}" slot. ` +
    `Expected answer shape: ${seed.expectedShape} ` +
    "Stay at the process level; do not ask for step-by-step detail."
  ).replace(/\s+/g, " ");
}

function finalizeProbe(seed: ProbeSeed): ProbeIntent {
  const phrasings =
    seed.phrasings && seed.phrasings.length > 0 ? seed.phrasings : [seed.phrasing];
  return {
    ...seed,
    phrasings,
    directive:
      seed.directive ??
      curatedProbeDirectives[seed.intent] ??
      derivedProbeDirective(seed),
  };
}

const defaultProbeSeeds: ProbeSeed[] = [
  {
    probeId: "scope-boundaries",
    targetSlot: "scope.boundaries",
    intent: "define_process_boundary",
    phrasing: "Which process should we focus on next?",
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

const defaultProbeLibrary: ProbeIntent[] = defaultProbeSeeds.map(finalizeProbe);

type ProbeYamlProbe = {
  id?: unknown;
  intent?: unknown;
  target_slots?: unknown;
  cooldown_seconds?: unknown;
  max_fires?: unknown;
  expected_shape?: unknown;
  base_priority?: unknown;
  phrasings?: unknown;
  directive?: unknown;
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
  const rawPhrasings = Array.isArray(probe.phrasings) ? probe.phrasings : [];
  const phrasings = rawPhrasings
    .map(stringValue)
    .filter((value): value is string => Boolean(value));
  const probeId = stringValue(probe.id);
  const intent = stringValue(probe.intent);
  const targetSlot = stringValue(targetSlots[0]);
  const phrasing = phrasings[0];
  if (!probeId || !intent || !targetSlot || !phrasing) return undefined;

  const expectedShape = stringValue(probe.expected_shape) || "Short evidence-backed answer.";
  return finalizeProbe({
    probeId,
    targetSlot,
    intent,
    phrasing,
    phrasings,
    directive: stringValue(probe.directive),
    score: numberValue(probe.base_priority, 10),
    reason: expectedShape,
    cooldownSeconds: numberValue(probe.cooldown_seconds, 90),
    maxFires: numberValue(probe.max_fires, 2),
    expectedShape,
  });
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
    probeLibrary.find((probe) => probe.targetSlot === slotPath) ??
    finalizeProbe({
      probeId: `fill-${slotPath.replace(/[^a-z0-9]+/gi, "-")}`,
      targetSlot: slotPath,
      intent: `fill_${slotPath.replace(/[^a-z0-9]+/gi, "_")}`,
      phrasing: `What should I know about ${slotLabel(slotPath)}?`,
      score: 10,
      reason: "Fallback question for an uncovered director slot.",
      cooldownSeconds: 90,
      maxFires: 2,
      expectedShape: "Short evidence-backed answer.",
    })
  );
}

export function probeConfigForIntent(intentName: string, targetSlot?: string) {
  return (
    probeLibrary.find((probe) => probe.intent === intentName) ??
    (targetSlot ? fallbackProbeForSlot(targetSlot) : undefined)
  );
}

/**
 * Canonical phrasings for the chosen intent, used as anchor examples for the
 * voice phraser (and as the verbatim escalation utterance).
 */
export function probePhrasingsForIntent(
  intentName: string,
  targetSlot?: string,
): string[] {
  return probeConfigForIntent(intentName, targetSlot)?.phrasings ?? [];
}

/**
 * Imperative instruction for the chosen intent. Unlike `reason` (a coverage
 * status report), this tells the phraser exactly what to ask next.
 */
export function probeDirectiveForIntent(
  intentName: string,
  targetSlot?: string,
): string | undefined {
  return probeConfigForIntent(intentName, targetSlot)?.directive;
}

function slotLabel(slotPath: string) {
  return (
    directorSlotDefinitions.find((definition) => definition.path === slotPath)
      ?.label ?? slotPath
  ).toLowerCase();
}
