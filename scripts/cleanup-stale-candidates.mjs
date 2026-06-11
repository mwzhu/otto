#!/usr/bin/env node
// One-time cleanup for workspaces that accumulated pending candidate_processes
// across many director interview sessions before session-supersede shipped
// (docs/DIRECTOR_EXTRACTION_QUALITY_PLAN.md, D2). Keeps the newest director
// session's pending candidates (or --keep-session) and discards the rest.
//
// Dry-run by default; pass --apply to write. Reads DATABASE_SERVICE_URL from
// the environment.
//
//   node scripts/cleanup-stale-candidates.mjs --workspace <uuid> [--keep-session <uuid>] [--apply]

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { Client } = require("../otto-frontend/node_modules/pg/lib/index.js");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspaceId = argValue("--workspace");
const keepSessionArg = argValue("--keep-session");
const apply = process.argv.includes("--apply");

if (!workspaceId) {
  console.error("Usage: cleanup-stale-candidates.mjs --workspace <uuid> [--keep-session <uuid>] [--apply]");
  process.exit(1);
}
if (!process.env.DATABASE_SERVICE_URL) {
  console.error("DATABASE_SERVICE_URL is not set.");
  process.exit(1);
}

const client = new Client({
  connectionString: process.env.DATABASE_SERVICE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  let keepSessionId = keepSessionArg;
  if (!keepSessionId) {
    const latest = await client.query(
      `SELECT id, started_at FROM capture_sessions
       WHERE workspace_id = $1 AND capture_type = 'director_interview'
       ORDER BY completed_at DESC NULLS LAST, started_at DESC
       LIMIT 1`,
      [workspaceId],
    );
    keepSessionId = latest.rows[0]?.id;
    if (!keepSessionId) {
      console.error("No director sessions found for that workspace.");
      process.exit(1);
    }
    console.log(`Keeping latest director session ${keepSessionId} (started ${latest.rows[0].started_at?.toISOString?.() ?? latest.rows[0].started_at})`);
  }

  const stale = await client.query(
    `SELECT id, proposed_name, capture_session_id, created_at
     FROM candidate_processes
     WHERE workspace_id = $1 AND status = 'pending' AND capture_session_id IS DISTINCT FROM $2
     ORDER BY created_at`,
    [workspaceId, keepSessionId],
  );
  console.log(`${stale.rows.length} stale pending candidate(s):`);
  for (const row of stale.rows) {
    console.log(`  - ${row.proposed_name}  (session ${row.capture_session_id}, ${row.created_at.toISOString()})`);
  }
  if (stale.rows.length === 0) process.exit(0);

  if (!apply) {
    console.log("\nDry run — pass --apply to discard these candidates.");
    process.exit(0);
  }

  await client.query("BEGIN");
  const updated = await client.query(
    `UPDATE candidate_processes
     SET status = 'discarded', updated_at = now()
     WHERE workspace_id = $1 AND status = 'pending' AND capture_session_id IS DISTINCT FROM $2
     RETURNING id`,
    [workspaceId, keepSessionId],
  );
  await client.query(
    `INSERT INTO audit_log (org_id, workspace_id, event_type, subject_type, subject_id, metadata_json)
     SELECT org_id, $1, 'candidate_process.superseded_by_session', 'workspace', $1,
            jsonb_build_object('script', 'cleanup-stale-candidates', 'kept_session_id', $2::text, 'discarded_count', $3::int)
     FROM workspaces WHERE id = $1`,
    [workspaceId, keepSessionId, updated.rows.length],
  );
  await client.query("COMMIT");
  console.log(`\nDiscarded ${updated.rows.length} candidate(s).`);
} finally {
  await client.end();
}
