import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { reportEvalScores } from "../evals/report";

const correctionCaseSchema = z
  .object({
    id: z.string().min(1),
    evidence_id: z.string().min(1),
    target_agent: z.enum(["director", "operator", "synthesis", "opportunity"]),
    target_metric: z.string().min(1),
    expected_behavior: z.string().min(1),
    prompt_template_id: z.string().optional(),
    prompt_template_version: z.string().optional(),
    affected_subject_type: z.string().optional(),
    affected_subject_id: z.string().optional(),
    quote: z.string().optional(),
    summary: z.string().optional(),
    created_at: z.string().datetime(),
  })
  .strict();

const correctionFixtureSchema = z
  .object({
    version: z.literal(1),
    description: z.string().min(1),
    cases: z.array(correctionCaseSchema),
  })
  .strict();

describe("workspace correction eval fixtures", () => {
  test("exported correction fixtures are valid regression inputs", () => {
    const fixtureDir = join(process.cwd(), "../evals/corrections");
    const fixtureFiles = existsSync(fixtureDir)
      ? readdirSync(fixtureDir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => join(fixtureDir, name))
      : [];
    const fixtures = fixtureFiles.map((file) =>
      correctionFixtureSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
    );
    const cases = fixtures.flatMap((fixture) => fixture.cases);
    const uniqueIds = new Set(cases.map((item) => item.id));

    reportEvalScores({
      suite: "corrections.workspace-fixtures",
      fixture: "../evals/corrections/*.json",
      cases: cases.length,
      metrics: [
        {
          name: "fixture_schema_validity",
          score: 1,
          minimum: 1,
        },
        {
          name: "unique_case_id_rate",
          score: cases.length === 0 ? 1 : uniqueIds.size / cases.length,
          minimum: 1,
        },
      ],
    });
    expect(uniqueIds.size).toBe(cases.length);
  });
});
