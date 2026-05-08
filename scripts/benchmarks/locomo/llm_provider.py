"""LLM provider abstractions for the answerer and the judge.

Supported backends:

  openai        — OpenAI API key (works with any flat / API budget).
                  Set OPENAI_API_KEY in the environment.

  anthropic     — Anthropic API key.
                  Set ANTHROPIC_API_KEY in the environment.

  claude_oauth  — Spawns the `claude` CLI as a subprocess. Uses your
                  Claude Pro / Max subscription via OAuth — no API key,
                  no per-token charges. Slower and rate-limited by the
                  subscription tier, but free if you already pay for it.
                  Requires `claude login` to be done once.

  ollama        — Local Ollama (free, requires a chat-capable model
                  pulled, e.g. `ollama pull qwen2.5:7b-instruct`).
"""
from __future__ import annotations

import asyncio
import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class LlmConfig:
    kind: str
    model: str
    api_key_env: Optional[str] = None
    temperature: float = 0.0
    max_tokens: int = 512
    base_url: Optional[str] = None
    timeout_s: int = 180


class LlmProvider(ABC):
    @abstractmethod
    async def complete(self, system: str, user: str) -> str:
        """Return the assistant's text reply (no tool use)."""


def make_provider(cfg: LlmConfig) -> LlmProvider:
    kind = cfg.kind.lower()
    if kind == "openai":
        return OpenAIProvider(cfg)
    if kind == "anthropic":
        return AnthropicProvider(cfg)
    if kind == "claude_oauth":
        return ClaudeOAuthProvider(cfg)
    if kind == "ollama":
        return OllamaProvider(cfg)
    raise ValueError(
        f"unknown provider kind: {cfg.kind!r} "
        "(supported: openai, anthropic, claude_oauth, ollama)"
    )


# --------------------------------------------------------------------------
# OpenAI
# --------------------------------------------------------------------------


class OpenAIProvider(LlmProvider):
    def __init__(self, cfg: LlmConfig):
        from openai import AsyncOpenAI

        api_key_env = cfg.api_key_env or "OPENAI_API_KEY"
        api_key = os.environ.get(api_key_env)
        if not api_key:
            raise RuntimeError(
                f"OpenAIProvider needs {api_key_env} in the environment"
            )
        self.client = AsyncOpenAI(api_key=api_key, base_url=cfg.base_url)
        self.cfg = cfg

    async def complete(self, system: str, user: str) -> str:
        resp = await self.client.chat.completions.create(
            model=self.cfg.model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=self.cfg.temperature,
            max_tokens=self.cfg.max_tokens,
            timeout=self.cfg.timeout_s,
        )
        return (resp.choices[0].message.content or "").strip()


# --------------------------------------------------------------------------
# Anthropic
# --------------------------------------------------------------------------


class AnthropicProvider(LlmProvider):
    def __init__(self, cfg: LlmConfig):
        from anthropic import AsyncAnthropic

        api_key_env = cfg.api_key_env or "ANTHROPIC_API_KEY"
        api_key = os.environ.get(api_key_env)
        if not api_key:
            raise RuntimeError(
                f"AnthropicProvider needs {api_key_env} in the environment"
            )
        self.client = AsyncAnthropic(api_key=api_key, base_url=cfg.base_url)
        self.cfg = cfg

    async def complete(self, system: str, user: str) -> str:
        resp = await self.client.messages.create(
            model=self.cfg.model,
            system=system,
            messages=[{"role": "user", "content": user}],
            temperature=self.cfg.temperature,
            max_tokens=self.cfg.max_tokens,
            timeout=self.cfg.timeout_s,
        )
        for block in resp.content:
            if getattr(block, "type", None) == "text":
                return (block.text or "").strip()
        return ""


# --------------------------------------------------------------------------
# Claude Code OAuth (subprocess)
# --------------------------------------------------------------------------


class ClaudeOAuthProvider(LlmProvider):
    """Drives the `claude` CLI as a subprocess — uses the user's Claude
    Pro / Max subscription via OAuth, no API charges. Best for small
    smoke runs (rate limits will bite on full LoCoMo).

    Setup once:
        npm install -g @anthropic-ai/claude-code
        claude login        # interactive OAuth flow

    The model field is informational here — the CLI uses whatever model
    the subscription routes to by default (Sonnet/Opus).
    """

    def __init__(self, cfg: LlmConfig):
        self.cfg = cfg

    async def complete(self, system: str, user: str) -> str:
        prompt = f"{system}\n\n---\n\n{user}"
        proc = await asyncio.create_subprocess_exec(
            "claude",
            "-p",
            prompt,
            "--output-format",
            "json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.cfg.timeout_s
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(
                f"`claude` CLI timed out after {self.cfg.timeout_s}s"
            ) from None
        if proc.returncode != 0:
            raise RuntimeError(
                f"`claude` CLI failed (exit {proc.returncode}): "
                f"{stderr.decode(errors='replace')[:500]}"
            )
        return _extract_claude_text(stdout)


def _extract_claude_text(stdout: bytes) -> str:
    raw = stdout.decode(errors="replace").strip()
    if not raw:
        return ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return raw
    if isinstance(data, dict):
        for key in ("result", "text", "answer", "content"):
            v = data.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        msgs = data.get("messages")
        if isinstance(msgs, list):
            return _last_assistant_text(msgs)
    if isinstance(data, list):
        return _last_assistant_text(data)
    return raw


def _last_assistant_text(msgs: list) -> str:
    for m in reversed(msgs):
        if not isinstance(m, dict):
            continue
        if m.get("role") != "assistant":
            continue
        content = m.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    text = c.get("text")
                    if isinstance(text, str):
                        return text.strip()
    return ""


# --------------------------------------------------------------------------
# Ollama (local, free)
# --------------------------------------------------------------------------


class OllamaProvider(LlmProvider):
    def __init__(self, cfg: LlmConfig):
        self.cfg = cfg
        self.base_url = (cfg.base_url or "http://127.0.0.1:11434").rstrip("/")

    async def complete(self, system: str, user: str) -> str:
        import urllib.request

        body = json.dumps(
            {
                "model": self.cfg.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "stream": False,
                "options": {
                    "temperature": self.cfg.temperature,
                    "num_predict": self.cfg.max_tokens,
                },
            }
        ).encode("utf-8")

        loop = asyncio.get_running_loop()

        def _post() -> dict:
            req = urllib.request.Request(
                f"{self.base_url}/api/chat",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.cfg.timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8"))

        data = await loop.run_in_executor(None, _post)
        return ((data.get("message") or {}).get("content") or "").strip()
