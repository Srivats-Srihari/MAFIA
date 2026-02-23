const fs = require("fs");
const path = require("path");

let loaded = false;

function unquote(v) {
  const s = String(v || "").trim();
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function loadEnvFile() {
  if (loaded) return;
  loaded = true;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = unquote(trimmed.slice(idx + 1));
    if (!key) continue;
    if (typeof process.env[key] === "undefined" || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

module.exports = {
  loadEnvFile
};
