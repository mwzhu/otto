// Retry for transaction-scoped work that can be killed by Postgres as a
// deadlock victim (SQLSTATE 40P01) or serialization failure (40001). Postgres
// expects callers to retry these; without a retry the director dispatch path
// records a permanently "failed" turn for an error that would succeed on the
// next attempt (see docs/BUG_FIXES.md Task 14). Only use around closures whose
// side effects are entirely inside the transaction, so a rolled-back attempt
// is safe to re-run.

const TRANSIENT_SQLSTATES = new Set(["40P01", "40001"]);
const TRANSIENT_MESSAGE_PATTERN = /deadlock detected|could not serialize access/i;

export function isTransientDbError(error: unknown): boolean {
  let current: unknown = error;
  // drizzle wraps the driver error as `cause` (sometimes nested); walk the
  // chain rather than trusting any one layer to carry the SQLSTATE.
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && TRANSIENT_SQLSTATES.has(code)) {
        return true;
      }
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && TRANSIENT_MESSAGE_PATTERN.test(message)) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

export async function retryTransientDbErrors<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientDbError(error)) throw error;
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * attempt + jitter),
      );
    }
  }
  throw lastError;
}
