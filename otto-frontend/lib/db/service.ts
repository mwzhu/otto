import "server-only";

import { Pool } from "pg";
import { getServerEnv } from "@/lib/env";

let servicePool: Pool | null = null;

export function getServiceDbPool() {
  const env = getServerEnv();
  if (!env.DATABASE_SERVICE_URL) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_SERVICE_URL is required for cross-org maintenance jobs.",
      );
    }
    return null;
  }
  if (!servicePool) {
    servicePool = new Pool({ connectionString: env.DATABASE_SERVICE_URL });
  }
  return servicePool;
}

export async function closeServiceDbPool() {
  await servicePool?.end();
  servicePool = null;
}
