export type ProcessSummary = {
  id: string;
  source?: "process" | "candidate";
  href?: string;
  name: string;
  process_status?: "candidate" | "draft" | "approved" | "archived";
  function: string;
  department: string;
  status: "documented" | "in_progress";
  complexity: "low" | "med" | "high";
  complexity_score: number; // 0-100
  doc_coverage: number; // 0-1
  description: string;
  people_count: number;
  systems: string[];
  frequency: string;
  evidence_count?: number;
  recommended: boolean;
  recommended_reason?: string;
};

export type ProcessDetail = ProcessSummary & {
  summary_paragraph?: string;
  what_it_involves: string;
  complexity_breakdown: {
    label: string;
    value: number;
    detail?: string;
  }[];
  complexity_total_max: number;
  accountability: {
    role: string;
    person?: string;
    domain: string;
    label: "owner" | "internal admin" | "external" | "notified";
    description: string;
  }[];
  systems_detail: {
    name: string;
    purpose?: string;
  }[];
  risks: {
    severity: "high" | "med" | "low";
    title: string;
    body: string;
  }[];
  evidence_claims?: {
    id: string;
    field: string;
    value: unknown;
    confidence: number;
    evidence_count: number;
  }[];
};

export type TeamResponsibility = {
  person: string;
  role: string;
  scope: string;
  systems: string[];
  decisions: string[];
  reports_to?: string;
};
