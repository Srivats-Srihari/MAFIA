const { execFile } = require("child_process");
const path = require("path");
const { loadEnvFile } = require("./envLoader");
loadEnvFile();
let initFn = null;
let getAuthTokenFn = null;
let puterRef = null;
let currentAuthToken = process.env.PUTER_AUTH_TOKEN || "";
const puterByToken = new Map();

const SAMBANOVA_DEFAULT_MODEL = process.env.SAMBANOVA_MODEL || "ALLaM-7B-Instruct-preview";
const SAMBANOVA_BASE_URL = process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1";
const AI_PROVIDER_MODE = String(process.env.MAFIA_AI_PROVIDER || "auto").trim().toLowerCase();
const DEFAULT_PROVIDER_CHAIN = "puter,sambanova,mistral,openrouter,together,groq";

function firstEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function loadInitModule() {
  if (initFn && getAuthTokenFn) {
    return;
  }

  let mod;
  try {
    // User-requested auth flow:
    // import { init, getAuthToken } from "@heyputer/puter.js/src/init.cjs";
    mod = require("@heyputer/puter.js/src/init.cjs");
  } catch (err) {
    throw new Error(
      "Could not load @heyputer/puter.js/src/init.cjs. " +
      "Run `npm install` in node-text-mafia first. Details: " +
      String(err && err.message ? err.message : err)
    );
  }

  initFn = mod && typeof mod.init === "function" ? mod.init : null;
  getAuthTokenFn = mod && typeof mod.getAuthToken === "function" ? mod.getAuthToken : null;

  if (!initFn || !getAuthTokenFn) {
    throw new Error("Puter init module does not export both init and getAuthToken.");
  }
}

async function ensurePuterClient() {
  loadInitModule();
  if (puterRef) {
    return puterRef;
  }

  if (!currentAuthToken) {
    // Opens browser login flow when needed.
    currentAuthToken = normalizeToken(await getAuthTokenFn());
  }

  puterRef = initFn(currentAuthToken);
  if (!puterRef || !puterRef.ai || typeof puterRef.ai.chat !== "function") {
    throw new Error("Initialized Puter client is missing ai.chat.");
  }
  return puterRef;
}

function getPuterTokenCandidates() {
  const csv = String(process.env.PUTER_AUTH_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = dedupeModels([
    ...csv,
    String(process.env.PUTER_AUTH_TOKEN || "").trim(),
    String(currentAuthToken || "").trim()
  ]);
  return merged.slice(0, 5);
}

async function getPuterClientForToken(token) {
  loadInitModule();
  const key = String(token || "").trim();
  if (!key) {
    return ensurePuterClient();
  }
  if (puterByToken.has(key)) {
    return puterByToken.get(key);
  }
  const client = initFn(key);
  if (!client || !client.ai || typeof client.ai.chat !== "function") {
    throw new Error("Initialized Puter client is missing ai.chat.");
  }
  puterByToken.set(key, client);
  return client;
}

async function initPuterClient(opts = {}) {
  loadInitModule();
  const token = String(opts.token || currentAuthToken || "").trim();
  if (token) {
    currentAuthToken = normalizeToken(token);
    puterRef = initFn(currentAuthToken);
    return;
  }

  if (process.env.MAFIA_HEADLESS === "1") {
    throw new Error("Headless mode enabled and no PUTER_AUTH_TOKEN set. Use token-based auth or non-headless mode.");
  }
  // No token provided: use browser login flow.
  currentAuthToken = normalizeToken(await getAuthTokenFn());
  puterRef = initFn(currentAuthToken);
}

async function puterChat(prompt, model) {
  const chain = resolveProviderChain();
  let lastError = null;
  for (const provider of chain) {
    try {
      return await chatWithProvider(provider, prompt, model);
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error("No AI provider available.");
}

async function getAuthToken() {
  loadInitModule();
  if (currentAuthToken) return currentAuthToken;
  currentAuthToken = normalizeToken(await getAuthTokenFn());
  return currentAuthToken;
}

function getPuterRef() {
  return puterRef;
}

async function setAuthToken(token) {
  currentAuthToken = normalizeToken(token);
  if (!currentAuthToken) {
    throw new Error("Empty token.");
  }
  loadInitModule();
  puterRef = initFn(currentAuthToken);
  puterByToken.set(currentAuthToken, puterRef);
  return currentAuthToken;
}

async function loginViaBrowser() {
  loadInitModule();
  currentAuthToken = normalizeToken(await getAuthTokenFn());
  if (!currentAuthToken) {
    throw new Error("No auth token returned from browser login.");
  }
  puterRef = initFn(currentAuthToken);
  puterByToken.set(currentAuthToken, puterRef);
  return currentAuthToken;
}

async function probePuter(model = process.env.PUTER_MODEL || "gpt-5.2") {
  const msg = '{"ping":"pong"}';
  const out = await puterChat("Return exactly this JSON and nothing else: " + msg, model);
  return out;
}

async function verifySinglePuterToken(token, model) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, source: "empty", message: "missing token" };
  try {
    const client = await getPuterClientForToken(t);
    const res = await client.ai.chat('Return exactly {"ok":true}', { model });
    const text = res && res.message ? String(res.message.content || "") : String(res || "");
    return { ok: true, source: "token", message: text.slice(0, 120) };
  } catch (err) {
    return { ok: false, source: "token", message: String(err && err.message ? err.message : err).slice(0, 220) };
  }
}

async function verifyPuterAuthSources(model = process.env.PUTER_MODEL || "gpt-5.2") {
  const result = {
    env: [],
    browser: { attempted: false, ok: false, message: "" }
  };

  const envTokens = getPuterTokenCandidates();
  for (let i = 0; i < envTokens.length; i++) {
    const r = await verifySinglePuterToken(envTokens[i], model);
    result.env.push({
      index: i + 1,
      ok: r.ok,
      message: r.message
    });
  }

  if (process.env.MAFIA_HEADLESS === "1") {
    result.browser = { attempted: false, ok: false, message: "headless mode enabled" };
    return result;
  }

  result.browser.attempted = true;
  try {
    loadInitModule();
    const browserToken = normalizeToken(await getAuthTokenFn());
    if (!browserToken) {
      result.browser = { attempted: true, ok: false, message: "no browser token returned" };
      return result;
    }
    const b = await verifySinglePuterToken(browserToken, model);
    result.browser = { attempted: true, ok: b.ok, message: b.message };
  } catch (err) {
    result.browser = { attempted: true, ok: false, message: String(err && err.message ? err.message : err).slice(0, 220) };
  }
  return result;
}

function canUseSambaFallback(err) {
  const enabled = process.env.MAFIA_SAMBANOVA_FALLBACK !== "0";
  const hasKey = !!String(process.env.SAMBANOVA_API_KEY || "").trim();
  if (!enabled || !hasKey) return false;
  // If fallback is configured, prefer resilience: any Puter failure can trigger Samba fallback.
  if (process.env.SAMBANOVA_FALLBACK_STRICT_MATCH !== "1") return true;
  const text = String(err && err.message ? err.message : err).toLowerCase();
  if (!text) return true;
  return (
    text.includes("token_missing") ||
    text.includes("insufficient_funds") ||
    text.includes("usage-limited-chat") ||
    text.includes("payment required") ||
    text.includes("402") ||
    text.includes("timeout") ||
    text.includes("network")
  );
}

function resolveProviderChain() {
  if (AI_PROVIDER_MODE && AI_PROVIDER_MODE !== "auto") {
    return [AI_PROVIDER_MODE];
  }
  const raw = String(process.env.MAFIA_PROVIDER_CHAIN || DEFAULT_PROVIDER_CHAIN);
  const arr = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set(arr));
}

async function chatWithProvider(provider, prompt, model) {
  if (provider === "puter") return puterOnlyChat(prompt, model);
  if (provider === "sambanova") return sambaChatViaPython(prompt, model);
  if (provider === "mistral") return openAICompatChat({
    name: "mistral",
    url: firstEnv("MISTRAL_BASE_URL") || "https://api.mistral.ai/v1/chat/completions",
    apiKey: firstEnv("MISTRAL_API_KEY", "MISTRAL_KEY"),
    model: String(model || "").trim(),
    defaultModels: csvModels("MISTRAL_MODELS", ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"]),
    prompt
  });
  if (provider === "openrouter") return openAICompatChat({
    name: "openrouter",
    url: firstEnv("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1/chat/completions",
    apiKey: firstEnv("OPENROUTER_API_KEY", "OPENROUTER_KEY"),
    model: String(model || "").trim(),
    defaultModels: csvModels("OPENROUTER_MODELS", [firstEnv("OPENROUTER_MODEL"), "mistralai/mistral-small-3.1-24b-instruct"]),
    prompt
  });
  if (provider === "together") return openAICompatChat({
    name: "together",
    url: firstEnv("TOGETHER_BASE_URL") || "https://api.together.xyz/v1/chat/completions",
    apiKey: firstEnv("TOGETHER_API_KEY", "TOGETHER_KEY"),
    model: String(model || "").trim(),
    defaultModels: csvModels("TOGETHER_MODELS", [firstEnv("TOGETHER_MODEL"), "mistralai/Mistral-7B-Instruct-v0.3"]),
    prompt
  });
  if (provider === "groq") return openAICompatChat({
    name: "groq",
    url: firstEnv("GROQ_BASE_URL") || "https://api.groq.com/openai/v1/chat/completions",
    apiKey: firstEnv("GROQ_API_KEY", "GROQ_KEY"),
    model: String(model || "").trim(),
    defaultModels: csvModels("GROQ_MODELS", [firstEnv("GROQ_MODEL"), "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]),
    prompt
  });
  throw new Error(`Unsupported provider: ${provider}`);
}

async function puterOnlyChat(prompt, model) {
  const candidates = dedupeModels([String(model || "").trim(), ...csvModels("PUTER_MODELS", [
    firstEnv("PUTER_MODEL"),
    "gpt-5.2",
    "gpt-5.1",
    "gpt-4.1"
  ])]);
  const tokens = getPuterTokenCandidates();
  const tokenPool = tokens.length > 0 ? tokens : [""];
  let lastErr = null;
  for (const token of tokenPool) {
    let puter;
    try {
      puter = await getPuterClientForToken(token);
    } catch (err) {
      lastErr = err;
      continue;
    }
    for (const candidate of candidates) {
      try {
        const result = await puter.ai.chat(prompt, { model: candidate });
        if (result && result.message && typeof result.message.content !== "undefined") {
          return String(result.message.content);
        }
        if (typeof result === "string") return result;
        const txt = JSON.stringify(result || {});
        if (txt && txt !== "{}") return txt;
        lastErr = new Error(`puter returned empty content for model ${candidate}`);
      } catch (err) {
        lastErr = err;
        continue;
      }
    }
  }
  throw lastErr || new Error("puter failed for all candidate models/tokens");
}

async function openAICompatChat(opts) {
  const url = String(opts.url || "");
  const apiKey = String(opts.apiKey || "").trim();
  const model = String(opts.model || "").trim();
  const prompt = String(opts.prompt || "");
  const temperature = Number(process.env.MAFIA_PROVIDER_TEMPERATURE || 0.2);
  const topP = Number(process.env.MAFIA_PROVIDER_TOP_P || 0.2);
  const modelCandidates = dedupeModels([model, ...(Array.isArray(opts.defaultModels) ? opts.defaultModels : [])]);
  if (!url || !apiKey || modelCandidates.length === 0) {
    const missing = [];
    if (!url) missing.push("base_url");
    if (!apiKey) missing.push("api_key");
    if (modelCandidates.length === 0) missing.push("model");
    throw new Error(`${opts.name} not configured: missing ${missing.join(", ")}`);
  }
  let lastErr = null;
  for (const candidateModel of modelCandidates) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: candidateModel,
        messages: [
          { role: "system", content: "You are a strategic Mafia game agent. Return only requested content." },
          { role: "user", content: prompt }
        ],
        temperature,
        top_p: topP
      })
    });
    const txt = await res.text();
    let obj = null;
    try {
      obj = JSON.parse(txt);
    } catch (_) {
      obj = null;
    }
    if (res.ok) {
      const content = obj && obj.choices && obj.choices[0] && obj.choices[0].message ? obj.choices[0].message.content : "";
      if (content) return String(content);
      lastErr = new Error(`${opts.name} returned empty content for model ${candidateModel}`);
      continue;
    }
    const msg = obj && obj.error ? (obj.error.message || JSON.stringify(obj.error)) : txt;
    lastErr = new Error(`${opts.name} error ${res.status} [${candidateModel}]: ${String(msg).slice(0, 220)}`);
    continue;
  }
  throw lastErr || new Error(`${opts.name} request failed`);
}

function csvModels(envKey, defaults) {
  const raw = String(process.env[envKey] || "").trim();
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return (defaults || []).filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
}

function dedupeModels(models) {
  const out = [];
  for (const m of models || []) {
    const v = String(m || "").trim();
    if (!v) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function runPythonBridge(payload) {
  return new Promise((resolve, reject) => {
    const defaultPy = process.platform === "win32" ? "python" : "python3";
    const pythonBin = String(process.env.PYTHON_BIN || defaultPy).trim();
    const scriptPath = path.join(__dirname, "sambanova_bridge.py");
    const child = execFile(
      pythonBin,
      [scriptPath],
      {
        timeout: Number(process.env.SAMBANOVA_TIMEOUT_MS || 45000),
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr || stdout || error.message || "SambaNova bridge failed.";
          reject(new Error(String(msg).trim()));
          return;
        }
        resolve(String(stdout || "").trim());
      }
    );
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function sambaChatViaPython(prompt, model) {
  const apiKey = String(process.env.SAMBANOVA_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("SambaNova fallback requested but SAMBANOVA_API_KEY is missing.");
  }
  const candidates = dedupeModels([
    String(process.env.SAMBANOVA_USE_REQUESTED_MODEL === "1" ? (model || "") : "").trim(),
    ...csvModels("SAMBANOVA_MODELS", [firstEnv("SAMBANOVA_MODEL"), SAMBANOVA_DEFAULT_MODEL])
  ]);
  let lastErr = null;
  for (const candidate of candidates) {
    const payload = {
      api_key: apiKey,
      base_url: SAMBANOVA_BASE_URL,
      model: candidate,
      prompt: String(prompt || ""),
      temperature: Number(process.env.SAMBANOVA_TEMPERATURE || 0.2),
      top_p: Number(process.env.SAMBANOVA_TOP_P || 0.2)
    };
    const raw = await runPythonBridge(payload);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      lastErr = new Error(`Invalid SambaNova bridge output: ${String(raw).slice(0, 220)}`);
      continue;
    }
    if (parsed && parsed.ok === true) {
      return String(parsed.content || "");
    }
    lastErr = new Error(parsed && parsed.error ? parsed.error : `Unknown SambaNova error for model ${candidate}.`);
  }
  throw lastErr || new Error("SambaNova failed for all candidate models");
}

function normalizeToken(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return String(value.authToken || value.token || "").trim();
  }
  return "";
}

module.exports = {
  initPuterClient,
  puterChat,
  getAuthToken,
  getPuterRef,
  setAuthToken,
  loginViaBrowser,
  probePuter,
  verifyPuterAuthSources
};
