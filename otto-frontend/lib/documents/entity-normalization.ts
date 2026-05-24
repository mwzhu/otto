import "server-only";

const systemAliases: Array<[RegExp, string]> = [
  [/^(sfdc|sales\s*force)$/i, "Salesforce"],
  [/^(g\s*sheets?|google\s*sheet|google\s*sheets)$/i, "Google Sheets"],
  [/^((ms\s*)?excel|microsoft\s*excel)$/i, "Excel"],
  [/^service\s*now$/i, "ServiceNow"],
  [/^net\s*suite$/i, "NetSuite"],
  [/^hub\s*spot$/i, "HubSpot"],
];

export function normalizeProcessName(value?: string | null) {
  return titleish(cleanEntity(value));
}

export function normalizeSystemName(value?: string | null) {
  const cleaned = cleanEntity(value);
  if (!cleaned) return "";
  const alias = systemAliases.find(([pattern]) => pattern.test(cleaned));
  return alias?.[1] ?? titleish(cleaned);
}

export function normalizeRoleName(value?: string | null) {
  return titleish(
    cleanEntity(value)
      .replace(/^(owner|accountable role|role|team|department):\s*/i, "")
      .replace(/\bdept\.?$/i, "department"),
  );
}

export function normalizeSignalText(value?: string | null) {
  return cleanEntity(value).replace(/\.$/, "");
}

export function uniqueNormalized(values: string[], normalize: (value: string) => string) {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return Array.from(byKey.values());
}

function cleanEntity(value?: string | null) {
  return (value ?? "")
    .replace(/^[\s\-*•:]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function titleish(value: string) {
  if (!value) return "";
  if (/[A-Z]{2,}/.test(value) || /[a-z][A-Z]/.test(value)) return value;
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
