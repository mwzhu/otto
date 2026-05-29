import { type DirectorSlotStatus } from "@/lib/interview/director/slot-schema";

export type CoverageStatus = DirectorSlotStatus;

export type DirectorCoverageSlot = {
  slotPath: string;
  candidateProcessId: string | null;
  processName: string | null;
  label: string;
  priority: number;
  status: CoverageStatus;
  confidence: number;
  evidenceCount: number;
  openFollowUps: number;
  lastAskedAt: Date | null;
  value: unknown;
};

export type DirectorCoverageSummary = {
  filled: number;
  partial: number;
  missing: number;
  conflicting: number;
  pendingReExtract: number;
  askedUnknown: number;
  totalSlots: number;
  averageConfidence: number;
  evidenceCount: number;
  openFollowUps: number;
};

export type Phase1Telemetry = {
  decisionCount: number;
  degradedTurns: number;
  totalCostCents: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  cacheHitRate: number;
  synthesisRunCount: number;
  failedSynthesisRuns: number;
  partialSynthesisRuns: number;
  latestSynthesisStatus: string | null;
  latestSynthesisStage: string | null;
  latestSynthesisUpdatedAt: Date | null;
};

export type DirectorCoverage = {
  workspaceId: string;
  captureSessionId: string | null;
  slots: DirectorCoverageSlot[];
  summary: DirectorCoverageSummary;
  telemetry: Phase1Telemetry;
};
