import "server-only";

import { z } from "zod";
import { readSharedSchemaArtifact } from "@/lib/interview/director/schema-artifacts";

const claimValueTypeSchema = z.enum([
  "array",
  "boolean",
  "number",
  "object",
  "string",
]);

const claimFieldSchema = z.object({
  field: z.string().min(1),
  value_schema: z.object({
    type: claimValueTypeSchema.or(z.array(claimValueTypeSchema).min(1)),
    required: z.array(z.string().min(1)).optional(),
  }),
});

const claimSubjectFieldsSchema = z.object({
  version: z.number().int().min(1),
  allowed: z.array(
    z.object({
      subject_type: z.string().min(1),
      fields: z.array(claimFieldSchema).min(1),
    }),
  ),
});

export type DirectorPlanClaim = {
  subject_type: string;
  field: string;
  value: unknown;
};

export type ClaimValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

const parsedAllowlist = claimSubjectFieldsSchema.parse(
  readSharedSchemaArtifact("claim-subject-fields.json"),
);
const fieldsBySubject = new Map(
  parsedAllowlist.allowed.map((subject) => [
    subject.subject_type,
    new Map(subject.fields.map((field) => [field.field, field])),
  ]),
);

export function validateDirectorPlanClaim(
  claim: DirectorPlanClaim,
): ClaimValidationResult {
  const field = fieldsBySubject.get(claim.subject_type)?.get(claim.field);
  if (!field) {
    return {
      ok: false,
      reason: `Unsupported claim field: ${claim.subject_type}.${claim.field}`,
    };
  }
  const allowedTypes = new Set(
    Array.isArray(field.value_schema.type)
      ? field.value_schema.type
      : [field.value_schema.type],
  );
  const actualType = claimValueType(claim.value);
  if (!allowedTypes.has(actualType)) {
    return {
      ok: false,
      reason: `Invalid claim value type for ${claim.subject_type}.${claim.field}: expected ${Array.from(allowedTypes).join("|")}, got ${actualType}`,
    };
  }
  if (field.value_schema.required && actualType === "object") {
    const value = claim.value as Record<string, unknown>;
    const missing = field.value_schema.required.filter((key) => value[key] === undefined);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Missing required claim value keys for ${claim.subject_type}.${claim.field}: ${missing.join(", ")}`,
      };
    }
  }
  return { ok: true };
}

export function allowedDirectorClaimSubjects() {
  return parsedAllowlist.allowed.map((subject) => ({
    subject_type: subject.subject_type,
    fields: subject.fields.map((field) => field.field),
  }));
}

function claimValueType(value: unknown) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "object";
  const type = typeof value;
  if (
    type === "boolean" ||
    type === "number" ||
    type === "object" ||
    type === "string"
  ) {
    return type;
  }
  return "object";
}
