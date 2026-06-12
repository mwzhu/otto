export type DirectorSlotStatus =
  | "empty"
  | "partial"
  | "filled"
  | "asked_unknown"
  | "conflicting"
  | "pending_re_extract";

export type DirectorSlotDefinition = {
  path: string;
  label: string;
  priority: number;
  mustFire?: boolean;
};

export const directorSlotDefinitions: DirectorSlotDefinition[] = [
  {
    path: "function.name",
    label: "Director remit and business function",
    priority: 110,
    mustFire: true,
  },
  {
    path: "process.inventory",
    label: "High-level process inventory",
    priority: 105,
    mustFire: true,
  },
  {
    path: "scope.boundaries",
    label: "Scope and boundaries",
    priority: 100,
    mustFire: true,
  },
  {
    path: "outcomes.business_outcomes",
    label: "Business outcomes",
    priority: 98,
    mustFire: true,
  },
  {
    path: "ownership.roles",
    label: "Ownership and participating roles",
    priority: 95,
    mustFire: true,
  },
  { path: "people.key_people", label: "People", priority: 90 },
  {
    path: "systems.systems_of_record",
    label: "Systems of record and shadow systems",
    priority: 85,
    mustFire: true,
  },
  { path: "frequency.volume", label: "Frequency and volume", priority: 80 },
  { path: "handoffs.dependencies", label: "Dependencies and handoffs", priority: 75 },
  { path: "metrics.kpis", label: "KPIs", priority: 70 },
  { path: "friction.pain_points", label: "Pain points", priority: 65 },
  { path: "risk.spofs", label: "Single points of failure", priority: 60 },
  {
    path: "controls.compliance",
    label: "Controls and compliance exposure",
    priority: 55,
  },
  {
    path: "documentation.maturity",
    label: "Documentation maturity",
    priority: 50,
  },
  {
    path: "priority.executive_priority",
    label: "Executive priority",
    priority: 45,
  },
  { path: "variants.exceptions", label: "Variants", priority: 40 },
];

/**
 * G1: the core per-process slots that define capture coverage. A process's
 * coverage % is the weighted fill of these seven (filled / asked_unknown = 1,
 * partial = 0.5); the overview's Documentation Coverage tile averages it
 * across the inventory, and complexity display gates on it (G3).
 */
export const directorCoreCoverageSlotPaths = [
  "scope.boundaries",
  "outcomes.business_outcomes",
  "ownership.roles",
  "systems.systems_of_record",
  "frequency.volume",
  "friction.pain_points",
  "risk.spofs",
] as const;

export function directorSlotLabel(slotPath: string) {
  return (
    directorSlotDefinitions.find((definition) => definition.path === slotPath)?.label ??
    slotPath
  );
}

export function slotPriority(slotPath: string) {
  return (
    directorSlotDefinitions.find((definition) => definition.path === slotPath)
      ?.priority ?? 10
  );
}

/**
 * Per-slot "filled requires" shape hints. A slot may only be stored as
 * `filled` when every component group below is satisfied by the value;
 * otherwise the extraction normalizer demotes it to `partial`.
 *
 * A group is satisfied when the value object carries one of the listed keys
 * with non-empty content, or — for free-text values — when the text matches
 * the group's pattern.
 */
export type DirectorSlotFilledComponent = {
  component: string;
  keys: string[];
  textPattern?: RegExp;
};

export const directorSlotFilledRequirements: Record<
  string,
  DirectorSlotFilledComponent[]
> = {
  "scope.boundaries": [
    {
      component: "start_condition",
      keys: [
        "start_condition",
        "starts_when",
        "start",
        "trigger",
        "begins_when",
        "entry_point",
      ],
      textPattern:
        /\b(start|starts|begin|begins|kick(?:s|ed)? off|triggered|when .{0,40}(arrives|lands|comes in|received))\b/i,
    },
    {
      component: "end_condition",
      keys: [
        "end_condition",
        "ends_when",
        "end",
        "done_when",
        "completion",
        "complete_when",
        "finished_when",
        "exit_point",
      ],
      textPattern:
        /\b(end|ends|done|complete|completed|finish|finished|released|closed|delivered)\b/i,
    },
  ],
  "friction.pain_points": [
    {
      component: "pain_point",
      keys: ["pain_point", "pain_points", "text", "items", "description"],
    },
  ],
  "outcomes.business_outcomes": [
    {
      component: "business_outcome",
      keys: [
        "business_outcomes",
        "business_outcome",
        "outcomes",
        "outcome",
        "text",
        "items",
        "name",
      ],
    },
  ],
};

/**
 * Returns the component labels a value is missing for the slot to qualify as
 * `filled`. Slots without registered requirements always return [].
 */
export function missingFilledSlotComponents(
  slotPath: string,
  value: unknown,
): string[] {
  const requirements = directorSlotFilledRequirements[slotPath];
  if (!requirements) return [];
  return requirements
    .filter((group) => !filledComponentSatisfied(group, value))
    .map((group) => group.component);
}

function filledComponentSatisfied(
  group: DirectorSlotFilledComponent,
  value: unknown,
): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return false;
    return group.textPattern ? group.textPattern.test(text) : true;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    if (!group.textPattern) return true;
    return value.some(
      (entry) => typeof entry === "string" && group.textPattern!.test(entry),
    );
  }
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const hasComponentKey = group.keys.some((key) =>
    hasNonEmptyContent(record[key]),
  );
  if (hasComponentKey) return true;
  if (!group.textPattern) return false;
  return nestedStrings(record).some((text) => group.textPattern!.test(text));
}

function hasNonEmptyContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function nestedStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === undefined || value === null) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => nestedStrings(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      nestedStrings(entry, depth + 1),
    );
  }
  return [];
}

export function isCaptureLevelDirectorSlot(slotPath: string) {
  return slotPath === "function.name" || slotPath === "process.inventory";
}

export function isDirectorSlotPath(slotPath: string) {
  return directorSlotDefinitions.some((definition) => definition.path === slotPath);
}

export function assertDirectorSlotPath(slotPath: string) {
  if (!isDirectorSlotPath(slotPath)) {
    throw new Error(`Unknown director slot path: ${slotPath}`);
  }
}
