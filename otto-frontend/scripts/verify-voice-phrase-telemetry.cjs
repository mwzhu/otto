#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const FAST_VOICE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_PROMPTS = [
  "director.voice.phrase-intent",
  "operator.voice.phrase-intent",
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function promptList(value) {
  return (value ? value.split(",") : DEFAULT_PROMPTS)
    .map((item) => item.trim())
    .filter(Boolean);
}

function expectedModelForPrompt(promptTemplateId, env) {
  if (promptTemplateId.startsWith("director.voice.")) {
    return env.DIRECTOR_VOICE_MODEL || FAST_VOICE_MODEL;
  }
  if (promptTemplateId.startsWith("operator.voice.")) {
    return env.OPERATOR_VOICE_MODEL || FAST_VOICE_MODEL;
  }
  return FAST_VOICE_MODEL;
}

function sinceClause(env) {
  if (env.VOICE_TELEMETRY_SINCE) {
    return {
      sql: "$2::timestamptz",
      params: [env.VOICE_TELEMETRY_SINCE],
      label: env.VOICE_TELEMETRY_SINCE,
    };
  }
  const hours = Number(env.VOICE_TELEMETRY_HOURS || 24);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("VOICE_TELEMETRY_HOURS must be a positive number.");
  }
  return {
    sql: `now() - interval '${hours} hours'`,
    params: [],
    label: `last ${hours} hours`,
  };
}

async function main() {
  const env = {
    ...loadEnvFile(path.join(process.cwd(), ".env.local")),
    ...process.env,
  };
  const connectionString = env.DATABASE_SERVICE_URL || env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_SERVICE_URL or DATABASE_URL is required.");
  }

  const prompts = promptList(env.VOICE_TELEMETRY_PROMPTS);
  const since = sinceClause(env);
  const maxAvgLatencyMs = env.VOICE_TELEMETRY_MAX_AVG_MS
    ? Number(env.VOICE_TELEMETRY_MAX_AVG_MS)
    : undefined;
  if (
    maxAvgLatencyMs !== undefined &&
    (!Number.isFinite(maxAvgLatencyMs) || maxAvgLatencyMs <= 0)
  ) {
    throw new Error("VOICE_TELEMETRY_MAX_AVG_MS must be a positive number.");
  }

  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const params = [prompts, ...since.params];
    const result = await pool.query(
      `
        WITH voice_turns AS (
          SELECT
            stage_name,
            delivery_json->'voice_metadata'->>'prompt_template_id' AS prompt_template_id,
            delivery_json->'voice_metadata'->>'model' AS model,
            nullif(delivery_json->'voice_metadata'->>'latency_ms', '')::int AS latency_ms,
            created_at
          FROM agent_decision_log
          WHERE stage_name IN ('director.turn', 'operator.turn')
            AND delivery_json ? 'voice_metadata'
            AND created_at >= ${since.sql}
        )
        SELECT
          prompt_template_id,
          model,
          count(*)::int AS rows,
          round(avg(latency_ms))::int AS avg_latency_ms,
          min(latency_ms)::int AS min_latency_ms,
          max(latency_ms)::int AS max_latency_ms,
          min(created_at) AS first_seen,
          max(created_at) AS last_seen
        FROM voice_turns
        WHERE prompt_template_id = ANY($1::text[])
        GROUP BY prompt_template_id, model
        ORDER BY prompt_template_id, last_seen DESC
      `,
      params,
    );

    const rowsByPrompt = new Map();
    for (const row of result.rows) {
      const rows = rowsByPrompt.get(row.prompt_template_id) || [];
      rows.push(row);
      rowsByPrompt.set(row.prompt_template_id, rows);
    }

    const failures = [];
    const summary = prompts.map((promptTemplateId) => {
      const rows = rowsByPrompt.get(promptTemplateId) || [];
      const expectedModel = expectedModelForPrompt(promptTemplateId, env);
      if (rows.length === 0) {
        failures.push(
          `${promptTemplateId}: no telemetry rows found in ${since.label}`,
        );
      }
      for (const row of rows) {
        if (row.model !== expectedModel) {
          failures.push(
            `${promptTemplateId}: saw ${row.model}, expected ${expectedModel}`,
          );
        }
        if (
          maxAvgLatencyMs !== undefined &&
          Number(row.avg_latency_ms) > maxAvgLatencyMs
        ) {
          failures.push(
            `${promptTemplateId}: avg latency ${row.avg_latency_ms}ms exceeds ${maxAvgLatencyMs}ms`,
          );
        }
      }
      return { prompt_template_id: promptTemplateId, expected_model: expectedModel, rows };
    });

    console.log(JSON.stringify({ ok: failures.length === 0, since: since.label, summary }, null, 2));
    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
