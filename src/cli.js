const readline = require("readline");
const { GameManager } = require("./gameManager");
const { initPuterClient, getAuthToken, setAuthToken, loginViaBrowser, probePuter, verifyPuterAuthSources } = require("./puterClient");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHeader() {
  console.log("======================================");
  console.log(" Text Mafia (Node.js)");
  console.log("======================================");
}

function printHelp() {
  console.log("Commands:");
  console.log("  next              Advance one phase");
  console.log("  run               Auto-run until winner");
  console.log("  multi <n>         Run n games consecutively and report winners");
  console.log("  playercount <n>=5 Set total players for next game");
  console.log("  save on|off [dir] Enable/disable save-to-file mode");
  console.log("  savenow [tag]     Save current game snapshot immediately");
  console.log("  players           Show player list");
  console.log("  transcript [n]    Show last n transcript lines");
  console.log("  log [n]           Show last n game-log lines");
  console.log("  ai                Show per-player raw/internal AI data");
  console.log("  models            List available models and assignments");
  console.log("  model <name>      Set default model");
  console.log("  playermodel <id|name> <model>  Set model for one player");
  console.log("  player <id|name>  Human controls a player");
  console.log("  player off        Disable human control");
  console.log("  separatehuman on|off [name]  Toggle separate human player mode");
  console.log("  say <text>        Submit your discussion message");
  console.log("  vote <target>     Submit your vote target");
  console.log("  night <action> <target> [dialogue]  Submit night action");
  console.log("  master on|off     Toggle master mode");
  console.log("  llm on|off        Toggle Puter LLM mode");
  console.log("  auth              Print current Puter auth token");
  console.log("  login             Open browser login and bind token");
  console.log("  probe             Test live LLM response");
  console.log("  verifyauth        Verify Puter auth from env tokens and browser token");
  console.log("  token <value>     Set Puter auth token at runtime");
  console.log("  state             Show phase and winner");
  console.log("  new               Start a new game");
  console.log("  help              Show this help");
  console.log("  quit              Exit");
}

function printPlayers(game) {
  console.log("\nPlayers:");
  for (const p of game.players) {
    const roleText = game.masterMode ? p.role : "Hidden";
    console.log(`- ${p.displayName} (${p.id}) | alive=${p.isAlive} | role=${roleText} | model=${game.getPlayerModel(p.id)}`);
  }
}

function printTranscript(game, limit = 20) {
  const lines = game.state.transcript.slice(-Math.max(1, limit));
  console.log("\nTranscript:");
  if (lines.length === 0) {
    console.log("- <empty>");
    return;
  }
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

function printState(game) {
  console.log(`\nRound: ${game.round}`);
  console.log(`Phase: ${game.currentPhase}`);
  console.log(`Winner: ${game.winner || "None"}`);
  console.log(`LLM mode: ${game.ai.usePuter ? "ON" : "OFF (stub)"}`);
  console.log(`Player count (next game): ${game.playerCount}`);
  console.log(`Save mode: ${game.saveToFileMode ? "ON" : "OFF"} (${game.saveDir})`);
  if (game.lastSavedPath) {
    console.log(`Last save: ${game.lastSavedPath}`);
  }
}

function printLog(game, limit = 20) {
  const lines = game.state.gameLog.slice(-Math.max(1, limit));
  console.log("\nGame Log:");
  if (lines.length === 0) {
    console.log("- <empty>");
    return;
  }
  for (const line of lines) {
    console.log(`- ${line}`);
  }
}

function printAiDebug(game) {
  console.log("\nAI Debug:");
  for (const p of game.players) {
    const summary = game.describeAiForPlayer(p.id);
    const internalRaw = game.state.lastInternalAnalysisByPlayer.get(p.id) || "";
    let internal = "<none>";
    if (internalRaw) {
      try {
        const o = JSON.parse(internalRaw);
        internal = `most_suspicious=${o.most_suspicious || "n/a"} confidence=${o.confidence ?? "n/a"}`;
      } catch (_) {
        internal = "available";
      }
    }
    console.log(`- ${p.displayName} (${p.id})`);
    console.log(`  ai: ${summary}`);
    console.log(`  internal: ${internal}`);
    console.log(`  night: <private_to_actor>`);
  }
}

async function runAuto(game) {
  console.log("Auto-running...");
  while (!game.winner) {
    await game.nextPhase();
    printState(game);
    printTranscript(game, 6);
    await sleep(600);
  }
  console.log(`Game over. Winner: ${game.winner}`);
}

async function runMulti(game, count) {
  const n = Math.max(1, Number(count) || 1);
  const winners = {};
  for (let i = 1; i <= n; i++) {
    await game.setupGame();
    while (!game.winner) {
      await game.nextPhase();
    }
    winners[game.winner] = (winners[game.winner] || 0) + 1;
    console.log(`Game ${i}/${n} winner: ${game.winner}`);
  }
  console.log("Multi-game summary:", winners);
}

async function main() {
  const game = new GameManager({ masterMode: false });
  await game.setupGame();

  if (process.env.MAFIA_USE_PUTER === "1") {
    try {
      await initPuterClient({ appName: "node-text-mafia", token: process.env.PUTER_AUTH_TOKEN || "" });
      game.ai.setUsePuter(true);
      game.applyLlmDisplayNames();
      console.log("Puter LLM mode: ON (no API key required; uses Puter auth flow).");
    } catch (err) {
      game.ai.setUsePuter(false);
      console.log("Puter init failed. Falling back to stubs.");
      console.log("Reason:", err && err.message ? err.message : err);
    }
  }

  printHeader();
  printHelp();
  printState(game);
  printPlayers(game);
  printTranscript(game, 8);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\nmafia> "
  });

  rl.prompt();

  rl.on("line", async (input) => {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = (parts[0] || "").toLowerCase();
    const arg = parts.slice(1).join(" ");

    try {
      switch (cmd) {
        case "next":
          await game.nextPhase();
          printState(game);
          printTranscript(game, 8);
          break;
        case "run":
          await runAuto(game);
          break;
        case "multi":
          await runMulti(game, arg || "1");
          break;
        case "playercount":
          if (!arg) {
            console.log("Usage: playercount <n>=5");
          } else {
            const ok = game.setPlayerCount(arg);
            console.log(ok ? `Player count set to ${game.playerCount} (applies on new game).` : "Invalid count. Must be >=5.");
          }
          break;
        case "save":
          {
            const segs = arg.split(/\s+/).filter(Boolean);
            const mode = (segs[0] || "").toLowerCase();
            const dir = segs.slice(1).join(" ");
            if (mode !== "on" && mode !== "off") {
              console.log("Usage: save on|off [dir]");
            } else {
              game.setSaveMode(mode === "on", dir);
              console.log(`Save mode ${mode.toUpperCase()} -> ${game.saveDir}`);
            }
          }
          break;
        case "savenow":
          try {
            const tag = arg || "manual";
            const paths = game.saveGameToFile(tag);
            console.log("Saved:", paths.txtPath || paths.jsonPath);
          } catch (err) {
            console.log("Save failed:", err && err.message ? err.message : err);
          }
          break;
        case "players":
          printPlayers(game);
          break;
        case "transcript":
          printTranscript(game, Number(arg) || 20);
          break;
        case "log":
          printLog(game, Number(arg) || 20);
          break;
        case "ai":
          printAiDebug(game);
          break;
        case "models":
          console.log("Available models:", game.ai.getAvailableModels().join(", "));
          console.log("Default model:", game.ai.defaultModel);
          console.log("Assignments:", game.getModelMapObject());
          break;
        case "model":
          if (!arg) {
            console.log("Usage: model <name>");
          } else {
            const ok = game.setDefaultModel(arg);
            console.log(ok ? `Default model set to ${arg}` : "Failed to set model.");
          }
          break;
        case "playermodel":
          {
            const segs = arg.split(/\s+/).filter(Boolean);
            if (segs.length < 2) {
              console.log("Usage: playermodel <id|name> <model>");
            } else {
              const player = segs[0];
              const model = segs.slice(1).join(" ");
              const ok = game.setPlayerModel(player, model);
              console.log(ok ? `Set ${player} model to ${model}` : "Failed to set player model.");
            }
          }
          break;
        case "master":
          if (arg !== "on" && arg !== "off") {
            console.log("Usage: master on|off");
          } else {
            game.toggleMasterMode(arg === "on");
            console.log(`Master mode set to ${arg}.`);
          }
          break;
        case "state":
          printState(game);
          break;
        case "new":
          await game.setupGame();
          console.log("New game started.");
          printState(game);
          printPlayers(game);
          break;
        case "player":
          if (!arg) {
            console.log("Usage: player <id|name> | player off");
          } else if (arg.toLowerCase() === "off") {
            game.clearHumanPlayer();
            console.log("Human control disabled.");
          } else {
            const ok = game.setHumanPlayer(arg);
            console.log(ok ? `Human controls ${arg}.` : `Player not found: ${arg}`);
          }
          break;
        case "separatehuman":
          {
            const segs = arg.split(/\s+/).filter(Boolean);
            const flag = (segs[0] || "").toLowerCase();
            const name = segs.slice(1).join(" ") || "You";
            if (flag !== "on" && flag !== "off") {
              console.log("Usage: separatehuman on|off [name]");
            } else {
              game.setSeparateHumanMode(flag === "on", name);
              await game.setupGame();
              console.log(`Separate human mode: ${flag.toUpperCase()} ${flag === "on" ? "(" + name + ")" : ""}`);
              printPlayers(game);
            }
          }
          break;
        case "say":
          if (!arg) {
            console.log("Usage: say <text>");
          } else {
            game.submitHumanDiscussion(arg);
            console.log("Queued discussion message.");
          }
          break;
        case "vote":
          if (!arg) {
            console.log("Usage: vote <target>");
          } else {
            game.submitHumanVote(arg);
            console.log("Queued vote.");
          }
          break;
        case "night":
          {
            const nParts = arg.split(/\s+/);
            const action = nParts[0] || "DoNothing";
            const target = nParts[1] || "";
            const dialogue = nParts.slice(2).join(" ");
            game.submitHumanNight(action, target, dialogue);
            console.log(`Queued night action ${action} ${target}`.trim());
          }
          break;
        case "llm":
          if (arg !== "on" && arg !== "off") {
            console.log("Usage: llm on|off");
          } else if (arg === "on") {
            try {
              await initPuterClient({ appName: "node-text-mafia", token: process.env.PUTER_AUTH_TOKEN || "" });
              game.ai.setUsePuter(true);
              game.applyLlmDisplayNames();
              console.log("Puter LLM mode enabled.");
              printPlayers(game);
            } catch (err) {
              console.log("Failed to enable Puter mode:", err && err.message ? err.message : err);
            }
          } else {
            game.ai.setUsePuter(false);
            console.log("Puter LLM mode disabled.");
          }
          break;
        case "auth":
          try {
            const token = await getAuthToken();
            console.log("Puter auth token:", token || "<none>");
          } catch (err) {
            console.log("Could not read auth token:", err && err.message ? err.message : err);
          }
          break;
        case "login":
          try {
            await loginViaBrowser();
            await initPuterClient({ appName: "node-text-mafia" });
            game.ai.setUsePuter(true);
            game.applyLlmDisplayNames();
            console.log("Browser login complete. Puter mode enabled.");
          } catch (err) {
            console.log("Browser login failed:", err && err.message ? err.message : err);
          }
          break;
        case "probe":
          try {
            const r = await probePuter(game.ai.defaultModel);
            console.log("LLM probe response:", String(r).slice(0, 220));
          } catch (err) {
            console.log("LLM probe failed:", err && err.message ? err.message : err);
          }
          break;
        case "verifyauth":
          try {
            const r = await verifyPuterAuthSources(game.ai.defaultModel);
            console.log("Env token checks:");
            if (!r.env.length) console.log("- <no env tokens found>");
            for (const item of r.env) {
              console.log(`- token#${item.index}: ${item.ok ? "OK" : "FAIL"} | ${item.message}`);
            }
            console.log(`Browser token: ${r.browser.attempted ? (r.browser.ok ? "OK" : "FAIL") : "SKIPPED"} | ${r.browser.message}`);
          } catch (err) {
            console.log("verifyauth failed:", err && err.message ? err.message : err);
          }
          break;
        case "token":
          if (!arg) {
            console.log("Usage: token <YOUR_PUTER_AUTH_TOKEN>");
          } else {
            try {
              await setAuthToken(arg);
              await initPuterClient({ appName: "node-text-mafia", token: arg });
              game.ai.setUsePuter(true);
              game.applyLlmDisplayNames();
              console.log("Token set. Puter LLM mode enabled.");
            } catch (err) {
              console.log("Failed to set token:", err && err.message ? err.message : err);
            }
          }
          break;
        case "help":
          printHelp();
          break;
        case "quit":
        case "exit":
          rl.close();
          return;
        case "":
          break;
        default:
          console.log("Unknown command. Type 'help'.");
          break;
      }
    } catch (err) {
      console.error("Command failed:", err && err.message ? err.message : err);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("Bye.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
