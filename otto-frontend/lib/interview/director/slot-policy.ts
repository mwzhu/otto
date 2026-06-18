import { stableStringify } from "@/lib/http/json";
import { directorSlotDefinitions } from "@/lib/interview/director/slot-schema";

// Phase 0.1 of the Director Continuous Reconciliation plan
// (docs/DIRECTOR_CONTINUOUS_RECONCILIATION_PLAN.md). Reconciliation verbs
// ("merge", "conflict", "enrich") are undefined until each slot path is
// classified by *where its durable truth lives* and what value shape it holds.
//
// This module is the single source of truth for that taxonomy plus the
// shape-aware compare/merge primitives that `reconcileSlotUpdate` (Phase 2)
// will consume. It must stay consistent with the "Slot Policy" table and the
// Phase 0.1 taxonomy table in the plan.

/**
 * Where a slot's durable truth lives.
 *
 * - `candidate`: `candidate_processes` rows; the process reconciler owns it.
 * - `claim`: `claims`/entity tables. `slot_states` holds only a coverage
 *   summary, so the durable merge happens in the claim layer and must NOT be
 *   re-merged inside `slot_states.value` (that would create a second,
 *   divergent source of truth).
 * - `slot_state`: `slot_states.value` is itself the durable truth.
 */
export type DirectorSlotBacking = "candidate" | "claim" | "slot_state";

/**
 * The value shape that selects a compare/merge primitive. Claim- and
 * candidate-backed slots use `summary` — the slot value is only a projection,
 * so it is compared structurally and never merged in this layer.
 */
export type DirectorSlotValueShape =
  | "scalar" // single identity/text value: function.name, frequency.volume
  | "string_list" // a set of short strings: outcomes, variants
  | "structured" // an object with named components: scope.boundaries
  | "summary"; // projection of claim/candidate truth; do not merge here

/**
 * Default reconciliation behavior when an incoming value differs from the
 * existing one. Mirrors the plan's Slot Policy table.
 */
export type DirectorSlotReconcilePolicy =
  | "process_reconciler" // process.inventory
  | "merge_in_claim_layer" // every claim-backed slot
  | "correction_or_conflict" // scalar identity
  | "enrich_or_replace_on_correction" // boundary text
  | "enrich_or_conflict" // frequency/volume
  | "merge_unique" // slot-state-backed list
  | "merge_or_enrich"; // outcomes

export type DirectorSlotPolicy = {
  backing: DirectorSlotBacking;
  shape: DirectorSlotValueShape;
  reconcile: DirectorSlotReconcilePolicy;
};

const CLAIM_BACKED: DirectorSlotPolicy = {
  backing: "claim",
  shape: "summary",
  reconcile: "merge_in_claim_layer",
};

const SLOT_POLICIES: Record<string, DirectorSlotPolicy> = {
  "function.name": {
    backing: "slot_state",
    shape: "scalar",
    reconcile: "correction_or_conflict",
  },
  "process.inventory": {
    backing: "candidate",
    shape: "summary",
    reconcile: "process_reconciler",
  },
  "scope.boundaries": {
    backing: "slot_state",
    shape: "structured",
    reconcile: "enrich_or_replace_on_correction",
  },
  "outcomes.business_outcomes": {
    backing: "slot_state",
    shape: "string_list",
    reconcile: "merge_or_enrich",
  },
  // Claim-backed: durable truth is the claim/entity row written by
  // recordRole / recordPerson / recordSystem / recordPainPoint / recordSpof /
  // recordCandidateProcessClaim (kpi, upstream_dependency, downstream_dependency).
  "ownership.roles": CLAIM_BACKED,
  "people.key_people": CLAIM_BACKED,
  "systems.systems_of_record": CLAIM_BACKED,
  "frequency.volume": {
    backing: "slot_state",
    shape: "scalar",
    reconcile: "enrich_or_conflict",
  },
  "handoffs.dependencies": CLAIM_BACKED,
  "metrics.kpis": CLAIM_BACKED,
  "friction.pain_points": CLAIM_BACKED,
  "risk.spofs": CLAIM_BACKED,
  "controls.compliance": {
    backing: "slot_state",
    shape: "scalar",
    reconcile: "correction_or_conflict",
  },
  "documentation.maturity": {
    backing: "slot_state",
    shape: "scalar",
    reconcile: "correction_or_conflict",
  },
  "priority.executive_priority": {
    backing: "slot_state",
    shape: "scalar",
    reconcile: "correction_or_conflict",
  },
  "variants.exceptions": {
    backing: "slot_state",
    shape: "string_list",
    reconcile: "merge_unique",
  },
};

export function directorSlotPolicy(slotPath: string): DirectorSlotPolicy {
  const policy = SLOT_POLICIES[slotPath];
  if (!policy) {
    throw new Error(`No reconciliation policy for director slot: ${slotPath}`);
  }
  return policy;
}

/** Where the slot's durable truth lives — the headline Phase 0.1 classifier. */
export function slotValueKind(slotPath: string): DirectorSlotBacking {
  return directorSlotPolicy(slotPath).backing;
}

export function slotValueShape(slotPath: string): DirectorSlotValueShape {
  return directorSlotPolicy(slotPath).shape;
}

/**
 * Claim-backed slots must merge in the claim/entity layer; the reconciler must
 * not invent a second merged list inside `slot_states.value` for them.
 */
export function isClaimBackedSlot(slotPath: string): boolean {
  return slotValueKind(slotPath) === "claim";
}

/** Slot paths that have no registered policy yet (schema-drift guard for tests). */
export function directorSlotPathsMissingPolicy(): string[] {
  return directorSlotDefinitions
    .map((definition) => definition.path)
    .filter((path) => !(path in SLOT_POLICIES));
}

// --- value primitives -------------------------------------------------------

const STRING_LIST_KEYS = [
  "roles",
  "owners",
  "systems",
  "people",
  "names",
  "process_names",
  "processNames",
  "items",
  "values",
  "list",
  "business_outcomes",
  "outcomes",
  "outcome",
  "pain_points",
  "kpis",
  "dependencies",
  "exceptions",
  "variants",
  "text",
];
const SCALAR_WRAPPER_KEYS = ["name", "text", "value", "label"];

/**
 * Best-effort extraction of a string list from a (list-shaped) slot value.
 * Handles a bare array, the wrapper objects the normalizers produce
 * (`{roles:[]}`, `{process_names:[]}`), and a delimiter-separated string.
 * De-duplicates exact repeats while preserving order and original casing.
 *
 * Only meaningful for `string_list`-shaped slots — do not call it on scalars,
 * where delimiter splitting would shred a single value.
 */
export function slotStringList(value: unknown): string[] {
  return dedupeExact(collectStrings(value));
}

/**
 * Union two list-shaped slot values: unique, case-insensitive de-dupe, first
 * seen casing wins, existing order preserved before new additions.
 */
export function mergeSlotStringLists(existing: unknown, incoming: unknown): string[] {
  const seen = new Map<string, string>();
  for (const entry of [...slotStringList(existing), ...slotStringList(incoming)]) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

/**
 * A canonical, comparable signature for a slot value, shape-aware:
 * - scalar: whitespace-collapsed, lowercased text
 * - string_list: sorted, lowercased, unique tokens (order-insensitive)
 * - structured / summary: stable JSON of a normalized record (key-sorted,
 *   lowercased leaves, arrays sorted) so member order does not matter
 */
export function slotValueSignature(slotPath: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  const shape = slotValueShape(slotPath);
  if (shape === "scalar") return scalarSignature(value);
  if (shape === "string_list") {
    return slotStringList(value)
      .map((entry) => entry.toLowerCase())
      .sort()
      .join("\u0001");
  }
  return stableStringify(normalizeForSignature(value));
}

/** True when two slot values are equivalent under the slot's shape. */
export function slotValuesEqual(
  slotPath: string,
  a: unknown,
  b: unknown,
): boolean {
  return slotValueSignature(slotPath, a) === slotValueSignature(slotPath, b);
}

export type ScopedDirectorSlotValue = {
  slotPath: string;
  candidateProcessId?: string | null;
  value: unknown;
};

/**
 * Equality for durable slot facts. Same label + same scalar value is not enough:
 * process-scoped slots with different candidate ids describe different facts.
 */
export function scopedSlotValuesEqual(
  a: ScopedDirectorSlotValue,
  b: ScopedDirectorSlotValue,
): boolean {
  return (
    a.slotPath === b.slotPath &&
    (a.candidateProcessId ?? null) === (b.candidateProcessId ?? null) &&
    slotValuesEqual(a.slotPath, a.value, b.value)
  );
}

// --- internals --------------------------------------------------------------

function collectStrings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return splitListText(value);
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return STRING_LIST_KEYS.filter((key) => key in record).flatMap((key) =>
      collectStrings(record[key]),
    );
  }
  return [];
}

function splitListText(text: string): string[] {
  return text
    .split(/[\n;,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function dedupeExact(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function scalarSignature(value: unknown): string {
  return scalarText(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const meaningfulEntries = Object.entries(record).filter(([, entry]) =>
      hasMeaningfulScalarWrapperEntry(entry),
    );
    if (meaningfulEntries.length === 1) {
      const [key, entry] = meaningfulEntries[0];
      if (SCALAR_WRAPPER_KEYS.includes(key) && typeof entry === "string") {
        return entry;
      }
    }
    return stableStringify(normalizeForSignature(value));
  }
  if (value === undefined || value === null) return "";
  return String(value);
}

function hasMeaningfulScalarWrapperEntry(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function normalizeForSignature(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) {
    return value
      .map(normalizeForSignature)
      .map((entry) => stableStringify(entry))
      .sort()
      .map((entry) => JSON.parse(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeForSignature(entry);
    }
    return out;
  }
  return value;
}
