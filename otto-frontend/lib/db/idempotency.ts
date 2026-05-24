import "server-only";

import { and, eq } from "drizzle-orm";
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
  return {
    hit: true,
    responseJson: existing.responseJson,
    statusCode: existing.statusCode ?? 200,
  };
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
  await tx.insert(idempotencyKeys).values({
    orgId: input.orgId,
    key: input.key,
    route: input.route,
    requestHash: input.requestHash,
    responseJson: input.responseJson,
    statusCode: input.statusCode,
    expiresAt,
  });
}

