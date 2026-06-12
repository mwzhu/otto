import { describe, expect, test } from "vitest";
import {
  claimValueText,
  isNearDuplicateClaimValue,
  isSinglePersonDependencyText,
  normalizeRiskClaimValue,
} from "@/lib/claims/value-text";
import { canonicalizeSystemName } from "@/lib/systems/canonicalize";
import { computeComplexityScore } from "@/lib/synthesis/complexity";

// Round 2 (F2/F4/F8) helpers, exercised with the exact value shapes prod
// session 667b5809 produced.

describe("claimValueText — the shapes the extractor actually emits", () => {
  test("plain string", () => {
    expect(claimValueText("Wrong quantities, missed back orders")).toBe(
      "Wrong quantities, missed back orders",
    );
  });
  test("items array (the prod pain_point shape that scored 0 friction)", () => {
    expect(
      claimValueText({ items: ["Wrong quantities", "Missed back orders"] }),
    ).toBe("Wrong quantities; Missed back orders");
  });
  test("description object (the prod raw-JSON risk)", () => {
    expect(
      claimValueText({ description: "Source of truth gap: Odoo is nominal SoT" }),
    ).toBe("Source of truth gap: Odoo is nominal SoT");
  });
  test("text object and empty fallbacks", () => {
    expect(claimValueText({ text: "tribal knowledge" })).toBe("tribal knowledge");
    expect(claimValueText({ unrelated: 42 })).toBe("");
    expect(claimValueText(null)).toBe("");
  });
});

describe("normalizeRiskClaimValue (F2)", () => {
  test("both prod Marcus risk phrasings normalize to the recordSpof shape", () => {
    const phrasings = [
      "Single-person dependency: Marcus is the only one who keys orders; absence halts the process.",
      "Single person dependency on Marcus; if out, order intake stops",
    ];
    for (const text of phrasings) {
      expect(normalizeRiskClaimValue(text)).toEqual({
        type: "single_point_of_failure",
        text,
      });
    }
  });
  test("a non-SPOF risk passes through unchanged", () => {
    const value = {
      description:
        "Source of truth gap: Odoo is nominal SoT but Google Sheets and tribal knowledge (Marcus) are used in practice",
    };
    // Contains "tribal knowledge" — this one IS a person-dependency signal.
    expect(isSinglePersonDependencyText(claimValueText(value))).toBe(true);
    const plain = "Pricing mismatches between the quote and the invoice";
    expect(normalizeRiskClaimValue(plain)).toBe(plain);
  });
  test("an already-canonical value is untouched", () => {
    const value = { type: "single_point_of_failure", text: "Marcus only" };
    expect(normalizeRiskClaimValue(value)).toBe(value);
  });
});

describe("isNearDuplicateClaimValue (F4a)", () => {
  test("the prod Marcus pair is a duplicate despite low token overlap", () => {
    expect(
      isNearDuplicateClaimValue(
        "Single-person dependency: Marcus is the only one who keys orders; absence halts the process.",
        "Single person dependency on Marcus; if out, order intake stops",
      ),
    ).toBe(true);
  });
  test("SPOF texts about different people are NOT duplicates", () => {
    expect(
      isNearDuplicateClaimValue(
        "Single-person dependency: Marcus is the only one who keys orders.",
        "Single point of failure: Priya is the only purchasing lead.",
      ),
    ).toBe(false);
  });
  test("the same list as a string and as items is a duplicate", () => {
    expect(
      isNearDuplicateClaimValue(
        "Wrong quantities, missed back orders, pricing that does not match",
        { items: ["Wrong quantities", "Missed back orders", "Pricing that doesn't match"] },
      ),
    ).toBe(true);
  });
  test("unrelated facts are not duplicates", () => {
    expect(
      isNearDuplicateClaimValue(
        "Orders arrive via Gmail",
        "Finance gets pulled in when a customer is over their credit limit",
      ),
    ).toBe(false);
  });
});

describe("canonicalizeSystemName (F5)", () => {
  test("the five prod Google Sheet variants fold to at most two canonical names", () => {
    const variants = [
      "Google Sheet",
      "Google Sheets",
      "Google Sheet (Marcus)",
      "Google Sheet (reorder)",
      "reorder Google Sheet",
    ];
    const canonical = new Set(variants.map(canonicalizeSystemName));
    expect(canonical.has("Google Sheets")).toBe(true);
    // The leading-qualifier variant stays distinct by design.
    expect(canonical.size).toBe(2);
  });
  test("unknown systems keep their name, minus parentheticals", () => {
    expect(canonicalizeSystemName("Fishbowl (warehouse)")).toBe("Fishbowl");
    expect(canonicalizeSystemName("Odoo")).toBe("Odoo");
  });
});

describe("complexity rubric (G2)", () => {
  test("an unknown process scores 0, not a defaults floor", () => {
    const score = computeComplexityScore({ frequency: null, evidenceIds: [] });
    expect(score.total).toBe(0);
  });
  test("totals rescale to /100 without the documentation factor", () => {
    const score = computeComplexityScore({
      systemCount: 4,
      roleCount: 1,
      frequency: "daily, 40-60 orders per day",
      painPoints: [
        { text: "wrong quantities and manual rework", evidenceIds: ["e1"] },
        { text: "price list lives in a spreadsheet", evidenceIds: ["e2"] },
      ],
      risks: [
        { text: "Single-person dependency: Marcus keys all orders", evidenceIds: ["e3"] },
      ],
      evidenceIds: ["e1", "e2", "e3"],
    });
    // raw: sprawl 16 + handoffs 3 + frequency 15 + friction 18 + spof 5 = 57/85
    expect(score.total).toBe(Math.round((57 / 85) * 100));
    expect(Object.keys(score.factors)).not.toContain("documentation_gap");
  });
});
