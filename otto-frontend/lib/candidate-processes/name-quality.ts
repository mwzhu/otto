// Shared candidate-process name-quality rules: the junk-name blocklist +
// heuristics and the token-set containment helpers used to collapse
// compound/atom duplicates. One module so the director brain, the director
// tools (write-time defense in depth), inventory synthesis, and the overview
// queries all enforce the same vocabulary — previously the literal list was
// copied in two places and the heuristics existed only in the brain.

/**
 * Literal names that are never a real process. Matched against
 * `lower(proposed_name)` both in SQL (synthesis + overview filters) and in
 * `isJunkCandidateProcessName`. Sourced from prod director sessions: vague
 * "things" answers, quantifier phrases ("six big ones"), and pronoun answers
 * ("all of it").
 */
export const genericCandidateProcessNames = [
  "a couple different things",
  "couple different things",
  "different things",
  "a few things",
  "several things",
  "some things",
  "multiple things",
  "things",
  "all of it",
  "all of them",
  "all of the above",
  "everything",
  "six big ones",
  "the big ones",
  "big ones",
  "a lot of things",
  "lots of things",
  "out of stock",
] as const;

const genericNameSet = new Set<string>(genericCandidateProcessNames);

/**
 * Words ignored when comparing candidate names for containment. Includes
 * possessives so "Our Vendor Payments" and "Vendor Payments" compare equal.
 */
export const CANDIDATE_NAME_STOPWORDS = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "with",
  "plus",
  "our",
  "my",
  "their",
  "your",
]);

// "six big ones", "the three main ones", "2 key ones".
const quantifierOnesPattern =
  /^(?:the\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)?\s*(?:big|main|key|major|core)\s+ones?$/i;

// "all of it", "most of them", "some of those".
const pronounTailPattern =
  /^(?:all|some|most|none|everything|anything|any|both)\s+of\s+(?:it|them|those|that|these|this)$/i;

// Sentence fragments and sentiment that ASR/extraction sometimes promotes to a
// "name": "It's Very Reactive", "Not Very Proactive".
const fragmentStartPattern =
  /^(?:it'?s|that'?s|its|not|very|really|kind\s+of|sort\s+of|we'?re|they'?re|honestly|basically)\b/i;

// Bare verb forms (imperative/past) that are workflow narration, not process
// names. Gerunds ("Shipping", "Invoicing") stay legal — directors do name
// processes that way and the Task 7 guard tests rely on it.
const bareVerbTokens = new Set([
  "pick",
  "picked",
  "ship",
  "shipped",
  "pack",
  "packed",
  "send",
  "sent",
  "pay",
  "paid",
  "check",
  "checked",
  "file",
  "filed",
  "scan",
  "scanned",
  "invoiced",
  "ordered",
]);

// Business abbreviations that are plausible process names on their own.
// Anything else in ALL CAPS ≤4 chars is most likely an ASR artifact ("RAP"
// for "our AP").
const allowedAbbreviations = new Set([
  "AP",
  "AR",
  "PO",
  "POS",
  "HR",
  "IT",
  "QA",
  "QC",
  "KYC",
  "CRM",
  "ERP",
  "EDI",
  "RMA",
  "SKU",
]);

export function normalizeCandidateProcessName(name: string): string {
  return name.trim().toLowerCase();
}

export function candidateNameTokenSet(name: string): Set<string> {
  const tokens = normalizeCandidateProcessName(name)
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !CANDIDATE_NAME_STOPWORDS.has(token));
  return new Set(tokens);
}

export function isTokenSubset(subset: Set<string>, superset: Set<string>): boolean {
  if (subset.size === 0 || subset.size > superset.size) return false;
  for (const token of subset) {
    if (!superset.has(token)) return false;
  }
  return true;
}

/**
 * True when a proposed process name is a known junk shape: a quantifier or
 * pronoun phrase, a sentence fragment, bare verb narration, or a likely ASR
 * artifact. Callers reject the name instead of minting a candidate.
 */
export function isJunkCandidateProcessName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  const normalized = normalizeCandidateProcessName(trimmed);
  if (genericNameSet.has(normalized)) return true;
  if (quantifierOnesPattern.test(trimmed)) return true;
  if (pronounTailPattern.test(trimmed)) return true;
  if (fragmentStartPattern.test(trimmed)) return true;
  if (/^[A-Z]{2,4}$/.test(trimmed) && !allowedAbbreviations.has(trimmed)) {
    return true;
  }
  const tokens = candidateNameTokenSet(trimmed);
  if (tokens.size > 0 && [...tokens].every((token) => bareVerbTokens.has(token))) {
    return true;
  }
  return false;
}

function cleanCandidatePhrase(value: string) {
  return value
    .replace(/\b(?:today|for us|right now|mostly|usually)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The full write-time predicate: junk shapes plus step-narration fragments,
 * bare system names, and length/word-count sanity. Every path that mints a
 * candidate (director dispatch, recordProcess itself, the document pipeline)
 * must agree on this — a name the brain would reject must not be insertable
 * by a direct caller.
 */
export function isPlausibleCandidateProcessName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const cleaned = cleanCandidatePhrase(value);
  const lower = cleaned.toLowerCase();
  if (cleaned.length < 3 || cleaned.length > 80) return false;
  if (cleaned.split(/\s+/).length > 8) return false;
  if (isJunkCandidateProcessName(cleaned)) return false;
  if (
    /^(then|and then|we then|we first|first|next|finally)\b/i.test(cleaned) ||
    /^(we\s+)?(?:begin|start|move|send|finish|look|open|check|copy|paste|reconcile|review|approve|export|upload|download)\b/i.test(cleaned)
  ) {
    return false;
  }
  if (
    /\b(?:begin by|starts? by|move data|send off|final check|we finish|looking at|make sure)\b/i.test(cleaned)
  ) {
    return false;
  }
  if (
    /^(?:google sheets?|netsuite|workday|salesforce|excel|slack|jira|asana|hubspot|zendesk)$/i.test(cleaned)
  ) {
    return false;
  }
  return !/^(?:and we|we|i|they|it|this|that|looks like|successful)$/i.test(lower);
}
