import "server-only";

export type ComplexityFactorKey =
  | "system_sprawl"
  | "handoff_count"
  | "frequency_pressure"
  | "friction_severity"
  | "spof_risk"
  | "documentation_gap";

export type ComplexityInput = {
  systemCount?: number;
  roleCount?: number;
  peopleCount?: number;
  frequency?: string | null;
  painPoints?: Array<{ text: string; evidenceIds?: string[] }>;
  risks?: Array<{ text: string; evidenceIds?: string[] }>;
  documentationEvidenceCount?: number;
  evidenceIds?: string[];
};

export type ComplexityScore = {
  total: number;
  factors: Record<
    ComplexityFactorKey,
    {
      label: string;
      value: number;
      max: number;
      evidenceIds: string[];
      assumptions: string[];
      detail: string;
    }
  >;
  assumptions: string[];
};

export function computeComplexityScore(input: ComplexityInput): ComplexityScore {
  const systemCount = input.systemCount ?? 0;
  const handoffActors = (input.roleCount ?? 0) + (input.peopleCount ?? 0);
  const frequency = input.frequency?.toLowerCase() ?? "";
  const painText = (input.painPoints ?? []).map((p) => p.text).join(" ");
  const riskText = (input.risks ?? []).map((r) => r.text).join(" ");
  const allEvidenceIds = unique([
    ...(input.evidenceIds ?? []),
    ...(input.painPoints ?? []).flatMap((p) => p.evidenceIds ?? []),
    ...(input.risks ?? []).flatMap((r) => r.evidenceIds ?? []),
  ]);

  const factors: ComplexityScore["factors"] = {
    system_sprawl: factor(
      "System sprawl",
      clamp(systemCount <= 1 ? systemCount * 4 : 8 + (systemCount - 2) * 4, 0, 20),
      20,
      allEvidenceIds,
      systemCount === 0 ? ["No systems were evidenced yet."] : [],
      `${systemCount} evidenced system${systemCount === 1 ? "" : "s"}.`,
    ),
    handoff_count: factor(
      "Handoffs",
      clamp(handoffActors <= 1 ? handoffActors * 3 : 6 + (handoffActors - 2) * 3, 0, 15),
      15,
      allEvidenceIds,
      handoffActors === 0 ? ["No roles or people were evidenced yet."] : [],
      `${handoffActors} evidenced role/person touchpoint${handoffActors === 1 ? "" : "s"}.`,
    ),
    frequency_pressure: factor(
      "Frequency pressure",
      frequencyScore(frequency),
      15,
      input.evidenceIds ?? [],
      frequency ? [] : ["Frequency has not been captured yet."],
      input.frequency ?? "Frequency missing.",
    ),
    friction_severity: factor(
      "Friction severity",
      clamp((input.painPoints?.length ?? 0) * 6 + severityBoost(painText), 0, 20),
      20,
      unique((input.painPoints ?? []).flatMap((p) => p.evidenceIds ?? [])),
      (input.painPoints?.length ?? 0) === 0 ? ["No pain points were evidenced yet."] : [],
      `${input.painPoints?.length ?? 0} evidenced friction signal${(input.painPoints?.length ?? 0) === 1 ? "" : "s"}.`,
    ),
    spof_risk: factor(
      "SPOF risk",
      clamp((input.risks?.length ?? 0) * 5 + spofBoost(riskText), 0, 15),
      15,
      unique((input.risks ?? []).flatMap((r) => r.evidenceIds ?? [])),
      (input.risks?.length ?? 0) === 0 ? ["No SPOF or risk claims were evidenced yet."] : [],
      `${input.risks?.length ?? 0} evidenced risk signal${(input.risks?.length ?? 0) === 1 ? "" : "s"}.`,
    ),
    documentation_gap: factor(
      "Documentation gap",
      input.documentationEvidenceCount && input.documentationEvidenceCount > 0 ? 4 : 15,
      15,
      input.evidenceIds ?? [],
      input.documentationEvidenceCount ? [] : ["No documented evidence is attached yet."],
      input.documentationEvidenceCount
        ? `${input.documentationEvidenceCount} documented evidence source${input.documentationEvidenceCount === 1 ? "" : "s"}.`
        : "Documentation evidence missing.",
    ),
  };

  const total = Object.values(factors).reduce((sum, row) => sum + row.value, 0);
  return {
    total,
    factors,
    assumptions: unique(Object.values(factors).flatMap((row) => row.assumptions)),
  };
}

function factor(
  label: string,
  value: number,
  max: number,
  evidenceIds: string[],
  assumptions: string[],
  detail: string,
) {
  return {
    label,
    value: Math.round(value),
    max,
    evidenceIds: unique(evidenceIds),
    assumptions,
    detail,
  };
}

function frequencyScore(frequency: string) {
  if (!frequency) return 8;
  if (/real.?time|hour|daily|per day|every day|high volume/.test(frequency)) return 15;
  if (/week|weekly|several times|recurring/.test(frequency)) return 10;
  if (/month|monthly|quarter/.test(frequency)) return 6;
  return 8;
}

function severityBoost(text: string) {
  return /manual|rework|delay|exception|cleanup|duplicate|spreadsheet|unclear/i.test(text)
    ? 6
    : 0;
}

function spofBoost(text: string) {
  return /single point|only one|depends on|tribal|backup|fragile/i.test(text) ? 8 : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
