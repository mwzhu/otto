import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("Phase 1 persistence skeleton", () => {
  test("migration adds RLS-protected Phase 1 tables", () => {
    const migration = read("migrations/0001_phase1_director_intake.sql");
    for (const table of [
      "slot_states",
      "candidate_processes",
      "capture_process_links",
      "follow_up_tasks",
      "synthesis_runs",
      "synthesis_stage_outputs",
      "agent_decision_log",
      "process_systems",
      "process_roles",
      "process_people",
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
      expect(migration).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY org_isolation_${table}`);
    }
  });

  test("agent decision log carries reconstructability and cost telemetry", () => {
    const schema = read("lib/db/schema.ts");
    for (const field of [
      "sanitizedAgentUtterance",
      "promptTemplateId",
      "tokenCountInput",
      "tokenCountOutput",
      "costCents",
      "latencyMs",
      "cacheHit",
      "degradedQuality",
    ]) {
      expect(schema).toContain(field);
    }
  });

  test("schema contracts exist for Week 2 handoffs", () => {
    for (const path of [
      "../schemas/claim.schema.json",
      "../schemas/slot-extraction.schema.json",
      "../schemas/probe-intent-ranking.schema.json",
      "../schemas/director-process-inventory.schema.json",
      "../schemas/document-extraction.schema.json",
      "../schemas/complexity-score.schema.json",
      "../schemas/narrative-tab.schema.json",
    ]) {
      expect(JSON.parse(read(path))).toHaveProperty("$schema");
    }
  });
});

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}
