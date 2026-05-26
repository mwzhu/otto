import "server-only";

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Pool as NodePgPool } from "pg";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { requireEnv } from "@/lib/env";
import * as schema from "@/lib/db/schema";

type NeonDb = ReturnType<typeof drizzle<typeof schema>>;
type NodePgDb = ReturnType<typeof drizzleNodePostgres<typeof schema>>;
type AppDb = NeonDb | NodePgDb;

let pool: Pool | NodePgPool | null = null;
let db: AppDb | null = null;
let servicePool: Pool | NodePgPool | null = null;
let serviceDb: AppDb | null = null;

export function getDb() {
  if (!db) {
    const connectionString = requireEnv("DATABASE_URL");
    if (isLocalPostgresUrl(connectionString)) {
      pool = new NodePgPool({ connectionString });
      db = drizzleNodePostgres(pool, { schema });
    } else {
      pool = new Pool({ connectionString });
      db = drizzle(pool, { schema });
    }
  }
  return db;
}

export function getServiceDb() {
  if (!serviceDb) {
    const connectionString = requireEnv("DATABASE_SERVICE_URL");
    if (isLocalPostgresUrl(connectionString)) {
      servicePool = new NodePgPool({ connectionString });
      serviceDb = drizzleNodePostgres(servicePool, { schema });
    } else {
      servicePool = new Pool({ connectionString });
      serviceDb = drizzle(servicePool, { schema });
    }
  }
  return serviceDb;
}

export async function setOrgContext(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  orgId: string,
) {
  await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
}

export async function closeDb() {
  await pool?.end();
  await servicePool?.end();
  pool = null;
  db = null;
  servicePool = null;
  serviceDb = null;
}

function isLocalPostgresUrl(connectionString: string) {
  try {
    const url = new URL(connectionString);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
