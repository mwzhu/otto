import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server_error";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function apiJson<T>(body: T, init?: ResponseInit) {
  return NextResponse.json(body, init);
}

export function apiError(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "bad_request",
          message: "Request validation failed.",
          issues: error.issues,
        },
      },
      { status: 400 },
    );
  }
  console.error(error);
  return NextResponse.json(
    { error: { code: "server_error", message: "Unexpected server error." } },
    { status: 500 },
  );
}

export async function readJsonWithHash(request: Request) {
  const raw = await request.text();
  const json = raw.length > 0 ? JSON.parse(raw) : {};
  return {
    json,
    hash: createHash("sha256").update(stableStringify(json)).digest("hex"),
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requireIdempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    throw new ApiError(
      400,
      "bad_request",
      "Missing required Idempotency-Key header.",
    );
  }
  if (key.length > 200) {
    throw new ApiError(400, "bad_request", "Idempotency-Key is too long.");
  }
  return key;
}

