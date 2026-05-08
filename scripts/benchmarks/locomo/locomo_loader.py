"""Load LoCoMo conversations + questions.

LoCoMo (Long Conversation Memory) is the standard benchmark for AI memory
layers. Paper: "Evaluating Very Long-Term Conversational Memory of LLM
Agents" (Snap Research, 2024). Dataset:
https://huggingface.co/datasets/snap-research/locomo

This loader is tolerant to two on-disk shapes:

  A) The HuggingFace shape, where each conversation has a `conversation`
     dict with keys `session_1`, `session_2`, ..., plus
     `session_N_date_time` siblings.

  B) A flat shape produced by some pre-processing scripts, where each
     conversation has a `sessions` list of {messages|turns} blocks.

In both shapes each turn must expose `speaker` and `text`, and each Q&A
must expose `question` and `answer`. Anything else (category/evidence
spans/etc.) is preserved verbatim.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass
class Turn:
    speaker: str
    text: str
    timestamp: str | None = None


@dataclass
class Question:
    question: str
    answer: str
    category: str | None = None
    evidence: list[str] = field(default_factory=list)


@dataclass
class Conversation:
    conv_id: str
    turns: list[Turn]
    questions: list[Question]


def load_locomo(path: str) -> list[Conversation]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "data" in raw:
        raw = raw["data"]
    if not isinstance(raw, list):
        raise ValueError(
            f"expected a list of conversations at top level, got {type(raw).__name__}"
        )

    out: list[Conversation] = []
    for i, item in enumerate(raw):
        conv_id = str(
            item.get("sample_id")
            or item.get("conv_id")
            or item.get("id")
            or f"conv_{i:03d}"
        )
        turns = list(_iter_turns(item))
        questions = list(_iter_questions(item))
        if not turns and not questions:
            continue
        out.append(Conversation(conv_id=conv_id, turns=turns, questions=questions))
    return out


def _iter_turns(item: dict[str, Any]) -> Iterable[Turn]:
    # Shape A — HuggingFace `conversation` dict with session_N keys.
    conv = item.get("conversation")
    if isinstance(conv, dict):
        session_keys = sorted(
            (k for k in conv.keys() if k.startswith("session_") and not k.endswith("_date_time")),
            key=_session_index,
        )
        for k in session_keys:
            ts = conv.get(f"{k}_date_time")
            msgs = conv.get(k)
            if not isinstance(msgs, list):
                continue
            for m in msgs:
                t = _turn_from_message(m, ts)
                if t is not None:
                    yield t
        return

    # Shape B — flat `sessions` list.
    sessions = item.get("sessions") or item.get("dialog") or []
    if isinstance(sessions, dict):
        sessions = list(sessions.values())
    for sess in sessions:
        if isinstance(sess, list):
            msgs, ts = sess, None
        elif isinstance(sess, dict):
            msgs = sess.get("messages") or sess.get("turns") or sess.get("dialog") or []
            ts = sess.get("date") or sess.get("timestamp")
        else:
            continue
        if not isinstance(msgs, list):
            continue
        for m in msgs:
            t = _turn_from_message(m, ts)
            if t is not None:
                yield t


def _turn_from_message(m: Any, ts: str | None) -> Turn | None:
    if not isinstance(m, dict):
        return None
    speaker = str(m.get("speaker") or m.get("role") or m.get("from") or "user")
    text = str(m.get("text") or m.get("content") or m.get("utterance") or "").strip()
    if not text:
        return None
    return Turn(speaker=speaker, text=text, timestamp=ts)


def _iter_questions(item: dict[str, Any]) -> Iterable[Question]:
    qas = item.get("qa") or item.get("questions") or []
    if not isinstance(qas, list):
        return
    for q in qas:
        if not isinstance(q, dict):
            continue
        question = str(q.get("question") or q.get("q") or "").strip()
        answer = q.get("answer")
        if answer is None:
            answer = q.get("a")
        if answer is None:
            continue
        if isinstance(answer, list):
            answer = " | ".join(str(a) for a in answer)
        answer = str(answer).strip()
        if not question or not answer:
            continue
        category = q.get("category") or q.get("type") or q.get("difficulty")
        evidence = q.get("evidence") or []
        if not isinstance(evidence, list):
            evidence = [str(evidence)]
        yield Question(
            question=question,
            answer=answer,
            category=str(category) if category is not None else None,
            evidence=[str(e) for e in evidence],
        )


def _session_index(key: str) -> int:
    parts = key.split("_")
    if len(parts) >= 2 and parts[1].isdigit():
        return int(parts[1])
    return 0
