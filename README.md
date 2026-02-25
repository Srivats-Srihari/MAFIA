# Node Text Mafia

Standalone text-based Mafia game (separate from Unity).

## Run

```bash
cd node-text-mafia
npm start
```

## Publish To GitHub (for Raspberry Pi clone)

Run on your main machine (Windows PowerShell or terminal with `git` installed):

```bash
cd "C:/Users/sriva/Downloads/node-text-mafia"
git init
git add .
git commit -m "Initial Node Mafia server"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/<YOUR_REPO>.git
git push -u origin main
```

Then on Raspberry Pi:

```bash
git clone https://github.com/<YOUR_USER>/<YOUR_REPO>.git
cd <YOUR_REPO>
npm install
cp .env.example .env
nano .env
npm run run:pi
```

For Raspberry Pi CLI mode:
```bash
npm run run:pi:cli
```

## .env Configuration (recommended)

The app auto-loads `.env` from project root.

1. Copy:
```bash
cp .env.example .env
```
2. Fill your provider keys/models in `.env`.
3. Run normally (`npm start` or `npm run gui`).

Auto-write `.env` from your current system environment:
```bash
npm run env:sync
```

Single command for Raspberry Pi/headless GUI run (syncs `.env` first):
```bash
npm run run:pi
```

## Simple GUI

```bash
cd node-text-mafia
npm run gui
```

Open:
- `http://localhost:8787`
- Google Colab: see `colab/COLAB_SETUP.md`

Host/port env (useful for Colab or remote hosts):
- `MAFIA_GUI_HOST` (default: `0.0.0.0`)
- `MAFIA_GUI_PORT` (default: `8787`)

GUI includes:
- auto phase countdown/run
- chat bubbles transcript
- direct vote/night target buttons on player cards
- separate human player mode toggle
- post-game analytics (winner rates, elimination order, suspicion timeline preview)
- login + probe buttons to verify live Puter LLM connectivity before running turns
- rolling memory compression + recent verbatim context for longer games
- prompt policy to use display names (Alpha/Delta style) instead of player ids in dialogue
- master-mode night logs show who did what and why

## Enable Real Puter LLM Players

```bash
cd node-text-mafia
npm install
MAFIA_USE_PUTER=1 npm start
```

If no token is set, Puter login is launched via browser using:
`init/getAuthToken` from `@heyputer/puter.js/src/init.cjs`.
For headless servers (Raspberry Pi), set `MAFIA_HEADLESS=1` and provide `PUTER_AUTH_TOKEN` or `PUTER_AUTH_TOKENS`.

Optional env:
- `PUTER_MODEL` (default: `gpt-5.2`)
- `MAFIA_MAX_RETRIES` (default: `2`)
- `PUTER_AUTH_TOKEN` (optional; if omitted, Puter auth flow is used)
- `PUTER_AUTH_TOKENS` (optional CSV of up to 5 tokens; runtime rotates and uses first non-error token)
- `PUTER_AGENT_NAMES` (optional CSV for player names, e.g. `GPT-5.2,GPT-4.1,Claude,Gemini,Llama,Mistral`)
- `MAFIA_AI_PROVIDER` (`auto` default, or one of `puter|sambanova|mistral|groq|claude|openrouter|together`)
- `MAFIA_PROVIDER_CHAIN` (comma list for `auto` mode; default `puter,sambanova,mistral,groq,claude,openrouter,together`)

## SambaNova Fallback (when Puter fails/stops)

If Puter errors (token/funds/usage/network), the game can auto-fallback to SambaNova via Python.

1. Install Python package:
```bash
pip install sambanova
```

2. Set env vars:
- `SAMBANOVA_API_KEY` (required for fallback)
- `SAMBANOVA_MODEL` (default: `ALLaM-7B-Instruct-preview`)
- `SAMBANOVA_BASE_URL` (default: `https://api.sambanova.ai/v1`)
- `MAFIA_SAMBANOVA_FALLBACK` (`1` by default; set `0` to disable)
- `PYTHON_BIN` (optional, default `python`)
- `SAMBANOVA_TIMEOUT_MS` (optional, default `45000`)

Example:
```bash
MAFIA_USE_PUTER=1 SAMBANOVA_API_KEY=your_key_here npm start
```

Samba-only mode (skip Puter completely):
```bash
MAFIA_AI_PROVIDER=sambanova SAMBANOVA_API_KEY=your_key_here npm start
```

Notes:
- Default `auto` mode tries providers in order: `puter -> sambanova -> mistral -> groq -> claude -> openrouter -> together`.
- By default fallback uses `SAMBANOVA_MODEL`, not Puter model names.
- If you want to pass requested model name through to SambaNova, set `SAMBANOVA_USE_REQUESTED_MODEL=1`.
- In `auto` mode, fallback triggers on any Puter failure when `SAMBANOVA_API_KEY` is set. To use strict error matching only, set `SAMBANOVA_FALLBACK_STRICT_MATCH=1`.

## Additional Provider Setup

Set keys only for providers you want in your chain:

- Mistral:
  - `MISTRAL_API_KEY`
  - `MISTRAL_MODEL` (default `mistral-small-latest`)
  - `MISTRAL_BASE_URL` (default `https://api.mistral.ai/v1/chat/completions`)
- OpenRouter:
  - `OPENROUTER_API_KEY`
  - `OPENROUTER_MODEL`
  - `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1/chat/completions`)
- Together:
  - `TOGETHER_API_KEY`
  - `TOGETHER_MODEL`
  - `TOGETHER_BASE_URL` (default `https://api.together.xyz/v1/chat/completions`)
- Groq:
  - `GROQ_API_KEY`
  - `GROQ_MODEL` (default `llama-3.1-70b-versatile`)
  - `GROQ_BASE_URL` (default `https://api.groq.com/openai/v1/chat/completions`)
- Claude (Anthropic):
  - `CLAUDE_API_KEY` (or `ANTHROPIC_API_KEY`)
  - `CLAUDE_MODEL` (default `claude-3-7-sonnet-latest`)
  - `CLAUDE_BASE_URL` (default `https://api.anthropic.com/v1/messages`)

Shared sampling knobs:
- `MAFIA_PROVIDER_TEMPERATURE` (default `0.2`)
- `MAFIA_PROVIDER_TOP_P` (default `0.2`)

## Raspberry Pi 4 Notes

- Use Node 18+.
- Prefer `.env` instead of shell-exporting keys.
- Set:
  - `MAFIA_HEADLESS=1`
  - `PYTHON_BIN=python3`
- If using SambaNova bridge on Pi:
  - install Python package: `pip3 install sambanova`
- If your API keys are set in system env already, run `npm run env:sync` to copy them into `.env`.

### Raspberry Pi Parallel Tournament (recommended)

Example `.env` for your setup:

```env
MAFIA_HEADLESS=1
PYTHON_BIN=python3
MAFIA_USE_PUTER=1
PUTER_AUTH_TOKENS=token1,token2,token3
MISTRAL_API_KEY=your_mistral_key
GROQ_API_KEY=your_groq_key
CLAUDE_API_KEY=your_claude_key
SAMBANOVA_API_KEY=your_sambanova_key
MAFIA_PROVIDER_CHAIN=puter,mistral,groq,sambanova
```

Run on Pi:

```bash
cd <YOUR_REPO>
npm install
npm run run:pi:cli
```

Then in CLI:

```text
llm on
playercount 8
new
multipar 50 5
```

Tips for Pi:
- Start with `multipar 20 3` if you hit rate limits/timeouts.
- Increase to `k=5` only after stable runs.

Mixed layout you requested (3 puter + 1 mistral + 2/3 groq + 1 claude + 1 sambanova):

```text
playercount 8
new
multimix 40 3
```

If you want 2 groq workers instead, use:
```text
multimix 40 2
```

## Google Colab Quickstart

Use the prepared guide:

- `colab/COLAB_SETUP.md`

It includes:
- one-cell dependency setup
- Colab proxy URL generation for the GUI
- headless-safe env defaults (`MAFIA_HEADLESS=1`)

## Commands

- `next`: advance one phase
- `run`: auto-run until a winner
- `multi <n>`: run `n` games consecutively (tournament mode)
- `multipar <n> [k]`: run `n` games with up to `k` concurrent workers (default `5`)
- `multimix <n> [groq=2|3]`: run `n` games across mixed workers (3 puter + 1 mistral + groq + 1 claude + 1 sambanova)
- `players`: list player states
- `transcript [n]`: show last `n` transcript lines (default `20`)
- `log [n]`: show game-log/debug lines (default `20`)
- `ai`: show each player's last raw JSON and internal analysis
- `models`: list available models and assignments
- `model <name>`: set default model
- `playermodel <id|name> <model>`: set model for one player
- `player <id|name>`: enable human player control
- `player off`: disable human player mode
- `separatehuman on|off [name]`: create/remove dedicated human-only player
- `say <text>`: queue your discussion line
- `vote <target>`: queue your vote
- `night <action> <target> [dialogue]`: queue your night action
- `master on|off`: toggle master mode
- `llm on|off`: toggle Puter LLM mode at runtime
- `probe`: test live LLM response
- `verifyauth`: verify Puter auth from env tokens and browser token
- `auth`: print current Puter auth token if SDK has one
- `new`: start a new game
- `help`: show commands
- `quit`: exit

Notes:
- CLI and GUI now present AI/debug output in readable text form (not raw JSON dumps).
- In voting ties, nobody is ejected.
