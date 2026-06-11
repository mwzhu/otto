import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { operatorSlotDefinitions } from "@/lib/interview/operator/slot-schema";

export type OperatorProbeIntent = {
  probeId: string;
  /** All slots this probe targets (operator probes often cover a slot pair). */
  targetSlots: string[];
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

type ProbeSeed = Omit<OperatorProbeIntent, "phrasings" | "directive"> & {
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
  capture_process_objective:
    "Ask the operator what this workflow is trying to get done and what result tells them it is complete.",
  capture_next_step:
    "Ask the operator what happens next — the next concrete action after the step they just described.",
  capture_step_systems:
    "Ask the operator which system is the source of truth for this step: the official system or a working tracker.",
  capture_inputs_outputs:
    "Ask the operator what input this step needs before it can start, or what gets created or changed when it is done.",
  capture_decision_rule:
    "Ask the operator how they decide which path to take at this point — the condition and who or what decides.",
  capture_handoff:
    "Ask the operator who gets the work after they finish this part and how the next person knows it is ready.",
  capture_exception:
    "Ask the operator when this step fails or gets stuck and what usually causes it.",
  capture_workaround:
    "Ask the operator whether what they just did is the normal workflow or a workaround, and why it exists.",
  clarify_sop_contradiction:
    "Point out that the SOP describes this differently and ask which version is current — without treating the SOP as more true than observed behavior.",
};

function derivedProbeDirective(seed: {
  intent: string;
  targetSlots: string[];
  expectedShape: string;
}): string {
  return (
    `Ask the operator one concrete question that fills the "${seed.targetSlots[0]}" slot. ` +
    `Expected answer shape: ${seed.expectedShape} ` +
    "Stay on the step being discussed; ask only when a blocking workflow gap or ambiguity needs an answer."
  ).replace(/\s+/g, " ");
}

function finalizeProbe(seed: ProbeSeed): OperatorProbeIntent {
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

// Mirrors probes/operator.yaml so behavior holds when the YAML is unavailable
// (e.g. a deploy artifact without the shared probes directory).
const defaultProbeSeeds: ProbeSeed[] = [
  {
    probeId: "process-objective",
    targetSlots: ["process.trigger", "process.objective"],
    intent: "capture_process_objective",
    phrasing: "What is this workflow trying to get done?",
    phrasings: [
      "What is this workflow trying to get done?",
      "What result tells you this process is complete?",
    ],
    score: 105,
    reason: "Business outcome, object being processed, and completion signal.",
    cooldownSeconds: 45,
    maxFires: 2,
    expectedShape: "Business outcome, object being processed, and completion signal.",
  },
  {
    probeId: "step-action",
    targetSlots: ["step.action_verb", "step.action_object"],
    intent: "capture_next_step",
    phrasing: "What happens next?",
    phrasings: ["What happens next?", "What do you do right after that?"],
    score: 120,
    reason: "Action verb plus object, with start/end cue when available.",
    cooldownSeconds: 15,
    maxFires: 20,
    expectedShape: "Action verb plus object, with start/end cue when available.",
  },
  {
    probeId: "system-source-of-truth",
    targetSlots: ["step.systems", "step.source_of_truth"],
    intent: "capture_step_systems",
    phrasing: "Which system is the source of truth for this step?",
    phrasings: [
      "Which system is the source of truth for this step?",
      "Are you updating the official system here, or a working tracker?",
    ],
    score: 100,
    reason: "System of record, shadow spreadsheet, or communication tool.",
    cooldownSeconds: 45,
    maxFires: 3,
    expectedShape: "System of record, shadow spreadsheet, or communication tool.",
  },
  {
    probeId: "inputs-outputs",
    targetSlots: ["step.data_copied_from", "step.output"],
    intent: "capture_inputs_outputs",
    phrasing: "What input do you need before you can do this step?",
    phrasings: [
      "What input do you need before you can do this step?",
      "What gets created or changed when this step is done?",
    ],
    score: 90,
    reason: "Input artifact/data and output artifact/data for the step.",
    cooldownSeconds: 60,
    maxFires: 3,
    expectedShape: "Input artifact/data and output artifact/data for the step.",
  },
  {
    probeId: "decision-rule",
    targetSlots: ["step.decision_criteria"],
    intent: "capture_decision_rule",
    phrasing: "How do you decide which path to take here?",
    phrasings: [
      "How do you decide which path to take here?",
      "What condition makes you send it back instead of moving forward?",
    ],
    score: 95,
    reason: "Condition, branch choices, and who or what decides.",
    cooldownSeconds: 60,
    maxFires: 3,
    expectedShape: "Condition, branch choices, and who or what decides.",
  },
  {
    probeId: "handoff",
    targetSlots: ["step.next_owner"],
    intent: "capture_handoff",
    phrasing: "Who gets this after you finish your part?",
    phrasings: [
      "Who gets this after you finish your part?",
      "How do you know the next person has everything they need?",
    ],
    score: 86,
    reason: "Sender, receiver, handoff medium, and acceptance cue.",
    cooldownSeconds: 75,
    maxFires: 3,
    expectedShape: "Sender, receiver, handoff medium, and acceptance cue.",
  },
  {
    probeId: "exception",
    targetSlots: ["step.exceptions"],
    intent: "capture_exception",
    phrasing: "When does this step fail or get stuck?",
    phrasings: [
      "When does this step fail or get stuck?",
      "What usually causes an exception here?",
    ],
    score: 102,
    reason: "Failure condition, frequency, impact, and recovery path.",
    cooldownSeconds: 45,
    maxFires: 4,
    expectedShape: "Failure condition, frequency, impact, and recovery path.",
  },
  {
    probeId: "workaround",
    targetSlots: ["step.workarounds"],
    intent: "capture_workaround",
    phrasing: "Is that the normal workflow, or a workaround?",
    phrasings: [
      "Is that the normal workflow, or a workaround?",
      "What makes you leave the official system and do it manually?",
    ],
    score: 104,
    reason: "Unofficial workaround, why it exists, and whether it is normal.",
    cooldownSeconds: 45,
    maxFires: 4,
    expectedShape: "Unofficial workaround, why it exists, and whether it is normal.",
  },
  {
    probeId: "sop-contradiction",
    targetSlots: ["sop.contradictions"],
    intent: "clarify_sop_contradiction",
    phrasing: "The SOP says something different here. Which version is current?",
    phrasings: [
      "The SOP says something different here. Which version is current?",
      "Is this different from the SOP because the document is outdated, or because this case is unusual?",
    ],
    score: 115,
    reason: "Current real behavior, whether SOP is outdated, and exception status.",
    cooldownSeconds: 30,
    maxFires: 5,
    expectedShape: "Current real behavior, whether SOP is outdated, and exception status.",
  },
];

const defaultProbeLibrary: OperatorProbeIntent[] = defaultProbeSeeds.map(finalizeProbe);

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

export const operatorProbeLibrary: OperatorProbeIntent[] = loadOperatorProbeLibrary();

export function loadOperatorProbeLibrary(): OperatorProbeIntent[] {
  const path = sharedProbePath("operator.yaml");
  if (!path) return defaultProbeLibrary;

  try {
    const document = parse(readFileSync(path, "utf8")) as ProbeYamlDocument;
    const probes = (document.probes ?? [])
      .map(probeFromYaml)
      .filter((probe): probe is OperatorProbeIntent => probe !== undefined);
    return probes.length > 0 ? probes : defaultProbeLibrary;
  } catch {
    return defaultProbeLibrary;
  }
}

function probeFromYaml(probe: ProbeYamlProbe) {
  const rawTargetSlots = Array.isArray(probe.target_slots) ? probe.target_slots : [];
  const targetSlots = rawTargetSlots
    .map(stringValue)
    .filter((value): value is string => Boolean(value));
  const rawPhrasings = Array.isArray(probe.phrasings) ? probe.phrasings : [];
  const phrasings = rawPhrasings
    .map(stringValue)
    .filter((value): value is string => Boolean(value));
  const probeId = stringValue(probe.id);
  const intent = stringValue(probe.intent);
  const phrasing = phrasings[0];
  if (!probeId || !intent || targetSlots.length === 0 || !phrasing) return undefined;

  const expectedShape = stringValue(probe.expected_shape) || "Short evidence-backed answer.";
  return finalizeProbe({
    probeId,
    targetSlots,
    intent,
    phrasing,
    phrasings,
    directive: stringValue(probe.directive),
    score: numberValue(probe.base_priority, 10),
    reason: expectedShape,
    cooldownSeconds: numberValue(probe.cooldown_seconds, 60),
    maxFires: numberValue(probe.max_fires, 3),
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

export function fallbackOperatorProbeForSlot(slotPath: string) {
  return (
    operatorProbeLibrary.find((probe) => probe.targetSlots.includes(slotPath)) ??
    finalizeProbe({
      probeId: `fill-${slotPath.replace(/[^a-z0-9]+/gi, "-")}`,
      targetSlots: [slotPath],
      intent: `fill_${slotPath.replace(/[^a-z0-9]+/gi, "_")}`,
      phrasing: `What should I know about ${operatorSlotLabel(slotPath)}?`,
      score: 10,
      reason: "Fallback question for an uncovered operator slot.",
      cooldownSeconds: 60,
      maxFires: 3,
      expectedShape: "Short evidence-backed answer.",
    })
  );
}

/**
 * Resolves the probe config for a brain intent. Brain intent names do not all
 * exist in the YAML (e.g. `capture_exception_or_workaround` covers the
 * `capture_exception` and `capture_workaround` probes), so unmatched intents
 * fall back to the probe targeting the intent's slot.
 */
export function operatorProbeConfigForIntent(intentName: string, targetSlot?: string) {
  return (
    operatorProbeLibrary.find((probe) => probe.intent === intentName) ??
    (targetSlot ? fallbackOperatorProbeForSlot(targetSlot) : undefined)
  );
}

/**
 * Canonical phrasings for the chosen intent, used as anchor examples for the
 * voice phraser (and as the verbatim escalation utterance).
 */
export function operatorProbePhrasingsForIntent(
  intentName: string,
  targetSlot?: string,
): string[] {
  return operatorProbeConfigForIntent(intentName, targetSlot)?.phrasings ?? [];
}

/**
 * Imperative instruction for the chosen intent. Unlike `reason` (a coverage
 * status report), this tells the phraser exactly what to ask next.
 */
export function operatorProbeDirectiveForIntent(
  intentName: string,
  targetSlot?: string,
): string | undefined {
  return operatorProbeConfigForIntent(intentName, targetSlot)?.directive;
}

function operatorSlotLabel(slotPath: string) {
  return (
    operatorSlotDefinitions.find((definition) => definition.path === slotPath)
      ?.label ?? slotPath
  ).toLowerCase();
}
