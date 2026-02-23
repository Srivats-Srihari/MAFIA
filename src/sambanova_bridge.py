import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def main():
    try:
        data = json.load(sys.stdin)
    except Exception as e:
        emit({"ok": False, "error": f"Invalid input JSON: {e}"})
        return 1

    api_key = str(data.get("api_key", "")).strip()
    base_url = str(data.get("base_url", "https://api.sambanova.ai/v1")).strip()
    model = str(data.get("model", "ALLaM-7B-Instruct-preview")).strip()
    prompt = str(data.get("prompt", ""))
    temperature = float(data.get("temperature", 0.2))
    top_p = float(data.get("top_p", 0.2))

    if not api_key:
        emit({"ok": False, "error": "Missing SambaNova API key."})
        return 1

    try:
        from sambanova import SambaNova
    except Exception as e:
        emit(
            {
                "ok": False,
                "error": "Python package 'sambanova' is not installed. "
                "Install with: pip install sambanova. "
                f"Details: {e}",
            }
        )
        return 1

    try:
        client = SambaNova(api_key=api_key, base_url=base_url)
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "You are a strategic Mafia game agent. Return only requested content."},
                {"role": "user", "content": prompt},
            ],
            temperature=temperature,
            top_p=top_p,
        )
        content = response.choices[0].message.content if response and response.choices else ""
        emit({"ok": True, "content": str(content or "")})
        return 0
    except Exception as e:
        emit({"ok": False, "error": str(e)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
