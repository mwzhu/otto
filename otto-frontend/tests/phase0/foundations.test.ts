import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serverEnvSchema } from "../../lib/env";
import { stableStringify } from "../../lib/http/json";

const root = process.cwd();
const migration = read("migrations/0000_phase0_foundations.sql");
const writeClaim = read("lib/db/write-claim.ts");
const nextConfig = read("next.config.ts");

describe("Phase 0 foundation contract", () => {
  test("initial migration enables pgvector and declares RBAC/lifecycle schema", () => {
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS "vector"');
    expect(migration).toContain("CREATE TYPE org_role AS ENUM ('org_admin', 'fde')");
    expect(migration).toContain(
      "CREATE TYPE workspace_role AS ENUM ('director', 'operator', 'viewer')",
    );
    expect(migration).toContain("superseded_by_claim_id uuid");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("redacted_at timestamptz");
    expect(migration).toContain("tombstoned_at timestamptz");
    expect(migration).toContain("embedding vector(1536)");
  });

  test("RLS is present and uses current org context", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION app_current_org_id()");
    expect(migration).toContain("ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE workspaces FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE POLICY org_isolation_workspaces");
    expect(migration).toContain("org_id = app_current_org_id()");
  });

  test("idempotency rows include request hash and mismatch surface", () => {
    expect(migration).toContain("request_hash text NOT NULL");
    expect(migration).toContain("UNIQUE (org_id, key, route)");
    expect(read("lib/db/idempotency.ts")).toContain(
      "reused with a different request body",
    );
  });

  test("writeClaim locks and maintains supersession chain", () => {
    expect(writeClaim).toContain("FOR UPDATE");
    expect(writeClaim).toContain("status = 'superseded'");
    expect(writeClaim).toContain("superseded_by_claim_id = ${newClaimId}");
    expect(writeClaim.indexOf("status = 'superseded'")).toBeLessThan(
      writeClaim.indexOf("INSERT INTO claims"),
    );
  });

  test("Drizzle migration journal exists for drizzle-kit migrate", () => {
    const journal = read("migrations/meta/_journal.json");
    expect(journal).toContain("0000_phase0_foundations");
    expect(read("migrations/meta/0000_snapshot.json")).toContain(
      "\"dialect\": \"postgresql\"",
    );
  });

  test("every SQL migration is registered in the Drizzle journal", () => {
    const journal = JSON.parse(read("migrations/meta/_journal.json")) as {
      entries: Array<{ tag: string }>;
    };
    const journalTags = new Set(journal.entries.map((entry) => entry.tag));
    const migrationTags = readdirSync(join(root, "migrations"))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .map((file) => file.replace(/\.sql$/, ""));

    expect(migrationTags).toEqual(
      expect.arrayContaining(Array.from(journalTags)),
    );
    expect(Array.from(journalTags)).toEqual(
      expect.arrayContaining(migrationTags),
    );
  });

  test("production cannot boot with dev auth bypass", () => {
    expect(nextConfig).toContain("NODE_ENV === \"production\"");
    expect(nextConfig).toContain("function truthyEnv");
    expect(nextConfig).toContain("[\"1\", \"true\", \"yes\"]");
    expect(nextConfig).toContain("truthyEnv(process.env.OTTO_DEV_AUTH_BYPASS)");
    expect(nextConfig).toContain("Refusing to start");
  });

  test("server boolean env parsing matches worker-friendly values", () => {
    expect(
      serverEnvSchema.parse({
        OTTO_USE_LIVEKIT_INFERENCE: "YES",
        OTTO_DIRECTOR_PREFLIGHT_STRICT: " true ",
        OTTO_VENDOR_PRIVACY_ACK: "1",
        OTTO_DEEPGRAM_NO_STORE_ACK: "NO",
        OTTO_CARTESIA_NO_RETENTION_ACK: "0",
        OTTO_DIRECTOR_PLANNER_RUNTIME: " Next ",
      }),
    ).toMatchObject({
      OTTO_USE_LIVEKIT_INFERENCE: true,
      OTTO_DIRECTOR_PREFLIGHT_STRICT: true,
      OTTO_VENDOR_PRIVACY_ACK: true,
      OTTO_DEEPGRAM_NO_STORE_ACK: false,
      OTTO_CARTESIA_NO_RETENTION_ACK: false,
      OTTO_DIRECTOR_PLANNER_RUNTIME: "next",
    });
  });

  test("stableStringify makes idempotency hashes order-independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}
