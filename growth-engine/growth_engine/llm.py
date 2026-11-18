"""Local text model via Ollama (our QLoRA fine-tune when it exists, else base model + few-shot)."""
from __future__ import annotations

import re

import requests

CLICHES = [
    "revolution", "game-changer", "gamechanger", "naar een hoger niveau", "next level", "in de huidige",
    "digitale wereld", "ik hoop dat", "deze mail je goed", "baanbrekend", "ontketen", "unleash",
    "boost", "supercharge", "synergie", "naadloos", "seamless", "cutting-edge", "state-of-the-art",
    "laat je inspireren", "duik", "dive", "in een notendop", "het is geen geheim", "sterker nog",
    "transformeer", "potentieel", "!!", "🚀", "✨", "💡", "🔥", "geoptimaliseerd", "allesomvattend",
]
EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF☀-➿]")


class LocalLLM:
    def __init__(self, cfg: dict):
        c = cfg["llm"]
        self.url = c["ollama_url"].rstrip("/")
        self.base_model = c["base_model"]
        self.ft_model = c.get("finetuned_model")
        self.temperature = c.get("temperature", 0.6)
        self._model = None

    def model(self) -> str | None:
        """Our fine-tune if Ollama has it, else the base model, else None (Ollama not running)."""
        if self._model is not None:
            return self._model or None
        try:
            tags = requests.get(self.url + "/api/tags", timeout=3).json().get("models", [])
        except (requests.RequestException, ValueError):
            self._model = ""
            return None
        names = {m["name"].split(":")[0] for m in tags} | {m["name"] for m in tags}
        if self.ft_model and self.ft_model in names:
            self._model = self.ft_model
        elif self.base_model in names or self.base_model.split(":")[0] in names:
            self._model = self.base_model
        else:
            self._model = ""
        return self._model or None

    def chat(self, messages: list[dict], max_tokens: int = 300) -> str | None:
        model = self.model()
        if not model:
            return None
        try:
            r = requests.post(self.url + "/api/chat", timeout=180, json={
                "model": model, "messages": messages, "stream": False,
                "options": {"temperature": self.temperature, "num_predict": max_tokens}})
            r.raise_for_status()
            return r.json()["message"]["content"].strip()
        except (requests.RequestException, KeyError, ValueError):
            return None


def clean_text(text: str) -> str:
    text = text.strip().strip('"').strip()
    text = re.sub(r"^(onderwerp|subject)\s*:.*\n", "", text, flags=re.I)
    text = re.sub(r"\*\*|__|^#+\s*", "", text, flags=re.M)
    text = EMOJI_RE.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def violations(text: str, max_words: int) -> list[str]:
    out = []
    low = text.lower()
    out += [f"cliché: {c}" for c in CLICHES if c in low]
    n = len(text.split())
    if n > max_words:
        out.append(f"te lang: {n} woorden")
    if EMOJI_RE.search(text):
        out.append("emoji")
    if re.search(r"https?://(?!orivenai\.com)", text):
        out.append("vreemde link")
    return out
