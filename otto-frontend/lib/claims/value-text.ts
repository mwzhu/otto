// Shared claim-value helpers: extracting display/scoring text from the
// value shapes the extractor actually emits (plain strings, {text}, {items},
// {description}), and normalizing free-text risk claims into the canonical
// single-point-of-failure shape the SPOF metrics match on.

/**
 * Best-effort text from a claim value. The extractor emits several shapes for
 * the same field — prod examples: `"Wrong quantities, missed back orders"`,
 * `{"items": ["Wrong quantities", ...]}`, `{"description": "Source of truth
 * gap: ..."}`, `{"text": "..."}`. Returns "" when nothing textual exists.
 */
export function claimValueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => claimValueText(item))
      .filter(Boolean)
      .join("; ");
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "description", "note", "summary", "name"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return (record[key] as string).trim();
    }
  }
  if (Array.isArray(record.items)) {
    return claimValueText(record.items);
  }
  return "";
}

const singlePersonDependencyPatterns = [
  /single.?(?:person|point)/i,
  /\bonly (?:one|person)\b/i,
  /\bonly \w+ who\b/i,
  /\bbus factor\b/i,
  /\btribal knowledge\b/i,
  /\bkey.?person risk\b/i,
  /\bif \w+(?:'s| is)? (?:out|absent|leaves|gone)\b/i,
  /\bdepends (?:entirely|solely|completely) on\b/i,
  /\b(?:absence|departure) (?:halts|stops|blocks)\b/i,
];

export function isSinglePersonDependencyText(text: string): boolean {
  if (!text) return false;
  return singlePersonDependencyPatterns.some((pattern) => pattern.test(text));
}

const claimTextStopwords = new Set([
  "the",
  "a",
  "an",
  "on",
  "in",
  "of",
  "to",
  "is",
  "are",
  "and",
  "or",
  "for",
  "it",
  "its",
  "that",
  "this",
  "with",
  "our",
  "we",
  "by",
  "if",
  "as",
  "be",
  "all",
]);

function claimTextTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !claimTextStopwords.has(token)),
  );
}

// Capitalized words that are risk vocabulary, not people — sentence-initial
// capitals would otherwise make any two SPOF texts "share a name".
const capitalizedNonNames = new Set([
  "single",
  "only",
  "person",
  "point",
  "dependency",
  "failure",
  "tribal",
  "knowledge",
  "absence",
  "departure",
  "the",
  "this",
  "that",
  "when",
  "risk",
  "process",
]);

function capitalizedNameTokens(text: string): Set<string> {
  return new Set(
    (text.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
      .map((name) => name.toLowerCase())
      .filter((name) => !capitalizedNonNames.has(name)),
  );
}

/**
 * F4a: true when two claim values for the same subject+field say the same
 * thing. Two rules:
 * - token containment ≥ 0.6 (catches the same list arriving as a string and
 *   as {items: [...]} — a prod duplicate pair);
 * - both are single-person-dependency texts naming the same person (the prod
 *   Marcus pair arrived with only ~24% token overlap but identical meaning).
 */
export function isNearDuplicateClaimValue(a: unknown, b: unknown): boolean {
  const textA = claimValueText(a);
  const textB = claimValueText(b);
  if (!textA || !textB) return false;
  const tokensA = claimTextTokens(textA);
  const tokensB = claimTextTokens(textB);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }
  if (shared / Math.min(tokensA.size, tokensB.size) >= 0.6) return true;
  if (isSinglePersonDependencyText(textA) && isSinglePersonDependencyText(textB)) {
    const namesA = capitalizedNameTokens(textA);
    const namesB = capitalizedNameTokens(textB);
    for (const name of namesA) {
      if (namesB.has(name)) return true;
    }
  }
  return false;
}

/**
 * F2: the brain writes SPOF findings as free-text risk claims ("Single-person
 * dependency: Marcus is the only one who keys orders") which the SPOF metric
 * cannot match — it looks for the recordSpof shape. Rewrite matching risk
 * values to that canonical shape at dispatch; everything else passes through.
 */
export function normalizeRiskClaimValue(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "single_point_of_failure"
  ) {
    return value;
  }
  const text = claimValueText(value);
  if (text && isSinglePersonDependencyText(text)) {
    return { type: "single_point_of_failure", text };
  }
  return value;
}
