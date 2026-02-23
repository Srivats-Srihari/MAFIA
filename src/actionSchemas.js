function safeParseJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function toNightAction(raw) {
  const o = safeParseJson(raw);
  if (!o || typeof o !== "object") return null;
  if (o.__error) return null;
  if (typeof o.action !== "string") return null;
  return {
    action: typeof o.action === "string" ? o.action : "DoNothing",
    target: typeof o.target === "string" ? o.target : "",
    dialogue: typeof o.dialogue === "string" ? o.dialogue : "",
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    investigationResult: typeof o.investigationResult === "string" ? o.investigationResult : "Unknown",
    internal_analysis: o.internal_analysis && typeof o.internal_analysis === "object" ? o.internal_analysis : {}
  };
}

function toDiscussionAction(raw) {
  const o = safeParseJson(raw);
  if (!o || typeof o !== "object") return null;
  if (o.__error) return null;
  if (typeof o.dialogue !== "string" && typeof o.shouldSpeak !== "boolean") return null;
  return {
    dialogue: typeof o.dialogue === "string" ? o.dialogue : "",
    shouldSpeak: typeof o.shouldSpeak === "boolean" ? o.shouldSpeak : (String(o.dialogue || "").trim().length > 0),
    strategy_notes: typeof o.strategy_notes === "string" ? o.strategy_notes : "",
    internal_analysis: o.internal_analysis && typeof o.internal_analysis === "object" ? o.internal_analysis : {}
  };
}

function toVoteAction(raw) {
  const o = safeParseJson(raw);
  if (!o || typeof o !== "object") return null;
  if (o.__error) return null;
  if (typeof o.vote !== "string") return null;
  return {
    vote: typeof o.vote === "string" ? o.vote : "",
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    internal_analysis: o.internal_analysis && typeof o.internal_analysis === "object" ? o.internal_analysis : {}
  };
}

module.exports = {
  safeParseJson,
  toNightAction,
  toDiscussionAction,
  toVoteAction
};
