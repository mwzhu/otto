import "server-only";

import type { ProcessGraph } from "@/lib/types/graph";
import type { OperatorEvidencePack } from "@/lib/synthesis/operator-process";
import { OPPORTUNITY_PATTERN_CATALOG, stableHash } from "@/lib/processes/opportunity-schema";
import { ROI_ASSUMPTION_TIERS } from "@/lib/processes/opportunity-heuristics";

export type OpportunityEvidencePack = {
  orgId: string;
  workspaceId: string;
  processId: string;
  processName: string;
  versionId: string;
  graph: ProcessGraph;
  complexity: unknown;
  narrative: unknown;
  allowedEvidenceIds: string[];
  evidence: Array<{
    id: string;
    text: string;
    source: string;
  }>;
  patternCatalog: typeof OPPORTUNITY_PATTERN_CATALOG;
  tierDefaults: typeof ROI_ASSUMPTION_TIERS;
  evidencePackHash: string;
};

export function buildOpportunityEvidencePack(input: {
  evidencePack: OperatorEvidencePack;
  versionId: string;
  graph: ProcessGraph;
  complexity: unknown;
  narrative: unknown;
  promptTemplateId: string;
  promptTemplateVersion: string;
  modelId: string;
}): OpportunityEvidencePack {
  const evidence = collectEvidenceText(input.evidencePack, input.graph);
  const allowedEvidenceIds = [...new Set(evidence.map((item) => item.id))];
  const base = {
    orgId: input.evidencePack.orgId,
    workspaceId: input.evidencePack.workspaceId,
    processId: input.evidencePack.processId,
    processName: input.evidencePack.processName,
    versionId: input.versionId,
    graph: input.graph,
    complexity: input.complexity,
    narrative: input.narrative,
    allowedEvidenceIds,
    evidence,
    patternCatalog: OPPORTUNITY_PATTERN_CATALOG,
    tierDefaults: ROI_ASSUMPTION_TIERS,
  };
  return {
    ...base,
    evidencePackHash: stableHash({
      promptTemplateId: input.promptTemplateId,
      promptTemplateVersion: input.promptTemplateVersion,
      modelId: input.modelId,
      base,
    }),
  };
}

export function opportunityEvidencePackToPrompt(pack: OpportunityEvidencePack) {
  return JSON.stringify(
    {
      process: {
        id: pack.processId,
        name: pack.processName,
        version_id: pack.versionId,
        summary: pack.graph.summary ?? null,
      },
      graph: {
        nodes: pack.graph.nodes.map((node) => ({
          id: node.id,
          type: node.type,
          title: node.data.title,
          description: node.data.description ?? null,
          systems: node.data.systems ?? [],
          sla_seconds: node.data.sla_seconds ?? null,
          est_minutes: node.data.est_minutes ?? null,
          exceptions: node.data.exceptions ?? [],
          workarounds: node.data.workarounds ?? [],
          variants: node.data.variants ?? [],
          confidence: node.data.confidence ?? null,
          evidence_ids: node.data.evidence_ids ?? [],
          claim_ids: node.data.claim_ids ?? [],
        })),
        edges: pack.graph.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          edge_type: edge.edge_type,
          label: edge.label ?? null,
          condition: edge.condition ?? null,
          evidence_ids: edge.evidence_ids ?? [],
        })),
      },
      evidence: pack.evidence,
      complexity: pack.complexity,
      narrative: pack.narrative,
      pattern_catalog: pack.patternCatalog,
      tier_defaults: pack.tierDefaults,
    },
    null,
    2,
  );
}

function collectEvidenceText(
  pack: OperatorEvidencePack,
  graph: ProcessGraph,
): OpportunityEvidencePack["evidence"] {
  const graphEvidenceIds = new Set([
    ...graph.nodes.flatMap((node) => collectNodeEvidenceIds(node)),
    ...graph.edges.flatMap((edge) => edge.evidence_ids ?? []),
  ]);
  const evidenceById = new Map<string, OpportunityEvidencePack["evidence"][number]>();
  const add = (id: string, text: string | null | undefined, source: string) => {
    if (!id || !graphEvidenceIds.has(id) || !text?.trim()) return;
    if (!evidenceById.has(id)) {
      evidenceById.set(id, { id, text: trim(text, 900), source });
    }
  };

  for (const segment of pack.transcriptSegments) {
    for (const id of segment.evidenceIds) add(id, segment.text, "transcript_segment");
  }
  for (const event of pack.screenEvents) {
    const text = [event.label, event.appName, event.windowTitle, event.url, event.ocrText]
      .filter(Boolean)
      .join(" | ");
    for (const id of event.evidenceIds) add(id, text, "screen_event");
  }
  for (const observation of pack.visualObservations ?? []) {
    const text = [observation.uiSummary, observation.ocrText].filter(Boolean).join(" | ");
    for (const id of observation.evidenceIds) add(id, text, "visual_observation");
  }
  for (const chunk of pack.documentChunks) {
    for (const id of chunk.evidenceIds) add(id, chunk.text, "document_chunk");
  }
  for (const claim of pack.processClaims ?? []) {
    for (const evidenceText of claim.evidenceTexts ?? []) {
      add(evidenceText.id, evidenceText.text, "claim_evidence");
    }
  }
  return [...evidenceById.values()];
}

function collectNodeEvidenceIds(node: ProcessGraph["nodes"][number]) {
  return [
    ...(node.data.evidence_ids ?? []),
    ...(node.data.inputs ?? []).flatMap((item) => item.evidence_ids ?? []),
    ...(node.data.outputs ?? []).flatMap((item) => item.evidence_ids ?? []),
    ...(node.data.exceptions ?? []).flatMap((item) => item.evidence_ids ?? []),
    ...(node.data.workarounds ?? []).flatMap((item) => item.evidence_ids ?? []),
    ...(node.data.variants ?? []).flatMap((item) => item.evidence_ids ?? []),
  ];
}

function trim(text: string, max: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}
