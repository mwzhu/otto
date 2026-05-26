import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, unknown>();

export function readSharedSchemaArtifact<T = unknown>(filename: string): T {
  const cached = cache.get(filename);
  if (cached !== undefined) return cached as T;

  const path = sharedSchemaPath(filename);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as T;
  cache.set(filename, parsed);
  return parsed;
}

function sharedSchemaPath(filename: string) {
  const candidates = [
    join(process.cwd(), "..", "schemas", filename),
    join(process.cwd(), "schemas", filename),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Missing shared schema artifact ${filename}. Tried: ${candidates.join(", ")}`,
    );
  }
  return found;
}
