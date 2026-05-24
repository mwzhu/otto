import { sql } from "drizzle-orm";

export function uuidArraySql(ids: string[]) {
  if (ids.length === 0) return sql`ARRAY[]::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}
