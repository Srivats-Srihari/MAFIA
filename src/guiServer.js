const http = require("http");
const { URL } = require("url");
const { GameManager } = require("./gameManager");
const { initPuterClient, setAuthToken, loginViaBrowser, probePuter, verifyPuterAuthSources } = require("./puterClient");

process.on("unhandledRejection", (reason) => {
  const msg = (reason && reason.message) ? reason.message : (() => {
    try { return JSON.stringify(reason); } catch (_) { return String(reason); }
  })();
  console.error("Unhandled async error:", msg);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err && err.message ? err.message : err);
});

const PORT = Number(process.env.MAFIA_GUI_PORT || 8787);
const HOST = String(process.env.MAFIA_GUI_HOST || "0.0.0.0");
const game = new GameManager({ masterMode: true });
let queue = Promise.resolve();
let analytics = {
  totalGames: 0,
  winners: {},
  eliminationOrders: [],
  suspicionTimeline: []
};
const recordedSessions = new Set();
let autoPhase = {
  enabled: false,
  intervalSec: 8,
  nextAt: 0
};

function runExclusive(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function textFromInternal(raw) {
  if (!raw) return "";
  try {
    const o = JSON.parse(raw);
    return `most_suspicious=${o.most_suspicious || "n/a"}, confidence=${o.confidence ?? "n/a"}`;
  } catch (_) {
    return "available";
  }
}

function parseLine(line) {
  const m = String(line).match(/^\[(.*?)\]\[(.*?)\]\s*(.*)$/);
  if (!m) return { phase: "", speaker: "System", msg: String(line), kind: "system" };
  const phase = m[1];
  const speaker = m[2];
  const msg = m[3];
  return {
    phase,
    speaker,
    msg,
    kind: speaker === "System" ? "system" : "player"
  };
}

function snapshot() {
  const now = Date.now();
  return {
    sessionId: game.sessionId,
    round: game.round,
    phase: game.currentPhase,
    winner: game.winner || "",
    llmMode: game.ai.usePuter,
    defaultModel: game.ai.defaultModel,
    availableModels: game.ai.getAvailableModels(),
    modelMap: game.getModelMapObject(),
    separateHumanPlayer: game.separateHumanPlayer,
    humanPlayerId: game.humanPlayerId || "",
    playerCount: game.playerCount,
    saveToFileMode: game.saveToFileMode,
    saveDir: game.saveDir,
    lastSavedPath: game.lastSavedPath || "",
    auto: {
      enabled: autoPhase.enabled,
      intervalSec: autoPhase.intervalSec,
      countdownSec: autoPhase.enabled ? Math.max(0, Math.ceil((autoPhase.nextAt - now) / 1000)) : 0
    },
    players: game.players.map((p) => ({
      id: p.id,
      name: p.displayName,
      alive: p.isAlive,
      role: game.masterMode ? p.role : "Hidden",
      ai: game.describeAiForPlayer(p.id),
      internal: textFromInternal(game.state.lastInternalAnalysisByPlayer.get(p.id)),
      night: ""
    })),
    transcript: game.state.transcript.slice(-120),
    transcriptStructured: game.state.transcript.slice(-120).map(parseLine),
    log: game.state.gameLog.slice(-120),
    analytics: {
      totalGames: analytics.totalGames,
      winners: analytics.winners,
      lastEliminationOrder: analytics.eliminationOrders[analytics.eliminationOrders.length - 1] || [],
      recentSuspicion: analytics.suspicionTimeline.slice(-80)
    }
  };
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

function page() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Text Mafia GUI</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background:#0f1317; color:#e8edf2; }
    .wrap { display:grid; grid-template-columns: 390px 1fr; gap:12px; padding:12px; height:100vh; box-sizing:border-box; }
    .panel { background:#171d24; border:1px solid #2a333e; border-radius:10px; padding:10px; overflow:auto; }
    .row { margin-bottom:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
    button,input,select { padding:7px 9px; border-radius:8px; border:1px solid #3a4654; background:#222b36; color:#ecf2f8; }
    button:hover { background:#2b3744; cursor:pointer; }
    .mono { font-family: Consolas, monospace; white-space: pre-wrap; }
    .status { background:#11161d; border:1px solid #293340; border-radius:8px; padding:8px; margin:8px 0; }
    .players { display:grid; gap:8px; }
    .player-card { border:1px solid #2f3947; border-radius:8px; padding:8px; background:#121820; }
    .dead { opacity:.55; }
    .bubble-wrap { display:flex; margin:6px 0; }
    .bubble-wrap.system { justify-content:center; }
    .bubble-wrap.player { justify-content:flex-start; }
    .bubble { max-width:78%; padding:8px 10px; border-radius:12px; line-height:1.3; border:1px solid #314050; }
    .bubble.system { background:#1a2430; color:#e3edf7; border-color:#3b4c60; }
    .bubble.player { background:#1d2a36; color:#f2f7fb; }
    .meta { font-size:11px; opacity:.75; margin-bottom:2px; }
    .log { font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <h3>Game Controls</h3>
      <div class="row">
        <button onclick="act('new')">New</button>
        <button onclick="act('next')">Next</button>
        <button onclick="act('run10')">Run 10 Phases</button>
        <button onclick="act('multi5')">Multi x5</button>
      </div>
      <div class="row">
        <label>Players:</label>
        <input id="playerCount" value="6" style="width:70px"/>
        <button onclick="setPlayerCount()">Apply</button>
      </div>
      <div class="row">
        <label>Auto phase (sec):</label>
        <input id="autoSec" value="8" style="width:70px"/>
        <button onclick="setAuto(true)">Auto On</button>
        <button onclick="setAuto(false)">Auto Off</button>
      </div>
      <div class="row">
        <label><input type="checkbox" id="saveMode"/> Save to file</label>
        <input id="saveDir" placeholder="save dir" value="saved_games"/>
        <button onclick="setSaveMode()">Apply Save</button>
        <button onclick="saveNow()">Save Now</button>
      </div>
      <div class="row">
        <button onclick="toggleLlm()">Toggle LLM</button>
        <input id="token" placeholder="Puter auth token"/>
        <button onclick="setToken()">Set Token</button>
        <button onclick="login()">Login</button>
        <button onclick="probe()">Probe</button>
        <button onclick="verifyAuth()">Verify Auth</button>
      </div>
      <div class="row">
        <label>Default model:</label>
        <select id="defaultModel"></select>
        <button onclick="setDefaultModel()">Apply Model</button>
      </div>
      <div class="row">
        <label><input type="checkbox" id="sepHuman"/> Separate Human Player</label>
        <input id="humanName" placeholder="Human name" value="You"/>
        <button onclick="setSeparateHuman()">Apply</button>
      </div>
      <div class="row">
        <select id="human"></select>
        <button onclick="setHuman()">Set Human</button>
        <button onclick="clearHuman()">Human Off</button>
      </div>
      <div class="row">
        <input id="say" placeholder="say message"/>
        <button onclick="sendSay()">Say</button>
      </div>
      <div class="row">
        <input id="vote" placeholder="vote target"/>
        <button onclick="sendVote()">Vote</button>
      </div>
      <div class="row">
        <input id="nightAction" placeholder="night action e.g. Kill"/>
        <input id="nightTarget" placeholder="night target"/>
        <button onclick="sendNight()">Night</button>
      </div>
      <div id="state" class="status mono"></div>
      <h4>Players</h4>
      <div id="players" class="players"></div>
      <h4>Analytics</h4>
      <div id="analytics" class="status mono"></div>
    </div>
    <div class="panel">
      <h3>Transcript</h3>
      <div id="transcript"></div>
      <h3>Log</h3>
      <div id="log" class="mono log"></div>
    </div>
  </div>
  <script>
    async function post(path, body={}) {
      const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
      return r.json();
    }
    async function act(name) {
      if (name === 'run10') return post('/api/run-phases', {count:10}).then(refresh);
      if (name === 'multi5') return post('/api/multi', {count:5}).then(refresh);
      return post('/api/action', {name}).then(refresh);
    }
    async function toggleLlm() { await post('/api/action', {name:'toggle-llm'}); refresh(); }
    async function setToken() { await post('/api/set-token', {token:document.getElementById('token').value}); refresh(); }
    async function login() { await post('/api/login'); refresh(); }
    async function probe() {
      const r = await post('/api/probe');
      alert(r.ok ? ('Probe: '+r.text) : ('Probe failed: '+r.message));
      refresh();
    }
    async function verifyAuth() {
      const r = await post('/api/verify-auth');
      if (!r.ok) {
        alert('Verify failed: '+(r.message||'unknown'));
        return;
      }
      const env = (r.result.env || []).map(x=>'#'+x.index+': '+(x.ok?'OK':'FAIL')+' ('+x.message+')').join('\\n') || '<no env tokens>';
      const browser = r.result.browser || {};
      alert('Env:\\n'+env+'\\n\\nBrowser: '+(browser.attempted?(browser.ok?'OK':'FAIL'):'SKIPPED')+' ('+(browser.message||'')+')');
      refresh();
    }
    async function setAuto(on) {
      const sec = Number(document.getElementById('autoSec').value || 8);
      await post('/api/auto', {on, intervalSec:sec});
      refresh();
    }
    async function setPlayerCount() {
      const count = Number(document.getElementById('playerCount').value || 6);
      const r = await post('/api/player-count', {count});
      if (!r.ok) alert('Player count must be >= 5');
      refresh();
    }
    async function setSaveMode() {
      await post('/api/save-mode', {
        on: document.getElementById('saveMode').checked,
        dir: document.getElementById('saveDir').value
      });
      refresh();
    }
    async function saveNow() {
      const r = await post('/api/save-now', {tag:'manual_gui'});
      if (!r.ok) alert(r.message || 'Save failed');
      refresh();
    }
    async function setSeparateHuman() {
      await post('/api/separate-human', {
        on: document.getElementById('sepHuman').checked,
        name: document.getElementById('humanName').value || 'You'
      });
      refresh();
    }
    async function setHuman() { await post('/api/player', {id:document.getElementById('human').value}); refresh(); }
    async function clearHuman() { await post('/api/player-off'); refresh(); }
    async function sendSay() { await post('/api/say', {text:document.getElementById('say').value}); document.getElementById('say').value=''; refresh(); }
    async function sendVote() { await post('/api/vote', {target:document.getElementById('vote').value}); document.getElementById('vote').value=''; refresh(); }
    async function sendNight() {
      await post('/api/night', {
        action: document.getElementById('nightAction').value,
        target: document.getElementById('nightTarget').value
      });
      document.getElementById('nightAction').value=''; document.getElementById('nightTarget').value='';
      refresh();
    }
    async function directVote(id) {
      await post('/api/vote', {target:id});
      await post('/api/action', {name:'next'});
      refresh();
    }
    async function directNightTarget(id) {
      document.getElementById('nightTarget').value=id;
      await sendNight();
    }
    async function setDefaultModel() {
      const m = document.getElementById('defaultModel').value;
      await post('/api/model-default', {model:m});
      refresh();
    }
    async function setPlayerModel(id) {
      const sel = document.getElementById('model_'+id);
      await post('/api/model-player', {player:id, model:sel.value});
      refresh();
    }
    function renderTranscript(entries) {
      return entries.map((p)=>{
        return '<div class="bubble-wrap '+p.kind+'"><div class="bubble '+p.kind+'"><div class="meta">'+p.phase+' • '+p.speaker+'</div><div>'+p.msg+'</div></div></div>';
      }).join('');
    }
    function renderPlayers(players) {
      return players.map(p=>{
        const cls = p.alive ? 'player-card' : 'player-card dead';
        return '<div class="'+cls+'">'+
          '<div><b>'+p.name+'</b> ('+p.id+')</div>'+
          '<div>Alive: '+p.alive+' | Role: '+p.role+'</div>'+
          '<div>AI: '+(p.ai||'')+'</div>'+
          '<div>Model: <select id="model_'+p.id+'">'+window.__models.map(m=>'<option value="'+m+'" '+(window.__modelMap[p.id]===m?'selected':'')+'>'+m+'</option>').join('')+'</select> <button onclick="setPlayerModel(\\''+p.id+'\\')">Set</button></div>'+
          '<div>Night: '+(p.night||'')+'</div>'+
          '<div class="row">'+
            '<button onclick="quickVote(\\''+p.id+'\\')">Vote '+p.name+'</button>'+
            '<button onclick="quickTarget(\\''+p.id+'\\')">Target</button>'+
            '<button onclick="directVote(\\''+p.id+'\\')">Vote Now</button>'+
            '<button onclick="directNightTarget(\\''+p.id+'\\')">Night Target</button>'+
          '</div>'+
        '</div>';
      }).join('');
    }
    function quickVote(id){ document.getElementById('vote').value=id; }
    function quickTarget(id){ document.getElementById('nightTarget').value=id; }
    async function refresh() {
      const data = await fetch('/api/state').then(r=>r.json());
      const activeId = (document.activeElement && document.activeElement.id) ? document.activeElement.id : '';
      const editingModel = activeId === 'defaultModel' || activeId.startsWith('model_');
      document.getElementById('state').textContent =
        'Round: '+data.round+'\\nPhase: '+data.phase+'\\nWinner: '+(data.winner||'None')+'\\nLLM: '+(data.llmMode?'ON':'OFF')+
        '\\nPlayers(next game): '+data.playerCount+'\\nSave mode: '+(data.saveToFileMode?'ON':'OFF')+' ('+(data.saveDir||'saved_games')+')'+
        '\\nLast save: '+(data.lastSavedPath || 'none')+'\\nSeparate Human: '+(data.separateHumanPlayer?'ON':'OFF')+'\\nHuman: '+(data.humanPlayerId||'none')+
        '\\nAuto: '+(data.auto.enabled?('ON ('+data.auto.countdownSec+'s)'):'OFF');
      window.__models = data.availableModels || [];
      window.__modelMap = data.modelMap || {};
      if (!editingModel) {
        document.getElementById('defaultModel').innerHTML = window.__models.map(m=>'<option value="'+m+'" '+(data.defaultModel===m?'selected':'')+'>'+m+'</option>').join('');
        document.getElementById('players').innerHTML = renderPlayers(data.players);
      }
      if (activeId !== 'playerCount') document.getElementById('playerCount').value = String(data.playerCount || 6);
      document.getElementById('saveMode').checked = !!data.saveToFileMode;
      if (activeId !== 'saveDir') document.getElementById('saveDir').value = data.saveDir || 'saved_games';
      document.getElementById('transcript').innerHTML = renderTranscript(data.transcriptStructured || []);
      document.getElementById('log').textContent = data.log.map(x=>'- '+x).join('\\n');
      const winners = Object.entries(data.analytics.winners).map(([k,v])=>k+':'+v).join(', ');
      const elim = (data.analytics.lastEliminationOrder||[]).map(e=>e.name+'('+e.cause+')').join(' -> ');
      const susp = (data.analytics.recentSuspicion||[]).slice(-8).map(s=>s.playerId+'=>'+(s.mostSuspicious||'n/a')+'@'+(s.confidence??'n/a')).join('\\n');
      document.getElementById('analytics').textContent =
        'Games: '+data.analytics.totalGames+'\\nWinners: '+(winners||'none')+'\\nLast elimination order: '+(elim||'none')+'\\nRecent suspicion:\\n'+(susp||'none');
      const humanSel = document.getElementById('human');
      humanSel.innerHTML = data.players.map(p=>'<option value="'+p.id+'">'+p.name+' ('+p.id+')</option>').join('');
      document.getElementById('sepHuman').checked = !!data.separateHumanPlayer;
    }
    refresh();
    setInterval(refresh, 1200);
  </script>
</body>
</html>`;
}

async function handleApi(req, res, path) {
  const body = await parseBody(req);
  if (path === "/api/state") return json(res, 200, snapshot());

  if (path === "/api/action") {
    await runExclusive(async () => {
      if (body.name === "new") await game.setupGame();
      else if (body.name === "next") await game.nextPhase();
      else if (body.name === "toggle-llm") {
        game.ai.setUsePuter(!game.ai.usePuter);
        if (game.ai.usePuter) await initPuterClient({ appName: "node-text-mafia" });
      }
      recordFinishedGameIfNeeded();
    });
    return json(res, 200, { ok: true });
  }

  if (path === "/api/run-phases") {
    const count = Math.max(1, Number(body.count || 1));
    await runExclusive(async () => {
      for (let i = 0; i < count && !game.winner; i++) await game.nextPhase();
      recordFinishedGameIfNeeded();
    });
    return json(res, 200, { ok: true });
  }

  if (path === "/api/multi") {
    const count = Math.max(1, Number(body.count || 1));
    const winners = {};
    await runExclusive(async () => {
      for (let i = 0; i < count; i++) {
        await game.setupGame();
        while (!game.winner) await game.nextPhase();
        winners[game.winner] = (winners[game.winner] || 0) + 1;
        recordFinishedGameIfNeeded();
      }
    });
    return json(res, 200, { ok: true, winners });
  }

  if (path === "/api/set-token") {
    await setAuthToken(String(body.token || ""));
    await initPuterClient({ appName: "node-text-mafia", token: String(body.token || "") });
    game.ai.setUsePuter(true);
    game.applyLlmDisplayNames();
    return json(res, 200, { ok: true });
  }

  if (path === "/api/model-default") {
    const ok = game.setDefaultModel(String(body.model || ""));
    return json(res, 200, { ok });
  }

  if (path === "/api/model-player") {
    const ok = game.setPlayerModel(String(body.player || ""), String(body.model || ""));
    return json(res, 200, { ok });
  }

  if (path === "/api/login") {
    await loginViaBrowser();
    await initPuterClient({ appName: "node-text-mafia" });
    game.ai.setUsePuter(true);
    game.applyLlmDisplayNames();
    return json(res, 200, { ok: true });
  }

  if (path === "/api/probe") {
    try {
      const text = await probePuter(game.ai.defaultModel);
      return json(res, 200, { ok: true, text: String(text).slice(0, 220) });
    } catch (err) {
      return json(res, 200, { ok: false, message: String(err && err.message ? err.message : err) });
    }
  }

  if (path === "/api/verify-auth") {
    try {
      const result = await verifyPuterAuthSources(game.ai.defaultModel);
      return json(res, 200, { ok: true, result });
    } catch (err) {
      return json(res, 200, { ok: false, message: String(err && err.message ? err.message : err) });
    }
  }

  if (path === "/api/player") {
    const ok = game.setHumanPlayer(String(body.id || ""));
    return json(res, 200, { ok });
  }

  if (path === "/api/player-off") {
    game.clearHumanPlayer();
    return json(res, 200, { ok: true });
  }

  if (path === "/api/separate-human") {
    const on = !!body.on;
    const name = String(body.name || "You");
    game.setSeparateHumanMode(on, name);
    await game.setupGame();
    return json(res, 200, { ok: true });
  }

  if (path === "/api/player-count") {
    const ok = game.setPlayerCount(Number(body.count || 6));
    return json(res, 200, { ok, playerCount: game.playerCount });
  }

  if (path === "/api/save-mode") {
    game.setSaveMode(!!body.on, String(body.dir || ""));
    return json(res, 200, { ok: true, saveToFileMode: game.saveToFileMode, saveDir: game.saveDir });
  }

  if (path === "/api/save-now") {
    try {
      const paths = game.saveGameToFile(String(body.tag || "manual"));
      return json(res, 200, { ok: true, jsonPath: paths.jsonPath, txtPath: paths.txtPath });
    } catch (err) {
      return json(res, 200, { ok: false, message: String(err && err.message ? err.message : err) });
    }
  }

  if (path === "/api/auto") {
    autoPhase.enabled = !!body.on;
    autoPhase.intervalSec = Math.max(2, Number(body.intervalSec || 8));
    autoPhase.nextAt = Date.now() + autoPhase.intervalSec * 1000;
    return json(res, 200, { ok: true });
  }

  if (path === "/api/say") {
    game.submitHumanDiscussion(String(body.text || ""));
    return json(res, 200, { ok: true });
  }

  if (path === "/api/vote") {
    game.submitHumanVote(String(body.target || ""));
    return json(res, 200, { ok: true });
  }

  if (path === "/api/night") {
    game.submitHumanNight(String(body.action || "DoNothing"), String(body.target || ""), "");
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, message: "Not found" });
}

function recordFinishedGameIfNeeded() {
  if (!game.winner) return;
  if (recordedSessions.has(game.sessionId)) return;
  recordedSessions.add(game.sessionId);
  analytics.totalGames += 1;
  analytics.winners[game.winner] = (analytics.winners[game.winner] || 0) + 1;
  analytics.eliminationOrders.push(game.eliminationOrder.slice());
  analytics.suspicionTimeline.push(...game.suspicionTimeline.slice());
  if (analytics.eliminationOrders.length > 40) analytics.eliminationOrders.shift();
  if (analytics.suspicionTimeline.length > 2000) {
    analytics.suspicionTimeline = analytics.suspicionTimeline.slice(-1200);
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && u.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }

  if (u.pathname.startsWith("/api/")) {
    await handleApi(req, res, u.pathname);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

async function main() {
  await game.setupGame();
  setInterval(() => {
    if (!autoPhase.enabled) return;
    if (Date.now() < autoPhase.nextAt) return;
    runExclusive(async () => {
      if (!game.winner) {
        await game.nextPhase();
        recordFinishedGameIfNeeded();
      }
      autoPhase.nextAt = Date.now() + autoPhase.intervalSec * 1000;
    }).catch(() => {});
  }, 400);
  server.listen(PORT, HOST, () => {
    console.log(`Text Mafia GUI running at http://${HOST}:${PORT}`);
    if (HOST !== "localhost" && HOST !== "127.0.0.1") {
      console.log(`Local access: http://localhost:${PORT}`);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
