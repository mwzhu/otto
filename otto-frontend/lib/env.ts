import "server-only";

import { z } from "zod";

const boolEnv = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

export const serverEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  OTTO_DEV_AUTH_BYPASS: boolEnv,
  WORKSPACE_DATA_TIER: z
    .enum(["trial", "customer", "restricted"])
    .default("trial"),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SERVICE_URL: z.string().url().optional(),
  WORKOS_API_KEY: z.string().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),
  WORKOS_REDIRECT_URI: z.string().url().optional(),
  WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  LIVEKIT_AGENT_SERVICE_TOKEN: z.string().optional(),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  LLAMAPARSE_API_KEY: z.string().optional(),
  LLAMAPARSE_API_URL: z.string().url().optional(),
  UNSTRUCTURED_API_KEY: z.string().optional(),
  UNSTRUCTURED_API_URL: z.string().url().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function getServerEnv(): ServerEnv {
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function assertSafeRuntimeEnv(env = getServerEnv()) {
  if (env.NODE_ENV === "production" && env.OTTO_DEV_AUTH_BYPASS) {
    throw new Error(
      "Refusing to start with OTTO_DEV_AUTH_BYPASS=true in production.",
    );
  }
}

export function requireEnv<K extends keyof ServerEnv>(
  key: K,
): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${String(key)}`);
  }
  return value as NonNullable<ServerEnv[K]>;
}
