export type OperatorSlotDefinition = {
  path: string;
  label: string;
  priority: number;
  scope: "capture" | "step" | "compatibility";
};

export const operatorSlotDefinitions = [
  { path: "process.trigger", label: "process trigger", priority: 98, scope: "capture" },
  { path: "process.boundary", label: "process boundary", priority: 96, scope: "capture" },
  { path: "process.objective", label: "process objective", priority: 95, scope: "capture" },
  { path: "process.happy_path_complete", label: "happy path completeness", priority: 91, scope: "capture" },
  { path: "process.hard_case_complete", label: "hard case completeness", priority: 91, scope: "capture" },
  { path: "process.primary_roles", label: "primary roles", priority: 86, scope: "capture" },
  { path: "process.primary_systems", label: "primary systems", priority: 86, scope: "capture" },
  { path: "process.source_of_truth", label: "process source of truth", priority: 88, scope: "capture" },
  { path: "process.frequency", label: "process frequency", priority: 78, scope: "capture" },
  { path: "process.volume", label: "process volume", priority: 78, scope: "capture" },
  { path: "process.known_variants", label: "known process variants", priority: 76, scope: "capture" },

  { path: "step.trigger", label: "step trigger", priority: 88, scope: "step" },
  { path: "step.action_verb", label: "step action verb", priority: 100, scope: "step" },
  { path: "step.action_object", label: "step action object", priority: 100, scope: "step" },
  { path: "step.systems", label: "systems used in the step", priority: 90, scope: "step" },
  { path: "step.source_of_truth", label: "step source of truth", priority: 89, scope: "step" },
  { path: "step.data_copied_from", label: "data copied from", priority: 84, scope: "step" },
  { path: "step.data_copied_to", label: "data copied to", priority: 84, scope: "step" },
  { path: "step.decision_criteria", label: "decision criteria", priority: 86, scope: "step" },
  { path: "step.output", label: "step output", priority: 84, scope: "step" },
  { path: "step.next_owner", label: "next owner or handoff", priority: 82, scope: "step" },
  { path: "step.approval_control_point", label: "approval or control point", priority: 88, scope: "step" },
  { path: "step.time_typical", label: "typical step time", priority: 72, scope: "step" },
  { path: "step.time_max", label: "maximum step time", priority: 70, scope: "step" },
  { path: "step.frequency_per_month", label: "step frequency per month", priority: 70, scope: "step" },
  { path: "step.exceptions", label: "exceptions", priority: 94, scope: "step" },
  { path: "step.workarounds", label: "workarounds", priority: 94, scope: "step" },
  { path: "step.intentional_deviations", label: "intentional deviations from SOP", priority: 87, scope: "step" },
  { path: "step.tacit_rules", label: "tacit rules", priority: 80, scope: "step" },
  { path: "step.variant_conditions", label: "variant conditions", priority: 78, scope: "step" },
  { path: "step.what_makes_this_case_hard", label: "hard case drivers", priority: 92, scope: "step" },

  { path: "sop.contradictions", label: "SOP contradictions", priority: 88, scope: "capture" },

  { path: "step.action", label: "combined step action", priority: 100, scope: "compatibility" },
  { path: "step.inputs_outputs", label: "combined inputs and outputs", priority: 86, scope: "compatibility" },
  { path: "step.decisions", label: "combined decisions and branch rules", priority: 82, scope: "compatibility" },
  { path: "step.handoffs", label: "combined handoffs", priority: 78, scope: "compatibility" },
] as const satisfies readonly OperatorSlotDefinition[];

const operatorSlotPaths = new Set<string>(operatorSlotDefinitions.map((slot) => slot.path));

export function assertOperatorSlotPath(path: string) {
  if (!operatorSlotPaths.has(path)) {
    throw new Error(`Unknown operator slot path: ${path}`);
  }
}

export function operatorSlotPriority(path: string) {
  return operatorSlotDefinitions.find((slot) => slot.path === path)?.priority ?? 0;
}

export function operatorSlotScope(path: string) {
  return operatorSlotDefinitions.find((slot) => slot.path === path)?.scope ?? null;
}
