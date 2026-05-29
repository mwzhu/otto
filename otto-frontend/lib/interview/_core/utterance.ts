export function limitToSingleQuestion(utterance: string) {
  const normalized = utterance.replace(/\s+/g, " ").trim();
  const firstQuestion = normalized.indexOf("?");
  if (firstQuestion === -1) return normalized;
  const firstQuestionOnly = normalized.slice(0, firstQuestion + 1);
  return firstQuestionOnly.replace(
    /(?:,\s+|\s+)and\s+(?:what|who|which|where|how|when|why|is|are|does|do|can|could|would|should)\b[^?]*\?$/i,
    "?",
  );
}
