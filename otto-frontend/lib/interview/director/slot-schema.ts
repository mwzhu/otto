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

export function slotPriority(slotPath: string) {
  return (
    directorSlotDefinitions.find((definition) => definition.path === slotPath)
      ?.priority ?? 10
  );
}

export function isDirectorSlotPath(slotPath: string) {
  return directorSlotDefinitions.some((definition) => definition.path === slotPath);
}

export function assertDirectorSlotPath(slotPath: string) {
  if (!isDirectorSlotPath(slotPath)) {
    throw new Error(`Unknown director slot path: ${slotPath}`);
  }
}
