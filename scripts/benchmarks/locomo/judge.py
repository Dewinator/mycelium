"""Scoring helpers for LoCoMo: F1, exact match, and LLM-as-judge.

The headline metric in the LoCoMo paper (and in Mem0 / Zep follow-ups)
is LLM-as-judge accuracy. F1 and EM are kept as cheap sanity baselines
that don't burn judge tokens.
"""
from __future__ import annotations

import json
import re
import string
from collections import Counter

from llm_provider import LlmProvider


def _normalize(s: str) -> str:
    s = s.lower()
    s = "".join(c for c in s if c not in string.punctuation)
    s = re.sub(r"\s+", " ", s).strip()
    for art in ("a ", "an ", "the "):
        if s.startswith(art):
            s = s[len(art) :]
    return s


def f1_score(pred: str, gold: str) -> float:
    pred_tokens = _normalize(pred).split()
    gold_tokens = _normalize(gold).split()
    if not pred_tokens or not gold_tokens:
        return float(pred_tokens == gold_tokens)
    common = Counter(pred_tokens) & Counter(gold_tokens)
    n = sum(common.values())
    if n == 0:
        return 0.0
    p = n / len(pred_tokens)
    r = n / len(gold_tokens)
    return 2 * p * r / (p + r)


def exact_match(pred: str, gold: str) -> float:
    return float(_normalize(pred) == _normalize(gold))


JUDGE_SYSTEM = (
    "You are an exam grader. Decide whether the candidate answer is "
    "semantically equivalent to the reference answer for the given "
    "question. Style and phrasing don't matter — only factual content. "
    "Return JSON only, no prose."
)

JUDGE_USER_TEMPLATE = """Question:
{question}

Reference answer:
{gold}

Candidate answer:
{pred}

Return strict JSON: {{"correct": 0 or 1, "reason": "<one short sentence>"}}.
A candidate counts as correct only when it conveys the same factual content
as the reference. Refusals or "I don't know" are incorrect unless the
reference itself is "I don't know"."""


async def llm_judge(
    judge: LlmProvider,
    question: str,
    pred: str,
    gold: str,
) -> tuple[int, str]:
    user = JUDGE_USER_TEMPLATE.format(question=question, gold=gold, pred=pred)
    raw = (await judge.complete(JUDGE_SYSTEM, user)).strip()

    data = _parse_json_loose(raw)
    if data is None:
        return 0, f"unparseable judge response: {raw[:160]}"

    correct = int(bool(data.get("correct", 0)))
    reason = str(data.get("reason", ""))[:240]
    return correct, reason


def _parse_json_loose(raw: str) -> dict | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    # Strip code fences.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1))
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            pass
    # Last resort: any {...} blob.
    blob = re.search(r"\{.*\}", raw, re.DOTALL)
    if not blob:
        return None
    try:
        parsed = json.loads(blob.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None
