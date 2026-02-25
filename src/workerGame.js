const { GameManager } = require("./gameManager");

async function main() {
  const playerCount = Math.max(5, Number(process.env.MAFIA_WORKER_PLAYER_COUNT || 6));
  const usePuter = process.env.MAFIA_WORKER_USE_PUTER === "1";
  const model = String(process.env.MAFIA_WORKER_DEFAULT_MODEL || "").trim();

  const game = new GameManager({
    masterMode: false,
    separateHumanPlayer: false,
    playerCount,
    saveToFileMode: false,
    alwaysWriteLogsToFile: false
  });
  game.ai.setUsePuter(usePuter);
  if (model) {
    game.ai.setDefaultModel(model);
  }

  await game.setupGame();
  while (!game.winner) {
    await game.nextPhase();
  }

  process.stdout.write(JSON.stringify({ winner: game.winner || "Unknown" }));
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(msg);
  process.exit(1);
});
