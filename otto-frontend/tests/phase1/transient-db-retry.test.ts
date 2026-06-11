import { describe, expect, test } from "vitest";
import {
  isTransientDbError,
  retryTransientDbErrors,
} from "@/lib/db/transient-retry";

// Mimics drizzle's DrizzleQueryError shape: a "Failed query: ..." wrapper with
// the original driver error (carrying the SQLSTATE) as `cause`.
function drizzleWrapped(code: string, message: string) {
  const driverError = Object.assign(new Error(message), { code });
  return new Error("Failed query: insert into \"claims\" ...", {
    cause: driverError,
  });
}

describe("Task 14 — transient DB error classifier", () => {
  test("deadlock victims (40P01) are transient, including wrapped as cause", () => {
    expect(isTransientDbError(drizzleWrapped("40P01", "deadlock detected"))).toBe(
      true,
    );
    expect(
      isTransientDbError(Object.assign(new Error("deadlock detected"), { code: "40P01" })),
    ).toBe(true);
  });

  test("serialization failures (40001) are transient", () => {
    expect(
      isTransientDbError(
        drizzleWrapped("40001", "could not serialize access due to concurrent update"),
      ),
    ).toBe(true);
  });

  test("message-only detection works when the SQLSTATE is stripped", () => {
    expect(isTransientDbError(new Error("deadlock detected"))).toBe(true);
  });

  test("ordinary errors are not transient", () => {
    expect(isTransientDbError(drizzleWrapped("23505", "duplicate key value"))).toBe(
      false,
    );
    expect(isTransientDbError(new Error("column does not exist"))).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError("deadlock detected")).toBe(false);
  });
});

describe("Task 14 — retryTransientDbErrors", () => {
  test("retries a deadlock victim and succeeds", async () => {
    let calls = 0;
    const result = await retryTransientDbErrors(
      async () => {
        calls += 1;
        if (calls < 3) throw drizzleWrapped("40P01", "deadlock detected");
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      retryTransientDbErrors(
        async () => {
          calls += 1;
          throw drizzleWrapped("23505", "duplicate key value");
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow("Failed query");
    expect(calls).toBe(1);
  });

  test("gives up after the attempt budget and rethrows the transient error", async () => {
    let calls = 0;
    await expect(
      retryTransientDbErrors(
        async () => {
          calls += 1;
          throw drizzleWrapped("40P01", "deadlock detected");
        },
        { attempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("Failed query");
    expect(calls).toBe(2);
  });
});
