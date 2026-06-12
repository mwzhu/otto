// F5: canonical system names. Prod accumulated five variants of one
// spreadsheet — "Google Sheet", "Google Sheets", "Google Sheet (Marcus)",
// "reorder Google Sheet", "Google Sheet (reorder)" — which inflated the
// system-sprawl complexity factor and cluttered cards. Canonicalization
// strips parenthetical qualifiers and folds well-known SaaS aliases; a name
// with a leading qualifier ("reorder Google Sheet") is intentionally left
// distinct — it may be a genuinely different artifact.

const systemAliases = new Map<string, string>([
  ["google sheet", "Google Sheets"],
  ["google sheets", "Google Sheets"],
  ["google spreadsheet", "Google Sheets"],
  ["google spreadsheets", "Google Sheets"],
  ["sheets", "Google Sheets"],
  ["gmail", "Gmail"],
  ["google mail", "Gmail"],
  ["excel", "Excel"],
  ["microsoft excel", "Excel"],
  ["odoo", "Odoo"],
  ["netsuite", "NetSuite"],
  ["salesforce", "Salesforce"],
  ["quickbooks", "QuickBooks"],
  ["slack", "Slack"],
  ["outlook", "Outlook"],
]);

export function canonicalizeSystemName(name: string): string {
  const stripped = name
    .replace(/\s*\([^)]*\)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return name.trim();
  return systemAliases.get(stripped.toLowerCase()) ?? stripped;
}
