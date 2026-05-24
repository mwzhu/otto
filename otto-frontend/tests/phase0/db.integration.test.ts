import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const image = "pgvector/pgvector:pg16";
const container = `otto-phase0-test-${process.pid}`;
const orgA = "11111111-1111-5111-8111-111111111111";
const orgB = "99999999-9999-5999-8999-999999999999";
const userId = "22222222-2222-5222-8222-222222222222";
const workspaceId = "33333333-3333-5333-8333-333333333333";
const processId = "44444444-4444-5444-8444-444444444444";
const evidenceId = "55555555-5555-5555-8555-555555555555";

let connectionString = "";
let appClient: Client;

describe("Phase 0 database integration", () => {
  beforeAll(async () => {
    ensureDocker();
    cleanupContainer();
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-e",
      "POSTGRES_DB=otto_test",
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    waitForPostgres();

    const migration = readFileSync(
      join(root, "migrations/0000_phase0_foundations.sql"),
    );
    execFileSync(
      "docker",
      ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "otto_test"],
      { input: migration },
    );
    execFileSync(
      "docker",
      ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "otto_test"],
      {
        input: `
          CREATE ROLE otto_app LOGIN PASSWORD 'otto_app';
          GRANT USAGE ON SCHEMA public TO otto_app;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO otto_app;
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO otto_app;
        `,
      },
    );

    const port = dockerPort();
    connectionString = `postgres://otto_app:otto_app@127.0.0.1:${port}/otto_test`;
    process.env.DATABASE_URL = connectionString;
    appClient = new Client({ connectionString });
    await appClient.connect();
  }, 120_000);

  afterAll(async () => {
    await appClient?.end().catch(() => undefined);
    cleanupContainer();
  });

  test("writeClaim supersedes prior claims and RLS hides cross-org rows", async () => {
    await seedOrgGraph(appClient);

    const { writeClaim } = await import("@/lib/db/write-claim");
    const { closeDb } = await import("@/lib/db/client");

    const first = await writeClaim({
      orgId: orgA,
      workspaceId,
      userId,
      subject: { type: "process", id: processId },
      field: "description",
      value: "First version",
      evidenceIds: [evidenceId],
      idempotencyKey: "claim-first",
      requestHash: "hash-first",
      route: "integration/write-claim",
    });
    expect(first.statusCode).toBe(201);
    expect(first.body.superseded_claim_id).toBeNull();

    const second = await writeClaim({
      orgId: orgA,
      workspaceId,
      userId,
      subject: { type: "process", id: processId },
      field: "description",
      value: "Second version",
      evidenceIds: [evidenceId],
      idempotencyKey: "claim-second",
      requestHash: "hash-second",
      route: "integration/write-claim",
    });
    expect(second.statusCode).toBe(201);
    expect(second.body.superseded_claim_id).toBe(first.body.claim.id);

    const active = await appClient.query(
      `
        SELECT id
        FROM claims
        WHERE subject_type = 'process'
          AND subject_id = $1
          AND field = 'description'
          AND status = 'active'
          AND superseded_by_claim_id IS NULL
      `,
      [processId],
    );
    expect(active.rows).toHaveLength(1);
    expect(active.rows[0].id).toBe(second.body.claim.id);

    const prior = await appClient.query(
      "SELECT status, superseded_by_claim_id FROM claims WHERE id = $1",
      [first.body.claim.id],
    );
    expect(prior.rows[0]).toEqual({
      status: "superseded",
      superseded_by_claim_id: second.body.claim.id,
    });

    const projection = await appClient.query(
      "SELECT description FROM processes WHERE id = $1",
      [processId],
    );
    expect(projection.rows[0].description).toBe("Second version");

    await appClient.query("SELECT set_config('app.current_org_id', $1, false)", [
      orgB,
    ]);
    const hidden = await appClient.query("SELECT count(*)::int AS count FROM workspaces");
    expect(hidden.rows[0].count).toBe(0);

    await closeDb();
  });

  test("customer tables force RLS", async () => {
    const ownerClient = new Client({
      connectionString: connectionString.replace(
        "otto_app:otto_app",
        "postgres:postgres",
      ),
    });
    await ownerClient.connect();
    const result = await ownerClient.query(`
      SELECT bool_and(relforcerowsecurity) AS forced
      FROM pg_class
      WHERE relname IN (
        'organizations',
        'users',
        'workspaces',
        'workspace_memberships',
        'processes',
        'process_versions',
        'artifacts',
        'evidence',
        'claims',
        'claim_evidence',
        'audit_log',
        'idempotency_keys'
      )
    `);
    await ownerClient.end();
    expect(result.rows[0].forced).toBe(true);
  });
});

async function seedOrgGraph(client: Client) {
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgA]);
  await client.query(
    "INSERT INTO organizations (id, workos_organization_id, name) VALUES ($1, $2, $3)",
    [orgA, "org_a", "Org A"],
  );
  await client.query(
    "INSERT INTO users (id, org_id, workos_user_id, email, org_role) VALUES ($1, $2, $3, $4, 'org_admin')",
    [userId, orgA, "user_a", "a@example.com"],
  );
  await client.query(
    "INSERT INTO workspaces (id, org_id, name, function_name, created_by_user_id) VALUES ($1, $2, $3, $4, $5)",
    [workspaceId, orgA, "Ops", "Commercial", userId],
  );
  await client.query(
    "INSERT INTO processes (id, org_id, workspace_id, name, description) VALUES ($1, $2, $3, $4, $5)",
    [processId, orgA, workspaceId, "Process", "Initial"],
  );
  await client.query(
    "INSERT INTO evidence (id, org_id, workspace_id, source_type, evidence_label, quote) VALUES ($1, $2, $3, 'user_correction', 'corrected', $4)",
    [evidenceId, orgA, workspaceId, "quote"],
  );
}

function ensureDocker() {
  execFileSync("docker", ["version"], { stdio: "ignore" });
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      execFileSync("docker", [
        "exec",
        container,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "otto_test",
        "-c",
        "SELECT 1",
      ], { stdio: "ignore" });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw new Error("Postgres container did not become ready.");
}

function dockerPort() {
  const output = execFileSync("docker", ["port", container, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const match = output.match(/:(\d+)$/);
  if (!match) throw new Error(`Could not parse docker port: ${output}`);
  return match[1];
}

function cleanupContainer() {
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  } catch {
    // Best effort cleanup.
  }
}
