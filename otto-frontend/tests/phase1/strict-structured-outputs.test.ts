import { describe, expect, test } from "vitest";
import { scrubForStrict } from "@/lib/adapters/llm";
import {
  FAST_VOICE_MODEL,
  anthropicMaxTokensForPrompt,
  anthropicModelForPrompt,
} from "@/lib/ai/models";
import {
  directorClaimSubjectTypesForPhase,
  directorClaimZodSchema,
  directorClaimsAnthropicSchema,
} from "@/lib/interview/director/schema-artifacts";
import { directorSlotExtractionAnthropicToolSchema } from "@/lib/interview/director/brain";

const STRICT_FORBIDDEN_KEYS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "if",
  "then",
  "else",
  "not",
  "oneOf",
];

function collectSchemaKeys(node: unknown, keys: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaKeys(item, keys);
    return keys;
  }
  if (!node || typeof node !== "object") return keys;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    keys.push(key);
    // Property names are not schema keywords; skip one level down so a
    // property literally named "format" is not misreported.
    if (key === "properties" && value && typeof value === "object") {
      for (const sub of Object.values(value as Record<string, unknown>)) {
        collectSchemaKeys(sub, keys);
      }
      continue;
    }
    collectSchemaKeys(value, keys);
  }
  return keys;
}

describe("scrubForStrict", () => {
  const sampleSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: true,
    properties: {
      subject_id: { type: "string", format: "uuid", minLength: 1 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence_ids: {
        type: "array",
        minItems: 1,
        items: { type: "string", format: "uuid" },
      },
      // A property literally named "format" must survive the scrub.
      format: { type: "string", pattern: "^[a-z]+$" },
      mode: { oneOf: [{ const: "fast" }, { const: "slow" }] },
      payload: { type: "object" },
    },
    required: ["subject_id", "confidence", "ghost_field"],
    allOf: [
      {
        if: { properties: { basis: { const: "evidence" } }, required: ["basis"] },
        then: { required: ["evidence_ids"] },
      },
    ],
  };

  test("strips keywords strict mode rejects and forces closed objects", () => {
    const scrubbed = scrubForStrict(sampleSchema);
    const keys = collectSchemaKeys(scrubbed);
    for (const forbidden of STRICT_FORBIDDEN_KEYS) {
      expect(keys, `expected scrubbed schema to drop "${forbidden}"`).not.toContain(
        forbidden,
      );
    }

    const properties = scrubbed.properties as Record<string, Record<string, unknown>>;
    // Property named "format" is preserved (only its pattern constraint is stripped).
    expect(properties.format).toEqual({ type: "string" });
    // oneOf becomes the supported anyOf.
    expect(properties.mode.anyOf).toEqual([{ const: "fast" }, { const: "slow" }]);
    // Objects with declared properties are closed...
    expect(scrubbed.additionalProperties).toBe(false);
    // ...free-form objects without properties stay open (closing them would
    // make them unsatisfiable).
    expect(properties.payload).toEqual({ type: "object" });
    // Conditionally-required fields from stripped if/then branches do not
    // linger in required.
    expect(scrubbed.required).toEqual(["subject_id", "confidence"]);
  });

  test("is deterministic and idempotent", () => {
    const once = scrubForStrict(sampleSchema);
    const again = scrubForStrict(sampleSchema);
    const twice = scrubForStrict(once);
    expect(JSON.stringify(again)).toBe(JSON.stringify(once));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  test("preserves explicit additionalProperties:false on property-less objects", () => {
    const scrubbed = scrubForStrict({ type: "object", additionalProperties: false });
    expect(scrubbed).toEqual({ type: "object", additionalProperties: false });
  });
});

describe("generated director claims schema", () => {
  const claimSchema = directorClaimZodSchema("inventory");

  test("accepts a candidate_process pain_point claim with a name subject", () => {
    const parsed = claimSchema.safeParse({
      subject_type: "candidate_process",
      subject_id: "Order Intake",
      field: "pain_point",
      value: "Manual exception handling when orders fail validation.",
      confidence: 0.72,
      evidence_ids: ["b9f0a52e-5f64-4dd0-9d3c-0a4f1c2ce111"],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects subject_type process in director phase 1", () => {
    expect(directorClaimSubjectTypesForPhase("inventory")).not.toContain("process");
    const parsed = claimSchema.safeParse({
      subject_type: "process",
      subject_id: "Order Intake",
      field: "kpi",
      value: "Week delay costs ~10% of customers.",
      confidence: 0.8,
      evidence_ids: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects a string value for system.used_in_process", () => {
    const stringValue = claimSchema.safeParse({
      subject_type: "system",
      subject_id: "Gmail",
      field: "used_in_process",
      value: "Order Intake",
      confidence: 0.8,
      evidence_ids: [],
    });
    expect(stringValue.success).toBe(false);

    const objectValue = claimSchema.safeParse({
      subject_type: "system",
      subject_id: "Gmail",
      field: "used_in_process",
      value: { candidate_process_id: "Order Intake" },
      confidence: 0.8,
      evidence_ids: [],
    });
    expect(objectValue.success).toBe(true);
  });

  test("rejects fields outside the allowlist", () => {
    const parsed = claimSchema.safeParse({
      subject_type: "person",
      subject_id: "Marcus",
      field: "favorite_color",
      value: "blue",
      confidence: 0.9,
      evidence_ids: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("JSON tool schema mirrors the phase-aware union", () => {
    const schema = directorClaimsAnthropicSchema("inventory");
    const items = (schema as { items: { anyOf: Array<Record<string, unknown>> } }).items;
    const branches = items.anyOf;
    expect(branches.length).toBeGreaterThan(0);

    const subjectTypes = new Set(
      branches.map(
        (branch) =>
          (branch.properties as Record<string, { const: string }>).subject_type.const,
      ),
    );
    expect([...subjectTypes].sort()).toEqual(
      [...directorClaimSubjectTypesForPhase("inventory")].sort(),
    );
    expect(subjectTypes.has("process")).toBe(false);

    for (const branch of branches) {
      const properties = branch.properties as Record<string, Record<string, unknown>>;
      // Name-or-id contract: no uuid format pin on subject references.
      expect(properties.subject_id).not.toHaveProperty("format");
      expect(branch.required).toContain("value");
      expect(branch.additionalProperties).toBe(false);
    }

    const usedInProcess = branches.find(
      (branch) =>
        (branch.properties as Record<string, { const?: string }>).subject_type.const ===
          "system" &&
        (branch.properties as Record<string, { const?: string }>).field.const ===
          "used_in_process",
    );
    expect(usedInProcess).toBeDefined();
    const valueSchema = (usedInProcess!.properties as Record<string, unknown>)
      .value as Record<string, unknown>;
    expect(valueSchema.type).toBe("object");
    expect(valueSchema.required).toEqual(["candidate_process_id"]);
  });

  test("scrubbed extraction tool schema is strict-clean and byte-stable", () => {
    const scrubbed = scrubForStrict(directorSlotExtractionAnthropicToolSchema("inventory"));
    const keys = collectSchemaKeys(scrubbed);
    for (const forbidden of STRICT_FORBIDDEN_KEYS) {
      expect(keys, `expected extraction schema to drop "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
    const rebuilt = scrubForStrict(
      directorSlotExtractionAnthropicToolSchema("inventory"),
    );
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(scrubbed));
  });
});

describe("checker template routing", () => {
  test("checker templates route to Haiku with a 1500-token budget", () => {
    expect(anthropicModelForPrompt({}, "director.checker.output")).toBe(FAST_VOICE_MODEL);
    expect(anthropicModelForPrompt({}, "operator.checker.output")).toBe(FAST_VOICE_MODEL);
    expect(anthropicMaxTokensForPrompt("director.checker.output")).toBe(1500);
    expect(anthropicMaxTokensForPrompt("operator.checker.output")).toBe(1500);
  });

  test("voice phrasers keep their 200-token speech budget", () => {
    expect(anthropicMaxTokensForPrompt("director.voice.phrase-intent")).toBe(200);
    expect(anthropicMaxTokensForPrompt("operator.voice.phrase-intent")).toBe(200);
  });

  test("operator turn plan budget covers the full plan payload", () => {
    expect(anthropicMaxTokensForPrompt("operator.turn.plan")).toBe(2000);
  });
});
