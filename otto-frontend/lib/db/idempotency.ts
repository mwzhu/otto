import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { idempotencyKeys } from "@/lib/db/schema";
import { ApiError } from "@/lib/http/json";

type Tx = {
  select: typeof import("@/lib/db/client").getDb extends () => infer Db
    ? Db extends { select: infer Select }
      ? Select
      : never
    : never;
  insert: ReturnType<typeof import("@/lib/db/client").getDb>["insert"];
  update: ReturnType<typeof import("@/lib/db/client").getDb>["update"];
  execute: ReturnType<typeof import("@/lib/db/client").getDb>["execute"];
};

export type IdempotentHit = {
  hit: true;
  responseJson: unknown;
  statusCode: number;
};

export type IdempotentMiss = {
  hit: false;
};

export async function getIdempotentResponse(
  tx: Tx,
  input: {
    orgId: string;
    key: string;
    route: string;
    requestHash: string;
  },
): Promise<IdempotentHit | IdempotentMiss> {
  const rows = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.orgId, input.orgId),
        eq(idempotencyKeys.key, input.key),
        eq(idempotencyKeys.route, input.route),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return { hit: false };
  if (existing.requestHash !== input.requestHash) {
    throw new ApiError(
      409,
      "conflict",
      "Idempotency-Key was reused with a different request body.",
    );
  }
  if (existing.responseJson === null || existing.statusCode === null) {
    throw new ApiError(
      409,
      "conflict",
      "A request with this Idempotency-Key is already in progress.",
    );
  }
  return {
    hit: true,
    responseJson: existing.responseJson,
    statusCode: existing.statusCode ?? 200,
  };
}

export async function reserveIdempotentRequest(
  tx: Tx,
  input: {
    orgId: string;
    key: string;
    route: string;
    requestHash: string;
  },
): Promise<IdempotentHit | IdempotentMiss> {
  const cached = await getIdempotentResponse(tx, input);
  if (cached.hit) return cached;

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const reserved = await tx.execute<{ id: string }>(sql`
    INSERT INTO idempotency_keys (
      org_id,
      key,
      route,
      request_hash,
      expires_at
    )
    VALUES (
      ${input.orgId},
      ${input.key},
      ${input.route},
      ${input.requestHash},
      ${expiresAt}
    )
    ON CONFLICT (org_id, key, route) DO NOTHING
    RETURNING id
  `);
  if (reserved.rows[0]) return { hit: false };
  return getIdempotentResponse(tx, input);
}

export async function storeIdempotentResponse(
  tx: Tx,
  input: {
    orgId: string;
    key: string;
    route: string;
    requestHash: string;
    responseJson: unknown;
    statusCode: number;
  },
) {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const stored = await tx.execute<{ id: string }>(sql`
    INSERT INTO idempotency_keys (
      org_id,
      key,
      route,
      request_hash,
      response_json,
      status_code,
      expires_at
    )
    VALUES (
      ${input.orgId},
      ${input.key},
      ${input.route},
      ${input.requestHash},
      ${JSON.stringify(input.responseJson)}::jsonb,
      ${input.statusCode},
      ${expiresAt}
    )
    ON CONFLICT (org_id, key, route)
    DO UPDATE SET
      response_json = EXCLUDED.response_json,
      status_code = EXCLUDED.status_code,
      expires_at = EXCLUDED.expires_at
    WHERE idempotency_keys.request_hash = EXCLUDED.request_hash
    RETURNING id
  `);
  if (!stored.rows[0]) {
    throw new ApiError(
      409,
      "conflict",
      "Idempotency-Key was reused with a different request body.",
    );
  }
}

export async function clearPendingIdempotentRequest(
  tx: Tx,
  input: {
    orgId: string;
    key: string;
    route: string;
    requestHash: string;
  },
) {
  await tx.execute(sql`
    DELETE FROM idempotency_keys
    WHERE org_id = ${input.orgId}
      AND key = ${input.key}
      AND route = ${input.route}
      AND request_hash = ${input.requestHash}
      AND response_json IS NULL
      AND status_code IS NULL
  `);
}
