import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  applyDeterministicFallbackForMockedResult,
  buildPromptCacheBlocks,
  deterministicTurnPlan,
  directorTurnPlanAnthropicToolSchema,
  gateDirectorPhase,
  materializeDirectorProcessInventory,
  mergeDeterministicExtractions,
  preflightDirectorPlanEvidence,
  selectPhaseGatedDirectorIntent,
} from "@/lib/interview/director/brain";
import {
  completeJsonStringField,
  structured,
  StructuredOutputError,
} from "@/lib/adapters/llm";
import { embedBatch, embedTextWithMetadata } from "@/lib/adapters/vector";
import {
  anthropicMaxTokensForPrompt,
  anthropicModelForPrompt,
  anthropicPricingForModel,
} from "@/lib/ai/models";
import {
  allowedDirectorClaimSubjects,
  validateDirectorPlanClaim,
} from "@/lib/interview/director/claim-allowlist";
import {
  limitToSingleQuestion,
  phraseDirectorTurn,
  phraseProbe,
} from "@/lib/interview/director/voice";
import {
  directorTurnPlanSchema,
  phase1ClaimSchema,
  phase1SlotStateSchema,
  type DirectorTurnPlan,
} from "@/lib/schemas/phase1";
import {
  assertDirectorSlotPath,
  directorSlotDefinitions,
} from "@/lib/interview/director/slot-schema";
import { loadDirectorProbeLibrary, probeLibrary } from "@/lib/interview/director/probe-library";
import {
  buildDocumentExtractionStaticInput,
  chunkDocument,
  extractDocumentInventory,
} from "@/lib/documents/pipeline";

const root = process.cwd();

describe("Week 3 director brain and document pipeline", () => {
  test("prompt cache assembly keeps static and dynamic blocks separate", () => {
    const blocks = buildPromptCacheBlocks({
      currentSlots: new Map([["scope.boundaries", { status: "empty", confidence: 0 }]]),
      recentTurns: ["We run promotion management weekly."],
      latestUtterance: "Salesforce and Google Sheets are involved.",
      candidateProcesses: [
        {
          id: "00000000-0000-0000-0000-000000000101",
          proposedName: "Quote Approvals",
        },
      ],
    });

    expect(blocks.staticBlock).toContain("Probe library");
    expect(blocks.staticBlock).toContain(directorSlotDefinitions[0].path);
    expect(blocks.staticBlock).not.toContain("Salesforce and Google Sheets");
    expect(blocks.dynamicBlock).toContain("Salesforce and Google Sheets");
    expect(blocks.dynamicBlock).toContain("scope.boundaries: empty");
    expect(blocks.dynamicBlock).toContain("00000000-0000-0000-0000-000000000101: Quote Approvals");
  });

  test("director cacheable static prompt blocks stay separate from compact document prompts", () => {
    const blocks = buildPromptCacheBlocks({
      currentSlots: new Map(),
      recentTurns: [],
      latestUtterance: "test",
    });
    expect(blocks.staticBlock.length).toBeGreaterThan(4096);
    expect(buildDocumentExtractionStaticInput().length).toBeLessThan(1800);
    expect(buildDocumentExtractionStaticInput()).not.toContain("Document inventory JSON schema");
  });

  test("observability dashboard avoids sparse-data and fan-out alert noise", () => {
    const observability = read("lib/admin/observability-queries.ts");

    expect(observability).toContain("inactiveMetric({");
    expect(observability).toContain("No cache-observed decisions");
    expect(observability).toContain("No synthesis runs");
    expect(observability).toContain("WITH stage_counts AS");
    expect(observability).toContain("stage_runs AS");
    expect(observability).toContain("run_costs AS");
    expect(observability).not.toContain("LEFT JOIN agent_decision_log adl");
    expect(observability).toContain("stage_name IN ('director.turn', 'operator.turn')");
    expect(observability).toContain(
      "AND stage_name IN ('director.extraction', 'operator.extraction')",
    );
    expect(observability).not.toContain("stage_name ILIKE '%extract%'");
    expect(observability).toContain("extraction_observed");
    expect(observability).toContain(
      "stage_name = 're_extract_degraded_turns.recovered'",
    );
    expect(observability).toContain("recovered.source_decision_log_id IS NULL");
    expect(observability).toContain("now() - interval '7 days'");
  });

  test("streaming planner waits for the complete planned utterance string", () => {
    const partial =
      '{"chosen_intent":{"intent":"discover_processes"},"planned_agent_utterance":"Thanks, wh';
    const complete = `${partial}ich recurring processes should we list first?","slot_updates":[]}`;

    expect(completeJsonStringField(partial, "planned_agent_utterance")).toBeNull();
    expect(completeJsonStringField(complete, "planned_agent_utterance")).toBe(
      "Thanks, which recurring processes should we list first?",
    );
  });

  test("director turn tool schema orders live utterance before bookkeeping arrays", () => {
    const jsonSchema = JSON.parse(read("../schemas/director-turn-plan.schema.json"));
    const propertyOrder = Object.keys(jsonSchema.properties);

    expect(propertyOrder.indexOf("chosen_intent")).toBeLessThan(
      propertyOrder.indexOf("slot_updates"),
    );
    expect(propertyOrder.indexOf("planned_agent_utterance")).toBeLessThan(
      propertyOrder.indexOf("slot_updates"),
    );
  });

  test("director respond SSE route flushes before phrasing", () => {
    const route = read("app/api/internal/director-turns/respond/route.ts");
    const readyIndex = route.indexOf('send?.("ready", { status: "responding" })');
    const phraseIndex = route.indexOf("await phraseDirectorSteeringTurn");

    expect(readyIndex).toBeGreaterThan(-1);
    expect(phraseIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeLessThan(phraseIndex);
  });

  test("director plan prompt carries live voice quality guidance", () => {
    const blocks = buildPromptCacheBlocks({
      currentSlots: new Map(),
      recentTurns: [],
      latestUtterance: "test",
    });

    expect(blocks.staticBlock).toContain("warm but efficient operations consultant");
    expect(blocks.staticBlock).toContain("Do not sound like a survey");
    expect(blocks.staticBlock).toContain("choose chosen_intent and planned_agent_utterance first");
  });

  test("director slot schema rejects model-invented slot paths", () => {
    expect(() => assertDirectorSlotPath("outcomes.business_outcomes")).not.toThrow();
    expect(() => assertDirectorSlotPath("outcomes.business")).toThrow(
      "Unknown director slot path",
    );
  });

  test("director fallback orients on greetings instead of repeating process boundary probes", () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "hello",
      evidenceIds: ["00000000-0000-0000-0000-000000000001"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });

    expect(plan.utterance_type).toBe("greeting");
    expect(plan.chosen_intent.intent).toBe("discover_function");
    expect(plan.chosen_intent.target_slot).toBe("function.name");
    expect(plan.tool_calls).toHaveLength(0);
  });

  test("director fallback answers meta questions with orientation intent", () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "what are we going to do",
      evidenceIds: ["00000000-0000-0000-0000-000000000002"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });

    expect(plan.utterance_type).toBe("meta_question");
    expect(plan.chosen_intent.intent).toBe("discover_function");
    expect(plan.chosen_intent.target_slot).toBe("function.name");
  });

  test("director fallback treats voice-call audio checks as meta turns", () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "can you hear me?",
      evidenceIds: ["00000000-0000-0000-0000-000000000003"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });

    expect(plan.utterance_type).toBe("meta_question");
    expect(plan.chosen_intent.intent).toBe("discover_function");
    expect(plan.tool_calls).toHaveLength(0);
  });

  test("director fallback extracts finance inventory from voice continuation phrasing", () => {
    const plan = (latestUtterance: string) =>
      deterministicTurnPlan({
        latestUtterance,
        evidenceIds: ["00000000-0000-0000-0000-000000000004"],
        currentSlots: new Map(),
        currentPhase: "orient",
        candidateProcessNames: [],
      });
    const firstPlan = plan(
      "Okay. Cool. Own the finance department. We're in charge of payroll. And cost management. As well as other, like, closing books.",
    );
    const secondPlan = plan(
      "Great. I own the finance department. We're in charge of payroll management. Cost management, and also closing the books.",
    );
    const latestDogfoodPlan = plan(
      "Great. I am the finance department. We're in charge of a couple different things. Like payroll management, cost management, and closing books.",
    );

    expect(firstPlan.slot_updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot_path: "function.name",
          value: { function_name: "The Finance Department" },
        }),
        expect.objectContaining({
          slot_path: "process.inventory",
          value: { processes: ["Payroll", "Cost Management", "Closing Books"] },
        }),
      ]),
    );
    expect(firstPlan.tool_calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "recordProcess", arguments: expect.objectContaining({ name: "Payroll" }) }),
        expect.objectContaining({ name: "recordProcess", arguments: expect.objectContaining({ name: "Cost Management" }) }),
        expect.objectContaining({ name: "recordProcess", arguments: expect.objectContaining({ name: "Closing Books" }) }),
      ]),
    );
    expect(secondPlan.slot_updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot_path: "process.inventory",
          value: {
            processes: [
              "Payroll Management",
              "Cost Management",
              "Closing Books",
            ],
          },
        }),
      ]),
    );
    expect(latestDogfoodPlan.slot_updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot_path: "process.inventory",
          value: {
            processes: [
              "Payroll Management",
              "Cost Management",
              "Closing Books",
            ],
          },
        }),
      ]),
    );
    expect(latestDogfoodPlan.tool_calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "recordProcess",
          arguments: expect.objectContaining({ name: "A Couple Different Things" }),
        }),
      ]),
    );
  });

  test("director fallback answers meta questions without resetting the interview phase", async () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "how long is this going to take?",
      evidenceIds: ["00000000-0000-0000-0000-000000000004"],
      currentSlots: new Map([
        ["function.name", { status: "filled", confidence: 0.8 }],
        ["process.inventory", { status: "filled", confidence: 0.8 }],
      ]),
      currentPhase: "expand",
      candidateProcessNames: ["Quote Approvals"],
    });
    const phrase = await phraseDirectorTurn({
      plan,
      recentTurns: [],
      coverageSummary: "",
      focusProcessName: "Quote Approvals",
    });

    expect(plan.utterance_type).toBe("meta_question");
    expect(plan.chosen_intent.intent).toBe("define_process_boundary");
    expect(plan.chosen_intent.target_process).toBe("Quote Approvals");
    expect(phrase.toLowerCase()).toContain("where does the process begin and end");
    expect(phrase.toLowerCase()).not.toContain("what part of the business");
  });

  test("director fallback voice honors last-attempt escalation hints", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const phrase = await phraseDirectorTurn({
        plan: {
          utterance_type: "substantive_answer",
          slot_updates: [],
          claims: [],
          tool_calls: [],
          contradiction_signals: [],
          current_phase: "expand",
          proposed_next_phase: "expand",
          phase_transition_ready: false,
          ranked_intents: [],
          chosen_intent: {
            intent: "define_process_boundary",
            target_slot: "scope.boundaries",
            score: 100,
            reason: "Boundary is still unresolved.",
            style_hint: "last_attempt",
          },
          planned_agent_utterance:
            "Last try on this one before I mark it as unknown: where does the process begin and end?",
        },
        recentTurns: ["I'm not sure."],
        coverageSummary: "scope.boundaries partial",
      });

      expect(phrase.toLowerCase()).toContain("last try");
      expect(phrase.toLowerCase()).toContain("mark it as unknown");
    } finally {
      if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
    }
  });

  test("director voice phrasing clamps bundled questions to one spoken ask", async () => {
    expect(
      limitToSingleQuestion(
        "Got it. For quote approvals, what outcome is that process responsible for, and where does it start? Who signs off?",
      ),
    ).toBe("Got it. For quote approvals, what outcome is that process responsible for?");

    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const phrase = await phraseDirectorTurn({
        plan: {
          utterance_type: "substantive_answer",
          slot_updates: [],
          claims: [],
          tool_calls: [],
          contradiction_signals: [],
          current_phase: "expand",
          proposed_next_phase: "expand",
          phase_transition_ready: false,
          ranked_intents: [],
          chosen_intent: {
            intent: "capture_owner_roles",
            target_slot: "ownership.roles",
            target_process: "quote approvals",
            score: 100,
            reason: "Owner is still unresolved.",
          },
          planned_agent_utterance: "Who is accountable for quote approvals?",
        },
        recentTurns: ["Quote approvals start in Slack."],
        coverageSummary: "ownership.roles empty",
      });

      expect(phrase).toBe("Who is accountable for quote approvals?");
      expect((phrase.match(/\?/g) ?? [])).toHaveLength(1);
    } finally {
      if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
    }
  });

  test("director probe artifacts teach one question at a time", () => {
    const compoundAsk =
      /\band\s+(?:what|who|which|where|how|when|why|is|are|does|do|can|could|would|should)\b[^?]*\?/i;
    for (const probe of probeLibrary) {
      expect(probe.phrasing, probe.probeId).not.toMatch(compoundAsk);
      expect(probe.phrasing.match(/\?/g) ?? [], probe.probeId).toHaveLength(1);
    }

    expect(
      phraseProbe({
        ...probeLibrary[0],
        phrasing:
          "For quote approvals, what outcome is that process responsible for, and where does it start?",
      }),
    ).toBe("For quote approvals, what outcome is that process responsible for?");

    const yaml = read("../probes/director.yaml");
    for (const line of yaml.split("\n").filter((value) => value.trim().startsWith("- "))) {
      if (!line.includes("?")) continue;
      expect(line, "YAML probe phrasing should stay single-question").not.toMatch(compoundAsk);
      expect(line.match(/\?/g) ?? [], "YAML probe phrasing should ask once").toHaveLength(1);
    }
  });

  test("director phase gate blocks premature jumps until required coverage exists", () => {
    const prematurePlan = {
      utterance_type: "substantive_answer",
      slot_updates: [],
      claims: [],
      tool_calls: [],
      contradiction_signals: [],
      current_phase: "orient",
      proposed_next_phase: "closeout",
      phase_transition_ready: true,
      ranked_intents: [],
      chosen_intent: {
        intent: "playback_summary",
        score: 100,
        reason: "Model tried to close early.",
      },
      planned_agent_utterance: "Before we wrap, what have we missed?",
    } satisfies DirectorTurnPlan;

    expect(gateDirectorPhase(prematurePlan, new Map(), [], [])).toBe("orient");
    expect(
      selectPhaseGatedDirectorIntent(
        "orient",
        new Map(),
        [],
        [],
        prematurePlan.ranked_intents,
        prematurePlan.chosen_intent,
      ).chosenIntent.intent,
    ).toBe("discover_function");
    expect(
      gateDirectorPhase(
        prematurePlan,
        new Map([["function.name", { status: "partial", confidence: 0.7 }]]),
        [],
        [],
      ),
    ).toBe("inventory");
    expect(
      selectPhaseGatedDirectorIntent(
        "inventory",
        new Map([["function.name", { status: "partial", confidence: 0.7 }]]),
        [],
        [],
        prematurePlan.ranked_intents,
        prematurePlan.chosen_intent,
      ).chosenIntent.intent,
    ).toBe("discover_processes");
    expect(
      gateDirectorPhase(
        prematurePlan,
        new Map([
          ["function.name", { status: "filled", confidence: 0.8 }],
          ["process.inventory", { status: "filled", confidence: 0.8 }],
        ]),
        [{ id: "candidate-1", proposedName: "Forecasting" }],
        [],
      ),
    ).toBe("expand");
    expect(
      selectPhaseGatedDirectorIntent(
        "expand",
        new Map([
          ["function.name", { status: "filled", confidence: 0.8 }],
          ["process.inventory", { status: "filled", confidence: 0.8 }],
        ]),
        [{ id: "candidate-1", proposedName: "Forecasting" }],
        [],
        prematurePlan.ranked_intents,
        prematurePlan.chosen_intent,
      ).chosenIntent.intent,
    ).toBe("define_process_boundary");
    expect(
      gateDirectorPhase(
        prematurePlan,
        new Map([
          ["function.name", { status: "filled", confidence: 0.8 }],
          ["process.inventory", { status: "filled", confidence: 0.8 }],
          ["scope.boundaries", { status: "asked_unknown", confidence: 1 }],
          ["ownership.roles", { status: "filled", confidence: 0.8 }],
          ["systems.systems_of_record", { status: "filled", confidence: 0.8 }],
        ]),
        [{ id: "candidate-1", proposedName: "Forecasting" }],
        [],
      ),
    ).toBe("closeout");
  });

  test("director forced closeout emits follow-up tasks for unresolved priority slots", () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "yeah",
      evidenceIds: ["00000000-0000-0000-0000-000000000012"],
      currentSlots: new Map([
        ["function.name", { status: "filled", confidence: 0.8 }],
        ["process.inventory", { status: "filled", confidence: 0.8 }],
        ["scope.boundaries", { status: "filled", confidence: 0.8 }],
        ["ownership.roles", { status: "filled", confidence: 0.8 }],
        ["systems.systems_of_record", { status: "filled", confidence: 0.8 }],
      ]),
      currentPhase: "enrich",
      candidateProcessNames: ["Quote Approvals"],
      lowInfoTurnCount: 2,
      lastNewSlotTurnIndex: 5,
      turnIndex: 8,
    });

    const followUpSlots = plan.tool_calls
      .filter((tool) => tool.name === "createFollowUpTask")
      .map((tool) => tool.arguments.targetSlot);

    expect(plan.proposed_next_phase).toBe("closeout");
    expect(plan.chosen_intent.style_hint).toBe("forced_closeout");
    expect(followUpSlots).toEqual([
      "outcomes.business_outcomes",
      "people.key_people",
    ]);
  });

  test("director fallback broadens repeated low-information prompts before closeout", async () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "yeah",
      evidenceIds: ["00000000-0000-0000-0000-000000000013"],
      currentSlots: new Map([
        ["function.name", { status: "filled", confidence: 0.8 }],
      ]),
      currentPhase: "inventory",
      candidateProcessNames: [],
      lowInfoTurnCount: 1,
    });
    const phrase = await phraseDirectorTurn({
      plan,
      recentTurns: [],
      coverageSummary: "",
    });

    expect(plan.utterance_type).toBe("non_answer");
    expect(plan.chosen_intent.style_hint).toContain("broaden_low_info");
    expect(phrase.toLowerCase()).toContain("normal week");
  });

  test("director forced closeout ignores duplicate slot updates as new coverage", () => {
    const plan = deterministicTurnPlan({
      latestUtterance: "I run revenue operations.",
      evidenceIds: ["00000000-0000-0000-0000-000000000014"],
      currentSlots: new Map([
        ["function.name", { status: "filled", confidence: 0.8 }],
      ]),
      currentPhase: "inventory",
      candidateProcessNames: [],
      lowInfoTurnCount: 0,
      lastNewSlotTurnIndex: 5,
      turnIndex: 8,
    });

    expect(plan.proposed_next_phase).toBe("closeout");
    expect(plan.chosen_intent.intent).toBe("open_questions_closeout");
    expect(plan.chosen_intent.style_hint).toBe("forced_closeout");
    expect(plan.chosen_intent.reason).toContain("without new slot coverage");
  });

  test("director fallback extracts a multi-process revops inventory", () => {
    const plan = deterministicTurnPlan({
      latestUtterance:
        "I oversee revenue operations. We own forecasting, territory planning, quote approvals, and sales comp.",
      evidenceIds: ["00000000-0000-0000-0000-000000000003"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });

    const processNames = plan.tool_calls
      .filter((tool) => tool.name === "recordProcess")
      .map((tool) => tool.arguments.name);

    expect(plan.proposed_next_phase).toBe("expand");
    expect(processNames).toEqual([
      "Forecasting",
      "Territory Planning",
      "Quote Approvals",
      "Sales Comp",
    ]);
    expect(plan.chosen_intent.intent).toBe("select_process_to_expand");
  });

  test("director fallback targets volunteered pain to the painful process", () => {
    const plan = deterministicTurnPlan({
      latestUtterance:
        "I run rev ops. We own forecasting, territory planning, quote approvals, and sales comp. Forecasting is weekly in Salesforce. Quote approvals are painful because finance gets pulled in late.",
      evidenceIds: ["00000000-0000-0000-0000-000000000033"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });

    const painTool = plan.tool_calls.find((tool) => tool.name === "recordPainPoint");
    const dependencyClaimTool = plan.tool_calls.find(
      (tool) =>
        tool.name === "recordCandidateProcessClaim" &&
        tool.arguments.field === "upstream_dependency",
    );

    expect(painTool?.arguments.targetProcess).toBe("Quote Approvals");
    expect(dependencyClaimTool?.arguments.targetProcess).toBe("Quote Approvals");
    expect(dependencyClaimTool?.arguments.value).toEqual({ name: "finance" });
    expect(plan.chosen_intent.target_process).toBe("Quote Approvals");
  });

  test("director fallback treats payroll step narration as process detail, not new processes", () => {
    const plan = deterministicTurnPlan({
      latestUtterance:
        "Yeah. So it's successful payroll end to end. Looks like we first begin by looking at Google Sheets, and then we move data to we reconciled with the make sure all the salaries are right for our employees on NetSuite, and then we send off to Sarah does a final check, and then we we finish.",
      evidenceIds: ["00000000-0000-0000-0000-000000000034"],
      currentSlots: new Map([
        ["function.name", { status: "filled", confidence: 0.97 }],
        ["process.inventory", { status: "partial", confidence: 0.95 }],
      ]),
      currentPhase: "expand",
      candidateProcessNames: ["AP", "closing books", "payroll"],
      priorIntent: "select_process_to_expand",
    });

    const processNames = plan.tool_calls
      .filter((tool) => tool.name === "recordProcess")
      .map((tool) => tool.arguments.name);
    const systemNames = plan.tool_calls
      .filter((tool) => tool.name === "recordSystem")
      .map((tool) => tool.arguments.name);

    expect(processNames).toEqual([]);
    expect(systemNames).toEqual(["NetSuite", "Google Sheets"]);
    expect(plan.chosen_intent.target_process).toBe("payroll");
    expect(
      plan.slot_updates.find((slot) => slot.slot_path === "process.inventory"),
    ).toBeUndefined();
  });

  test("director deterministic merge does not resurrect step narration as recordProcess", () => {
    const deterministicPlan = deterministicTurnPlan({
      latestUtterance:
        "Looks like we first begin by looking at Google Sheets, and then we move data to NetSuite, and then we send off to Sarah for a final check.",
      evidenceIds: ["00000000-0000-0000-0000-000000000035"],
      currentSlots: new Map(),
      currentPhase: "expand",
      candidateProcessNames: ["payroll"],
    });
    const sparseLlmPlan = {
      ...deterministicPlan,
      tool_calls: [
        {
          name: "recordProcess",
          arguments: {
            name: "Then We Send Off To Sarah For A Final Check",
          },
        },
      ],
    } satisfies DirectorTurnPlan;

    const merged = mergeDeterministicExtractions(sparseLlmPlan, deterministicPlan);
    const processNames = merged.tool_calls
      .filter((tool) => tool.name === "recordProcess")
      .map((tool) => tool.arguments.name);

    expect(processNames).toEqual([]);
  });

  test("director deterministic extraction only merges when structured output is mocked", () => {
    const deterministicPlan = deterministicTurnPlan({
      latestUtterance:
        "I run finance. We own AP, payroll, and closing books.",
      evidenceIds: ["00000000-0000-0000-0000-000000000036"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });
    const authoritativeLlmPlan = {
      ...deterministicPlan,
      slot_updates: [],
      tool_calls: [],
    } satisfies DirectorTurnPlan;

    expect(
      applyDeterministicFallbackForMockedResult(
        authoritativeLlmPlan,
        deterministicPlan,
        { mocked: false },
      ).tool_calls,
    ).toEqual([]);
    expect(
      applyDeterministicFallbackForMockedResult(
        authoritativeLlmPlan,
        deterministicPlan,
        { mocked: true },
      ).tool_calls.map((tool) => tool.name),
    ).toContain("recordProcess");
  });

  test("director LLM process inventory materializes candidate process tools", () => {
    const chosenIntent = {
      intent: "discover_processes",
      target_slot: "process.inventory",
      score: 100,
      reason: "Capture the named processes.",
    };
    const plan = materializeDirectorProcessInventory({
      utterance_type: "substantive_answer",
      slot_updates: [
        {
          slot_path: "function.name",
          status: "filled",
          confidence: 0.91,
          evidence_ids: ["00000000-0000-0000-0000-000000000037"],
          priority: 100,
          value: { name: "finance" },
        },
        {
          slot_path: "process.inventory",
          status: "filled",
          confidence: 0.88,
          evidence_ids: ["00000000-0000-0000-0000-000000000037"],
          priority: 90,
          value: {
            processes: [
              "Accounts Payable (AP)",
              "Payroll",
              "Cost Optimization",
            ],
          },
        },
      ],
      claims: [],
      tool_calls: [
        {
          name: "recordCandidateProcessClaim",
          arguments: {
            targetProcess: "Accounts Payable (AP)",
            field: "proposed_name",
            value: "Accounts Payable (AP)",
            confidence: 0.88,
          },
        },
      ],
      contradiction_signals: [],
      current_phase: "orient",
      proposed_next_phase: "expand",
      phase_transition_ready: true,
      ranked_intents: [chosenIntent],
      chosen_intent: chosenIntent,
      planned_agent_utterance: "Which one should we expand first?",
    } satisfies DirectorTurnPlan);

    expect(
      plan.tool_calls
        .filter((tool) => tool.name === "recordProcess")
        .map((tool) => tool.arguments),
    ).toEqual([
      {
        name: "Accounts Payable (AP)",
        confidence: 0.88,
        proposedFunction: "finance",
      },
      { name: "Payroll", confidence: 0.88, proposedFunction: "finance" },
      {
        name: "Cost Optimization",
        confidence: 0.88,
        proposedFunction: "finance",
      },
    ]);
    expect(plan.tool_calls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "recordCandidateProcessClaim",
          arguments: expect.objectContaining({ field: "proposed_name" }),
        }),
      ]),
    );
  });

  test("mocked director structured output can use deterministic factual fallback", () => {
    const deterministicPlan = deterministicTurnPlan({
      latestUtterance:
        "I run revenue operations. My team owns forecasting, territory changes, quote approvals, and weekly pipeline inspection. Sales, finance, and legal are involved, mostly in Salesforce, Clari, and Slack.",
      evidenceIds: ["00000000-0000-0000-0000-000000000004"],
      currentSlots: new Map(),
      currentPhase: "orient",
      candidateProcessNames: [],
    });
    const sparseMockPlan = {
      ...deterministicPlan,
      slot_updates: [
        {
          slot_path: "scope.boundaries",
          status: "pending_re_extract",
          confidence: 0,
          evidence_ids: ["00000000-0000-0000-0000-000000000004"],
          priority: 100,
        },
      ],
      tool_calls: [],
      chosen_intent: {
        intent: "discover_function",
        target_slot: "function.name",
        score: 100,
        reason: "Ask about remit.",
      },
    } satisfies DirectorTurnPlan;

    const merged = applyDeterministicFallbackForMockedResult(
      sparseMockPlan,
      deterministicPlan,
      { mocked: true },
    );
    const slotPaths = merged.slot_updates.map((slot) => slot.slot_path);
    const processNames = merged.tool_calls
      .filter((tool) => tool.name === "recordProcess")
      .map((tool) => tool.arguments.name);
    const systemNames = merged.tool_calls
      .filter((tool) => tool.name === "recordSystem")
      .map((tool) => tool.arguments.name);
    const ownership = merged.slot_updates.find(
      (slot) => slot.slot_path === "ownership.roles",
    )?.value;

    expect(slotPaths).toContain("function.name");
    expect(slotPaths).toContain("process.inventory");
    expect(slotPaths).toContain("systems.systems_of_record");
    expect(processNames).toEqual([
      "Forecasting",
      "Territory Changes",
      "Quote Approvals",
      "Weekly Pipeline Inspection",
    ]);
    expect(systemNames).toEqual(["Salesforce", "Clari", "Slack"]);
    expect(ownership).toEqual({ roles: ["Sales", "Finance", "Legal"] });
  });

  test("director turn plan schema requires explicit JSON-schema fields", () => {
    const chosenIntent = {
      intent: "discover_function",
      target_slot: "function.name",
      score: 100,
      reason: "Start with remit.",
    };

    expect(
      directorTurnPlanSchema.safeParse({
        utterance_type: "greeting",
        current_phase: "orient",
        proposed_next_phase: "orient",
        chosen_intent: chosenIntent,
      }).success,
    ).toBe(false);
    expect(
      directorTurnPlanSchema.safeParse({
        utterance_type: "greeting",
        slot_updates: [],
        claims: [],
        tool_calls: [{ name: "recordProcess" }],
        contradiction_signals: [],
        current_phase: "orient",
        proposed_next_phase: "orient",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
      }).success,
    ).toBe(false);
    expect(
      directorTurnPlanSchema.safeParse({
        utterance_type: "greeting",
        slot_updates: [],
        claims: [],
        tool_calls: [
          {
            name: "recordProcess",
            arguments: { name: "Forecasting" },
            uncontracted_field: true,
          },
        ],
        contradiction_signals: [],
        current_phase: "orient",
        proposed_next_phase: "orient",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
      }).success,
    ).toBe(false);
    expect(
      directorTurnPlanSchema.safeParse({
        utterance_type: "greeting",
        slot_updates: [
          {
            slot_path: "function.name",
            status: "filled",
            confidence: 0.8,
            priority: 100,
          },
        ],
        claims: [],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "orient",
        proposed_next_phase: "orient",
        phase_transition_ready: false,
        ranked_intents: [chosenIntent],
        chosen_intent: chosenIntent,
      }).success,
    ).toBe(false);
    const jsonSchema = JSON.parse(read("../schemas/director-turn-plan.schema.json"));
    expect(jsonSchema.properties.tool_calls.items.additionalProperties).toBe(false);
  });

  test("director dispatch evidence preflight keeps assertions tied to the current turn", () => {
    const currentEvidence = "00000000-0000-0000-0000-000000000011";
    const staleEvidence = "00000000-0000-0000-0000-000000000099";
    const baseIntent = {
      intent: "capture_metrics",
      target_slot: "metrics.kpis",
      score: 100,
      reason: "Metric is missing.",
    };
    const result = preflightDirectorPlanEvidence(
      {
        utterance_type: "substantive_answer",
        slot_updates: [
          {
            slot_path: "metrics.kpis",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [currentEvidence],
            priority: 90,
            value: { metric: "forecast accuracy" },
          },
          {
            slot_path: "systems.systems_of_record",
            status: "filled",
            confidence: 0.8,
            evidence_ids: [staleEvidence],
            priority: 100,
            value: { systems: ["Salesforce"] },
          },
        ],
        claims: [
          {
            subject_type: "candidate_process",
            subject_id: "00000000-0000-0000-0000-000000000101",
            field: "kpi",
            value: { name: "forecast accuracy" },
            confidence: 0.8,
            evidence_ids: [currentEvidence],
          },
          {
            subject_type: "candidate_process",
            subject_id: "00000000-0000-0000-0000-000000000101",
            field: "upstream_dependency",
            value: { name: "finance input" },
            confidence: 0.8,
            evidence_ids: [],
          },
        ],
        tool_calls: [],
        contradiction_signals: [],
        current_phase: "enrich",
        proposed_next_phase: "enrich",
        phase_transition_ready: false,
        ranked_intents: [baseIntent],
        chosen_intent: baseIntent,
        planned_agent_utterance: "What metric should we use here?",
      },
      [currentEvidence],
    );

    expect(result.plan.slot_updates.map((slot) => slot.slot_path)).toEqual(["metrics.kpis"]);
    expect(result.plan.claims.map((claim) => claim.field)).toEqual(["kpi"]);
    expect(result.invalid).toEqual([
      expect.objectContaining({
        kind: "slot_update",
        target: "systems.systems_of_record",
      }),
      expect.objectContaining({
        kind: "claim",
        target: "candidate_process.upstream_dependency",
      }),
    ]);
  });

  test("director TypeScript brain sends an inlined Anthropic tool schema", () => {
    const toolSchema = directorTurnPlanAnthropicToolSchema();
    const serialized = JSON.stringify(toolSchema);

    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("$schema");
    expect(toolSchema).toMatchObject({
      title: "DirectorTurnPlan",
      additionalProperties: false,
    });
    expect(toolSchema.required).toContain("planned_agent_utterance");
    expect(
      ((toolSchema.properties as Record<string, unknown>).tool_calls as {
        items: { additionalProperties: boolean };
      }).items.additionalProperties,
    ).toBe(false);
    expect(serialized).toContain('"function.name"');
    expect(serialized).toContain('"process.inventory"');
    expect(serialized).toContain('"select_process_to_expand"');
  });

  test("director TypeScript schemas stay aligned with shared JSON Schema artifacts", () => {
    const directorJson = JSON.parse(read("../schemas/director-turn-plan.schema.json"));
    const slotJson = JSON.parse(read("../schemas/slot-state.schema.json"));
    const claimJson = JSON.parse(read("../schemas/claim.schema.json"));
    const directorZodJson = z.toJSONSchema(directorTurnPlanSchema);
    const slotZodJson = z.toJSONSchema(phase1SlotStateSchema);
    const claimZodJson = z.toJSONSchema(phase1ClaimSchema);

    expect(directorZodJson.required).toEqual(directorJson.required);
    expect(Object.keys(directorZodJson.properties ?? {}).sort()).toEqual(
      Object.keys(directorJson.properties).sort(),
    );
    expect(directorZodJson.additionalProperties).toBe(false);
    expect(
      (directorZodJson.properties as Record<string, { enum?: string[] }>).utterance_type.enum,
    ).toEqual(directorJson.properties.utterance_type.enum);
    expect(
      (directorZodJson.properties as Record<string, { enum?: string[] }>).current_phase.enum,
    ).toEqual(directorJson.properties.current_phase.enum);
    expect(
      (directorZodJson.properties as Record<string, { enum?: string[] }>).proposed_next_phase.enum,
    ).toEqual(directorJson.properties.proposed_next_phase.enum);

    assertObjectSchemaShape(slotZodJson, slotJson);
    assertObjectSchemaShape(claimZodJson, claimJson);
  });

  test("director probes carry controller policy for cooldown and max fires", () => {
    const probeYaml = read("../probes/director.yaml");
    const yamlDocument = parse(probeYaml) as {
      probes: Array<{
        id: string;
        intent: string;
        target_slots: string[];
        cooldown_seconds: number;
        max_fires: number;
        expected_shape: string;
        base_priority: number;
        phrasings: string[];
      }>;
    };
    const expected = yamlDocument.probes.map((probe) => ({
      probeId: probe.id,
      targetSlot: probe.target_slots[0],
      intent: probe.intent,
      phrasing: probe.phrasings[0],
      score: probe.base_priority,
      reason: probe.expected_shape,
      cooldownSeconds: probe.cooldown_seconds,
      maxFires: probe.max_fires,
      expectedShape: probe.expected_shape,
    }));

    expect(loadDirectorProbeLibrary()).toEqual(expected);
    expect(probeLibrary).toEqual(expected);
    expect(probeLibrary.length).toBeGreaterThan(10);
    expect(
      probeLibrary.every(
        (probe) =>
          probe.intent &&
          probe.cooldownSeconds > 0 &&
          probe.maxFires > 0 &&
          probe.expectedShape,
      ),
    ).toBe(true);
    expect(probeYaml).toContain("version: 1");
    for (const probe of probeLibrary) {
      expect(probeYaml).toContain(`id: ${probe.probeId}`);
      expect(probeYaml).toContain(`intent: ${probe.intent}`);
      expect(probeYaml).toContain(`cooldown_seconds: ${probe.cooldownSeconds}`);
      expect(probeYaml).toContain(`max_fires: ${probe.maxFires}`);
    }
  });

  test("director prompt artifacts match logged template ids", () => {
    const brainPrompt = read("../prompts/director.turn.plan.md");
    const voicePrompt = read("../prompts/director.voice.phrase-intent.md");

    expect(brainPrompt).toContain("template_id: director.turn.plan");
    expect(brainPrompt).toContain('template_version: "1"');
    expect(brainPrompt).toContain("schemas/director-turn-plan.schema.json");
    expect(brainPrompt).toContain("probes/director.yaml");
    expect(brainPrompt).toContain("`candidate_process` subjects only");
    expect(brainPrompt).toContain("Do not write claims against canonical");
    expect(brainPrompt).toContain("recordCandidateProcessClaim");
    expect(voicePrompt).toContain("template_id: director.voice.phrase-intent");
    expect(voicePrompt).toContain('template_version: "1"');
  });

  test("director claim allowlist is loaded from the shared schema artifact", () => {
    const allowlist = JSON.parse(read("../schemas/claim-subject-fields.json")) as {
      allowed: Array<{ subject_type: string; fields: Array<{ field: string }> }>;
    };

    expect(allowlist.allowed.length).toBeGreaterThan(3);
    expect(allowedDirectorClaimSubjects()).toContainEqual(
      expect.objectContaining({
        subject_type: "candidate_process",
        fields: expect.arrayContaining([
          "business_outcome",
          "kpi",
          "upstream_dependency",
          "downstream_dependency",
          "handoff",
          "process_relationship",
          "control",
          "exec_priority",
          "variant",
        ]),
      }),
    );
    expect(
      validateDirectorPlanClaim({
        subject_type: "candidate_process",
        field: "kpi",
        value: { name: "forecast accuracy" },
      }),
    ).toEqual({ ok: true });
    expect(
      validateDirectorPlanClaim({
        subject_type: "candidate_process",
        field: "exec_priority",
        value: { level: "high", reason: "board visibility" },
      }),
    ).toEqual({ ok: true });
    expect(
      validateDirectorPlanClaim({
        subject_type: "candidate_process",
        field: "variant",
        value: ["enterprise approvals", "mid-market approvals"],
      }),
    ).toEqual({ ok: true });
    expect(
      validateDirectorPlanClaim({
        subject_type: "candidate_process",
        field: "unreviewed_field",
        value: "nope",
      }).ok,
    ).toBe(false);
    expect(
      validateDirectorPlanClaim({
        subject_type: "system",
        field: "used_in_process",
        value: { system_name: "Salesforce" },
      }).ok,
    ).toBe(false);
  });

  test("internal realtime turn endpoints enforce service auth and idempotency", () => {
    const ingest = read("app/api/internal/director-turns/ingest/route.ts");
    const contextRoute = read("app/api/internal/director-turns/context/route.ts");
    const verifyRoute = read("app/api/internal/director-turns/verify/route.ts");
    const internalComplete = read("app/api/internal/director-turns/complete/route.ts");
    const internalOpening = read("app/api/internal/director-turns/opening/route.ts");
    const internalNotice = read("app/api/internal/director-turns/notice/route.ts");
    const respond = read("app/api/internal/director-turns/respond/route.ts");
    const extract = read("app/api/internal/director-turns/extract/route.ts");
    const delivery = read("app/api/internal/director-turns/[turnIndex]/delivery/route.ts");
    const complete = read("app/api/director-interviews/[captureSessionId]/complete/route.ts");
    const userTurns = read("app/api/director-interviews/[captureSessionId]/turns/route.ts");
    const transcriptChat = read("components/onboarding/TranscriptChat.tsx");
    const transaction = read("lib/interview/director/turn-transaction.ts");
    const brain = read("lib/interview/director/brain.ts");
    const livekit = read("lib/adapters/livekit.ts");
    const worker = read("../agents/director/director_agent/worker.py");
    const agent = read("../agents/director/director_agent/agent.py");
    const agentReadme = read("../agents/director/README.md");
    const planner = read("../agents/director/director_agent/planner.py");
    const directorInterviews = read("app/api/director-interviews/route.ts");
    const inngestFunctions = read("lib/inngest/functions.ts");
    const voicePreStart = read("app/onboarding/voice/VoicePreStartClient.tsx");
    const completion = read("lib/interview/director/completion.ts");
    const directorTools = read("lib/interview/director/tools.ts");

    expect(ingest).toContain("requireLiveKitAgentService(request)");
    expect(ingest).toContain("requireIdempotencyKey(request)");
    expect(ingest).toContain("reserveIdempotentRequest");
    expect(ingest).toContain("ingestDirectorTurn");
    expect(ingest).toContain("tx,");
    expect(ingest).toContain("storeIdempotentResponse");
    expect(ingest).not.toContain("clearPendingIdempotentRequest");
    expect(respond).toContain("requireLiveKitAgentService(request)");
    expect(respond).toContain("requireIdempotencyKey(request)");
    expect(respond).toContain("reserveIdempotentRequest");
    expect(respond).toContain("clearPendingIdempotentRequest");
    expect(respond).toContain("storeIdempotentResponse");
    expect(respond).toContain("phraseDirectorSteeringTurn");
    expect(respond).toContain("voice_metadata: phrased.metadata");
    expect(extract).toContain("requireLiveKitAgentService(request)");
    expect(extract).toContain("requireIdempotencyKey(request)");
    expect(extract).toContain("reserveIdempotentRequest");
    expect(extract).toContain("storeIdempotentResponse");
    expect(extract).toContain("tx,");
    expect(extract).toContain("voiceMetadata");
    expect(brain).toContain("streaming?: boolean");
    expect(brain).toContain('stream_cutoff?: "first_question" | "message_stop"');
    expect(brain).toContain("cache_read_input_tokens");
    expect(brain).toContain("cache_creation_input_tokens");
    expect(transaction).toContain("voice_timeout_fallback");
    expect(transaction).toContain("voice_degraded");
    expect(delivery).toContain("requireLiveKitAgentService(request)");
    expect(delivery).toContain("requireIdempotencyKey(request)");
    expect(delivery).toContain("reserveIdempotentRequest");
    expect(delivery).toContain("readTerminalDirectorTurnDelivery");
    expect(delivery).toContain("isIdempotencyBodyMismatch");
    expect(delivery).toContain('error.message.includes("different request body")');
    expect(delivery).toContain("storeIdempotentResponse");
    expect(delivery).toContain("tx,");
    expect(delivery).toContain("decision_log_id: z.string().uuid()");
    expect(delivery).toContain("delivered_utterance: z.string()");
    expect(delivery).toContain("playback was truncated before speech");
    expect(delivery).toContain("completed delivery requires spoken_fraction to equal 1");
    expect(delivery).toContain(
      "truncated delivery with an empty utterance requires spoken_fraction to equal 0",
    );
    expect(delivery).toContain(
      "truncated delivery with spoken audio must include the spoken utterance prefix",
    );
    expect(delivery).toContain(
      "failed text fallback delivery requires spoken_fraction to equal 0",
    );
    expect(delivery).toContain("spoken_fraction: z.number().min(0).max(1)");
    expect(delivery).toContain("latency_ms");
    expect(delivery).toContain("audio_metadata: z.record");
    expect(complete).toContain("reserveIdempotentRequest");
    expect(complete).toContain("clearPendingIdempotentRequest");
    expect(complete).toContain("storeIdempotentResponse");
    expect(complete).toContain("completeDirectorInterviewInTransaction");
    expect(complete).toContain('source: "browser"');
    expect(complete).toContain("sendDirectorCompletionEvent(result.eventData)");
    expect(completion).toContain("requestAndRunDirectorInventorySynthesis");
    expect(completion).toContain("runInventorySynthesis");
    expect(completion).toContain('eventType: "capture.director_interview.inline_synthesis_failed"');
    expect(completion.indexOf("await inngest.send")).toBeGreaterThan(
      completion.indexOf("if (!eventData) return;"),
    );
    expect(inngestFunctions).toContain("alreadyQueued");
    expect(inngestFunctions).toContain("pg_advisory_xact_lock");
    expect(inngestFunctions).toContain("synthesis.inventory.queued:");
    expect(inngestFunctions).toContain("metadata_json->>'idempotency_key'");
    expect(inngestFunctions).toContain("!result.alreadyQueued");
    expect(inngestFunctions).toContain("configuredRecoverySecret(getServerEnv().ANTHROPIC_API_KEY)");
    expect(inngestFunctions).toContain("missing_anthropic_api_key");
    expect(inngestFunctions).toContain("rerun_still_degraded");
    expect(inngestFunctions).toContain("writeSkippedDegradedRecovery");
    expect(ingest).toContain("resolveDirectorSessionContext(body.capture_session_id)");
    expect(contextRoute).toContain("readDirectorPlanningContext");
    expect(contextRoute).toContain("requireLiveKitAgentService(request)");
    expect(transaction).toContain("director_user_id: context.userId");
    expect(transaction).toContain("directorUserIdFromCaptureMetadata(session.metadataJson)");
    expect(transaction).toContain("'Director: ' || text");
    expect(transaction).toContain("'Otto: ' || (");
    expect(transaction).toContain("delivery_json->>'delivery_status' = 'pending' THEN NULL");
    expect(transaction).toContain("delivery_json->>'delivery_status' = 'truncated'");
    expect(transaction).toContain("stage_name IN (");
    expect(transaction).toContain("next_turn_index");
    expect(worker).toContain("initial_turn_counter(context)");
    expect(worker).not.toContain("initial_notice_counter(context)");
    expect(transaction).toContain("stale_pending_delivery_decisions");
    expect(transaction).toContain("created_at < now() - interval '30 seconds'");
    expect(worker).not.toContain("wire_user_away_recovery");
    expect(worker).toContain("stale_pending_delivery_decisions=context.get");
    expect(worker).toContain("expected_control_participant_identity");
    expect(worker).toContain("control_participant_identity_from_context(context)");
    expect(worker).toContain("director_user_id");
    expect(agent).toContain("_recover_stale_pending_deliveries");
    expect(agent).toContain('delivery_status="failed_text_fallback"');
    expect(agent).toContain('"worker_recovery_ms"');
    expect(verifyRoute).toContain("requireLiveKitAgentService(request)");
    expect(verifyRoute).toContain("readDirectorSessionVerification");
    expect(transaction).toContain("ok: failedAcceptanceChecks.length === 0");
    expect(internalOpening).toContain("requireLiveKitAgentService(request)");
    expect(internalOpening).toContain("writeAgentDecisionInTransaction");
    expect(internalOpening).toContain('stageName: "director.opening"');
    expect(internalOpening).toContain('delivery_status: "pending"');
    expect(internalNotice).toContain("requireLiveKitAgentService(request)");
    expect(internalNotice).toContain("writeAgentDecisionInTransaction");
    expect(internalNotice).toContain("requireLiveKitAgentService(request)");
    expect(internalNotice).toContain('delivery_status: "pending"');
    expect(internalComplete).toContain("requireLiveKitAgentService(request)");
    expect(internalComplete).toContain("resolveDirectorSessionContext");
    expect(internalComplete).toContain("completeDirectorInterviewInTransaction");
    expect(internalComplete).toContain('source: "livekit_agent"');
    expect(completion).toContain("isNull(captureSessions.completedAt)");
    expect(completion).toContain("completionEventIdempotencyKey");
    expect(completion).toContain("director-complete:");
    expect(completion).toContain("sendDirectorCompletionEvent");
    expect(completion).toContain("hasQueuedDirectorSynthesis");
    expect(completion).toContain("synthesis.inventory.queued");
    expect(completion).toContain("recoverStalePendingDirectorVoiceDeliveries");
    expect(completion).toContain('input.source === "browser"');
    expect(completion).toContain("now() - interval '5 seconds'");
    expect(completion).toContain("browser_completion_recovery");
    expect(completion).toContain("capture.director_voice.stale_delivery_recovered");
    expect(completion).toContain("assertAllDirectorVoiceDeliveryTerminal");
    expect(completion).toContain("unknown_delivery_turns");
    expect(completion).toContain("invalid_delivery_fidelity_turns");
    expect(completion).toContain(
      "pending, unknown, or inconsistent voice delivery evidence",
    );
    expect(completion).toContain("delivery_pending");
    expect(completion).toContain("director.opening");
    expect(completion).toContain("director.opening");
    expect(completion).toContain("createUnresolvedPrioritySlotFollowUps");
    expect(completion).toContain("directorSlotDefinitions.filter");
    expect(completion).toContain('targetType: "director_slot"');
    expect(completion).toContain("unresolved_priority_follow_up_tasks_created");
    const synthesisStatus = read("app/api/synthesis/status/route.ts");
    const synthesisClient = read("app/synthesis/SynthesisClient.tsx");
    expect(synthesisStatus).toContain('searchParams.get("capture_session_id")');
    expect(synthesisStatus).toContain("getCaptureInventoryCount");
    expect(synthesisStatus).toContain("capture_process_count");
    expect(synthesisStatus).toContain("@> ARRAY[");
    expect(synthesisClient).toContain('sp.get("capture_session_id")');
    expect(synthesisClient).toContain("params.set(\"capture_session_id\"");
    expect(synthesisClient).toContain("!captureSessionId && !synthesisBlocked && statusTimedOut");
    expect(synthesisClient).toContain("const statusPollTimedOut");
    expect(synthesisClient).toContain("if (!captureSessionId) return");
    expect(transaction).toContain("capture_session_completed");
    expect(transaction).toContain("capture_session_completed_at");
    expect(transaction).toContain("captureSessions.completedAt");
    expect(transaction).toContain("has_opening_prompt");
    expect(transaction).toContain("director.opening");
    expect(transaction).toContain("voice_prompt_turns");
    expect(transaction).toContain("opening_prompt_has_tts_playout");
    expect(transaction).toContain("all_voice_prompts_delivery_terminal");
    expect(transaction).toContain("all_voice_prompts_have_spoken_evidence");
    expect(transaction).toContain("no_failed_text_fallback_voice_prompts");
    expect(transaction).toContain("voice_prompts");
    expect(transaction).toContain("prompt_delivery_fidelity_turns");
    expect(transaction).toContain("tts_playout_prompt_turns");
    expect(transaction).toContain("audible_prompt_turns");
    expect(transaction).toContain("probe_firings");
    expect(transaction).toContain("target_candidate_process_id");
    expect(brain).toContain("resolvedStatusAfter");
    expect(brain).toContain("readResolvedSlotStatusAfterProbe");
    expect(transaction).toContain("all_delivery_terminal");
    expect(transaction).toContain("backend_pre_tts_p50_ok");
    expect(transaction).toContain("backend_pre_tts_p95_ok");
    expect(transaction).toContain("p50_backend_pre_tts_ms");
    expect(transaction).toContain("total_cost_within_2x_baseline");
    expect(transaction).toContain("voice_cost_cents");
    expect(transaction).toContain("DIRECTOR_INTERVIEW_COST_ALERT_THRESHOLD_CENTS");
    expect(transaction).toContain("cost_alert_threshold_cents");
    expect(transaction).toContain("timing_source");
    expect(transaction).toContain("asr_metrics_turns");
    expect(transaction).toContain("coalesce(turn_index::text, id::text) AS turn_key");
    expect(transaction).toContain("count(DISTINCT turn_key)::int AS transcript_turns");
    expect(transaction).toContain("transcript_segments: transcriptSegmentCount");
    expect(transaction).toContain("turn_contract: {");
    expect(transaction).toContain("all_decisions_have_ingested_transcript_evidence");
    expect(transaction).toContain("decision_turns_with_transcript_evidence");
    expect(transaction).toContain("transcript_segment_ids");
    expect(transaction).toContain("asr_metrics_segments: asrMetricsSegmentCount");
    expect(transaction).toContain("has_real_asr_timing");
    expect(transaction).toContain("has_configured_asr_runtime");
    expect(transaction).toContain("has_privacy_configured_asr_runtime");
    expect(transaction).toContain("llm_brain_turns");
    expect(transaction).toContain("has_llm_brain_turn");
    expect(transaction).toContain("llm_voice_turns");
    expect(transaction).toContain("has_llm_voice_turn");
    expect(transaction).toContain("llm_cache_observed");
    expect(transaction).toContain("has_llm_cache_observation");
    expect(transaction).toContain("voice_cache_observed");
    expect(transaction).toContain("has_voice_cache_observation");
    expect(transaction).toContain("llm_cache_hit_rate_target");
    expect(transaction).toContain("voice_cache_hit_rate_target");
    expect(transaction).toContain("streamed_voice_turns");
    expect(transaction).toContain("has_streamed_voice_turn");
    expect(transaction).toContain("voice_streaming = 'true'");
    expect(transaction).toContain("voice_stream_cutoff = 'first_question'");
    expect(transaction).toContain("brain_metadata,cache_read_input_tokens");
    expect(transaction).toContain("voice_metadata,cache_read_input_tokens");
    expect(transaction).toContain("llm_cache_hits");
    expect(transaction).toContain("voice_cache_hits");
    expect(transaction).toContain("llm_cache_hit_rate");
    expect(transaction).toContain("voice_cache_hit_rate");
    expect(transaction).toContain("llm_cache_read_input_tokens");
    expect(transaction).toContain("voice_cache_creation_input_tokens");
    expect(transaction).toContain("voice_timeout_fallback_turns");
    expect(transaction).toContain("voice_degraded_turns");
    expect(transaction).toContain("voice_timeout_fallback = 'true'");
    expect(transaction).toContain("voice_degraded = 'true'");
    expect(transaction).toContain("no_degraded_turns");
    expect(transaction).toContain("recovered_degraded_turns");
    expect(transaction).toContain("unresolved_degraded_turns");
    expect(transaction).toContain("re_extract_degraded_turns.recovered");
    expect(transaction).toContain("failed_acceptance_checks");
    expect(transaction).toContain("candidate_processes: candidateRows.map");
    expect(transaction).toContain("duplicate_candidate_process_name_groups");
    expect(transaction).toContain("no_duplicate_candidate_process_names");
    expect(transaction).toContain("regexp_replace(trim(proposed_name)");
    expect(transaction).toContain("has_synthesis_run_for_capture");
    expect(transaction).toContain("synthesis_terminal_for_capture");
    expect(transaction).toContain("overview_ready");
    expect(transaction).toContain("overview_has_evidence_linked_card");
    expect(transaction).toContain("capture_session_ids @> ARRAY");
    expect(transaction).toContain("evidence_linked_overview_cards");
    expect(transaction).toContain("priority_1_coverage_ratio");
    expect(transaction).toContain("directorSlotDefinitions.filter");
    expect(transaction).toContain("priority1StatusByPath");
    expect(transaction).toContain("priority1PartialOrConflictingSlots");
    expect(transaction).toContain("priority_1_no_partial_or_conflicting");
    expect(transaction).toContain("model NOT LIKE 'deterministic-%'");
    expect(transaction).toContain("tts_playout_turns");
    expect(transaction).toContain("delivery_fidelity_turns");
    expect(transaction).toContain("all_terminal_delivery_has_spoken_evidence");
    expect(transaction).toContain("delivered_utterance = planned_utterance");
    expect(transaction).toContain("regexp_replace(delivered_utterance");
    expect(transaction).toContain("audible_tts_turns");
    expect(transaction).toContain("audio_playout = 'session.say.wait_for_playout'");
    expect(transaction).toContain("configured_tts_runtime_turns");
    expect(transaction).toContain("privacy_configured_tts_runtime_turns");
    expect(transaction).toContain("configured_tts_runtime_prompt_turns");
    expect(transaction).toContain("privacy_configured_tts_runtime_prompt_turns");
    expect(transaction).toContain("audio_transport IN ('direct_plugin', 'livekit_inference')");
    expect(transaction).toContain("spoken_fraction > 0");
    expect(transaction).toContain("metadata_json->>'timing' = 'started_stopped_speaking_at'");
    expect(transaction).toContain("has_tts_playout_timing");
    expect(transaction).toContain("has_audible_tts_delivery");
    expect(transaction).toContain("has_configured_tts_runtime");
    expect(transaction).toContain("has_privacy_configured_tts_runtime");
    expect(transaction).toContain("voice_prompts_have_configured_tts_runtime");
    expect(transaction).toContain("voice_prompts_have_privacy_configured_tts_runtime");
    expect(transaction).toContain("vendor_export_audits");
    expect(transaction).toContain("livekit_vendor_export_audits");
    expect(transaction).toContain("anthropic_vendor_export_audits");
    expect(transaction).toContain("privacy_ack_vendor_export_audits");
    expect(transaction).toContain("stable_agent_identity_audits");
    expect(transaction).toContain("has_stable_livekit_agent_identity");
    expect(transaction).toContain("agent_participant_identity");
    expect(transaction).toContain("capture.director_voice.vendor_export");
    expect(transaction).toContain("metadata_json->'vendors' ? 'anthropic'");
    expect(transaction).toContain("has_vendor_export_audit");
    expect(transaction).toContain("no_duplicate_vendor_export_audits");
    expect(transaction).toContain("has_livekit_vendor_export_audit");
    expect(transaction).toContain("has_anthropic_vendor_export_audit");
    expect(transaction).toContain("vendor_privacy_controls_acknowledged");
    expect(transaction).toContain("audio_retention_audit_consistent");
    expect(transaction).toContain("raw_payload_logging_audit_consistent");
    expect(transaction).toContain("audio_retention_enabled_audits");
    expect(transaction).toContain("raw_payload_logging_enabled_audits");
    expect(transaction).toContain("vendor_privacy: {");
    expect(transaction).toContain("no_failed_text_fallback_turns");
    expect(transaction).toContain("unknown_delivery_turns");
    expect(transaction).toContain("terminal_delivery_turns");
    expect(transaction).toContain("terminalDeliveryTurns === decisionTurns");
    expect(respond).toContain("buildDirectorSteeringPlan");
    expect(respond).toContain("phraseDirectorSteeringTurn");
    expect(respond).toContain("assertDirectorTurnReferences");
    expect(respond.indexOf("await assertDirectorTurnReferences")).toBeLessThan(
      respond.indexOf("await buildDirectorSteeringPlan"),
    );
    expect(respond).toContain("voiceMetadataDegrades(phrased.metadata)");
    expect(respond).toContain("upsertDirectorExtractionWindow");
    expect(extract).toContain("assertDirectorTurnReferences");
    expect(extract.indexOf("await assertDirectorTurnReferences")).toBeLessThan(
      extract.indexOf("await extractDirectorTurn"),
    );
    expect(extract).toContain("dispatchDirectorTurnPlan");
    expect(read("lib/db/client.ts")).toContain("export function getServiceDb()");
    expect(read("lib/db/client.ts")).toContain("requireEnv(\"DATABASE_SERVICE_URL\")");
    expect(transaction).toContain("getServiceDb()");
    expect(brain).toContain("writeClaimInTransaction");
    expect(brain).toContain("recordCandidateProcessClaim");
    expect(brain).toContain("writeAgentDecisionInTransaction");
    expect(brain).toContain("coverage_slots");
    expect(brain).toContain("readCoverageSnapshot");
    expect(brain).toContain("degradedQuality = llmResult.metadata.mocked");
    expect(brain).toContain("degradedQuality: planned.degraded_quality");
    expect(brain).toContain("preflightDirectorPlanEvidence");
    expect(brain).toContain("Director assertions must cite evidence ids from the current turn");
    expect(brain).toContain("selectActiveCandidateProcessId");
    expect(brain).toContain("candidateProcessIdForTool");
    expect(brain).toContain("targetProcess");
    expect(brain).toContain("candidateProcessBelongsToSession");
    expect(brain).toContain("rejected_focus_candidate_process_id");
    expect(brain).toContain("does not belong to this capture session");
    expect(brain).toContain("preflightDirectorPlanClaims");
    expect(brain).toContain("preflightDirectorPlanClaimSubjects");
    expect(brain).toContain("directorClaimSubjectFailure");
    expect(brain).toContain("referencedCandidateProcessIdFromValue");
    expect(brain).toContain("Director Phase 1 claims must target candidate_process subjects until promotion");
    expect(brain).toContain("candidate_process claims must target a candidate from this capture session");
    expect(brain).toContain("claims that reference candidate_process_id must reference this capture session");
    expect(brain).toContain("runDirectorTool");
    expect(brain).toContain("const state = await readInterviewState(context, tx);");
    expect(brain).toContain(
      "const currentSlotsBeforeDispatch = await readCurrentSlots(",
    );
    expect(brain).toContain("tx?: ClaimWriteTx");
    expect(brain).not.toContain("isDirectorToolRequiredByChosenIntent");
    expect(brain).not.toContain("isMalformedDirectorClaimRequiredByChosenIntent");
    expect(brain).not.toContain("directorClaimFieldLooksLikeIntent");
    expect(brain).not.toContain("Required director tool failed");
    expect(brain).not.toContain("Required director claim failed validation");
    expect(brain).toContain("The latest answer does not need to satisfy the chosen intent");
    expect(brain).toContain("Review skipped director enrichment");
    expect(brain).toContain("exhaustedProbeEscalation");
    expect(brain).toContain('source: "probe_max_fires"');
    expect(brain).toContain("planEvidenceIds(plan, currentTurnEvidenceIds)");
    expect(brain).toContain('"asked_unknown"');
    expect(brain).toContain("Resolve unanswered director slot");
    expect(brain).toContain('tool.name === "createFollowUpTask"');
    expect(delivery).toContain("updateDirectorTurnDelivery");
    expect(brain).toContain("planned_utterance");
    expect(brain).toContain("brain_metadata: metadata");
    expect(respond).toContain("voiceMetadata: phrased.metadata");
    expect(brain).toContain("voice_metadata: input.voiceMetadata ?? null");
    expect(brain).toContain(".onConflictDoNothing()");
    expect(directorTools).toContain("pg_advisory_xact_lock");
    expect(directorTools).toContain("candidate_process:");
    expect(directorTools.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      directorTools.indexOf("SELECT id, proposed_function, frequency"),
    );
    expect(transaction).toContain("delivery_status");
    expect(transaction).toContain("sanitizeJsonForLogs");
    expect(transaction).toContain("latency_ms: input.latencyMs");
    expect(transaction).toContain("audio_metadata: input.audioMetadata ?? {}");
    expect(transaction).toContain("delivery_json #>> '{audio_metadata,source}' AS audio_source");
    expect(transaction).toContain("delivery_json #>> '{audio_metadata,provider}' AS audio_provider");
    expect(transaction).toContain("delivery_json #>> '{audio_metadata,model}' AS audio_model");
    expect(transaction).toContain("delivery_json #>> '{audio_metadata,voice_id}' AS audio_voice_id");
    expect(transaction).toContain("audio_source = 'livekit_agents'");
    expect(transaction).toContain("audio_provider = 'cartesia'");
    expect(transaction).toContain("coalesce(delivery_json->>'delivery_status', 'pending') = 'pending'");
    expect(transaction).toContain("isTerminalDeliveryStatus");
    expect(transaction).toContain("readTerminalDirectorTurnDelivery");
    expect(transaction).toContain("delivery_json->>'delivery_status' IN");
    expect(transaction).toContain("language: context.language");
    expect(transaction).toContain("languageFromCaptureMetadata");
    expect(transaction).toContain("metadata_json: z.record");
    expect(transaction).toContain("sanitizedTranscriptMetadata");
    expect(transaction).toContain(
      "metadataJson: sanitizedTranscriptMetadata(segment.metadata_json)",
    );
    expect(transaction).toContain("export async function assertDirectorTurnReferences");
    expect(transaction).toContain("All transcript_segment_ids for a director turn must share the same turn_index.");
    expect(transaction).toContain("All transcript_segment_ids must belong to this director capture session.");
    expect(transaction).toContain("All evidence_ids must be transcript evidence created from the submitted segment ids.");
    expect(transaction).toContain("lockDirectorTurnSequence");
    expect(transaction).toContain("assertDirectorCaptureAcceptsTurns");
    expect(transaction).toContain("captureSessions.completedAt");
    expect(transaction).toContain("already completed and cannot accept new turns");
    expect(transaction).toContain("pg_advisory_xact_lock");
    expect(transaction).toContain("hashtextextended");
    expect(transaction).toContain("function nextDirectorTurnIndex");
    expect(transaction).toContain("stage_name = 'director.turn'");
    expect(transaction).toContain("livekit_deepgram_asr_metrics_turns");
    expect(transaction).toContain("configured_asr_runtime_turns");
    expect(transaction).toContain("metadata_json->>'source' = 'livekit_agents'");
    expect(transaction).toContain("metadata_json->>'provider' = 'deepgram'");
    expect(directorInterviews).toContain("}).strict()");
    expect(userTurns).toContain("}).strict()");
    expect(complete).toContain("}).strict()");
    expect(directorInterviews).toContain("consent_acknowledged: z.literal(true)");
    expect(directorInterviews).toContain("consent_text_version");
    expect(directorInterviews).toContain("consent_acknowledged_at");
    expect(directorInterviews).toContain("audio_recording_default");
    expect(directorInterviews).toContain("director_user_id: auth.userId");
    expect(voicePreStart).toContain("consent_acknowledged: true");
    expect(voicePreStart).toContain('consent_text_version: "director_voice_v1"');
    expect(read("lib/db/schema.ts")).toContain("agent_decision_log_capture_turn_stage_idx");
    expect(read("lib/db/schema.ts")).toContain('turnIndex: integer("turn_index")');
    expect(read("lib/db/schema.ts")).toContain('metadataJson: jsonb("metadata_json")');
    expect(read("lib/db/schema.ts")).toContain("probe_firings_capture_turn_probe_idx");
    expect(userTurns).toContain("export async function GET");
    expect(userTurns).toContain("agentDecisionLog");
    expect(userTurns).toContain("director.opening");
    expect(userTurns).toContain("director.opening");
    expect(userTurns).toContain("stageName: agentDecisionLog.stageName");
    expect(userTurns).toContain("segmentTurnIndexes");
    expect(userTurns).toContain("row.turnIndex ?? segmentTurnIndexes.get(row.id) ?? null");
    expect(userTurns).toContain("transcriptSegmentIds: agentDecisionLog.transcriptSegmentIds");
    expect(userTurns).toContain("reserveIdempotentRequest");
    expect(userTurns).toContain("clearPendingIdempotentRequest");
    expect(userTurns).toContain("ingestDirectorTurn");
    expect(userTurns).toContain("tx,");
    expect(userTurns).toContain("storeIdempotentResponse");
    expect(transcriptChat).toContain("const hydrateTranscript = useCallback");
    expect(transcriptChat).toContain("hydrateTranscript(session)");
    expect(transcriptChat).toContain("liveKitDirectorTurnIndexesRef.current = new Set");
    expect(transcriptChat).toContain("liveKitAgentTurnKeysRef.current = new Set");
    expect(transcriptChat).toContain('parsed.event === "director.session.completed"');
    expect(transcriptChat).toContain("await onCompleted();");
    expect(transcriptChat).toContain("const navigateToSynthesis = useCallback");
    expect(transcriptChat).toContain("completeDirectorInterview(session)");
    expect(transcriptChat).toContain("completionNavigationStartedRef");
    expect(transcriptChat).toContain("capture_session_id");
    expect(transcriptChat).toContain("isRetryableCompleteError");
    expect(transcriptChat).toContain("isCompletionSettlingError");
    expect(transcriptChat).toContain("attempt <= 60");
    expect(transcriptChat).toContain("error.status === 409");
    expect(transcriptChat.indexOf('sendLiveKitControl(\n          liveKitRoomRef.current,\n          "end"')).toBeLessThan(
      transcriptChat.indexOf("return;\n      } else"),
    );
    expect(transcriptChat).toContain("const endControlSent = await sendLiveKitControl");
    expect(transcriptChat).toContain("if (!endControlSent)");
    expect(transcriptChat).toContain("await completeDirectorInterview(session)");
    expect(transcriptChat).toContain("disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef)");
    const liveKitEndMicIndex = transcriptChat.indexOf("setMicrophoneEnabled?.(false)");
    const liveKitEndCompleteIndex = transcriptChat.indexOf(
      "await completeDirectorInterview(session)",
      liveKitEndMicIndex,
    );
    expect(liveKitEndMicIndex).toBeGreaterThan(-1);
    expect(liveKitEndCompleteIndex).toBeGreaterThan(liveKitEndMicIndex);
    expect(transcriptChat).toContain("return true");
    expect(transcriptChat).toContain("return false");
    expect(transcriptChat).toContain("Press End again to retry");
    expect(transcriptChat.indexOf("expectedLiveKitDisconnectRef.current = true")).toBeLessThan(
      transcriptChat.indexOf("sendLiveKitControl("),
    );
    expect(transcriptChat).toContain('noticeType === "failed_completion"');
    expect(transcriptChat).toContain("expectedDisconnectRef.current = false");
    expect(transcriptChat).toContain("showStartInterviewPrompt");
    expect(transcriptChat).toContain("waitingForFirstAgentMessage");
    expect(transcriptChat).toContain('parsed.payload.stage_name ?? "director.turn"');
    expect(transcriptChat).not.toContain("introMessage(session)");
    expect(transcriptChat).toContain("sendLiveKitControl");
    expect(transcriptChat).toContain("refreshLiveKitSession");
    expect(transcriptChat).toContain('"/api/livekit/director-room"');
    expect(transcriptChat).toContain("director-room-refresh-");
    expect(transcriptChat).toContain("liveKitRefreshIdempotencyKey");
    expect(transcriptChat).toContain("5 * 60 * 1000");
    expect(transcriptChat).toContain("roomTokenExpiresAt");
    expect(transcriptChat).toContain("hasUsableLiveKitCredentials(input.session)");
    expect(transcriptChat).toContain("liveKitTokenFresh(session.roomTokenExpiresAt)");
    expect(transcriptChat).toContain("expiresAtMs - Date.now() > 60_000");
    expect(transcriptChat).toContain("DIRECTOR_SESSION_CHANGED_EVENT");
    expect(transcriptChat).toContain("shouldPersist: () => boolean = () => true");
    expect(transcriptChat).toContain("liveKitConnectStillCurrent(input),");
    expect(transcriptChat).toContain("if (shouldPersist())");
    expect(transcriptChat).toContain("writeStoredDirectorSession(refreshed)");
    expect(transcriptChat).toContain("clearStoredDirectorSession()");
    expect(transcriptChat).toContain("window.dispatchEvent(new Event(DIRECTOR_SESSION_CHANGED_EVENT))");
    expect(transcriptChat).toContain("window.addEventListener(DIRECTOR_SESSION_CHANGED_EVENT");
    expect(transcriptChat).toContain("activeCaptureSessionRef");
    expect(transcriptChat).toContain("}, [hydrateTranscript, session]);");
    expect(transcriptChat).toContain("previous && current && previous !== current");
    expect(transcriptChat).toContain("coverage_slots");
    expect(transcriptChat).toContain('"end",');
    expect(transcriptChat).toContain("syncLiveKitControlState");
    expect(transcriptChat).toContain("statusRef: MutableRefObject");
    expect(transcriptChat).toContain('state.paused ? "pause" : "resume"');
    expect(transcriptChat).toContain('state.muted ? "mute" : "unmute"');
    expect(transcriptChat).toContain("events.Reconnected");
    expect(transcriptChat).toContain('"resume",');
    expect(transcriptChat).toContain("otto.director.control");
    expect(transcriptChat).toContain("director.control.updated");
    expect(transcriptChat).toContain("setMuted(parsed.payload.muted)");
    expect(transcriptChat).toContain("setPaused(parsed.payload.paused)");
    expect(transcriptChat).toContain('topic !== "otto.director"');
    expect(transcriptChat).toContain("participantIdentity");
    expect(transcriptChat).toContain("isExpectedAgentDataSender");
    expect(transcriptChat).toContain("session.agentParticipantIdentity?.trim()");
    expect(transcriptChat).toContain("session.agentName?.trim()");
    expect(transcriptChat).toContain("session.dispatchId?.trim()");
    expect(transcriptChat).toContain("participantIdentity === expectedAgentIdentity");
    expect(transcriptChat).toContain("participantIdentity === expected");
    expect(transcriptChat).toContain('source: "otto_browser_client"');
    expect(transcriptChat).toContain('parsed.source !== "otto_director_agent"');
    expect(transcriptChat).toContain("parsed.capture_session_id !== session.captureSessionId");
    expect(transcriptChat).toContain("director.turn.delivery_updated");
    expect(transcriptChat).toContain("updateAgentMessageForTurn");
    expect(transcriptChat).toContain("removeAgentMessageForTurn");
    expect(transcriptChat).not.toContain("Review queued");
    expect(transcriptChat).toContain("setLastTelemetry({");
    expect(transcriptChat).toContain("id: `agent-${stageName}-${turnIndex}`");
    expect(transcriptChat).toContain("parsed.payload.stage_name ?? \"director.turn\"");
    expect(transcriptChat).toContain('"completed", "truncated", "failed_text_fallback"');
    expect(transcriptChat).toContain('delivery_status === "truncated"');
    expect(transcriptChat).toContain("agent_utterance.trim().length === 0");
    expect(transcriptChat).toContain("director.turn.ingested");
    expect(transcriptChat).toContain("liveKitDirectorTurnIndexesRef");
    expect(transcriptChat).toContain(
      'appendMessage("director", parsed.payload.transcript, turnIndex)',
    );
    expect(transcriptChat).toContain(
      'appendMessage(\n          "director",\n          parsed.payload.transcript,\n          typeof turnIndex === "number" ? turnIndex : null,',
    );
    expect(transcriptChat).toContain("agentTurnKeysRef");
    expect(transcriptChat).toContain("agentMessageKey(");
    expect(transcriptChat).toContain("stage_name");
    expect(transcriptChat).toContain("director.turn.telemetry");
    expect(transcriptChat).toContain("pre-TTS");
    expect(transcriptChat).toContain("TrackUnsubscribed");
    expect(transcriptChat).toContain("trackUnsubscribed");
    expect(transcriptChat).toContain("removeLiveKitAudioElement");
    expect(transcriptChat).toContain("cleanupLiveKitAudioElements");
    expect(transcriptChat).toContain("Reconnecting to the voice room...");
    expect(transcriptChat).toContain("rehydrateTranscript: () => hydrateTranscript(session)");
    expect(transcriptChat).toContain("input.rehydrateTranscript()");
    expect(transcriptChat).toContain("transcript refresh failed");
    expect(transcriptChat).toContain("MAX_LIVEKIT_RECONNECT_ATTEMPTS");
    expect(transcriptChat).toContain("scheduleLiveKitReconnect(input");
    expect(transcriptChat).toContain("clearLiveKitReconnectTimer");
    expect(transcriptChat).toContain("Voice room disconnected. Reconnecting...");
    expect(transcriptChat).toContain("Voice room disconnected. Press Start mic to reconnect.");
    expect(transcriptChat).not.toContain("Transcribing");
    expect(transcriptChat).not.toContain("Mic standby");
    expect(transcriptChat).not.toContain("Audio recording off");
    expect(transcriptChat).toContain("expectedLiveKitDisconnectRef");
    expect(transcriptChat).toContain("liveKitConnectingRef");
    expect(transcriptChat).toContain("liveKitConnectedSessionRef");
    expect(transcriptChat).toContain("connectingRef: liveKitConnectingRef");
    expect(transcriptChat).toContain("connectedSessionRef: liveKitConnectedSessionRef");
    expect(transcriptChat).toContain("activeCaptureSessionRef");
    expect(transcriptChat).toContain("activeCaptureSessionRef.current = session.captureSessionId");
    expect(transcriptChat).toContain("if (input.connectingRef.current)");
    expect(transcriptChat).toContain("const pendingConnection = input.connectingRef.current");
    expect(transcriptChat).toContain("await pendingConnection.catch(() => undefined)");
    expect(transcriptChat).toContain("!input.statusRef.current.listening");
    expect(transcriptChat).toContain("const connection = connectLiveKitOnce(input)");
    expect(transcriptChat).toContain("liveKitConnectStillCurrent(input)");
    expect(transcriptChat).toContain("liveKitRoomEventStillCurrent(input, room, activeSession.captureSessionId)");
    expect(transcriptChat).toContain("liveKitSessionStillCurrent(input, activeSession.captureSessionId)");
    expect(transcriptChat).toContain("input.roomRef.current !== room");
    expect(transcriptChat).toContain("input.roomRef.current !== room ||");
    expect(transcriptChat).toContain("input.connectedSessionRef.current !== activeSession.captureSessionId");
    expect(transcriptChat).toContain("input.connectedSessionRef.current !== input.session.captureSessionId");
    expect(transcriptChat).toContain("input.connectedSessionRef.current = activeSession.captureSessionId");
    expect(transcriptChat).toContain("input.expectedDisconnectRef.current ||");
    expect(transcriptChat).toContain("(input.publishMicrophone && !input.statusRef.current.listening)");
    expect(transcriptChat).toContain("publishMicrophone: false");
    expect(transcriptChat).toContain("startAgent: false");
    expect(transcriptChat).toContain("surfaceErrors: false");
    expect(transcriptChat).toContain("publishMicrophone: true");
    expect(transcriptChat).toContain("startAgent: true");
    expect(transcriptChat).toContain("surfaceErrors: true");
    expect(transcriptChat).toContain("const [voiceFallback, setVoiceFallback] = useState(false)");
    expect(transcriptChat).toContain('const effectiveRoomMode = voiceFallback ? "simulated" : session?.roomMode');
    expect(transcriptChat).toContain("enableTypedFallback: () => {");
    expect(transcriptChat).toContain("disconnectLiveKitRoom(liveKitRoomRef, liveKitMicTrackRef, liveKitAudioElsRef)");
    expect(transcriptChat).toContain("let pendingRoom: LiveKitRoomLike | null = null");
    expect(transcriptChat).toContain("pendingRoom = room");
    expect(transcriptChat).toContain("cleanupFailedLiveKitConnection(");
    expect(transcriptChat).toContain("room?.disconnect()");
    expect(transcriptChat.indexOf("cleanupFailedLiveKitConnection(")).toBeLessThan(
      transcriptChat.lastIndexOf("input.enableTypedFallback()"),
    );
    expect(transcriptChat).toContain("input.enableTypedFallback()");
    expect(transcriptChat).toContain("director.session.notice");
    expect(transcriptChat).toContain('noticeType === "worker_startup_failed"');
    expect(transcriptChat).toContain("enableTypedFallback();");
    expect(transcriptChat).toContain("statusRef.current = { ...statusRef.current, listening: false }");
    expect(transcriptChat).toContain('noticeType.endsWith("_persistence")');
    expect(transcriptChat).toContain('appendMessage("agent", parsed.payload.agent_utterance)');
    expect(transcriptChat).toContain("Audio playback failed. Otto's response is shown as text.");
    expect(agent).not.toContain("AUDIO_STALL_PROMPT");
    expect(agent).not.toContain("record_notice(");
    expect(agent).not.toContain('"director.notice.asr_stall"');
    expect(agent).not.toContain("failed_asr_stall_persistence");
    expect(agent).toContain("failed_opening_persistence");
    expect(agent).toContain("failed_completion");
    expect(agent).toContain('"director.session.completed"');
    expect(agent).toContain("completion did not save");
    expect(agentReadme).toContain("publishes `director.session.completed`");
    expect(agentReadme).toContain("route to `/synthesis?next=/overview`");
    expect(agentReadme).toContain("keeps the room connected so **End** can be pressed again");
    expect(agent).toContain("self._muted = False");
    expect(agent).toContain("_expected_control_participant_identity");
    expect(agent).toContain("_control_participant_allowed");
    expect(agent).toContain("return False");
    expect(agent).toContain("if action == \"mute\"");
    expect(agent).toContain("if action == \"unmute\"");
    expect(agent).toContain("_publish_control_update");
    expect(agent).toContain('"director.control.updated"');
    expect(agent).toContain("self._paused or self._muted");
    expect(agent).not.toContain("_notice_counter");
    expect(agent).not.toContain("_next_notice_turn_index");
    expect(agent).not.toContain("notice_type\": \"asr_stall");
    expect(agent).not.toContain("on_user_away_timeout");
    expect(agent).toContain("record_opening(");
    expect(agent).toContain('"director.opening"');
    expect(agent).toContain("_complete_session_and_disconnect");
    expect(agent).toContain("complete_session(");
    expect(agent).toContain('"livekit_end"');
    expect(agent).toContain("self._active_turn_done");
    expect(agent).toContain("active_turn_done.wait()");
    expect(worker).not.toContain("MAX_USER_TURN_SECONDS");
    expect(worker).not.toContain("user_turn_limit");
    expect(worker).toContain("turn_handling=TurnHandlingOptions(");
    expect(worker).toContain("turn_detection = None");
    expect(worker).toContain("if config.use_semantic_turn_detector:");
    expect(worker).toContain("turn_detection=turn_detection");
    expect(worker).toContain("endpointing={");
    expect(worker).toContain('"min_delay": config.endpointing_min_delay');
    expect(worker).toContain('"max_delay": config.endpointing_max_delay');
    expect(worker).toContain("interruption={");
    expect(worker).toContain('"enabled": True');
    expect(worker).toContain("user_away_timeout=None");
    expect(worker).not.toContain('session.on("user_state_changed"');
    expect(agent).toContain('session.on("user_state_changed", self._on_user_state_changed)');
    expect(agent).toContain('session.on("user_input_transcribed", self._on_user_input_transcribed)');
    expect(agent).toContain("_supersede_active_turn");
    expect(agent).not.toContain("_interrupt_and_wait_for_prior_delivery");
    expect(agent).not.toContain("prior_delivery_timeout");
    expect(planner).toContain('"tools":');
    expect(planner).toContain('"tool_choice"');
    expect(planner).toContain("director_turn_plan_tool_schema()");
    expect(planner).toContain("emit_director_turn_plan");
    expect(transcriptChat).toContain("livekit.createLocalAudioTrack?.()");
    expect(transcriptChat).toContain("await room.localParticipant.publishTrack?.(track,");
    expect(transcriptChat).toContain("source: livekit.Track?.Source?.Microphone");
    expect(transcriptChat).toContain("await room.localParticipant.setMicrophoneEnabled?.(true)");
    expect(
      transcriptChat.indexOf("livekit.createLocalAudioTrack?.()"),
    ).toBeLessThan(
      transcriptChat.indexOf("await room.connect(activeSession.roomUrl"),
    );
    expect(transcriptChat).toContain("room.localParticipant.publishData(payload");
    expect(transcriptChat).not.toContain("const publishData = room?.localParticipant.publishData");
    expect(transcriptChat).toContain("coverageUpdateFromPayload(session, parsed.payload)");
    expect(transcriptChat).toContain("refreshCoverage(session, payload.slot_updates)");
    expect(transcriptChat).not.toContain("parsed.payload.slot_updates.map((slot)");
    expect(livekit).toContain("LIVEKIT_AGENT_SERVICE_TOKEN");
    expect(livekit).toContain("OTTO_INTERNAL_API_BASE_URL");
    expect(livekit).toContain("env.ANTHROPIC_API_KEY");
    expect(livekit).toContain("env.DEEPGRAM_API_KEY");
    expect(livekit).toContain("env.CARTESIA_API_KEY");
    expect(livekit).toContain("AgentDispatchClient");
    expect(livekit).toContain("RoomServiceClient");
    expect(livekit).toContain("export function directorVoiceReadiness");
    expect(livekit).toContain("DIRECTOR_BROWSER_TOKEN_TTL_SECONDS");
    expect(livekit).toContain("tokenExpiresAt");
    expect(livekit).toContain("ttlSeconds: DIRECTOR_BROWSER_TOKEN_TTL_SECONDS");
    expect(livekit).toContain('mode: "unconfigured"');
    expect(read("app/api/livekit/director-room/route.ts")).toContain("export async function GET");
    expect(read("app/api/livekit/director-room/route.ts")).toContain("directorVoiceReadiness(getServerEnv())");
    expect(livekit).toContain("ensureDirectorAgentDispatch");
    expect(livekit).toContain("LIVEKIT_AGENT_NAME");
    expect(livekit).toContain("audio_recording_default");
    expect(livekit).toContain("egress_recording_default");
    expect(livekit).toContain("data_channel_logging");
    expect(livekit).toContain("vendor_privacy_ack");
    expect(livekit).toContain("OTTO_DEEPGRAM_NO_STORE_ACK");
    expect(livekit).toContain("OTTO_CARTESIA_NO_RETENTION_ACK");
    expect(livekit).toContain("OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK");
    expect(livekit).toContain("deepgram_no_store_ack");
    expect(livekit).toContain("cartesia_no_retention_ack");
    expect(livekit).toContain("anthropic_raw_logging_off_ack");
    expect(livekit).toContain("agent_name: agentName");
    expect(livekit).toContain("agent_participant_identity: agentParticipantIdentity");
    expect(livekit).toContain("isStrictDirectorVoiceMode");
    expect(livekit).toContain('env.NODE_ENV === "production"');
    expect(livekit).toContain("LiveKit voice is not fully configured");
    expect(read("app/api/livekit/director-room/route.ts")).toContain("}).strict()");
    expect(read("app/api/livekit/director-room/route.ts")).toContain("captureHasConsent");
    expect(read("app/api/livekit/director-room/route.ts")).toContain("consent_acknowledged");
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "requireIdempotencyKey(request)",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "reserveIdempotentRequest",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "storeIdempotentResponse",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "clearPendingIdempotentRequest",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "capture.director_voice.vendor_export",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "pg_advisory_xact_lock",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "existingVendorExportAudit",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "vendor_privacy_controls",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "agent_participant_identity",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "captureDirectorUserId(reserved.capture)",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "persistCaptureDirectorUserId",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "Only the director who started this interview can join its voice room.",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "directorVoiceVendorPrivacyControls",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "directorVoiceConsentAudit",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "directorVoiceRetentionPolicy",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "capture.director_voice.audio_retention_enabled",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "capture.director_voice.raw_payload_logging_enabled",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "existingRetentionAudit",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "existingRawPayloadAudit",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "raw_payload_logging",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "debug_window_enabled",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "audio_retention_days",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      "directorVoiceVendors(room.mode)",
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      '"deepgram"',
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      '"cartesia"',
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      '"anthropic"',
    );
    expect(read("app/api/livekit/director-room/route.ts")).not.toContain(
      'env.ANTHROPIC_API_KEY ? ["anthropic"]',
    );
    expect(read("app/api/livekit/director-room/route.ts")).toContain(
      'data_channel_logging: "not_logged_by_livekit"',
    );
    expect(voicePreStart).toContain("const readiness = await getJson<DirectorVoiceReadiness>");
    expect(voicePreStart).toContain('readiness.mode === "unconfigured"');
    expect(voicePreStart).toContain("if (readiness.requiresMicrophone)");
    expect(voicePreStart.indexOf('"/api/livekit/director-room"')).toBeLessThan(
      voicePreStart.indexOf("await requestMicrophonePermission()"),
    );
    expect(voicePreStart.indexOf("await requestMicrophonePermission()")).toBeLessThan(
      voicePreStart.indexOf('"/api/director-interviews"'),
    );
    const readinessCheckIndex = voicePreStart.indexOf('"/api/livekit/director-room"');
    const sessionCreateIndex = voicePreStart.indexOf('"/api/director-interviews"');
    const roomPrewarmIndex = voicePreStart.indexOf(
      '"/api/livekit/director-room"',
      readinessCheckIndex + 1,
    );
    expect(roomPrewarmIndex).toBeGreaterThan(sessionCreateIndex);
    expect(voicePreStart).toContain('roomMode: readiness.mode === "livekit" ? "livekit" : "simulated"');
    expect(voicePreStart).toContain("roomUrl: null");
    expect(voicePreStart).toContain("roomToken: null");
    expect(voicePreStart).toContain("roomUrl: room.url");
    expect(voicePreStart).toContain("roomToken: room.token");
    expect(transcriptChat).toContain("refreshLiveKitSession(input.session, () =>");
    expect(transcriptChat).toContain("hasUsableLiveKitCredentials(input.session)");
    expect(transcriptChat).toContain("livekit.createLocalAudioTrack?.()");
    expect(transcriptChat).toContain("source: livekit.Track?.Source?.Microphone");
    const liveKitStartIndex = transcriptChat.indexOf('if (effectiveRoomMode === "livekit")');
    const optimisticListeningIndex = transcriptChat.indexOf(
      "setListening(true);",
      liveKitStartIndex,
    );
    const connectLiveKitIndex = transcriptChat.indexOf(
      "void connectLiveKit({",
      liveKitStartIndex,
    );
    expect(optimisticListeningIndex).toBeGreaterThan(liveKitStartIndex);
    expect(optimisticListeningIndex).toBeLessThan(connectLiveKitIndex);
  });

  test("degraded director recovery applies extraction without advancing the live interview", () => {
    const inngestFunctions = read("lib/inngest/functions.ts");
    const brain = read("lib/interview/director/brain.ts");

    expect(inngestFunctions).toContain("extractDirectorTurn");
    expect(inngestFunctions).toContain("dispatchDirectorTurnPlan");
    expect(inngestFunctions).not.toContain("runDirectorTurn");
    expect(inngestFunctions).toContain(
      'decisionStageName: "re_extract_degraded_turns.applied"',
    );
    expect(inngestFunctions).toContain("advanceConversationState: false");
    expect(inngestFunctions).toContain("re_extract_degraded_turns.recovered");
    expect(brain).toContain("decisionStageName?: string");
    expect(brain).toContain("advanceConversationState?: boolean");
    expect(brain).toContain("const advanceConversationState = input.advanceConversationState ?? true");
    expect(brain).toContain('stageName: input.decisionStageName ?? "director.turn"');
    expect(brain).toContain("if (advanceConversationState) {");
  });

  test("director voice env examples document full production configuration", () => {
    const frontendExample = read(".env.example");
    const workerExample = read("../agents/director/.env.example");
    const frontendReadme = read("README.md");
    const workerReadme = read("../agents/director/README.md");
    for (const key of [
      "LIVEKIT_URL",
      "LIVEKIT_API_KEY",
      "LIVEKIT_API_SECRET",
      "LIVEKIT_AGENT_NAME",
      "LIVEKIT_AGENT_SERVICE_TOKEN",
      "OTTO_INTERNAL_API_BASE_URL",
      "DATABASE_SERVICE_URL",
      "OTTO_USE_LIVEKIT_INFERENCE",
      "DEEPGRAM_API_KEY",
      "CARTESIA_API_KEY",
      "ANTHROPIC_API_KEY",
      "DIRECTOR_BRAIN_MODEL",
      "DIRECTOR_VOICE_MODEL",
      "OTTO_DIRECTOR_PREFLIGHT_STRICT",
      "OTTO_VENDOR_PRIVACY_ACK",
      "OTTO_DEEPGRAM_NO_STORE_ACK",
      "OTTO_CARTESIA_NO_RETENTION_ACK",
      "OTTO_ANTHROPIC_RAW_LOGGING_OFF_ACK",
    ]) {
      expect(frontendExample).toContain(key);
      expect(workerExample).toContain(key);
    }
    expect(workerExample).toContain("OTTO_CAPTURE_SESSION_ID");
    expect(workerExample).toContain("OTTO_DIRECTOR_PLANNER_RUNTIME");
    expect(workerExample).toContain("CARTESIA_VOICE_ID");
    for (const readme of [frontendReadme, workerReadme]) {
      expect(readme).toContain("otto-director-session-verify");
      expect(readme).toContain("--env-file .env");
      expect(readme).toContain("--app-env-file ../../otto-frontend/.env.local");
      expect(readme).toContain("--strict-voice-env");
    }
  });

  test("synthesis handoff waits for backend synthesis status before overview navigation", () => {
    const synthesisClient = read("app/synthesis/SynthesisClient.tsx");
    const statusRoute = read("app/api/synthesis/status/route.ts");
    const transcriptChat = read("components/onboarding/TranscriptChat.tsx");
    const uploadClient = read("app/onboarding/upload/UploadClient.tsx");

    expect(synthesisClient).toContain("/api/synthesis/status");
    expect(synthesisClient).toContain("sp.get(\"workspace_id\")");
    expect(synthesisClient).toContain("new URLSearchParams()");
    expect(synthesisClient).toContain('params.set("workspace_id", workspaceId)');
    expect(synthesisClient).toContain("appendCaptureContextToOverview");
    expect(synthesisClient).toContain("params.set(\"capture_session_id\", context.captureSessionId)");
    expect(synthesisClient).toContain("params.set(\"workspace_id\", context.workspaceId)");
    expect(synthesisClient).toContain("ready_for_overview");
    expect(synthesisClient).toContain("const synthesisBlocked");
    expect(synthesisClient).toContain("status.ready_for_overview !== true");
    expect(synthesisClient).toContain("!captureSessionId && !synthesisBlocked && statusTimedOut");
    expect(synthesisClient).toContain("const statusPollTimedOut");
    expect(synthesisClient).toContain("if (!captureSessionId) return");
    expect(synthesisClient).not.toContain("status?.terminal === true ||");
    expect(synthesisClient).toContain("STATUS_TIMEOUT_MS");
    expect(statusRoute).toContain("ensureWorkspaceRole");
    expect(statusRoute).toContain('searchParams.get("workspace_id")');
    expect(statusRoute).toContain("latestSynthesisRun");
    expect(statusRoute).toContain("getOverviewMetrics");
    expect(statusRoute).toContain("ready_for_overview");
    expect(statusRoute).toContain('latestRun?.status === "completed"');
    const overviewPage = read("app/overview/page.tsx");
    expect(overviewPage).toContain("capture_session_id");
    expect(overviewPage).toContain("workspace_id");
    expect(overviewPage).toContain("getWorkspaceForUser");
    expect(overviewPage).toContain("getWorkspaceForCaptureSession");
    expect(read("lib/overview/queries.ts")).toContain("captureSessionId");
    expect(transcriptChat).toContain("workspace_id=");
    expect(transcriptChat).toContain("session.workspaceId");
    expect(uploadClient).toContain("otto.phase0.workspaceId");
  });

  test("director model roles are independently configurable", () => {
    expect(
      anthropicModelForPrompt(
        {
          DIRECTOR_BRAIN_MODEL: "brain-model",
          DIRECTOR_VOICE_MODEL: "voice-model",
          SYNTHESIS_PLANNER_MODEL: "planner-model",
          ANTHROPIC_MODEL: undefined,
        },
        "director.turn.plan",
      ),
    ).toBe("brain-model");
    expect(
      anthropicModelForPrompt(
        {
          DIRECTOR_BRAIN_MODEL: undefined,
          DIRECTOR_VOICE_MODEL: "voice-model",
          SYNTHESIS_PLANNER_MODEL: undefined,
          ANTHROPIC_MODEL: undefined,
        },
        "director.voice.phrase-intent",
      ),
    ).toBe("voice-model");
    expect(
      anthropicModelForPrompt(
        {
          DIRECTOR_BRAIN_MODEL: undefined,
          DIRECTOR_VOICE_MODEL: undefined,
          SYNTHESIS_PLANNER_MODEL: undefined,
          ANTHROPIC_MODEL: undefined,
        },
        "director.turn.plan",
      ),
    ).toBe("claude-sonnet-4-6");
    expect(
      anthropicModelForPrompt(
        {
          DIRECTOR_BRAIN_MODEL: undefined,
          DIRECTOR_VOICE_MODEL: undefined,
          SYNTHESIS_PLANNER_MODEL: undefined,
          ANTHROPIC_MODEL: undefined,
        },
        "director.voice.phrase-intent",
      ),
    ).toBe("claude-haiku-4-5-20251001");
    expect(
      anthropicModelForPrompt(
        {
          DIRECTOR_BRAIN_MODEL: undefined,
          DIRECTOR_VOICE_MODEL: undefined,
          SYNTHESIS_PLANNER_MODEL: undefined,
          ANTHROPIC_MODEL: undefined,
        },
        "synthesis.inventory",
      ),
    ).toBe("claude-opus-4-7");
    expect(anthropicMaxTokensForPrompt("director.turn.plan")).toBe(8000);
    expect(anthropicMaxTokensForPrompt("director.voice.phrase-intent")).toBe(200);
    expect(anthropicMaxTokensForPrompt("document.extract-claims")).toBe(8000);
    expect(anthropicMaxTokensForPrompt("synthesis.inventory")).toBe(1200);
    expect(anthropicPricingForModel("claude-haiku-4-5").output).toBeLessThan(
      anthropicPricingForModel("claude-sonnet-4-6").output,
    );
    expect(anthropicPricingForModel("claude-opus-4-7").output).toBeGreaterThan(
      anthropicPricingForModel("claude-sonnet-4-6").output,
    );
  });

  test("document chunking preserves stable ordinals and readable text", () => {
    const chunks = chunkDocument(
      [
        "Process: Promotion Management",
        "Systems: Salesforce, Google Sheets",
        "Pain points: manual spreadsheet cleanup.",
      ].join("\n"),
      40,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain(
      "Promotion Management",
    );
  });

  test("structured adapter validates deterministic fallback and exposes forced failure", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const schema = z.object({ ok: z.boolean() });
    const result = await structured({
      prompt_template_id: "test.structured",
      schema_name: "test",
      schema,
      input: "Return ok",
      mock: { ok: true },
    });
    expect(result.value).toEqual({ ok: true });
    expect(result.metadata.mocked).toBe(true);
    expect(result.metadata.cache_hit).toBe(false);

    process.env.OTTO_LLM_FORCE_INVALID = "true";
    await expect(
      structured({
        prompt_template_id: "test.structured",
        schema_name: "test",
        schema,
        input: "Return ok",
        mock: { ok: true },
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    delete process.env.OTTO_LLM_FORCE_INVALID;
    if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
  });

  test("structured adapter retries once after local schema validation failure", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const schema = z.object({ ok: z.boolean() });
    const result = await structured({
      prompt_template_id: "test.structured.retry",
      schema_name: "test",
      schema,
      input: "Return ok",
      mock_sequence: [{ ok: "nope" }, { ok: true }],
    });
    expect(result.value).toEqual({ ok: true });
    if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
  });

  test("document inventory falls back to heuristic extraction when structured output fails", async () => {
    process.env.OTTO_LLM_FORCE_INVALID = "true";
    let candidates: Awaited<ReturnType<typeof extractDocumentInventory>>;
    try {
      candidates = await extractDocumentInventory(
        [
          "Process: Forecast Submission",
          "Owner: Finance Operations",
          "Frequency: weekly",
          "Systems: Google Sheets, Salesforce",
          "Pain points: manual spreadsheet cleanup.",
        ].join("\n"),
      );
    } finally {
      delete process.env.OTTO_LLM_FORCE_INVALID;
    }

    expect(candidates).toEqual([
      expect.objectContaining({
        processName: "Forecast Submission",
        ownerRole: "Finance Operations",
        frequency: "weekly",
        systems: ["Google Sheets", "Salesforce"],
      }),
    ]);
  });

  test("structured adapter parses Anthropic tool-use input when a tool schema is provided", async () => {
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "anthropic-test-key";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: Array<{ name: string; input_schema: unknown }>;
        tool_choice?: { type: string; name: string };
      };
      expect(body.tools?.[0]?.name).toBe("emit_test");
      expect(body.tool_choice).toEqual({ type: "tool", name: "emit_test" });
      expect(body.tools?.[0]?.input_schema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_test",
              input: { ok: true },
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 3,
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await structured({
        prompt_template_id: "test.structured.tool",
        schema_name: "test",
        schema: z.object({ ok: z.boolean() }),
        input: "Return ok",
        anthropic_tool: {
          name: "emit_test",
          description: "Emit test structured output.",
          input_schema: {
            type: "object",
            additionalProperties: false,
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
        },
      });

      expect(result.value).toEqual({ ok: true });
      expect(result.metadata.mocked).toBe(false);
      expect(result.metadata.cache_hit).toBe(true);
      expect(result.metadata.cache_read_input_tokens).toBe(3);
      expect(result.metadata.cache_creation_input_tokens).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      if (priorAnthropic) process.env.ANTHROPIC_API_KEY = priorAnthropic;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("embedding adapter reports lexical fallback when no provider key is configured", async () => {
    const priorVoyage = process.env.VOYAGE_API_KEY;
    const priorOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = await embedTextWithMetadata({
      prompt_template_id: "test.embed",
      text: "Promotion Management",
      dimensions: 8,
    });
    expect(result.provider).toBe("lexical-fallback");
    expect(result.lexicalFallback).toBe(true);
    expect(result.embedding).toHaveLength(8);
    if (priorVoyage) process.env.VOYAGE_API_KEY = priorVoyage;
    if (priorOpenAi) process.env.OPENAI_API_KEY = priorOpenAi;
  });

  test("batch embedding preserves provider metadata", async () => {
    const priorVoyage = process.env.VOYAGE_API_KEY;
    const priorOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const results = await embedBatch({
      prompt_template_id: "test.embed.batch",
      texts: ["one", "two"],
      dimensions: 4,
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.provider === "lexical-fallback")).toBe(
      true,
    );
    expect(results[0].embedding).toHaveLength(4);
    if (priorVoyage) process.env.VOYAGE_API_KEY = priorVoyage;
    if (priorOpenAi) process.env.OPENAI_API_KEY = priorOpenAi;
  });
});

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

function assertObjectSchemaShape(
  actual: unknown,
  expected: {
    required?: string[];
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  },
) {
  expect(actual).toMatchObject({
    type: "object",
    additionalProperties: expected.additionalProperties,
    required: expected.required,
  });
  expect(
    Object.keys((actual as { properties?: Record<string, unknown> }).properties ?? {}).sort(),
  ).toEqual(Object.keys(expected.properties ?? {}).sort());
}
