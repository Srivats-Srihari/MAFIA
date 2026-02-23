const fs = require("fs");
const path = require("path");

function parseEnv(content) {
  const out = {};
  for (const line of String(content || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx <= 0) continue;
    const k = t.slice(0, idx).trim();
    let v = t.slice(idx + 1).trim();
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function quoteIfNeeded(value) {
  const v = String(value == null ? "" : value);
  if (!v) return "";
  if (/[\s#]/.test(v)) {
    return `"${v.replace(/"/g, "\\\"")}"`;
  }
  return v;
}

function main() {
  const root = process.cwd();
  const examplePath = path.join(root, ".env.example");
  const envPath = path.join(root, ".env");

  if (!fs.existsSync(examplePath)) {
    console.error("Missing .env.example");
    process.exit(1);
  }

  const exampleContent = fs.readFileSync(examplePath, "utf8");
  const existingContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const existing = parseEnv(existingContent);

  const lines = exampleContent.split(/\r?\n/);
  let updated = 0;
  let fromSystem = 0;
  let unresolved = 0;

  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return line;
    const idx = line.indexOf("=");
    if (idx <= 0) return line;
    const key = line.slice(0, idx).trim();
    const exampleVal = line.slice(idx + 1).trim();

    const sysVal = process.env[key];
    const chosen =
      (typeof sysVal === "string" && sysVal !== "")
        ? (fromSystem++, sysVal)
        : (typeof existing[key] === "string" ? existing[key] : exampleVal);
    if (chosen === "" || chosen === exampleVal) unresolved++;
    if (chosen !== exampleVal) updated++;
    return `${key}=${quoteIfNeeded(chosen)}`;
  });

  fs.writeFileSync(envPath, out.join("\n"), "utf8");
  console.log(`.env synced: ${envPath}`);
  console.log(`From system env: ${fromSystem}`);
  console.log(`Updated fields: ${updated}`);
  console.log(`Unresolved/default fields: ${unresolved}`);
}

main();
