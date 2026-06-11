import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { materializeDirectorProcessInventory } from "@/lib/interview/director/brain";
import { isJunkCandidateProcessName } from "@/lib/candidate-processes/name-quality";
import type { DirectorTurnPlan } from "@/lib/schemas/phase1";

// Regression suite for prod session e919bb61 (docs/DIRECTOR_EXTRACTION_QUALITY_PLAN.md):
// the director named six processes; the brain's direct recordProcess tool calls
// bypassed the Task 7 collapse and the plausibility filter, producing 18
// candidates including "Six Big Ones" and "All Of It".

type FixtureCase = {
  id: string;
  comment: string;
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  expected_surviving_names: string[];
  forbidden_surviving_names: string[];
};

const root = join(process.cwd(), "..");
const fixture = JSON.parse(
  readFileSync(
    join(root, "evals/director/extraction-quality-prod-e919bb61.json"),
    "utf8",
  ),
) as {
  cases: FixtureCase[];
  observed_junk_names_all_sessions: string[];
  legitimate_names_all_sessions: string[];
};

function basePlan(overrides: Partial<DirectorTurnPlan>): DirectorTurnPlan {
  const chosenIntent = {
    intent: "discover_processes",
    target_slot: "process.inventory",
    score: 100,
    reason: "Capture the named processes.",
  };
  return {
    utterance_type: "substantive_answer",
    slot_updates: [],
    claims: [],
    tool_calls: [],
    contradiction_signals: [],
    current_phase: "inventory",
    proposed_next_phase: "expand",
    phase_transition_ready: true,
    ranked_intents: [chosenIntent],
    chosen_intent: chosenIntent,
    planned_agent_utterance: "Which one should we map first?",
    ...overrides,
  } satisfies DirectorTurnPlan;
}

function survivingNames(plan: DirectorTurnPlan): string[] {
  return plan.tool_calls
    .filter((tool) => tool.name === "recordProcess")
    .map((tool) => String(tool.arguments.name));
}

describe("prod session e919bb61 replay — direct recordProcess calls funnel through the collapse", () => {
  for (const fixtureCase of fixture.cases) {
    test(fixtureCase.id, () => {
      const plan = materializeDirectorProcessInventory(
        basePlan({ tool_calls: fixtureCase.tool_calls }),
      );
      const names = survivingNames(plan);
      const normalized = names.map((name) => name.toLowerCase());
      for (const expected of fixtureCase.expected_surviving_names) {
        expect(normalized).toContain(expected.toLowerCase());
      }
      for (const forbidden of fixtureCase.forbidden_surviving_names) {
        expect(normalized).not.toContain(forbidden.toLowerCase());
      }
      // Nothing else sneaks through.
      expect(names).toHaveLength(fixtureCase.expected_surviving_names.length);
    });
  }

  test("a plan whose recordProcess calls are all junk strips them instead of passing them through", () => {
    const plan = materializeDirectorProcessInventory(
      basePlan({
        tool_calls: [
          { name: "recordProcess", arguments: { name: "All Of It", confidence: 0.78 } },
          { name: "recordProcess", arguments: { name: "Six Big Ones", confidence: 0.78 } },
        ],
      }),
    );
    expect(survivingNames(plan)).toHaveLength(0);
  });

  test("collapse metadata precedence: an atom's frequency survives onto the compound, evidence is unioned", () => {
    const evidenceA = "00000000-0000-0000-0000-000000000a01";
    const evidenceB = "00000000-0000-0000-0000-000000000a02";
    const evidenceC = "00000000-0000-0000-0000-000000000a03";
    const plan = materializeDirectorProcessInventory(
      basePlan({
        tool_calls: [
          {
            name: "recordProcess",
            arguments: {
              name: "Purchasing And Replenishment",
              confidence: 0.74,
              evidenceIds: [evidenceA],
            },
          },
          {
            name: "recordProcess",
            arguments: {
              name: "Purchasing",
              confidence: 0.95,
              frequency: "weekly POs plus ad hoc when stock runs low",
              evidenceIds: [evidenceB],
            },
          },
          {
            name: "recordProcess",
            arguments: {
              name: "Replenishment",
              confidence: 0.9,
              evidenceIds: [evidenceC],
            },
          },
        ],
      }),
    );
    const tools = plan.tool_calls.filter((tool) => tool.name === "recordProcess");
    expect(tools).toHaveLength(1);
    expect(tools[0].arguments.name).toBe("Purchasing And Replenishment");
    expect(tools[0].arguments.frequency).toBe(
      "weekly POs plus ad hoc when stock runs low",
    );
    expect(tools[0].arguments.evidenceIds).toEqual(
      expect.arrayContaining([evidenceA, evidenceB, evidenceC]),
    );
  });

  test("the survivor's own metadata beats donor metadata", () => {
    const plan = materializeDirectorProcessInventory(
      basePlan({
        tool_calls: [
          {
            name: "recordProcess",
            arguments: {
              name: "Purchasing And Replenishment",
              confidence: 0.74,
              frequency: "weekly",
            },
          },
          {
            name: "recordProcess",
            arguments: {
              name: "Purchasing",
              confidence: 0.95,
              frequency: "daily",
            },
          },
        ],
      }),
    );
    const tools = plan.tool_calls.filter((tool) => tool.name === "recordProcess");
    expect(tools).toHaveLength(1);
    expect(tools[0].arguments.frequency).toBe("weekly");
  });
});

describe("junk-name rejection — every junk shape observed across prod sessions", () => {
  for (const junk of fixture.observed_junk_names_all_sessions) {
    test(`rejects "${junk}"`, () => {
      expect(isJunkCandidateProcessName(junk)).toBe(true);
    });
  }
  for (const legit of fixture.legitimate_names_all_sessions) {
    test(`keeps "${legit}"`, () => {
      expect(isJunkCandidateProcessName(legit)).toBe(false);
    });
  }
});
