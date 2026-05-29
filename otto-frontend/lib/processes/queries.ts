import "server-only";

import { sql } from "drizzle-orm";
import { getDb, setOrgContext } from "@/lib/db/client";
import type { Claim, Evidence, ProcessDetail } from "@/lib/types";

type DetailRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  owner_role: string | null;
  version_summary: string | null;
  frequency: string | null;
  system_details: Array<{ name: string; purpose?: string; evidence_ids?: string[] }>;
  role_details: Array<{ name: string; evidence_ids?: string[] }>;
  person_details: Array<{ name: string; title?: string; evidence_ids?: string[] }>;
  complexity_value: unknown;
  narrative_value: unknown;
  risk_claims: Array<{ id: string; value: unknown; confidence: number; evidence_count: number }>;
  evidence_count: number;
};

type EvidenceClaimRow = {
  id: string;
  subject_type: Claim["subject_type"];
  subject_id: string;
  field: string;
  value: unknown;
  confidence: string;
  status: Claim["status"];
  evidence: Array<{
    id: string;
    source_type: Evidence["source_type"];
    source_id: string | null;
    evidence_label: Evidence["evidence_label"];
    quote: string | null;
    observed_at: string | null;
    confidence: string;
  }>;
};

export type ProcessEvidenceBundle = {
  claims: Claim[];
  evidenceById: Record<string, Evidence>;
};

export async function getDirectorProcessDetail(
  orgId: string,
  workspaceId: string,
  processId: string,
): Promise<ProcessDetail | null> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<DetailRow>(sql`
      SELECT
        p.id,
        p.name,
        p.description,
        p.status::text,
        owner.name AS owner_role,
        pv.summary AS version_summary,
        MAX(freq.value #>> '{}') AS frequency,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('name', s.name, 'purpose', s.description, 'evidence_ids', ps.evidence_ids))
            FILTER (WHERE s.id IS NOT NULL),
          '[]'::jsonb
        ) AS system_details,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('name', r.name, 'evidence_ids', pr.evidence_ids))
            FILTER (WHERE r.id IS NOT NULL),
          '[]'::jsonb
        ) AS role_details,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object('name', pe.name, 'title', pe.title, 'evidence_ids', pp.evidence_ids))
            FILTER (WHERE pe.id IS NOT NULL),
          '[]'::jsonb
        ) AS person_details,
        MAX(cscore.value::text)::jsonb AS complexity_value,
        MAX(narrative.value::text)::jsonb AS narrative_value,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object(
            'id', risk.id,
            'value', risk.value,
            'confidence', risk.confidence,
            'evidence_count', risk_evidence.evidence_count
          )) FILTER (WHERE risk.id IS NOT NULL),
          '[]'::jsonb
        ) AS risk_claims,
        count(DISTINCT ce.evidence_id)::int AS evidence_count
      FROM processes p
      LEFT JOIN process_versions pv
        ON pv.id = COALESCE(p.current_draft_version_id, p.current_approved_version_id)
      LEFT JOIN roles owner ON owner.id = p.owner_role_id
      LEFT JOIN process_systems ps ON ps.process_id = p.id
      LEFT JOIN systems s ON s.id = ps.system_id
      LEFT JOIN process_roles pr ON pr.process_id = p.id
      LEFT JOIN roles r ON r.id = pr.role_id
      LEFT JOIN process_people pp ON pp.process_id = p.id
      LEFT JOIN people pe ON pe.id = pp.person_id
      LEFT JOIN claims freq
        ON freq.subject_type = 'process'
       AND freq.subject_id = p.id
       AND freq.field = 'frequency'
       AND freq.status = 'active'
       AND freq.superseded_by_claim_id IS NULL
      LEFT JOIN claims cscore
        ON cscore.subject_type = 'process'
       AND cscore.subject_id = p.id
       AND cscore.field = 'complexity_score'
       AND cscore.status = 'active'
       AND cscore.superseded_by_claim_id IS NULL
      LEFT JOIN claims narrative
        ON narrative.subject_type = 'process'
       AND narrative.subject_id = p.id
       AND narrative.field = 'narrative'
       AND narrative.status = 'active'
       AND narrative.superseded_by_claim_id IS NULL
      LEFT JOIN claims risk
        ON risk.subject_type = 'process'
       AND risk.subject_id = p.id
       AND risk.field = 'risk'
       AND risk.status = 'active'
       AND risk.superseded_by_claim_id IS NULL
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS evidence_count
        FROM claim_evidence
        WHERE claim_id = risk.id
      ) risk_evidence ON true
      LEFT JOIN claims evidence_claim
        ON evidence_claim.subject_type = 'process'
       AND evidence_claim.subject_id = p.id
       AND evidence_claim.status = 'active'
       AND evidence_claim.superseded_by_claim_id IS NULL
      LEFT JOIN claim_evidence ce ON ce.claim_id = evidence_claim.id
      WHERE p.org_id = ${orgId}
        AND p.workspace_id = ${workspaceId}
        AND p.id = ${processId}
      GROUP BY p.id, pv.id, owner.id
      LIMIT 1
    `);
  });
  const row = result.rows[0];
  if (!row) return null;
  return rowToDetail(row);
}

export async function getProcessEvidence(
  orgId: string,
  workspaceId: string,
  processId: string,
): Promise<ProcessEvidenceBundle> {
  const result = await getDb().transaction(async (tx) => {
    await setOrgContext(tx, orgId);
    return tx.execute<EvidenceClaimRow>(sql`
      SELECT
        c.id,
        c.subject_type,
        c.subject_id,
        c.field,
        c.value,
        c.confidence,
        c.status,
        COALESCE(
          jsonb_agg(jsonb_build_object(
            'id', e.id,
            'source_type', e.source_type,
            'source_id', e.source_id,
            'evidence_label', e.evidence_label,
            'quote', e.quote,
            'observed_at', e.observed_at,
            'confidence', e.confidence
          )) FILTER (WHERE e.id IS NOT NULL),
          '[]'::jsonb
        ) AS evidence
      FROM claims c
      LEFT JOIN claim_evidence ce ON ce.claim_id = c.id
      LEFT JOIN evidence e ON e.id = ce.evidence_id
      WHERE c.org_id = ${orgId}
        AND c.workspace_id = ${workspaceId}
        AND c.subject_type = 'process'
        AND c.subject_id = ${processId}
        AND c.status = 'active'
        AND c.superseded_by_claim_id IS NULL
      GROUP BY c.id
      ORDER BY c.field ASC, c.created_at ASC
    `);
  });

  const evidenceById: Record<string, Evidence> = {};
  const claims = result.rows.map((row) => {
    const evidenceIds: string[] = [];
    for (const item of row.evidence ?? []) {
      evidenceIds.push(item.id);
      evidenceById[item.id] = {
        id: item.id,
        source_type: item.source_type,
        source_id: item.source_id ?? "",
        evidence_label: item.evidence_label,
        quote: item.quote ?? "",
        observed_at: item.observed_at ?? new Date().toISOString(),
        confidence: Number(item.confidence ?? 1),
      };
    }
    return {
      id: row.id,
      subject_type: row.subject_type,
      subject_id: row.subject_id,
      field: row.field,
      value: row.value,
      confidence: Number(row.confidence),
      status: row.status,
      evidence_ids: evidenceIds,
    };
  });
  return { claims, evidenceById };
}

function rowToDetail(row: DetailRow): ProcessDetail {
  const complexity = parseComplexity(row.complexity_value);
  const narrative = parseNarrative(row.narrative_value);
  const systems = row.system_details ?? [];
  const roles = row.role_details ?? [];
  const people = row.person_details ?? [];
  const riskClaims = row.risk_claims ?? [];
  const score = complexity?.total ?? 0;

  return {
    id: row.id,
    source: "process",
    href: `/process/${row.id}`,
    name: row.name,
    process_status: row.status as "candidate" | "draft" | "approved" | "archived",
    function: row.owner_role ?? "Captured process",
    department: row.owner_role ?? "Commercial Department",
    status: "documented",
    complexity: score >= 65 ? "high" : score >= 35 ? "med" : "low",
    complexity_score: score,
    doc_coverage: row.evidence_count > 0 ? 1 : 0,
    description: row.description ?? narrative?.summaryParagraph ?? row.version_summary ?? "Promoted Phase 1 process draft.",
    people_count: roles.length + people.length,
    systems: systems.map((system) => system.name),
    frequency: row.frequency ?? "Unknown",
    evidence_count: row.evidence_count,
    recommended: score >= 55,
    recommended_reason: narrative?.recommendedDrilldownReason,
    summary_paragraph: narrative?.summaryParagraph,
    what_it_involves:
      narrative?.whatThisProcessInvolves ??
      row.version_summary ??
      "Director-layer detail is available, but the synthesis narrative is still thin.",
    complexity_breakdown: Object.values(complexity?.factors ?? {}).map((factor) => ({
      label: factor.label,
      value: factor.value,
      detail: factor.detail,
    })),
    complexity_total_max: 100,
    accountability: [
      ...roles.map((role) => ({
        role: role.name,
        domain: "Director intake",
        label: "owner" as const,
        description: "Role was linked during candidate promotion from active claims.",
      })),
      ...people.map((person) => ({
        role: person.title || person.name,
        person: person.name,
        domain: "Director intake",
        label: "internal admin" as const,
        description: "Person was linked from active intake evidence.",
      })),
    ],
    systems_detail: systems.map((system) => ({
      name: system.name,
      purpose: system.purpose ?? "Linked from active process-system evidence.",
    })),
    risks: riskClaims.length
      ? riskClaims.map((risk) => ({
          severity: risk.evidence_count > 0 ? "high" : "med",
          title: riskTitle(risk.value),
          body: riskBody(risk.value),
        }))
      : narrative?.topRisks.map((risk) => ({
          severity: risk.severity,
          title: risk.title,
          body: risk.body,
        })) ?? [],
  };
}

function parseComplexity(value: unknown): {
  total: number;
  factors: Record<string, { label: string; value: number; detail?: string }>;
} | null {
  if (!value || typeof value !== "object") return null;
  const object = value as {
    total?: unknown;
    factors?: Record<string, { label: string; value: number; detail?: string }>;
  };
  return typeof object.total === "number" && object.factors ? object as never : null;
}

function parseNarrative(value: unknown): {
  summaryParagraph?: string;
  whatThisProcessInvolves?: string;
  recommendedDrilldownReason?: string;
  topRisks: Array<{ title: string; body: string; severity: "high" | "med" | "low" }>;
} | null {
  if (!value || typeof value !== "object") return null;
  const object = value as {
    summaryParagraph?: string;
    whatThisProcessInvolves?: string;
    recommendedDrilldownReason?: string;
    topRisks?: Array<{ title: string; body: string; severity: "high" | "med" | "low" }>;
  };
  return { ...object, topRisks: object.topRisks ?? [] };
}

function riskTitle(value: unknown) {
  const body = riskBody(value);
  if (/single point|only one|depends on/i.test(body)) return "Single point of failure";
  if (/compliance|audit|control/i.test(body)) return "Control exposure";
  return "Operational risk";
}

function riskBody(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const object = value as { text?: unknown; type?: unknown };
    return String(object.text ?? object.type ?? JSON.stringify(value));
  }
  return "Risk captured from intake evidence.";
}
