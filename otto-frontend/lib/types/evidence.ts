export type EvidenceLabel =
  | "observed"
  | "stated_operator"
  | "stated_director"
  | "documented"
  | "inferred"
  | "confirmed"
  | "corrected";

export type EvidenceSource =
  | "transcript_segment"
  | "screen_event"
  | "document_chunk"
  | "user_correction"
  | "agent_inference";

export type Evidence = {
  id: string;
  source_type: EvidenceSource;
  source_id: string;
  evidence_label: EvidenceLabel;
  quote: string;
  speaker?: string;
  observed_at: string; // ISO
  confidence: number;
};

export type ClaimSubjectType =
  | "process_node"
  | "process_edge"
  | "node"
  | "edge"
  | "exception"
  | "workaround"
  | "variant"
  | "insight"
  | "risk"
  | "opportunity"
  | "pain_point"
  | "spof"
  | "process"
  | "process_version"
  | "candidate_process"
  | "system"
  | "role"
  | "person"
  | "ontology_term"
  | "narrative_paragraph";

export type ClaimStatus = "active" | "superseded" | "redacted" | "tombstoned";

export type Claim = {
  id: string;
  subject_type: ClaimSubjectType;
  subject_id: string;
  field: string;
  value: unknown;
  confidence: number;
  status: ClaimStatus;
  evidence_ids: string[];
};
