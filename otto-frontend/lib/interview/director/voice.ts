import "server-only";

import { generate, generateStream, type Generation } from "@/lib/adapters/llm";
import { getServerEnv } from "@/lib/env";
import { limitToSingleQuestion } from "@/lib/interview/_core/utterance";
import { fallbackProbeForSlot, type ProbeIntent } from "@/lib/interview/director/probe-library";
import type { DirectorInterviewPhase, DirectorTurnPlan } from "@/lib/schemas/phase1";

export function phraseProbe(intent: ProbeIntent) {
  return limitToSingleQuestion(intent.phrasing || fallbackProbeForSlot(intent.targetSlot).phrasing);
}

export type PhrasedDirectorTurn = {
  utterance: string;
  metadata: Omit<Generation, "text">;
};

type PhraseableDirectorPlan = Omit<DirectorTurnPlan, "planned_agent_utterance"> & {
  planned_agent_utterance?: string;
};

/**
 * Explicit steering sections for the voice phraser. Passed as labeled prompt
 * sections (not a JSON pseudo-turn) so the fast model treats the directive as
 * binding rather than background noise.
 */
export type DirectorVoiceSteering = {
  directive: string;
  anchorPhrasings: string[];
  doNotAsk: string[];
  verbatimRequired: boolean;
  requiredStyle?: string;
};

export async function phraseDirectorTurn(input: {
  plan: DirectorTurnPlan;
  recentTurns: string[];
  coverageSummary: string;
  focusProcessName?: string;
  forceSeparateVoiceLlm?: boolean;
}) {
  const phrased = await phraseDirectorTurnDetailed(input);
  return phrased.utterance;
}

export async function phraseDirectorTurnDetailed(input: {
  plan: DirectorTurnPlan;
  recentTurns: string[];
  coverageSummary: string;
  focusProcessName?: string;
  forceSeparateVoiceLlm?: boolean;
  steering?: DirectorVoiceSteering;
  onTextDelta?: (delta: string, textSoFar: string) => void | Promise<void>;
}): Promise<PhrasedDirectorTurn> {
  const started = Date.now();
  const targetPhraseRequired = mustSpeakDeterministicTargetPhrase(
    input.plan,
    input.focusProcessName,
  );
  // When verbatim escalation is active, the deterministic fallback is the
  // canonical probe phrasing itself. Concrete focus targets are stricter than
  // generic verbatim probes: if the controller selected a named process, the
  // spoken phrase must name that process.
  const verbatimAnchor =
    !targetPhraseRequired &&
    input.steering?.verbatimRequired &&
    input.steering.anchorPhrasings[0]
      ? input.steering.anchorPhrasings[0]
      : undefined;
  const fallback = limitToSingleQuestion(
    targetPhraseRequired
      ? deterministicPhrase(input.plan, input.focusProcessName)
      : verbatimAnchor ?? deterministicPhrase(input.plan, input.focusProcessName),
  );
  const env = getServerEnv();
  if (targetPhraseRequired) {
    await input.onTextDelta?.(fallback, fallback);
    return {
      utterance: fallback,
      metadata: deterministicVoiceMetadata(started, input, fallback, {
        reason: "required_target_phrase",
      }),
    };
  }
  if (verbatimAnchor) {
    // Verbatim escalation exists because the phraser ignored steering; asking
    // the same phraser to comply via prompt would re-trust the failing
    // component, and on the streaming path deltas reach TTS before any
    // post-generation check could override. Bypass generation entirely and
    // speak the canonical probe phrasing.
    await input.onTextDelta?.(fallback, fallback);
    return {
      utterance: fallback,
      metadata: deterministicVoiceMetadata(started, input, fallback, {
        reason: "verbatim_escalation",
      }),
    };
  }
  const useSeparateVoiceLlm =
    input.forceSeparateVoiceLlm ||
    process.env.OTTO_DIRECTOR_USE_SEPARATE_VOICE_LLM === "true";
  if (
    input.plan.planned_agent_utterance &&
    !useSeparateVoiceLlm
  ) {
    const utterance = limitToSingleQuestion(input.plan.planned_agent_utterance);
    return {
      utterance,
      metadata: brainPlannedVoiceMetadata(started, input, utterance, env),
    };
  }
  if (!useSeparateVoiceLlm) {
    return {
      utterance: fallback,
      metadata: deterministicVoiceMetadata(started, input, fallback, {
        reason: "missing_planned_agent_utterance",
      }),
    };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return {
      utterance: fallback,
      metadata: deterministicVoiceMetadata(started, input, fallback, {
        reason: "missing_anthropic_api_key",
      }),
    };
  }
  try {
    const commonInput = {
      prompt_template_id: "director.voice.phrase-intent",
      prompt_template_version: "1",
      static_input: [
        "You are Otto, a warm but efficient operations consultant.",
        "Phrase exactly one next thing to say to a VP/Director.",
        "Do not sound like a survey. Acknowledge what they said, then ask one targeted question.",
        "Keep it under 45 words unless answering a meta question.",
        "Anchor questions in concrete examples when possible.",
        "HARD RULES:",
        "- Your question MUST target the OBJECTIVE below. Never substitute a different topic.",
        "- The ANCHOR PHRASINGS show what to ask; adapt the wording to the conversation, never the target.",
        "- If VERBATIM REQUIRED is yes, speak the first anchor phrasing verbatim after a brief acknowledgment.",
        "- Never re-ask anything in DO NOT ASK, including paraphrases of it.",
        "- Director interviews stay at process level: never ask for step-by-step detail. If the director defers to an operator, acknowledge and move on.",
      ].join("\n"),
      dynamic_input: [
        directorSteeringPromptSections(input.steering),
        [
          `Phase: ${input.plan.proposed_next_phase}`,
          `Utterance type: ${input.plan.utterance_type}`,
          `Chosen intent: ${JSON.stringify(input.plan.chosen_intent)}`,
          input.focusProcessName ? `Focus process: ${input.focusProcessName}` : "",
          `Coverage: ${input.coverageSummary}`,
          "Recent turns:",
          ...input.recentTurns.slice(-4).map((turn) => `- ${turn}`),
        ]
          .filter(Boolean)
          .join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      input: "Return only the next sentence(s) Otto should say. No JSON.",
    };
    const result = input.onTextDelta
      ? await generateStream({
          ...commonInput,
          onTextDelta: input.onTextDelta,
        })
      : await generate(commonInput);
    const utterance = limitToSingleQuestion(result.text.trim() || fallback);
    if (voicePhraseMissesRequiredTarget(input.plan, utterance, input.focusProcessName)) {
      return {
        utterance: fallback,
        metadata: deterministicVoiceMetadata(started, input, fallback, {
          reason: "voice_phrase_missed_required_target",
        }),
      };
    }
    return {
      utterance,
      metadata: {
        ...generationMetadata(result),
        utterance_source: "separate_voice_llm",
      } as Omit<Generation, "text">,
    };
  } catch {
    return {
      utterance: fallback,
      metadata: deterministicVoiceMetadata(started, input, fallback, {
        reason: "voice_phrase_failed",
      }),
    };
  }
}

function mustSpeakDeterministicTargetPhrase(
  plan: DirectorTurnPlan,
  focusProcessName?: string,
) {
  return (
    plan.chosen_intent.intent === "select_process_to_expand" &&
    Boolean(plan.chosen_intent.target_process ?? focusProcessName)
  );
}

function voicePhraseMissesRequiredTarget(
  plan: DirectorTurnPlan,
  utterance: string,
  focusProcessName?: string,
) {
  if (plan.chosen_intent.intent !== "select_process_to_expand") return false;
  const target = plan.chosen_intent.target_process ?? focusProcessName;
  if (!target) return false;
  const targetTokens = normalizedVoiceTokens(target);
  if (targetTokens.length === 0) return false;
  const utteranceTokens = new Set(normalizedVoiceTokens(utterance));
  return !targetTokens.some((token) => utteranceTokens.has(token));
}

function normalizedVoiceTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function directorSteeringPromptSections(steering?: DirectorVoiceSteering) {
  if (!steering) return "";
  const sections = [
    "## OBJECTIVE (your question MUST target this)",
    steering.directive,
  ];
  if (steering.anchorPhrasings.length > 0) {
    sections.push(
      "## ANCHOR PHRASINGS (adapt wording to the conversation, never the target)",
      ...steering.anchorPhrasings.map((phrasing) => `- ${phrasing}`),
    );
  }
  sections.push(
    "## VERBATIM REQUIRED",
    steering.verbatimRequired
      ? "Yes. Speak the first anchor phrasing verbatim after a brief acknowledgment."
      : "No. Adapt the anchors naturally.",
  );
  if (steering.doNotAsk.length > 0) {
    sections.push(
      "## DO NOT ASK (already covered, pending, or just asked)",
      ...steering.doNotAsk.slice(0, 12).map((item) => `- ${item}`),
    );
  }
  if (steering.requiredStyle) {
    sections.push("## STYLE", steering.requiredStyle);
  }
  return sections.join("\n");
}

function brainPlannedVoiceMetadata(
  started: number,
  input: {
    plan: DirectorTurnPlan;
    recentTurns: string[];
    coverageSummary: string;
    focusProcessName?: string;
  },
  output: string,
  env: ReturnType<typeof getServerEnv>,
): Omit<Generation, "text"> {
  const inputText = JSON.stringify({
    chosenIntent: input.plan.chosen_intent,
    plannedAgentUtterance: input.plan.planned_agent_utterance,
    focusProcessName: input.focusProcessName,
  });
  return {
    model: env.DIRECTOR_BRAIN_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    prompt_template_id: "director.voice.phrase-intent",
    prompt_template_version: "1",
    token_count_input: estimateTokens(inputText),
    token_count_output: estimateTokens(output),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_cents: 0,
    latency_ms: Math.max(1, Date.now() - started),
    cache_hit: false,
    mocked: false,
    source: "brain_planned_utterance",
    utterance_source: "brain_planned_utterance",
    llm_call_elided: true,
  } as Omit<Generation, "text">;
}

function deterministicVoiceMetadata(
  started: number,
  input: {
    plan: DirectorTurnPlan;
    recentTurns: string[];
    coverageSummary: string;
    focusProcessName?: string;
  },
  output: string,
  options: { reason?: string } = {},
): Omit<Generation, "text"> {
  const inputText = JSON.stringify({
    plan: input.plan,
    recentTurns: input.recentTurns.slice(-4),
    coverageSummary: input.coverageSummary,
    focusProcessName: input.focusProcessName,
  });
  return {
    model: "deterministic-local-voice",
    prompt_template_id: "director.voice.phrase-intent",
    prompt_template_version: "1",
    token_count_input: estimateTokens(inputText),
    token_count_output: estimateTokens(output),
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_cents: 0,
    latency_ms: Math.max(1, Date.now() - started),
    cache_hit: false,
    mocked: true,
    utterance_source: "deterministic_phrase_fallback",
    reason: options.reason,
    llm_call_elided: true,
  } as Omit<Generation, "text">;
}

function estimateTokens(input: string) {
  return Math.max(1, Math.ceil(input.length / 4));
}

function generationMetadata(result: Generation): Omit<Generation, "text"> {
  return {
    model: result.model,
    prompt_template_id: result.prompt_template_id,
    prompt_template_version: result.prompt_template_version,
    token_count_input: result.token_count_input,
    token_count_output: result.token_count_output,
    cache_read_input_tokens: result.cache_read_input_tokens,
    cache_creation_input_tokens: result.cache_creation_input_tokens,
    cost_cents: result.cost_cents,
    latency_ms: result.latency_ms,
    cache_hit: result.cache_hit,
    mocked: result.mocked,
  };
}

export { limitToSingleQuestion } from "@/lib/interview/_core/utterance";

export function deterministicPhrase(
  plan: PhraseableDirectorPlan,
  focusProcessName?: string,
) {
  const target = plan.chosen_intent.target_process ?? focusProcessName;
  if (
    plan.chosen_intent.intent === "open_questions_closeout" ||
    plan.chosen_intent.intent === "playback_summary"
  ) {
    return intentPhrase(plan, target);
  }
  const withEscalation = (phrase: string) => lastAttemptPhrase(plan, phrase);
  if (plan.chosen_intent.intent === "select_process_to_expand" && target) {
    return intentPhrase(plan, target);
  }
  switch (plan.utterance_type) {
    case "greeting":
      return "Hi. I'm going to build a high-level map of the processes you own: outcomes, people, systems, cadence, metrics, and friction. To start, what part of the business do you oversee?";
    case "meta_question":
      return `We're mapping how your function operates so Otto can turn it into evidence-backed process cards and drilldown recommendations. ${intentPhrase(plan, target)}`;
    case "dont_know":
      if (plan.chosen_intent.style_hint?.includes("broaden_low_info")) {
        return withEscalation("Let's make this easier: what are the three things your team is asked to do most often in a normal week?");
      }
      return withEscalation("That's okay. Let's come at it from another angle: what are the three recurring things your team gets asked to handle most often?");
    case "non_answer":
      if (plan.chosen_intent.style_hint?.includes("broaden_low_info")) {
        return withEscalation("Let's make this easier: what are the three things your team is asked to do most often in a normal week?");
      }
      return withEscalation("No worries. Put another way, what area of the business should I understand first: the team you run, the workflows you own, or the systems your team lives in?");
    case "clarification_request":
      return clarificationPhrase(plan, target);
    case "off_topic":
      return "Happy to come back to that later. For now, what recurring process should we map next?";
    case "correction":
      return target
        ? `Got it, I'll treat that as a correction for ${target}. What should the ownership or process detail be instead?`
        : "Got it, I'll treat that as a correction. What should I update in the process map?";
    case "contradiction":
      return target
        ? `That sounds different from what I had for ${target}. Which version should I trust for the process map?`
        : "That sounds different from what I had earlier. Which version should I trust for the process map?";
    case "partial_answer":
      return withEscalation(partialFollowUp(plan, target));
    default:
      return withEscalation(intentPhrase(plan, target));
  }
}

function lastAttemptPhrase(plan: PhraseableDirectorPlan, phrase: string) {
  if (!plan.chosen_intent.style_hint?.includes("last_attempt")) return phrase;
  return `Last try on this one before I mark it as unknown: ${lowercaseFirst(phrase)}`;
}

function lowercaseFirst(value: string) {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function clarificationPhrase(plan: PhraseableDirectorPlan, target?: string) {
  if (plan.chosen_intent.target_slot === "systems.systems_of_record") {
    return target
      ? `By systems of record, I mean the tools people trust as the source of truth, like Salesforce, NetSuite, or Sheets. Which systems does ${target} rely on?`
      : "By systems of record, I mean the tools people trust as the source of truth, like Salesforce, NetSuite, or Sheets. Which systems does this work rely on?";
  }
  return "I mean the recurring work your team is responsible for: who is involved, the systems it runs through, and the outcome it produces. What part of that should we start with?";
}

function partialFollowUp(plan: PhraseableDirectorPlan, target?: string) {
  if (plan.chosen_intent.intent === "discover_processes") {
    return "Got it. Could you give me the rough list of recurring processes your team owns? Names are enough for now.";
  }
  if (target) {
    return `Got it. For ${target}, what outcome is that process responsible for?`;
  }
  return "Got it. Can you make that concrete with one recurring process your team owns?";
}

function intentPhrase(plan: PhraseableDirectorPlan, target?: string) {
  switch (plan.chosen_intent.intent) {
    case "discover_function":
    case "orient_interview":
      return "What part of the business do you oversee?";
    case "discover_processes":
      return "What are the main recurring processes your team owns? A rough list is fine.";
    case "select_process_to_expand":
      return target
        ? `Let's zoom into ${target}. Where does it start?`
        : "Which of those processes is most important or most painful to zoom into next?";
    case "define_process_boundary":
      return target
        ? `For ${target}, where does the process begin and end?`
        : "Where does that process begin and end?";
    case "capture_outcome":
      return target
        ? `What outcome is ${target} supposed to produce for the business?`
        : "What outcome is this process supposed to produce for the business?";
    case "capture_owner_roles":
      return target
        ? `Who is accountable for ${target}?`
        : "Who is accountable for that process?";
    case "capture_systems":
      return target
        ? `Which systems of record, spreadsheets, or shadow tools does the team use for ${target}?`
        : "Which systems of record, spreadsheets, or shadow tools does the team use for this?";
    case "quantify_frequency_volume":
      return target
        ? `How often does ${target} happen?`
        : "How often does this happen?";
    case "capture_metrics":
      return target
        ? `How do you measure whether ${target} is working well?`
        : "How do you measure whether this process is working well?";
    case "capture_friction":
      return target
        ? `Where does ${target} slow down, break, or require manual cleanup today?`
        : "Where does this work slow down, break, or require manual cleanup today?";
    case "capture_dependencies":
      return target
        ? `What upstream inputs does ${target} depend on?`
        : "What upstream inputs does this depend on?";
    case "capture_risk_spof":
      return target
        ? `Is any part of ${target} dependent on one person, tribal knowledge, or a fragile workaround?`
        : "Is any part of this dependent on one person, tribal knowledge, or a fragile workaround?";
    case "playback_summary":
      return "Let me play back what I have so far, then you can tell me what I missed.";
    case "open_questions_closeout":
      return "Before we wrap, I still have a few gaps. Can we quickly cover the biggest one?";
    default:
      return phaseFallback(plan.proposed_next_phase);
  }
}

function phaseFallback(phase: DirectorInterviewPhase) {
  switch (phase) {
    case "orient":
      return "What part of the business do you oversee?";
    case "inventory":
      return "What are the main recurring processes your team owns?";
    case "expand":
      return "Which process should we zoom into next?";
    case "enrich":
      return "Where does that process connect to other teams, systems, or metrics?";
    case "closeout":
      return "Let me summarize what I have and check what I missed.";
  }
}
