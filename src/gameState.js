class GameState {
  constructor() {
    this.transcript = [];
    this.gameLog = [];
    this.votes = new Map();
    this.nightActions = new Map();
    this.nightActionSummaryByPlayer = new Map();
    this.lastRawJsonByPlayer = new Map();
    this.lastInternalAnalysisByPlayer = new Map();
  }

  appendTranscript(line) {
    if (!line) return;
    this.transcript.push(line);
  }

  clearForNewGame() {
    this.transcript.length = 0;
    this.gameLog.length = 0;
    this.votes.clear();
    this.nightActions.clear();
    this.nightActionSummaryByPlayer.clear();
    this.lastRawJsonByPlayer.clear();
    this.lastInternalAnalysisByPlayer.clear();
  }
}

module.exports = {
  GameState
};
