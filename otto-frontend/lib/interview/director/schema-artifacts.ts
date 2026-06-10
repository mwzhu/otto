import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DirectorInterviewPhase } from "@/lib/schemas/phase1";

const cache = new Map<string, unknown>();

export function readSharedSchemaArtifact<T = unknown>(filename: string): T {
  const cached = cache.get(filename);
  if (cached !== undefined) return cached as T;

  const path = sharedSchemaPath(filename);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as T;
  cache.set(filename, parsed);
  return parsed;
}

function sharedSchemaPath(filename: string) {
  const candidates = [
    join(process.cwd(), "..", "schemas", filename),
    join(process.cwd(), "schemas", filename),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Missing shared schema artifact ${filename}. Tried: ${candidates.join(", ")}`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Director claims schema, generated from schemas/claim-subject-fields.json.
//
// The extraction tool's `claims` array is a discriminated union: one branch
// per allowed (subject_type, field) pair, with `subject_type`/`field` as
// const values and `value` constrained to the allowlisted shape. Wrong
// subject types, unknown fields, and wrong value shapes become
// unrepresentable at generation time (with strict tool use) instead of being
// dropped post-hoc at dispatch.
//
// Cross-lane contract: `subject_id` accepts a row UUID *or* a plain entity
// name — the model cannot know UUIDs for entities created in the same turn,
// and dispatch resolves names against session entities.
// ---------------------------------------------------------------------------

type ClaimValueType = "array" | "boolean" | "number" | "object" | "string";

type ClaimFieldSpec = {
  field: string;
  value_schema: {
    type: ClaimValueType | ClaimValueType[];
    required?: string[];
  };
};

type ClaimSubjectSpec = {
  subject_type: string;
  fields: ClaimFieldSpec[];
};

type ClaimSubjectFieldsArtifact = {
  version: number;
  allowed: ClaimSubjectSpec[];
};

/**
 * Director interviews operate at the discovery layer for every conversation
 * phase ("phase 1" of the product): claims may only target inventory-level
 * subjects. Deeper subjects (process, process_version, process_node, ...)
 * belong to the operator path and post-promotion synthesis, so the director
 * tool schema never offers them — `process.*` facts must target the matching
 * `candidate_process` instead.
 */
const DIRECTOR_CLAIM_SUBJECT_TYPES: readonly string[] = [
  "candidate_process",
  "system",
  "person",
  "role",
];

export function directorClaimSubjectTypesForPhase(
  _phase?: DirectorInterviewPhase,
): readonly string[] {
  // All current director phases (orient/inventory/expand/enrich/closeout)
  // share the discovery-layer subject set. The parameter keeps the routing
  // explicit for callers and lets later phases diverge without changing the
  // call sites.
  return DIRECTOR_CLAIM_SUBJECT_TYPES;
}

const SUBJECT_ID_DESCRIPTION =
  "Row id (UUID) of the subject when known; otherwise the subject's exact name as mentioned in the conversation.";

function allowedSubjectSpecs(phase?: DirectorInterviewPhase): ClaimSubjectSpec[] {
  const allowedTypes = new Set(directorClaimSubjectTypesForPhase(phase));
  const artifact = readSharedSchemaArtifact<ClaimSubjectFieldsArtifact>(
    "claim-subject-fields.json",
  );
  return artifact.allowed.filter((subject) => allowedTypes.has(subject.subject_type));
}

/**
 * JSON Schema for the extraction tool's `claims` array. Deterministic for a
 * given phase (branches follow artifact order), so the serialized request
 * stays byte-stable for prompt caching.
 */
export function directorClaimsAnthropicSchema(
  phase?: DirectorInterviewPhase,
): Record<string, unknown> {
  return {
    type: "array",
    description:
      "Evidence-backed claims about entities mentioned this turn. Each claim targets one allowed subject_type + field pair.",
    items: {
      anyOf: allowedSubjectSpecs(phase).flatMap((subject) =>
        subject.fields.map((field) => claimBranchJsonSchema(subject.subject_type, field)),
      ),
    },
  };
}

function claimBranchJsonSchema(subjectType: string, spec: ClaimFieldSpec) {
  return {
    type: "object",
    properties: {
      subject_type: { const: subjectType },
      subject_id: { type: "string", description: SUBJECT_ID_DESCRIPTION },
      field: { const: spec.field },
      value: claimValueJsonSchema(spec.value_schema),
      confidence: { type: "number", description: "Confidence from 0 to 1." },
      evidence_ids: { type: "array", items: { type: "string" } },
      metadata: {
        type: "object",
        properties: {
          inferred: {
            type: "boolean",
            description: "True when the value is inferred rather than stated.",
          },
        },
        additionalProperties: false,
      },
    },
    required: [
      "subject_type",
      "subject_id",
      "field",
      "value",
      "confidence",
      "evidence_ids",
    ],
    additionalProperties: false,
  };
}

function claimValueJsonSchema(valueSchema: ClaimFieldSpec["value_schema"]) {
  const types = Array.isArray(valueSchema.type)
    ? valueSchema.type
    : [valueSchema.type];
  const variants = types.map((type) =>
    claimValueTypeJsonSchema(type, valueSchema.required),
  );
  return variants.length === 1 ? variants[0] : { anyOf: variants };
}

function claimValueTypeJsonSchema(
  type: ClaimValueType,
  requiredKeys?: string[],
): Record<string, unknown> {
  if (type === "object" && requiredKeys && requiredKeys.length > 0) {
    return {
      type: "object",
      properties: Object.fromEntries(
        requiredKeys.map((key) => [
          key,
          key.endsWith("_id")
            ? { type: "string", description: SUBJECT_ID_DESCRIPTION }
            : { type: "string" },
        ]),
      ),
      required: [...requiredKeys],
      additionalProperties: false,
    };
  }
  return { type };
}

export type DirectorGeneratedClaim = {
  subject_type: string;
  subject_id: string;
  field: string;
  value: unknown;
  confidence: number;
  evidence_ids: string[];
  metadata?: Record<string, unknown>;
};

const claimZodCache = new Map<string, z.ZodType<DirectorGeneratedClaim>>();

/**
 * Zod mirror of {@link directorClaimsAnthropicSchema} for one claim, built
 * from the same artifact so client validation matches what the tool schema
 * allows. `subject_id` stays permissive (UUID or plain name).
 */
export function directorClaimZodSchema(
  phase?: DirectorInterviewPhase,
): z.ZodType<DirectorGeneratedClaim> {
  const subjects = allowedSubjectSpecs(phase);
  const cacheKey = subjects.map((subject) => subject.subject_type).join("|");
  const cached = claimZodCache.get(cacheKey);
  if (cached) return cached;

  const branches: z.ZodTypeAny[] = subjects.flatMap((subject) =>
    subject.fields.map((field) => claimBranchZodSchema(subject.subject_type, field)),
  );
  const schema = z.union(
    branches as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  ) as unknown as z.ZodType<DirectorGeneratedClaim>;
  claimZodCache.set(cacheKey, schema);
  return schema;
}

function claimBranchZodSchema(subjectType: string, spec: ClaimFieldSpec) {
  return z.object({
    subject_type: z.literal(subjectType),
    subject_id: z.string().min(1),
    field: z.literal(spec.field),
    value: claimValueZodSchema(spec.value_schema),
    confidence: z.number().min(0).max(1),
    evidence_ids: z.array(z.string()).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
}

function claimValueZodSchema(valueSchema: ClaimFieldSpec["value_schema"]) {
  const types = Array.isArray(valueSchema.type)
    ? valueSchema.type
    : [valueSchema.type];
  const variants = types.map((type) =>
    claimValueTypeZodSchema(type, valueSchema.required),
  );
  if (variants.length === 1) return variants[0];
  return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

function claimValueTypeZodSchema(
  type: ClaimValueType,
  requiredKeys?: string[],
): z.ZodTypeAny {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object": {
      if (requiredKeys && requiredKeys.length > 0) {
        return z.looseObject(
          Object.fromEntries(
            requiredKeys.map((key) => [key, z.string().min(1)]),
          ),
        );
      }
      return z.record(z.string(), z.unknown());
    }
  }
}
