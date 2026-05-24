const patterns: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[PII:email]"],
  [/(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g, "[PII:phone]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[PII:ssn]"],
  [/(?<![A-Fa-f0-9-])(?:\d[ -]*?){13,19}(?![A-Fa-f0-9-])/g, "[PII:card]"],
];

export function sanitizeForLogs(value: string) {
  return patterns.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

export function sanitizeJsonForLogs(value: unknown): unknown {
  if (typeof value === "string") return sanitizeForLogs(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonForLogs(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizeJsonForLogs(child)]),
    );
  }
  return value;
}
