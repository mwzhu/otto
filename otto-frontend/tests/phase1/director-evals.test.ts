import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicTurnPlan } from "@/lib/interview/director/brain";
import { phraseDirectorTurn } from "@/lib/interview/director/voice";
import type { DirectorInterviewPhase } from "@/lib/schemas/phase1";

type EvalCase = {
  id: string;
  current_phase: DirectorInterviewPhase;
  prior_intent?: string;
  low_info_turn_count?: number;
  last_new_slot_turn_index?: number | null;
  turn_index?: number;
  current_slots?: Record<string, { status: string; confidence: number }>;
  candidate_process_names?: string[];
  utterance: string;
  expected: {
    utterance_type?: string;
    chosen_intent?: string;
    proposed_next_phase?: DirectorInterviewPhase;
    required_processes?: string[];
    required_slot_updates?: string[];
    required_slot_statuses?: Record<string, string>;
    required_claim_fields?: string[];
    required_systems?: string[];
    required_phrase_fragments?: string[];
    required_contradiction_signal?: string;
    forbidden_phrase_fragments?: string[];
    forbidden_intents?: string[];
  };
};

const root = join(process.cwd(), "..");
const fixture = JSON.parse(
  readFileSync(join(root, "evals/director/conversational-smoke.json"), "utf8"),
) as { cases: EvalCase[] };

describe("director conversational smoke evals", () => {
  for (const evalCase of fixture.cases) {
    test(evalCase.id, async () => {
      const priorAnthropic = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const plan = deterministicTurnPlan({
          latestUtterance: evalCase.utterance,
          evidenceIds: ["00000000-0000-0000-0000-000000000001"],
          currentSlots: new Map(Object.entries(evalCase.current_slots ?? {})),
          currentPhase: evalCase.current_phase,
          candidateProcessNames: evalCase.candidate_process_names ?? [],
          priorIntent: evalCase.prior_intent,
          lowInfoTurnCount: evalCase.low_info_turn_count,
          lastNewSlotTurnIndex: evalCase.last_new_slot_turn_index,
          turnIndex: evalCase.turn_index,
        });
        const phrase = await phraseDirectorTurn({
          plan,
          recentTurns: [evalCase.utterance],
          coverageSummary: "eval coverage",
          focusProcessName: plan.chosen_intent.target_process,
        });

        if (evalCase.expected.utterance_type) {
          expect(plan.utterance_type).toBe(evalCase.expected.utterance_type);
        }
        if (evalCase.expected.chosen_intent) {
          expect(plan.chosen_intent.intent).toBe(evalCase.expected.chosen_intent);
        }
        if (evalCase.expected.proposed_next_phase) {
          expect(plan.proposed_next_phase).toBe(evalCase.expected.proposed_next_phase);
        }

        const processes = plan.tool_calls
          .filter((tool) => tool.name === "recordProcess")
          .map((tool) => tool.arguments.name);
        for (const expectedProcess of evalCase.expected.required_processes ?? []) {
          expect(processes).toContain(expectedProcess);
        }

        const slotPaths = plan.slot_updates.map((slot) => slot.slot_path);
        for (const expectedSlot of evalCase.expected.required_slot_updates ?? []) {
          expect(slotPaths).toContain(expectedSlot);
        }
        for (const [slotPath, status] of Object.entries(
          evalCase.expected.required_slot_statuses ?? {},
        )) {
          expect(plan.slot_updates.find((slot) => slot.slot_path === slotPath)?.status).toBe(
            status,
          );
        }
        const claimFields = plan.tool_calls
          .filter((tool) => tool.name === "recordCandidateProcessClaim")
          .map((tool) => tool.arguments.field);
        for (const expectedField of evalCase.expected.required_claim_fields ?? []) {
          expect(claimFields).toContain(expectedField);
        }

        const systems = plan.tool_calls
          .filter((tool) => tool.name === "recordSystem")
          .map((tool) => tool.arguments.name);
        for (const expectedSystem of evalCase.expected.required_systems ?? []) {
          expect(systems).toContain(expectedSystem);
        }

        const rankedIntents = plan.ranked_intents.map((intent) => intent.intent);
        for (const forbiddenIntent of evalCase.expected.forbidden_intents ?? []) {
          expect(rankedIntents).not.toContain(forbiddenIntent);
        }

        const normalizedPhrase = phrase.toLowerCase();
        for (const fragment of evalCase.expected.required_phrase_fragments ?? []) {
          expect(normalizedPhrase).toContain(fragment.toLowerCase());
        }
        if (evalCase.expected.required_contradiction_signal) {
          expect(plan.contradiction_signals.join("\n").toLowerCase()).toContain(
            evalCase.expected.required_contradiction_signal.toLowerCase(),
          );
        }
        for (const fragment of evalCase.expected.forbidden_phrase_fragments ?? []) {
          expect(normalizedPhrase).not.toContain(fragment.toLowerCase());
        }
      } finally {
        if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
      }
    });
  }
});
