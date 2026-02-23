const fs = require("fs");
const path = require("path");
const { Role, Phase } = require("./roles");
const { PlayerData } = require("./playerData");
const { GameState } = require("./gameState");
const { AIManager } = require("./aiManager");
const { toNightAction, toDiscussionAction, toVoteAction } = require("./actionSchemas");

class GameManager {
  constructor(options = {}) {
    this.masterMode = !!options.masterMode;
    this.players = [];
    this.state = new GameState();
    this.ai = new AIManager();
    this.currentPhase = Phase.Night;
    this.winner = "";
    this.round = 1;
    this.maxSpeechCharsPerRound = Number(options.maxSpeechCharsPerRound || 20000);
    this.maxSpeechCharsPerMessage = Number(options.maxSpeechCharsPerMessage || 20000);
    this.spokenCharsThisRound = new Map();
    this.humanPlayerId = "";
    this.pendingHumanDiscussion = "";
    this.pendingHumanVote = "";
    this.pendingHumanNight = null;
    this.separateHumanPlayer = !!options.separateHumanPlayer;
    this.humanDisplayName = String(options.humanDisplayName || "You");
    this.playerCount = Math.max(5, Number(options.playerCount || 6));
    this.sessionId = 0;
    this.eliminationOrder = [];
    this.suspicionTimeline = [];
    this.playerModelById = new Map();
    this.playerModelPinned = new Set();
    this.rollingSummary = "";
    this.saveToFileMode = !!options.saveToFileMode;
    this.saveDir = String(options.saveDir || "saved_games");
    this.lastSavedPath = "";
    this.sessionTextSavePath = "";
    this.abortReason = "";
    this.alwaysWriteLogsToFile = options.alwaysWriteLogsToFile !== false;
  }

  setupGame(customNames = null, playerCountOverride = null) {
    const targetPlayerCount = Math.max(5, Number(playerCountOverride || this.playerCount || 6));
    this.playerCount = targetPlayerCount;
    this.sessionId += 1;
    const aiCount = this.separateHumanPlayer ? Math.max(4, targetPlayerCount - 1) : targetPlayerCount;
    const names = Array.isArray(customNames) && customNames.length >= aiCount
      ? customNames.slice(0, aiCount)
      : (this.ai.usePuter
          ? this.ai.getPreferredPlayerNames(aiCount)
          : ["Alex", "Blair", "Casey", "Drew", "Emery", "Flynn"]);

    this.players = names.map((name, i) => new PlayerData(`player_${i}`, name));
    if (this.separateHumanPlayer) {
      const hp = new PlayerData("human_player", this.humanDisplayName, Role.Villager);
      hp.isHuman = true;
      this.players.push(hp);
      this.humanPlayerId = hp.id;
    }
    this.assignRolesRandomly();
    this.players.forEach((p) => p.resetForNewGame());

    this.state.clearForNewGame();
    this.currentPhase = Phase.Night;
    this.winner = "";
    this.round = 1;
    this.spokenCharsThisRound.clear();
    this.eliminationOrder = [];
    this.suspicionTimeline = [];
    this.playerModelById.clear();
    this.playerModelPinned.clear();
    this.rollingSummary = "";
    this.abortReason = "";
    this.appendSystem(`Game started with ${this.players.length} players.`);
    this.appendSystem(`Night ${this.round} begins.`);
    this.state.gameLog.push("Setup complete.");
    this.applyDefaultModelToAllPlayers();

    if (this.masterMode) this.logRoles();
    const dir = path.resolve(this.saveDir);
    fs.mkdirSync(dir, { recursive: true });
    this.sessionTextSavePath = path.join(dir, `session_${this.sessionId}.txt`);
    this.lastSavedPath = this.sessionTextSavePath;
    this.persistSnapshot("game_start");
    return this.prepareNightActions();
  }

  applyLlmDisplayNames() {
    const aiPlayers = this.players.filter((p) => !p.isHuman);
    const names = this.ai.getPreferredPlayerNames(aiPlayers.length || 6);
    for (let i = 0; i < aiPlayers.length; i++) {
      if (aiPlayers[i]) {
        aiPlayers[i].displayName = names[i];
      }
    }
  }

  assignModelsRoundRobin() {
    const models = this.ai.getAvailableModels();
    if (models.length === 0) return;
    const aiPlayers = this.players.filter((p) => !p.isHuman);
    for (let i = 0; i < aiPlayers.length; i++) {
      this.playerModelById.set(aiPlayers[i].id, models[i % models.length]);
    }
  }

  setDefaultModel(model) {
    const ok = this.ai.setDefaultModel(model);
    if (!ok) return false;
    this.applyDefaultModelToAllPlayers();
    this.state.gameLog.push(`[MODEL] default -> ${this.ai.defaultModel}`);
    return true;
  }

  setPlayerModel(playerIdOrName, model) {
    const id = this.normalizeTargetId(playerIdOrName, "");
    const m = String(model || "").trim();
    if (!id || !m) return false;
    this.playerModelById.set(id, m);
    this.playerModelPinned.add(id);
    this.state.gameLog.push(`[MODEL] ${id} -> ${m}`);
    return true;
  }

  getPlayerModel(playerId) {
    return this.playerModelById.get(playerId) || this.ai.defaultModel;
  }

  getModelMapObject() {
    const o = {};
    for (const p of this.players) {
      if (!p) continue;
      o[p.id] = this.getPlayerModel(p.id);
    }
    return o;
  }

  applyDefaultModelToAllPlayers() {
    for (const p of this.players) {
      if (!p || p.isHuman) continue;
      if (this.playerModelPinned.has(p.id)) continue;
      this.playerModelById.set(p.id, this.ai.defaultModel);
    }
  }

  getAlivePlayers() {
    return this.players.filter((p) => p.isAlive);
  }

  getCurrentDayMemory() {
    const dayTag = `[Day ${this.round}]`;
    return this.state.transcript.filter((line) => line.includes(dayTag)).join("\n");
  }

  getCompressedMemoryBlock(playerId) {
    const tail = 80;
    const lines = this.state.transcript || [];
    const recent = lines.slice(-tail);
    const older = lines.slice(0, Math.max(0, lines.length - tail));
    const summary = this.buildOlderSummary(older);
    const personalNight = this.getPlayerNightActionMemory(playerId);
    return {
      summary,
      recentTranscript: recent.join("\n"),
      dayMemory: this.getCurrentDayMemory(),
      personalNight
    };
  }

  getPlayerNightActionMemory(playerId) {
    return this.state.nightActionSummaryByPlayer.get(playerId) || "";
  }

  setHumanPlayer(playerIdOrName) {
    const id = this.normalizeTargetId(playerIdOrName, "");
    if (!id) return false;
    this.humanPlayerId = id;
    this.state.gameLog.push(`[PLAYER_MODE] Human controls ${id}`);
    return true;
  }

  setSeparateHumanMode(on, name = "You") {
    this.separateHumanPlayer = !!on;
    this.humanDisplayName = String(name || "You");
    if (!this.separateHumanPlayer) {
      this.clearHumanPlayer();
    }
  }

  setPlayerCount(count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 5) return false;
    this.playerCount = Math.floor(n);
    return true;
  }

  setSaveMode(on, dir = "") {
    this.saveToFileMode = !!on;
    if (dir && String(dir).trim()) {
      this.saveDir = String(dir).trim();
    }
  }

  clearHumanPlayer() {
    this.humanPlayerId = "";
    this.pendingHumanDiscussion = "";
    this.pendingHumanVote = "";
    this.pendingHumanNight = null;
    this.state.gameLog.push("[PLAYER_MODE] Human control disabled");
  }

  submitHumanDiscussion(text) {
    this.pendingHumanDiscussion = String(text || "").trim();
  }

  submitHumanVote(target) {
    this.pendingHumanVote = String(target || "").trim();
  }

  submitHumanNight(action, target, dialogue = "") {
    this.pendingHumanNight = {
      action: String(action || "DoNothing"),
      target: String(target || ""),
      dialogue: String(dialogue || "")
    };
  }

  async nextPhase() {
    if (this.winner) return;

    switch (this.currentPhase) {
      case Phase.Night:
        this.resolveNightActions();
        this.currentPhase = Phase.Discussion;
        await this.startDiscussionPhase();
        break;
      case Phase.Discussion:
        this.currentPhase = Phase.Voting;
        await this.startVotingPhase();
        break;
      case Phase.Voting:
        this.currentPhase = Phase.Results;
        this.resolveVoting();
        break;
      case Phase.Results:
        if (!this.winner) {
          this.currentPhase = Phase.Night;
          this.round += 1;
          this.spokenCharsThisRound.clear();
          this.appendSystem(`Night ${this.round} begins.`);
          await this.prepareNightActions();
        }
        break;
      default:
        break;
    }

    this.state.gameLog.push(`Phase -> ${this.currentPhase}`);
    this.persistSnapshot(`phase_${this.currentPhase.toLowerCase()}_r${this.round}`);
  }

  async startDiscussionPhase() {
    this.appendSystem(`Discussion ${this.round} begins.`);
    const alive = this.getDiscussionOrder();

    for (const player of alive) {
      let raw;
      if (player.id === this.humanPlayerId) {
        const msg = this.pendingHumanDiscussion || "(passes this turn)";
        raw = JSON.stringify({
          dialogue: msg,
          strategy_notes: "human",
          internal_analysis: { source: "human" }
        });
        this.pendingHumanDiscussion = "";
      } else {
        raw = await this.ai.requestDecision(player, Phase.Discussion, this, this.getPlayerModel(player.id));
      }
      if (this.isFatalAiResponse(raw)) {
        this.stopGameDueToAI(`Discussion AI failed for ${player.displayName}`);
        return;
      }
      this.captureRaw(player.id, raw);
      let action = toDiscussionAction(raw);
      if (!action) {
        this.stopGameDueToAI(`Invalid discussion JSON from ${player.displayName}`);
        return;
      }
      if (!action.shouldSpeak || !String(action.dialogue || "").trim()) {
        this.appendSystem(`${player.displayName} stays silent this turn.`);
        continue;
      }
      const bounded = this.boundSpeech(player.id, action.dialogue);
      player.lastDialogue = bounded;
      this.appendSpeech(player.displayName, bounded, `Day ${this.round}`);
      if (this.masterMode) {
        this.state.gameLog.push(`[MASTER][DISCUSSION] ${player.id} dialogue=${bounded}`);
      }
    }
  }

  async startVotingPhase() {
    this.appendSystem(`Voting ${this.round} begins.`);
    this.state.votes.clear();
    const alive = this.getAlivePlayers();

    for (const voter of alive) {
      let raw;
      if (voter.id === this.humanPlayerId) {
        raw = JSON.stringify({
          vote: this.pendingHumanVote || "",
          reasoning: "human vote",
          internal_analysis: { source: "human" }
        });
        this.pendingHumanVote = "";
      } else {
        raw = await this.ai.requestDecision(voter, Phase.Voting, this, this.getPlayerModel(voter.id));
      }
      if (this.isFatalAiResponse(raw)) {
        this.stopGameDueToAI(`Voting AI failed for ${voter.displayName}`);
        return;
      }
      this.captureRaw(voter.id, raw);
      let action = toVoteAction(raw);
      if (!action) {
        this.stopGameDueToAI(`Invalid vote JSON from ${voter.displayName}`);
        return;
      }
      let target = this.normalizeTargetId(action.vote, voter.id);
      if (!this.isAliveTarget(target) || target === voter.id) {
        target = this.pickFallbackTarget(voter.id);
        this.state.gameLog.push(`[WARN] Invalid vote fixed for ${voter.id} -> ${target}`);
      }
      this.state.votes.set(voter.id, target);
      this.appendSpeech(voter.displayName, `votes for ${this.playerNameFromRef(target) || "nobody"}`, `Day ${this.round}`);
      if (this.masterMode) {
        this.state.gameLog.push(`[MASTER][VOTE] ${voter.id} -> ${target}`);
      }
    }
  }

  async prepareNightActions() {
    this.state.nightActions.clear();
    this.state.nightActionSummaryByPlayer.clear();
    const alive = this.getAlivePlayers();
    const summary = [];
    const mafiaProposals = [];

    for (const actor of alive) {
      if (![Role.Mafia, Role.Doctor, Role.Detective].includes(actor.role)) continue;
      let raw;
      if (actor.id === this.humanPlayerId) {
        const hn = this.pendingHumanNight || { action: "DoNothing", target: "", dialogue: "" };
        raw = JSON.stringify({
          action: hn.action,
          target: hn.target,
          dialogue: hn.dialogue,
          internal_analysis: { source: "human" }
        });
        this.pendingHumanNight = null;
      } else {
        raw = await this.ai.requestDecision(actor, Phase.Night, this, this.getPlayerModel(actor.id));
      }
      if (this.isFatalAiResponse(raw)) {
        this.stopGameDueToAI(`Night AI failed for ${actor.displayName}`);
        return;
      }
      this.captureRaw(actor.id, raw);
      let acceptedRaw = raw;
      const parsed = toNightAction(raw);
      if (!parsed) {
        this.stopGameDueToAI(`Invalid night-action JSON from ${actor.displayName}`);
        return;
      }
      if (parsed) {
        // Normalize model target text (id or displayName) into canonical playerId.
        const normalizedTarget = this.normalizeTargetId(parsed.target, actor.role === Role.Doctor ? "" : actor.id);
        const normalizedAction = { ...parsed, target: normalizedTarget || this.pickFallbackTarget(actor.id) };
        acceptedRaw = JSON.stringify(normalizedAction);
      }
      this.state.nightActions.set(actor.id, acceptedRaw);
      const parsedForSummary = toNightAction(acceptedRaw);
      if (parsedForSummary) {
        if (actor.role === Role.Mafia && parsedForSummary.action === "Kill") {
          mafiaProposals.push({
            actorId: actor.id,
            targetId: this.normalizeTargetId(parsedForSummary.target, actor.id)
          });
        }
        let why = "";
        try {
          const o = JSON.parse(acceptedRaw);
          const reason =
            (typeof o.reasoning === "string" && o.reasoning) ||
            (o.internal_analysis && typeof o.internal_analysis.plan === "string" && o.internal_analysis.plan) ||
            (o.internal_analysis && typeof o.internal_analysis.confidence === "number" ? `confidence=${o.internal_analysis.confidence}` : "");
          why = reason ? ` | why: ${reason}` : "";
        } catch (_) {
          // Ignore parse issues in summary formatting.
        }
        summary.push(
          `${actor.displayName} -> ${parsedForSummary.action}(${this.playerNameFromRef(parsedForSummary.target) || "none"})${why}`
        );
        this.state.nightActionSummaryByPlayer.set(
          actor.id,
          `Round ${this.round}: ${parsedForSummary.action}(${this.playerNameFromRef(parsedForSummary.target) || "none"})${why}`
        );
      }
      if (this.masterMode) {
        this.state.gameLog.push(`[MASTER][NIGHT] ${actor.id} action captured (private)`);
      }
    }

    if (mafiaProposals.length > 0) {
      const consensusTarget = this.pickConsensusTarget(
        mafiaProposals.map((m) => m.targetId).filter((id) => this.isAliveTarget(id))
      ) || this.pickFallbackTarget("");
      for (const proposal of mafiaProposals) {
        const raw = this.state.nightActions.get(proposal.actorId);
        const actionObj = toNightAction(raw);
        if (!actionObj) continue;
        const unifiedRaw = JSON.stringify({
          ...actionObj,
          action: "Kill",
          target: consensusTarget
        });
        this.state.nightActions.set(proposal.actorId, unifiedRaw);
        this.state.nightActionSummaryByPlayer.set(
          proposal.actorId,
          `Round ${this.round}: Kill(${this.playerNameFromRef(consensusTarget) || "none"}) | via mafia consensus`
        );
      }
      this.state.gameLog.push(`[NIGHT][MAFIA_CONSENSUS] target=${consensusTarget}`);
    }
  }

  resolveNightActions() {
    if (this.state.nightActions.size === 0) {
      this.appendSystem("The night was quiet.");
      return;
    }

    let mafiaTarget = "";
    let doctorSave = "";
    const mafiaTargets = [];

    for (const [playerId, raw] of this.state.nightActions.entries()) {
      const actor = this.findPlayer(playerId);
      if (!actor || !actor.isAlive) continue;
      const action = toNightAction(raw);
      if (!action) continue;
      const targetId = this.normalizeTargetId(action.target, actor.role === Role.Doctor ? "" : actor.id);
      if (actor.role === Role.Mafia && action.action === "Kill") mafiaTargets.push(targetId);
      if (actor.role === Role.Doctor) doctorSave = targetId;
      if (this.masterMode) {
        this.state.gameLog.push(`[MASTER][NIGHT_RESOLVE] ${actor.id} action=${action.action} target=${targetId || "<none>"}`);
      }
    }

    mafiaTarget = this.pickConsensusTarget(mafiaTargets.filter((id) => this.isAliveTarget(id))) || this.pickFallbackTarget("");

    const victim = this.findPlayer(mafiaTarget);
    if (!victim) {
      this.appendSystem("No valid night target.");
    } else if (doctorSave && doctorSave === mafiaTarget) {
      this.appendSystem(`${victim.displayName} was attacked but survived.`);
    } else {
      victim.isAlive = false;
      this.eliminationOrder.push({
        round: this.round,
        phase: this.currentPhase,
        playerId: victim.id,
        name: victim.displayName,
        cause: "Night"
      });
      this.appendSystem(`${victim.displayName} was eliminated during the night.`);
    }
    this.state.nightActions.clear();
  }

  resolveVoting() {
    if (this.state.votes.size === 0) {
      this.appendSystem("No votes were cast.");
      this.currentPhase = Phase.Results;
      this.checkWinConditions();
      return;
    }

    const tally = new Map();
    for (const [, targetId] of this.state.votes.entries()) {
      if (!targetId) continue;
      tally.set(targetId, (tally.get(targetId) || 0) + 1);
    }
    if (tally.size > 0) {
      const tallyText = Array.from(tally.entries()).map(([k, v]) => `${this.playerNameFromRef(k)}:${v}`).join(", ");
      this.appendSystem(`Vote tally: ${tallyText}`);
    }

    const { eliminatedId, tied } = this.getVoteResult(tally);
    if (tied) {
      this.appendSystem("Vote tied. Nobody is ejected.");
    } else {
      const eliminated = this.findPlayer(eliminatedId);
      if (eliminated && eliminated.isAlive) {
        eliminated.isAlive = false;
        this.eliminationOrder.push({
          round: this.round,
          phase: this.currentPhase,
          playerId: eliminated.id,
          name: eliminated.displayName,
          cause: "Vote"
        });
        this.appendSystem(`${eliminated.displayName} was voted out. Role revealed: ${eliminated.role}.`);
        if (eliminated.role === Role.Jester) {
          this.setWinner("Jester");
          this.appendSystem("Jester wins by being eliminated.");
        }
      } else {
        this.appendSystem("Voting produced no valid elimination.");
      }
    }

    this.state.votes.clear();
    if (!this.winner) this.checkWinConditions();
  }

  toggleMasterMode(on) {
    this.masterMode = !!on;
    this.state.gameLog.push(`Master mode: ${this.masterMode}`);
    if (this.masterMode) this.logRoles();
  }

  checkWinConditions() {
    let mafiaAlive = 0;
    let townAlive = 0;
    for (const p of this.players) {
      if (!p.isAlive) continue;
      if (p.role === Role.Mafia) mafiaAlive += 1;
      else townAlive += 1;
    }

    if (mafiaAlive === 0) {
      this.setWinner("Town");
      this.appendSystem("Town wins. All Mafia are eliminated.");
    } else if (mafiaAlive >= townAlive) {
      this.setWinner("Mafia");
      this.appendSystem("Mafia wins by parity.");
    }
  }

  findPlayer(playerId) {
    return this.players.find((p) => p.id === playerId) || null;
  }

  isAliveTarget(playerId) {
    const p = this.findPlayer(playerId);
    return !!(p && p.isAlive);
  }

  pickFallbackTarget(excludeId) {
    const alive = this.getAlivePlayers().filter((p) => p.id !== excludeId);
    return alive.length > 0 ? alive[0].id : "";
  }

  captureRaw(playerId, rawJson) {
    this.state.lastRawJsonByPlayer.set(playerId, rawJson);
    try {
      const obj = JSON.parse(rawJson);
      if (obj && obj.__error) {
        this.state.gameLog.push(`[AI_ERROR] ${playerId}: ${obj.message || "unknown error"}`);
      }
      if (obj && obj.internal_analysis) {
        this.state.lastInternalAnalysisByPlayer.set(playerId, JSON.stringify(obj.internal_analysis));
        this.suspicionTimeline.push({
          round: this.round,
          phase: this.currentPhase,
          playerId,
          mostSuspicious: obj.internal_analysis.most_suspicious || "",
          confidence: typeof obj.internal_analysis.confidence === "number" ? obj.internal_analysis.confidence : null
        });
      }
    } catch (_) {
      this.state.gameLog.push(`[WARN] Malformed JSON from ${playerId}`);
    }

    if (this.masterMode) {
      if (this.currentPhase === Phase.Night) {
        this.state.gameLog.push(`[MASTER][AI] ${playerId} model=${this.getPlayerModel(playerId)} private_night_action`);
      } else {
        this.state.gameLog.push(`[MASTER][AI] ${playerId} model=${this.getPlayerModel(playerId)} ${this.describeAiForPlayer(playerId)}`);
      }
    }
  }

  logRoles() {
    for (const p of this.players) {
      this.state.gameLog.push(`[MASTER] ${p.displayName} role=${p.role} alive=${p.isAlive}`);
    }
  }

  assignRolesRandomly() {
    const total = this.players.length;
    const mafiaCount = Math.max(1, Math.floor(total / 3));
    const roleBag = [];

    for (let i = 0; i < mafiaCount; i++) roleBag.push(Role.Mafia);
    roleBag.push(Role.Doctor, Role.Detective, Role.Jester);
    while (roleBag.length > total) roleBag.pop();
    while (roleBag.length < total) roleBag.push(Role.Villager);

    // Fisher-Yates shuffle.
    for (let i = roleBag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roleBag[i], roleBag[j]] = [roleBag[j], roleBag[i]];
    }

    for (let i = 0; i < this.players.length; i++) {
      this.players[i].role = roleBag[i];
    }

    // Keep separate human player as Villager for predictable manual play.
    if (this.separateHumanPlayer) {
      const hp = this.findPlayer("human_player");
      if (hp) {
        hp.role = Role.Villager;
      }
    }
  }

  getHighestVotedDeterministic(tally) {
    let bestId = "";
    let bestVotes = -1;
    let bestIndex = Number.MAX_SAFE_INTEGER;

    for (const [targetId, votes] of tally.entries()) {
      const idx = this.players.findIndex((p) => p.id === targetId);
      if (votes > bestVotes || (votes === bestVotes && idx < bestIndex)) {
        bestVotes = votes;
        bestId = targetId;
        bestIndex = idx;
      }
    }
    return bestId;
  }

  getVoteResult(tally) {
    let topVotes = -1;
    const leaders = [];
    for (const [targetId, votes] of tally.entries()) {
      if (votes > topVotes) {
        topVotes = votes;
        leaders.length = 0;
        leaders.push(targetId);
      } else if (votes === topVotes) {
        leaders.push(targetId);
      }
    }

    if (leaders.length === 0) {
      return { eliminatedId: "", tied: false };
    }
    if (leaders.length > 1) {
      return { eliminatedId: "", tied: true };
    }
    return { eliminatedId: leaders[0], tied: false };
  }

  pickConsensusTarget(targetIds) {
    const ids = (targetIds || []).filter(Boolean);
    if (ids.length === 0) return "";
    const counts = new Map();
    for (const id of ids) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    let bestId = "";
    let bestCount = -1;
    let bestIndex = Number.MAX_SAFE_INTEGER;
    for (const [id, count] of counts.entries()) {
      const idx = this.players.findIndex((p) => p.id === id);
      if (count > bestCount || (count === bestCount && idx < bestIndex)) {
        bestId = id;
        bestCount = count;
        bestIndex = idx;
      }
    }
    return bestId;
  }

  buildDiscussionFallback(player) {
    const target = this.pickFallbackTarget(player.id);
    const tName = this.playerNameFromRef(target) || "someone";
    const byRole = {
      [Role.Mafia]: `I suspect ${tName} is controlling this too much.`,
      [Role.Doctor]: "Let's avoid rushing and compare contradictions.",
      [Role.Detective]: "Give one suspect and one reason each.",
      [Role.Jester]: "If you think I'm suspicious, test that vote.",
      [Role.Villager]: `My vote likely goes to ${tName || "unclear target"} for now.`
    };
    return {
      dialogue: byRole[player.role] || `${player.displayName} shares a cautious opinion.`,
      strategy_notes: "game-manager fallback"
    };
  }

  buildVoteFallback(voter) {
    const target = this.pickFallbackTarget(voter.id);
    return {
      vote: target,
      reasoning: `fallback vote toward ${this.playerNameFromRef(target) || "a suspect"}`
    };
  }

  normalizeTargetId(value, excludeId = "") {
    if (!value) return "";
    const raw = String(value).trim();
    if (!raw) return "";

    // Direct id match.
    const byId = this.findPlayer(raw);
    if (byId && byId.isAlive && byId.id !== excludeId) return byId.id;

    // Case-insensitive id/displayName match.
    const lower = raw.toLowerCase();
    for (const p of this.players) {
      if (!p || !p.isAlive || p.id === excludeId) continue;
      if (p.id.toLowerCase() === lower) return p.id;
      if (String(p.displayName || "").toLowerCase() === lower) return p.id;
    }
    return "";
  }

  appendSpeech(speaker, message, phaseTag = "") {
    const phase = phaseTag ? `[${phaseTag}]` : "";
    this.state.appendTranscript(`${phase}[${speaker}] ${message}`);
  }

  appendSystem(message) {
    const phaseTag = this.currentPhase === Phase.Night ? `Night ${this.round}` : `Day ${this.round}`;
    this.state.appendTranscript(`[${phaseTag}][System] ${message}`);
  }

  boundSpeech(playerId, text) {
    const safe = this.cleanMessage(String(text || "").trim() || "...");
    const used = this.spokenCharsThisRound.get(playerId) || 0;
    this.spokenCharsThisRound.set(playerId, used + safe.length);
    return safe;
  }

  cleanMessage(message) {
    return String(message || "").replace(/\s+/g, " ").trim();
  }

  trimAtWordBoundary(text, maxLen) {
    if (text.length <= maxLen) return text;
    const cut = text.slice(0, Math.max(1, maxLen));
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace < Math.floor(maxLen * 0.6)) return cut + "...";
    return cut.slice(0, lastSpace) + "...";
  }

  describeAiForPlayer(playerId) {
    const raw = this.state.lastRawJsonByPlayer.get(playerId);
    if (!raw) return "no-ai-output";
    try {
      const o = JSON.parse(raw);
      if (o.__error) {
        return `error=${o.message || "unknown"}`;
      }
      if (typeof o.dialogue === "string") {
        return `dialogue="${o.dialogue.slice(0, 90)}"`;
      }
      if (typeof o.vote === "string") {
        return `vote=${this.playerNameFromRef(o.vote) || "none"} reason="${String(o.reasoning || "").slice(0, 70)}"`;
      }
      if (typeof o.action === "string") {
        return `action=${o.action} target=${this.playerNameFromRef(o.target) || "none"}`;
      }
      return "valid-ai-output";
    } catch (_) {
      return "unparseable-ai-output";
    }
  }

  playerNameFromRef(value) {
    if (!value) return "";
    const p = this.findPlayer(String(value));
    if (p) return p.displayName;
    const lower = String(value).toLowerCase();
    for (const x of this.players) {
      if (!x) continue;
      if (x.displayName.toLowerCase() === lower) return x.displayName;
    }
    return String(value);
  }

  buildOlderSummary(lines) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return this.rollingSummary || "";
    }
    const events = [];
    for (const line of lines) {
      const l = String(line || "");
      if (!l) continue;
      const keyTerms = ["voted", "eliminated", "wins", "suspect", "attacked", "saved", "Night actions"];
      if (keyTerms.some((k) => l.toLowerCase().includes(k.toLowerCase()))) {
        events.push(l);
      }
    }
    const compact = events.slice(-24).join(" | ");
    this.rollingSummary = compact || this.rollingSummary;
    return this.rollingSummary;
  }

  getDiscussionOrder() {
    return this.getAlivePlayers()
      .slice()
      .sort((a, b) => this.players.indexOf(a) - this.players.indexOf(b));
  }

  isFatalAiResponse(rawJson) {
    if (!rawJson) return true;
    try {
      const obj = JSON.parse(rawJson);
      return !!(obj && obj.__error);
    } catch (_) {
      return false;
    }
  }

  stopGameDueToAI(reason) {
    this.abortReason = String(reason || "AI failure");
    this.winner = "Aborted";
    this.state.gameLog.push(`[FATAL] ${this.abortReason}`);
    this.appendSystem(`Game stopped: ${this.abortReason}`);
    this.persistSnapshot("aborted_ai");
  }

  setWinner(winner) {
    if (!winner) return;
    this.winner = winner;
    if (this.saveToFileMode) {
      this.saveGameToFile(`winner_${winner}`);
    }
  }

  persistSnapshot(tag) {
    if (!this.alwaysWriteLogsToFile && !this.saveToFileMode) return;
    try {
      this.saveGameToFile(tag || "snapshot");
    } catch (_) {
      // Swallow snapshot errors so gameplay loop is not interrupted.
    }
  }

  buildSavePayload() {
    const aiDiagnostics = this.players.map((p) => ({
      playerId: p.id,
      displayName: p.displayName,
      rawJson: this.state.lastRawJsonByPlayer.get(p.id) || "",
      internalAnalysis: this.state.lastInternalAnalysisByPlayer.get(p.id) || "",
      internalMonologue: this.extractMonologue(this.state.lastInternalAnalysisByPlayer.get(p.id) || ""),
      nightSummary: this.state.nightActionSummaryByPlayer.get(p.id) || ""
    }));

    return {
      sessionId: this.sessionId,
      round: this.round,
      phase: this.currentPhase,
      winner: this.winner,
      abortReason: this.abortReason,
      timestamp: new Date().toISOString(),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.displayName,
        role: p.role,
        alive: p.isAlive,
        model: this.getPlayerModel(p.id)
      })),
      transcript: this.state.transcript.slice(),
      log: this.state.gameLog.slice(),
      nightActionsByPlayer: Array.from(this.state.nightActionSummaryByPlayer.entries()).map(([playerId, summary]) => ({ playerId, summary })),
      aiDiagnostics,
      eliminationOrder: this.eliminationOrder.slice(),
      suspicionTimeline: this.suspicionTimeline.slice()
    };
  }

  saveGameToFile(tag = "manual") {
    const payload = this.buildSavePayload();
    const dir = path.resolve(this.saveDir);
    fs.mkdirSync(dir, { recursive: true });
    if (!this.sessionTextSavePath) {
      this.sessionTextSavePath = path.join(dir, `session_${this.sessionId}.txt`);
    }
    const txtPath = this.sessionTextSavePath;
    const txt = [
      `Session: ${payload.sessionId}`,
      `Winner: ${payload.winner || "none"}`,
      `Abort reason: ${payload.abortReason || "none"}`,
      `Round: ${payload.round}`,
      `Phase: ${payload.phase}`,
      "",
      "Players:",
      ...payload.players.map((p) => `- ${p.name} (${p.id}) role=${p.role} alive=${p.alive} model=${p.model}`),
      "",
      "Night Actions:",
      ...(payload.nightActionsByPlayer.length > 0
        ? payload.nightActionsByPlayer.map((n) => `- ${n.playerId}: ${n.summary}`)
        : ["- <none>"]),
      "",
      "AI Internal Thoughts / Reasoning:",
      ...payload.aiDiagnostics.map((d) => {
        const parts = [];
        parts.push(`- ${d.displayName} (${d.playerId})`);
        parts.push(`  night: ${d.nightSummary || "<none>"}`);
        parts.push(`  monologue: ${d.internalMonologue || "<none>"}`);
        parts.push(`  raw: ${d.rawJson || "<none>"}`);
        parts.push(`  internal: ${d.internalAnalysis || "<none>"}`);
        return parts.join("\n");
      }),
      "",
      "Transcript:",
      ...payload.transcript.map((t) => `- ${t}`),
      "",
      "Log:",
      ...payload.log.map((l) => `- ${l}`)
    ].join("\n");
    fs.writeFileSync(txtPath, txt, "utf8");
    this.lastSavedPath = txtPath;
    this.state.gameLog.push(`[SAVE] ${txtPath} (${tag})`);
    return { jsonPath: "", txtPath };
  }

  extractMonologue(internalAnalysisRaw) {
    if (!internalAnalysisRaw) return "";
    try {
      const obj = JSON.parse(internalAnalysisRaw);
      return typeof obj.monologue === "string" ? obj.monologue : "";
    } catch (_) {
      return "";
    }
  }
}

module.exports = {
  GameManager
};
