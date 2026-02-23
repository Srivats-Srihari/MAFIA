const { Role, Phase } = require("./roles");
const { puterChat } = require("./puterClient");
const { loadEnvFile } = require("./envLoader");
loadEnvFile();

function hashString(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return Math.abs(h >>> 0);
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function parsePossibleJson(raw) {
  const t = String(raw || "").trim().replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (_) {}

  let start = -1;
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === "\"") inQuote = false;
      continue;
    }
    if (c === "\"") {
      inQuote = true;
      continue;
    }
    if (c === "{" || c === "[") {
      if (start < 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = t.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(candidate) };
        } catch (err) {
          return { ok: false, message: err.message };
        }
      }
    }
  }
  return { ok: false, message: "No JSON object found." };
}

class AIManager {
  constructor() {
    this.defaultModel = process.env.PUTER_MODEL || "gpt-5.2";
    this.usePuter = process.env.MAFIA_USE_PUTER === "1";
    this.maxRetries = Number(process.env.MAFIA_MAX_RETRIES || 2);
    this.availableModels = this.buildAvailableModels();
    this.agentNames = this.buildAgentNames();
    this.lastGoodActionByPlayerPhase = new Map();
    this.strictAiMode = process.env.MAFIA_STRICT_AI !== "0";
  }

  setUsePuter(on) {
    this.usePuter = !!on;
  }

  setDefaultModel(model) {
    const m = String(model || "").trim();
    if (!m) return false;
    this.defaultModel = m;
    this.agentNames = this.buildAgentNames();
    return true;
  }

  getAvailableModels() {
    return this.availableModels.slice();
  }

  getPreferredPlayerNames(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(this.agentNames[i % this.agentNames.length]);
    }
    return out;
  }

  async requestDecision(player, phase, state, modelOverride = null) {
    const primaryModel = modelOverride || this.defaultModel;
    if (!player || !state) {
      return JSON.stringify({ __error: true, message: "Invalid AI request." });
    }
    if (!this.usePuter) {
      return this.stubDecision(player, phase, state);
    }

    const schema = this.schemaFor(player.role, phase);
    const modelChain = this.buildModelChain(primaryModel);
    let lastError = "unknown_error";
    let lastRaw = "";

    for (let attempt = 0; attempt < modelChain.length; attempt++) {
      const model = modelChain[attempt];
      const contextTier = attempt === 0 ? "full" : (attempt === 1 ? "medium" : "minimal");
      const basePrompt = this.buildPrompt(player, phase, state, schema, contextTier);
      const analysisSchema = '{ "suspicions": { "<playerId>": 0-100 }, "contradictions":[{"playerId":"<id>","lines":["..."]}], "most_suspicious":"<playerId>", "flipCandidates":["<id>"], "confidence":0-100, "plan":"<short>", "monologue":"<multi-sentence private reasoning>" }';
      const analysisPrompt = [
        basePrompt,
        "",
        "Stage A: Internal analysis only.",
        "Return exactly one JSON object with this schema:",
        analysisSchema
      ].join("\n");

      const analysis = await this.requestJsonWithRetry(analysisPrompt, analysisSchema, model);
      if (analysis && analysis.__error) {
        lastError = analysis.message || "analysis_error";
        lastRaw = analysis.raw || "";
        continue;
      }

      const finalPrompt = [
        basePrompt,
        "",
        "Stage B: Final public action.",
        "Internal analysis JSON:",
        JSON.stringify(analysis && !analysis.__error ? analysis : {}),
        "Return only the final public JSON following the schema."
      ].join("\n");

      const finalRawOrObj = await this.requestJsonWithRetry(finalPrompt, schema, model);
      if (finalRawOrObj && finalRawOrObj.__error) {
        lastError = finalRawOrObj.message || "json_error";
        lastRaw = finalRawOrObj.raw || "";
        continue;
      } else {
        const repaired = this.repairAndValidateDecision(player, phase, state, finalRawOrObj, analysis, model);
        if (repaired) {
          const key = `${player.id}|${phase}`;
          this.lastGoodActionByPlayerPhase.set(key, repaired);
          return JSON.stringify(repaired);
        }
        lastError = "schema_validation_failed";
        lastRaw = JSON.stringify(finalRawOrObj || {});
        continue;
      }
    }

    // Last-resort: reuse last valid output for this player+phase.
    const cachedKey = `${player.id}|${phase}`;
    const cached = this.lastGoodActionByPlayerPhase.get(cachedKey);
    if (cached) {
      const withMeta = {
        ...cached,
        internal_analysis: {
          ...(cached.internal_analysis || {}),
          source: "cached_last_good",
          error: lastError
        }
      };
      return JSON.stringify(withMeta);
    }

    if (this.strictAiMode && this.usePuter) {
      return JSON.stringify({ __error: true, fatal: true, message: `AI decision failed: ${lastError}`, raw: lastRaw });
    }
    return this.makeFallbackDecision(player, phase, state, lastError, lastRaw);
  }

  async requestJsonWithRetry(prompt, schema, model) {
    let currentPrompt = prompt;
    let lastRaw = "";
    for (let i = 0; i <= this.maxRetries; i++) {
      try {
        lastRaw = await puterChat(currentPrompt, model);
        const parsed = parsePossibleJson(lastRaw);
        if (parsed.ok) return parsed.value;
        if (i < this.maxRetries) {
          currentPrompt =
            "Your previous output was invalid JSON. Return only valid JSON matching this schema: " +
            schema +
            ". Output must be a single JSON object and nothing else.\n\nOriginal prompt:\n" +
            prompt;
        }
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (i >= this.maxRetries) {
          return { __error: true, message: msg, raw: lastRaw };
        }
      }
    }
    return { __error: true, message: "invalid_json", raw: lastRaw };
  }

  buildPrompt(player, phase, state, schema, contextTier) {
    const alive = state.getAlivePlayers().map((p) => `${p.displayName}(${p.id})`);
    const dead = state.players.filter((p) => !p.isAlive).map((p) => `${p.displayName}(${p.id})`);
    const mem = state.getCompressedMemoryBlock(player.id);
    const objective = this.objectiveFor(player.role, phase);
    const personality = this.personalityFor(player.id);

    let summary = mem.summary || "<none>";
    let dayMemory = mem.dayMemory || "<none yet>";
    let recent = mem.recentTranscript || "<empty>";
    if (contextTier === "medium") {
      summary = String(summary).slice(-1800);
      dayMemory = String(dayMemory).slice(-1400);
      recent = String(recent).slice(-1600);
    } else if (contextTier === "minimal") {
      summary = String(summary).slice(-900);
      dayMemory = String(dayMemory).slice(-500);
      recent = String(recent).slice(-700);
    }

    return [
      "You are playing a competitive Mafia game. Use strategic, coherent logic.",
      `Identity: You are ${player.displayName} (${player.id}).`,
      "Speak as yourself in FIRST PERSON (I/me/my). Never refer to yourself in third person by your own name.",
      `Your role: ${player.role}`,
      `Current phase: ${phase}`,
      `Objective: ${objective}`,
      `PERSONALITY: aggression=${personality.aggression}, subtlety=${personality.subtlety}, riskTolerance=${personality.riskTolerance}`,
      `Alive players: ${JSON.stringify(alive)}`,
      `Dead players: ${JSON.stringify(dead)}`,
      "",
      "COMPRESSED OLDER MEMORY:",
      summary,
      "",
      "CURRENT DAY MEMORY (verbatim):",
      dayMemory,
      "",
      "YOUR NIGHT ACTION MEMORY:",
      mem.personalNight || "<none>",
      "",
      "RECENT VERBATIM TRANSCRIPT:",
      recent,
      "",
      "Decision rules:",
      "1) Prefer actions with concrete evidence from transcript and role constraints.",
      "2) Avoid generic statements; include one specific suspicion or defense.",
      "3) Do not self-target for kill/save/investigate/vote.",
      "4) Use player DISPLAY NAMES in dialogue/reasoning (Alpha, Delta, etc.).",
      "5) Act to win for your role every phase: night actions must be purposeful, day talk must influence votes.",
      "6) Never output placeholders like 'nothing to add' unless fully justified by state contradictions.",
      "7) Mention at least one specific player name in discussion or vote reasoning.",
      "8) In discussion phase, if you truly want to pass, set shouldSpeak=false and keep dialogue empty.",
      "9) Do not accuse any player as Mafia without evidence. If evidence is weak, ask questions instead of hard accusations.",
      "10) internal_analysis.monologue must be detailed (4-8 sentences), strategic, and evidence-based.",
      "11) Discussion dialogue should be substantive: 3-6 sentences unless tactical silence is chosen.",
      "",
      "Required output schema:",
      schema,
      "",
      "Return only valid JSON matching the schema. No markdown, no commentary, no extra text.",
      'If private reasoning is included, place it under "internal_analysis".'
    ].join("\n");
  }

  objectiveFor(role, phase) {
    if (phase === Phase.Night) {
      if (role === Role.Mafia) return "Eliminate a town-aligned threat while avoiding detection.";
      if (role === Role.Doctor) return "Protect a likely Mafia target and keep town power roles alive.";
      if (role === Role.Detective) return "Investigate highest-value suspect to improve tomorrow's vote.";
      return "Survive the night.";
    }
    if (phase === Phase.Voting) {
      if (role === Role.Mafia) return "Redirect votes away from Mafia and secure a town elimination.";
      if (role === Role.Jester) return "Attract votes to yourself without obvious trolling.";
      return "Eliminate the most likely Mafia based on claims and contradictions.";
    }
    if (role === Role.Mafia) return "Shape discussion to frame town targets and avoid your own exposure.";
    if (role === Role.Jester) return "Create controlled chaos and appear suspicious enough to attract votes.";
    return "Build consensus using specific contradictions and evidence.";
  }

  personalityFor(playerId) {
    const seed = hashString(String(playerId || "p"));
    return {
      aggression: 25 + (seed % 71),
      subtlety: 20 + ((seed >> 4) % 71),
      riskTolerance: 20 + ((seed >> 8) % 71)
    };
  }

  schemaFor(role, phase) {
    if (phase === Phase.Night && role === Role.Mafia) {
      return '{ "action":"Kill|DoNothing", "target":"<playerName or playerId>", "dialogue":"<text>", "internal_analysis":{"most_suspicious":"<id>","suspicions":{"<id>":0-100},"confidence":0-100} }';
    }
    if (phase === Phase.Night && role === Role.Doctor) {
      return '{ "action":"Save|DoNothing", "target":"<playerName or playerId>", "dialogue":"", "internal_analysis":{"most_suspicious":"<id>","suspicions":{"<id>":0-100},"confidence":0-100} }';
    }
    if (phase === Phase.Night && role === Role.Detective) {
      return '{ "action":"Investigate|DoNothing", "target":"<playerName or playerId>", "dialogue":"", "investigationResult":"Town|Mafia|Unknown", "internal_analysis":{"most_suspicious":"<id>","suspicions":{"<id>":0-100},"confidence":0-100} }';
    }
    if (phase === Phase.Voting) {
      return '{ "vote":"<playerName or playerId>", "reasoning":"<text>", "internal_analysis":{"most_suspicious":"<id>","suspicions":{"<id>":0-100},"confidence":0-100} }';
    }
    return '{ "shouldSpeak": true|false, "dialogue":"<text>", "strategy_notes":"<text>", "internal_analysis":{"most_suspicious":"<id>","suspicions":{"<id>":0-100},"confidence":0-100} }';
  }

  repairAndValidateDecision(player, phase, state, finalObj, analysis, modelUsed) {
    const o = finalObj && typeof finalObj === "object" ? { ...finalObj } : null;
    if (!o) return null;
    const alive = state.getAlivePlayers();
    const fallbackTarget = this.pickTarget(player.id, alive);

    if (phase === Phase.Night) {
      if (!o.action || typeof o.action !== "string") return null;
      if (player.role === Role.Mafia && !["Kill", "DoNothing"].includes(o.action)) o.action = "DoNothing";
      if (player.role === Role.Doctor && !["Save", "DoNothing"].includes(o.action)) o.action = "DoNothing";
      if (player.role === Role.Detective && !["Investigate", "DoNothing"].includes(o.action)) o.action = "DoNothing";
      const target = this.extractPlayerIdFromText(String(o.target || ""), alive, player.id) || fallbackTarget || "";
      o.target = o.action === "DoNothing" ? "" : target;
      if (typeof o.dialogue !== "string") o.dialogue = "";
      o.dialogue = this.rewriteSelfReference(o.dialogue, player, state);
      if (player.role === Role.Detective) {
        if (!["Town", "Mafia", "Unknown"].includes(String(o.investigationResult || ""))) {
          o.investigationResult = "Unknown";
        }
      } else {
        delete o.investigationResult;
      }
    } else if (phase === Phase.Voting) {
      const target = this.extractPlayerIdFromText(String(o.vote || ""), alive, player.id) || fallbackTarget || "";
      o.vote = target;
      if (typeof o.reasoning !== "string") o.reasoning = "Strategic pressure vote.";
      o.reasoning = this.rewriteSelfReference(o.reasoning, player, state);
      if (!this.hasEvidenceForTarget(target, player, state, o.reasoning)) {
        o.reasoning = `I am voting ${this.prettyName(state, target)} based on current pressure, but evidence is limited and I want more claims reviewed.`;
      }
      o.reasoning = o.reasoning;
    } else {
      if (typeof o.shouldSpeak !== "boolean") o.shouldSpeak = true;
      if (typeof o.dialogue !== "string") o.dialogue = "";
      if (o.shouldSpeak && !o.dialogue.trim()) return null;
      o.dialogue = this.rewriteSelfReference(o.dialogue, player, state);
      const accusedTarget = this.extractPlayerIdFromText(o.dialogue, alive, player.id);
      if (accusedTarget && this.isHardAccusation(o.dialogue) && !this.hasEvidenceForTarget(accusedTarget, player, state, o.dialogue)) {
        o.dialogue = `I need stronger evidence before accusing ${this.prettyName(state, accusedTarget)}. What contradictions do we have?`;
      }
      if (typeof o.strategy_notes !== "string") o.strategy_notes = "";
    }

    if (!o.internal_analysis || typeof o.internal_analysis !== "object") {
      o.internal_analysis = analysis && !analysis.__error ? analysis : {};
    }
    o.internal_analysis.model = modelUsed;
    if (typeof o.internal_analysis.monologue !== "string" || !o.internal_analysis.monologue.trim()) {
      o.internal_analysis.monologue = this.buildMonologue(player, state, o);
    }
    return o;
  }

  makeFallbackDecision(player, phase, state, reason, raw) {
    const alive = state.getAlivePlayers();
    const target = this.pickTarget(player.id, alive);
    const analysis = this.makeInternalAnalysis(player.id, alive, target);
    analysis.error = reason || "fallback";
    analysis.raw_excerpt = typeof raw === "string" ? String(raw).slice(0, 220) : "";
    analysis.source = "fallback_or_salvage";
    analysis.monologue = this.buildMonologue(player, state, { target, phase });

    const cleanedRaw = this.cleanRawDialogue(raw);
    const extractedTarget = this.extractPlayerIdFromText(cleanedRaw, alive, player.id) || target;

    if (phase === Phase.Night) {
      if (player.role === Role.Mafia) {
        return JSON.stringify({
          action: "Kill",
          target: extractedTarget || "",
          dialogue: cleanedRaw || "I will act under cover of darkness.",
          internal_analysis: analysis
        });
      }
      if (player.role === Role.Doctor) {
        return JSON.stringify({
          action: "Save",
          target: extractedTarget || "",
          dialogue: "",
          internal_analysis: analysis
        });
      }
      if (player.role === Role.Detective) {
        return JSON.stringify({
          action: "Investigate",
          target: extractedTarget || "",
          dialogue: "",
          investigationResult: "Unknown",
          internal_analysis: analysis
        });
      }
      return JSON.stringify({
        action: "DoNothing",
        target: "",
        dialogue: "",
        internal_analysis: analysis
      });
    }

    if (phase === Phase.Voting) {
      return JSON.stringify({
        vote: extractedTarget || "",
        reasoning: cleanedRaw || `I vote ${this.prettyName(state, extractedTarget || target)} based on pressure and contradictions.`,
        internal_analysis: analysis
      });
    }

    const discussionByRole = {
      [Role.Mafia]: `I want to review ${this.prettyName(state, target)}'s claims before we conclude anything.`,
      [Role.Doctor]: "Let's compare claims calmly before we rush a vote.",
      [Role.Detective]: "I want concrete accusations with reasons, not guesses.",
      [Role.Jester]: "If you suspect me, say it clearly and I'll respond.",
      [Role.Villager]: `I want clearer evidence about ${this.prettyName(state, target)} before committing to an accusation.`
    };

    return JSON.stringify({
      shouldSpeak: true,
      dialogue: cleanedRaw || discussionByRole[player.role] || "I am sharing a cautious read.",
      strategy_notes: "fallback-generated discussion line",
      internal_analysis: analysis
    });
  }

  stubDecision(player, phase, state) {
    if (phase === Phase.Night) return this.buildNightActionStub(player, state);
    if (phase === Phase.Discussion) return this.buildDiscussionActionStub(player, state);
    if (phase === Phase.Voting) return this.buildVoteActionStub(player, state);
    return JSON.stringify({ dialogue: "..." });
  }

  buildNightActionStub(player, state) {
    const alive = state.getAlivePlayers();
    const target = this.pickTarget(player.id, alive);
    const analysis = this.makeInternalAnalysis(player.id, alive, target);

    if (player.role === Role.Mafia) {
      return JSON.stringify({ action: "Kill", target, dialogue: "Let's remove uncertainty tonight.", internal_analysis: analysis });
    }
    if (player.role === Role.Doctor) {
      return JSON.stringify({ action: "Save", target: target || "", dialogue: "", internal_analysis: analysis });
    }
    if (player.role === Role.Detective) {
      return JSON.stringify({ action: "Investigate", target, dialogue: "", investigationResult: "Unknown", internal_analysis: analysis });
    }
    return JSON.stringify({ action: "DoNothing", target: "", dialogue: "", internal_analysis: analysis });
  }

  buildDiscussionActionStub(player, state) {
    const alive = state.getAlivePlayers();
    const target = this.pickTarget(player.id, alive);
    const analysis = this.makeInternalAnalysis(player.id, alive, target);
    return JSON.stringify({
      shouldSpeak: true,
      dialogue: `I currently suspect ${this.prettyName(state, target)}.`,
      strategy_notes: "Deterministic fallback strategy.",
      internal_analysis: analysis
    });
  }

  buildVoteActionStub(player, state) {
    const alive = state.getAlivePlayers();
    const target = this.pickTarget(player.id, alive);
    const analysis = this.makeInternalAnalysis(player.id, alive, target);
    return JSON.stringify({
      vote: target,
      reasoning: `Voting ${this.prettyName(state, target)} by consistency pressure.`,
      internal_analysis: analysis
    });
  }

  rewriteSelfReference(text, player, state) {
    let out = String(text || "");
    if (!out) return out;
    const escapedName = String(player.displayName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escapedName) {
      const selfNameRe = new RegExp(`\\b${escapedName}\\b`, "gi");
      out = out.replace(selfNameRe, "I");
      out = out.replace(/\bI is\b/gi, "I am");
      out = out.replace(/\bI was\b/gi, "I was");
    }
    // Keep references to other players as display names, not ids.
    for (const p of state.players || []) {
      if (!p || p.id === player.id) continue;
      const idRe = new RegExp(`\\b${String(p.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      out = out.replace(idRe, p.displayName);
    }
    return out;
  }

  pickTarget(selfId, alivePlayers) {
    const candidates = alivePlayers.filter((p) => p && p.id !== selfId);
    if (candidates.length === 0) return "";
    const idx = hashString(selfId + "|" + candidates.map((c) => c.id).join(",")) % candidates.length;
    return candidates[idx].id;
  }

  makeInternalAnalysis(selfId, alivePlayers, mostSuspicious) {
    const suspicions = {};
    for (const p of alivePlayers) {
      suspicions[p.id] = (hashString(selfId + ":" + p.id) % 81) + 10;
    }
    return {
      most_suspicious: mostSuspicious || "",
      suspicions,
      contradictions: [],
      flipCandidates: alivePlayers.map((p) => p.id).filter((id) => id !== selfId).slice(0, 3),
      confidence: (hashString(selfId) % 41) + 50,
      monologue:
        "I am tracking who is driving votes versus who is hedging. " +
        "I need to compare claims against timing and vote history before committing. " +
        "My current suspect has pressure but I still need contradiction-level evidence. " +
        "I will choose actions that improve information while protecting my role objective."
    };
  }

  buildAgentNames() {
    const envNames = String(process.env.PUTER_AGENT_NAMES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (envNames.length > 0) return envNames;

    const base = this.defaultModel || "gpt-5.2";
    return [
      `${base}-Alpha`,
      `${base}-Bravo`,
      `${base}-Charlie`,
      `${base}-Delta`,
      `${base}-Echo`,
      `${base}-Foxtrot`,
      `${base}-Gamma`,
      `${base}-Hotel`,
      `${base}-India`,
      `${base}-Juliet`
    ];
  }

  buildAvailableModels() {
    const fromEnv = String(process.env.PUTER_MODELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromEnv.length > 0) return Array.from(new Set(fromEnv));
    return [
      "gpt-5.2",
      "gpt-5.1",
      "gpt-4.1",
      "mistral-small-latest",
      "mistral-medium-latest",
      "mistral-large-latest",
      "claude-3.7-sonnet",
      "gemini-2.0-flash",
      "llama-3.3-70b"
    ];
  }

  buildModelChain(primaryModel) {
    const all = [primaryModel, ...this.availableModels].filter(Boolean);
    const uniq = [];
    for (const m of all) {
      if (!uniq.includes(m)) uniq.push(m);
    }
    return uniq.slice(0, 5);
  }

  isBudgetOrUsageError(msg) {
    const text = String(msg || "").toLowerCase();
    return (
      text.includes("insufficient_funds") ||
      text.includes("usage-limited-chat") ||
      text.includes("402") ||
      text.includes("payment required")
    );
  }

  cleanRawDialogue(raw) {
    if (!raw) return "";
    let text = String(raw).trim();
    const obj = safeJsonParse(text);
    if (obj && obj.message && typeof obj.message === "string") {
      text = obj.message;
    }
    text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
    if (text.startsWith("{") || text.startsWith("[")) return "";
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return "";
    const lower = text.toLowerCase();
    const blockedMarkers = [
      "you are an ai mafia player",
      "output schema",
      "alive players:",
      "dead players:",
      "transcript:",
      "return only valid json",
      "internal_analysis"
    ];
    for (const marker of blockedMarkers) {
      if (lower.includes(marker)) return "";
    }
    return text;
  }

  extractPlayerIdFromText(text, alivePlayers, selfId) {
    if (!text) return "";
    const lower = text.toLowerCase();
    for (const p of alivePlayers) {
      if (!p || p.id === selfId) continue;
      if (lower.includes(p.id.toLowerCase())) return p.id;
      if (lower.includes(String(p.displayName || "").toLowerCase())) return p.id;
    }
    return "";
  }

  prettyName(state, id) {
    if (!id) return "someone";
    const p = state.players.find((x) => x.id === id);
    return p ? p.displayName : id;
  }

  isHardAccusation(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    const markers = ["is mafia", "definitely mafia", "liar", "vote out", "must be mafia", "guilty"];
    return markers.some((m) => t.includes(m));
  }

  hasEvidenceForTarget(targetId, player, state, localText) {
    if (!targetId) return false;
    const mem = state.getCompressedMemoryBlock(player.id);
    const name = this.prettyName(state, targetId);
    const corpus = [
      String(localText || ""),
      String(mem.dayMemory || ""),
      String(mem.recentTranscript || ""),
      String(mem.summary || "")
    ].join("\n").toLowerCase();
    const mentionsTarget =
      corpus.includes(String(targetId).toLowerCase()) ||
      corpus.includes(String(name || "").toLowerCase());
    if (!mentionsTarget) return false;
    const evidenceWords = ["because", "since", "claimed", "said", "voted", "contradiction", "inconsistent", "timeline", "defended"];
    return evidenceWords.some((w) => corpus.includes(w));
  }

  buildMonologue(player, state, actionLike) {
    const mem = state.getCompressedMemoryBlock(player.id);
    const targetId =
      this.extractPlayerIdFromText(String((actionLike && (actionLike.target || actionLike.vote)) || ""), state.getAlivePlayers(), player.id) ||
      this.pickTarget(player.id, state.getAlivePlayers());
    const tName = this.prettyName(state, targetId);
    const dayMem = String(mem.dayMemory || "");
    const hasVoteRef = /vote|voted|eject|lynch/i.test(dayMem);
    const hasClaimRef = /claim|claimed|role|doctor|detective|mafia/i.test(dayMem);
    const line1 = `I am weighing ${tName} against the wider table pressure and my role objective as ${player.role}.`;
    const line2 = hasClaimRef
      ? "I see role-claim dynamics in recent dialogue, so I am checking consistency before making a hard push."
      : "I do not yet have enough hard claims, so I am prioritizing information gain over reckless certainty.";
    const line3 = hasVoteRef
      ? "Vote momentum is a key signal; I am tracking who is steering it versus who is opportunistically following."
      : "Without clear vote momentum, I should pressure for specific accusations and contradictions.";
    const line4 = "I will avoid random accusations and anchor decisions to transcript evidence, contradictions, and survivability.";
    const line5 = "If this read weakens, I should pivot quickly to the next strongest candidate rather than tunnel.";
    return [line1, line2, line3, line4, line5].join(" ");
  }
}

module.exports = {
  AIManager
};
