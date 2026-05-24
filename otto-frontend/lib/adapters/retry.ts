export type RetryableErrorKind =
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

export type RetryOptions = {
  maxAttempts?: number;
  delaysMs?: number[];
  jitterRatio?: number;
  classify?: (error: unknown) => RetryableErrorKind | "fatal";
};

const defaultDelaysMs = [1000, 2000, 4000, 8000, 16000];

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? defaultDelaysMs;
  const maxAttempts = options.maxAttempts ?? delays.length + 1;
  const classify = options.classify ?? defaultClassifier;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1 || classify(error) === "fatal") {
        throw error;
      }
      await sleep(withJitter(delays[Math.min(attempt, delays.length - 1)], options.jitterRatio ?? 0.2));
    }
  }
  throw lastError;
}

export function defaultClassifier(error: unknown): RetryableErrorKind | "fatal" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("rate") || message.includes("429")) return "rate_limit";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("network") || message.includes("fetch")) return "network";
  if (message.includes("500") || message.includes("503")) return "server";
  return "unknown";
}

function withJitter(ms: number, ratio: number) {
  const delta = ms * ratio;
  return Math.max(0, ms - delta + Math.random() * delta * 2);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

