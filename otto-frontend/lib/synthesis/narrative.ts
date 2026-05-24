import "server-only";

import type { ComplexityScore } from "@/lib/synthesis/complexity";

export type NarrativeInput = {
  name: string;
  functionName?: string | null;
  frequency?: string | null;
  systems?: string[];
  roles?: string[];
  painPoints?: string[];
  risks?: string[];
  evidenceIds?: string[];
  complexity: ComplexityScore;
};

export type CandidateNarrative = {
  summaryParagraph: string;
  whatThisProcessInvolves: string;
  topRisks: Array<{ title: string; body: string; severity: "high" | "med" | "low"; evidenceIds: string[] }>;
  frictionSignals: Array<{ title: string; body: string; evidenceIds: string[] }>;
  recommendedDrilldownReason: string;
  evidenceLinks: string[];
  inferred: boolean;
};

export function generateCandidateNarrative(input: NarrativeInput): CandidateNarrative {
  const systems = input.systems ?? [];
  const roles = input.roles ?? [];
  const painPoints = input.painPoints ?? [];
  const risks = input.risks ?? [];
  const evidenceLinks = unique(input.evidenceIds ?? []);
  const hasThinEvidence = evidenceLinks.length < 2;
  const functionPhrase = input.functionName ? ` in ${input.functionName}` : "";
  const systemPhrase =
    systems.length > 0
      ? ` It touches ${list(systems)}.`
      : " No systems have been evidenced yet.";
  const rolePhrase =
    roles.length > 0
      ? ` Accountable or participating roles include ${list(roles)}.`
      : " Accountable roles still need confirmation.";

  return {
    summaryParagraph: `${input.name}${functionPhrase} is captured as a director-layer process with a complexity score of ${input.complexity.total}/100.${systemPhrase}${rolePhrase}`,
    whatThisProcessInvolves: [
      `${input.name} currently appears to involve ${input.frequency ?? "an uncaptured cadence"}.`,
      systems.length ? `The evidenced system footprint includes ${list(systems)}.` : "The system footprint is not fully documented yet.",
      painPoints.length ? `The main friction signals are ${list(painPoints)}.` : "No explicit friction signal has been attached yet.",
      hasThinEvidence ? "Evidence is still thin, so this summary should be treated as a draft." : "Each statement is backed by intake evidence.",
    ].join(" "),
    topRisks: risks.length
      ? risks.map((risk) => ({
          title: riskTitle(risk),
          body: risk,
          severity: /single point|only one|compliance|audit|fragile/i.test(risk) ? "high" : "med",
          evidenceIds: evidenceLinks,
        }))
      : [
          {
            title: "Risk evidence incomplete",
            body: "No explicit risk or SPOF claim has been captured yet.",
            severity: "low",
            evidenceIds: evidenceLinks,
          },
        ],
    frictionSignals: painPoints.map((pain) => ({
      title: frictionTitle(pain),
      body: pain,
      evidenceIds: evidenceLinks,
    })),
    recommendedDrilldownReason:
      input.complexity.total >= 55
        ? "High complexity and evidenced friction make this a strong operator-drilldown candidate."
        : hasThinEvidence
          ? "More evidence is needed before prioritizing deeper capture."
          : "Captured enough evidence for director review; drill down if this process is strategically important.",
    evidenceLinks,
    inferred: hasThinEvidence,
  };
}

function riskTitle(text: string) {
  if (/single point|only one|depends on/i.test(text)) return "Single point of failure";
  if (/compliance|audit|control/i.test(text)) return "Control exposure";
  return "Operational risk";
}

function frictionTitle(text: string) {
  if (/manual|spreadsheet/i.test(text)) return "Manual work";
  if (/delay|wait|approval/i.test(text)) return "Delay or approval friction";
  if (/rework|cleanup|duplicate/i.test(text)) return "Rework";
  return "Friction signal";
}

function list(values: string[]) {
  if (values.length <= 2) return values.join(" and ");
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
