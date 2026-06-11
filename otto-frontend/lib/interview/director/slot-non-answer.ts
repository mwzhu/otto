import type { DirectorUtteranceType } from "@/lib/schemas/phase1";

// Task 3 / Task 9: detect slot extractions that are non-answers and must not be
// stored as a real slot value. This is a pure helper shared by the extraction
// normalizer (brain.ts) and the slot upsert downgrade guard (tools.ts); keeping
// it dependency-free avoids a brain.ts <-> tools.ts import cycle.

// Explicit don't-know / defer phrasing (Task 3).
const NON_ANSWER_VALUE_PATTERN =
  /\b(?:not (?:really |entirely |quite )?sure|i don'?t (?:really |actually )?know|no idea|hard to say|you(?:'d| would) have to ask|i(?:'d| would) have to (?:ask|check)|couldn'?t (?:tell|say)|i'?m not certain|don'?t quote me)\b/i;

// Task 9: a garbled deflection can look like a real answer — e.g. the director
// answered "what part of the business do you lead?" with "I oversee those peep
// those employees I just mentioned", which was stored as the function name.
// These are self-references back to earlier content, not new facts. A value that
// is essentially one of these phrases (or is dominated by self-reference /
// filler words) is a non-answer.
const NON_ANSWER_SELF_REFERENCE_PATTERN =
  /\b(?:(?:those|these|the|that|this|them|the same)\s+(?:peep\s+)?(?:people|employees|folks|team|ones?|things?|stuff|process(?:es)?|guys|group)?\s*(?:i|we|that i|that we)?\s*(?:just\s+)?(?:mentioned|said|talked about|listed|named|described|told you about|went over|covered|referenced))|(?:(?:like|as)\s+i\s+(?:just\s+)?(?:mentioned|said|told you))|(?:the\s+(?:one|ones|people|folks|employees|team)\s+(?:i|we)\s+(?:just\s+)?(?:mentioned|named|said))|(?:same\s+(?:as\s+)?(?:before|above|earlier))/i;

// Words that carry no slot-specific information on their own; a value made
// almost entirely of these (filler + self-reference scaffolding) is low-content.
const NON_ANSWER_FILLER_WORDS = new Set([
  "i",
  "we",
  "you",
  "they",
  "them",
  "those",
  "these",
  "that",
  "this",
  "the",
  "a",
  "an",
  "and",
  "just",
  "oversee",
  "manage",
  "handle",
  "lead",
  "led",
  "run",
  "peep",
  "people",
  "employees",
  "folks",
  "team",
  "ones",
  "one",
  "guys",
  "group",
  "stuff",
  "things",
  "thing",
  "mentioned",
  "said",
  "named",
  "listed",
  "described",
  "referenced",
  "talked",
  "about",
  "to",
  "of",
  "as",
  "like",
  "same",
  "before",
  "above",
  "earlier",
  "already",
  "kind",
  "sort",
  "etc",
  "whatever",
]);

export function isNonAnswerSlotExtraction(
  value: unknown,
  utteranceType?: DirectorUtteranceType,
): boolean {
  if (value === undefined) return false;
  if (utteranceType === "dont_know" || utteranceType === "non_answer") {
    return true;
  }
  const text = extractionValueText(value);
  if (text.length === 0) return false;
  if (NON_ANSWER_VALUE_PATTERN.test(text)) return true;
  if (NON_ANSWER_SELF_REFERENCE_PATTERN.test(text)) return true;
  return isLowContentSlotValueText(text);
}

// A value whose significant words are (almost) entirely filler/self-reference
// scaffolding carries no real answer. Requires that essentially every content
// word be filler so this never demotes a legitimate short answer like
// "VP of operations" or "Accounts Payable".
function isLowContentSlotValueText(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length < 3) return false;
  const informative = words.filter((word) => !NON_ANSWER_FILLER_WORDS.has(word));
  return informative.length === 0;
}

export function extractionValueText(value: unknown, depth = 0): string {
  if (depth > 3 || value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => extractionValueText(entry, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((entry) => extractionValueText(entry, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}
