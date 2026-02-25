# Run Node Text Mafia on Google Colab

Use these cells in a Colab notebook.

## 1) Install Node.js and clone project

```bash
%%bash
set -e
apt-get update -y
apt-get install -y nodejs npm
cd /content
if [ ! -d node-text-mafia ]; then
  git clone https://github.com/<YOUR_USER>/<YOUR_REPO>.git node-text-mafia
fi
cd /content/node-text-mafia
npm install
```

## 2) (Optional) Set provider keys for this runtime

```python
import os

# Recommended for Colab (no local browser login flow)
os.environ["MAFIA_HEADLESS"] = "1"
os.environ["MAFIA_GUI_HOST"] = "0.0.0.0"
os.environ["MAFIA_GUI_PORT"] = "8787"

# Set whichever providers you use:
# os.environ["MAFIA_AI_PROVIDER"] = "sambanova"
# os.environ["SAMBANOVA_API_KEY"] = "..."
# os.environ["GROQ_API_KEY"] = "..."
# os.environ["OPENROUTER_API_KEY"] = "..."
```

## 3) Start GUI server and open Colab proxy URL

```python
import os
import time
import subprocess
from google.colab.output import eval_js

workdir = "/content/node-text-mafia"
port = int(os.environ.get("MAFIA_GUI_PORT", "8787"))

proc = subprocess.Popen(
    ["npm", "run", "colab:gui"],
    cwd=workdir,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True
)

time.sleep(4)
url = eval_js(f"google.colab.kernel.proxyPort({port})")
print("Open GUI:", url)
```

## 4) (Optional) Stream server logs in a new cell

```python
while True:
    line = proc.stdout.readline()
    if not line:
        break
    print(line, end="")
```

## Notes

- Colab runtimes are ephemeral; reinstall/restart after reconnect.
- For Puter browser login flows, Colab is usually not ideal. Prefer token/headless providers in Colab.
