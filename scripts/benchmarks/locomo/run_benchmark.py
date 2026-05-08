#!/usr/bin/env python3
"""LoCoMo benchmark runner for Mycelium.

Pipeline per conversation:

  1. Spawn (or reuse) the Mycelium MCP server over stdio.
  2. Ingest every turn via `remember` or `absorb` (config-driven).
  3. For each Q&A pair: call `recall` for top-K memories, hand the
     retrieved context to the answer-LLM, capture the answer.
  4. Score the answer with F1 + exact-match + LLM-as-judge.
  5. Write a JSON + Markdown report to the output directory.

Important caveat: Mycelium's `recall` does not isolate by `source`. If
you ingest multiple LoCoMo conversations into the same Mycelium DB,
memories from conversation A can surface when answering questions
about conversation B. For clean per-conversation numbers, run with
--reset-db (drops Mycelium's `memories` table between conversations)
or run one conversation per fresh DB.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Make sibling modules importable when run as `python run_benchmark.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import yaml  # noqa: E402
from tqdm import tqdm  # noqa: E402

from llm_provider import LlmConfig, LlmProvider, make_provider  # noqa: E402
from locomo_loader import Conversation, Question, load_locomo  # noqa: E402
from mycelium_client import MyceliumClient  # noqa: E402
from judge import exact_match, f1_score, llm_judge  # noqa: E402


ANSWER_SYSTEM = (
    "You are answering questions about a long-running conversation between "
    "two people. Use ONLY the retrieved memories below as evidence. If they "
    "don't contain the answer, reply with exactly 'I don't know'. Keep "
    "answers short — one sentence or less, no explanation."
)

ANSWER_USER_TEMPLATE = """Retrieved memories:
{context}

Question: {question}

Answer:"""


# --------------------------------------------------------------------------
# Main pipeline
# --------------------------------------------------------------------------


async def run(
    cfg_path: str,
    out_dir: str | None,
    limit_conv: int | None,
    limit_q: int | None,
    reset_db: bool,
) -> None:
    cfg = yaml.safe_load(Path(cfg_path).read_text(encoding="utf-8"))

    dataset_path = cfg["dataset"]["path"]
    max_conv = limit_conv if limit_conv is not None else cfg["dataset"].get("max_conversations")
    max_q = limit_q if limit_q is not None else cfg["dataset"].get("max_questions_per_conversation")

    answer_cfg = LlmConfig(**cfg["answer_provider"])
    judge_cfg = LlmConfig(**cfg["judge_provider"])
    answer_llm = make_provider(answer_cfg)
    judge_llm = make_provider(judge_cfg)

    output_dir = Path(out_dir or cfg.get("output", {}).get("dir", "./results"))
    output_dir.mkdir(parents=True, exist_ok=True)
    run_id = time.strftime("%Y%m%d-%H%M%S", time.gmtime())

    print(f"Loading dataset: {dataset_path}", file=sys.stderr)
    conversations = load_locomo(dataset_path)
    if max_conv:
        conversations = conversations[:max_conv]
    print(
        f"  {len(conversations)} conversations, "
        f"{sum(len(c.questions) for c in conversations)} questions total",
        file=sys.stderr,
    )

    mc = cfg["mycelium"]
    env = {**os.environ, **(mc.get("env") or {})}
    ingest_tool = mc.get("ingest_tool", "remember")
    if ingest_tool not in {"remember", "absorb"}:
        raise ValueError(f"mycelium.ingest_tool must be 'remember' or 'absorb', got {ingest_tool!r}")

    retrieval = cfg.get("retrieval", {}) or {}
    top_k = int(retrieval.get("top_k", 10))
    vector_weight = float(retrieval.get("vector_weight", 0.6))
    spread = bool(retrieval.get("spread", False))
    ignore_affect = bool(retrieval.get("ignore_affect", True))
    with_experiences = bool(retrieval.get("with_experiences", False))

    per_conv_results: list[dict] = []

    async with MyceliumClient.connect(mc["command"], mc.get("args", []), env=env) as mycelium:
        for conv in tqdm(conversations, desc="conversations", file=sys.stderr):
            if reset_db:
                _reset_mycelium_db(env)

            await ingest_conversation(mycelium, conv, ingest_tool=ingest_tool)
            scored = await score_conversation(
                mycelium,
                conv,
                answer_llm,
                judge_llm,
                top_k=top_k,
                vector_weight=vector_weight,
                spread=spread,
                ignore_affect=ignore_affect,
                with_experiences=with_experiences,
                max_q=max_q,
            )
            per_conv_results.append(scored)

    summary = aggregate(summary_meta(run_id, dataset_path, answer_cfg, judge_cfg, retrieval), per_conv_results)

    json_path = output_dir / f"{run_id}.json"
    md_path = output_dir / f"{run_id}.md"
    json_path.write_text(json.dumps({"summary": summary, "conversations": per_conv_results}, indent=2))
    md_path.write_text(render_markdown(summary))

    print(
        f"\nResults written to:\n  {json_path}\n  {md_path}\n"
        f"  F1={summary['metrics']['f1']:.3f}  "
        f"EM={summary['metrics']['exact_match']:.3f}  "
        f"Judge={summary['metrics']['llm_judge']:.3f}  "
        f"(n={summary['n_questions']})",
        file=sys.stderr,
    )


# --------------------------------------------------------------------------
# Per-conversation steps
# --------------------------------------------------------------------------


async def ingest_conversation(
    mycelium: MyceliumClient,
    conv: Conversation,
    *,
    ingest_tool: str,
) -> None:
    source_tag = f"locomo:{conv.conv_id}"
    for turn in conv.turns:
        text = f"{turn.speaker}: {turn.text}".strip()
        if turn.timestamp:
            text = f"[{turn.timestamp}] {text}"
        if ingest_tool == "absorb":
            await mycelium.absorb(text=text, context=source_tag)
        else:
            await mycelium.remember(content=text, category="general", source=source_tag)


async def score_conversation(
    mycelium: MyceliumClient,
    conv: Conversation,
    answer_llm: LlmProvider,
    judge_llm: LlmProvider,
    *,
    top_k: int,
    vector_weight: float,
    spread: bool,
    ignore_affect: bool,
    with_experiences: bool,
    max_q: int | None,
) -> dict:
    questions = conv.questions[:max_q] if max_q else conv.questions
    out_questions: list[dict] = []

    for q in tqdm(questions, desc=f"  {conv.conv_id}", leave=False, file=sys.stderr):
        try:
            context = await mycelium.recall(
                query=q.question,
                limit=top_k,
                vector_weight=vector_weight,
                spread=spread,
                ignore_affect=ignore_affect,
                with_experiences=with_experiences,
            )
        except Exception as e:
            context = f"[recall error: {e}]"

        try:
            pred = await answer_llm.complete(
                ANSWER_SYSTEM,
                ANSWER_USER_TEMPLATE.format(context=context, question=q.question),
            )
        except Exception as e:
            pred = f"[answerer error: {e}]"
        pred = pred.strip()

        f1 = f1_score(pred, q.answer)
        em = exact_match(pred, q.answer)

        try:
            judge_correct, judge_reason = await llm_judge(
                judge_llm, q.question, pred, q.answer
            )
        except Exception as e:
            judge_correct, judge_reason = 0, f"[judge error: {e}]"

        out_questions.append(
            {
                "question": q.question,
                "category": q.category,
                "gold": q.answer,
                "pred": pred,
                "f1": f1,
                "exact_match": em,
                "judge_correct": judge_correct,
                "judge_reason": judge_reason,
            }
        )

    return {"conv_id": conv.conv_id, "n_turns": len(conv.turns), "questions": out_questions}


# --------------------------------------------------------------------------
# Aggregation + reporting
# --------------------------------------------------------------------------


def summary_meta(
    run_id: str,
    dataset_path: str,
    answer_cfg: LlmConfig,
    judge_cfg: LlmConfig,
    retrieval: dict,
) -> dict:
    return {
        "run_id": run_id,
        "dataset": dataset_path,
        "answer_provider": {"kind": answer_cfg.kind, "model": answer_cfg.model},
        "judge_provider": {"kind": judge_cfg.kind, "model": judge_cfg.model},
        "retrieval": retrieval,
    }


def aggregate(meta: dict, per_conv: list[dict]) -> dict:
    flat = [q for c in per_conv for q in c["questions"]]
    n = len(flat)
    avg = lambda key: (sum(q[key] for q in flat) / n) if n else 0.0  # noqa: E731

    by_cat: dict[str, list[dict]] = {}
    for q in flat:
        by_cat.setdefault(q.get("category") or "uncategorized", []).append(q)

    return {
        **meta,
        "n_conversations": len(per_conv),
        "n_questions": n,
        "metrics": {
            "f1": avg("f1"),
            "exact_match": avg("exact_match"),
            "llm_judge": avg("judge_correct"),
        },
        "by_category": {
            cat: {
                "n": len(items),
                "f1": sum(q["f1"] for q in items) / len(items),
                "exact_match": sum(q["exact_match"] for q in items) / len(items),
                "llm_judge": sum(q["judge_correct"] for q in items) / len(items),
            }
            for cat, items in sorted(by_cat.items())
        },
    }


def render_markdown(summary: dict) -> str:
    lines: list[str] = []
    lines.append(f"# LoCoMo benchmark — {summary['run_id']}")
    lines.append("")
    lines.append(f"- Dataset: `{summary['dataset']}`")
    lines.append(
        f"- Conversations: {summary['n_conversations']}, "
        f"Questions: {summary['n_questions']}"
    )
    lines.append(
        f"- Answerer: `{summary['answer_provider']['kind']}/"
        f"{summary['answer_provider']['model']}`"
    )
    lines.append(
        f"- Judge: `{summary['judge_provider']['kind']}/"
        f"{summary['judge_provider']['model']}`"
    )
    r = summary.get("retrieval", {})
    lines.append(
        f"- Retrieval: top_k={r.get('top_k', '?')}, "
        f"vector_weight={r.get('vector_weight', '?')}, "
        f"spread={r.get('spread', False)}"
    )
    lines.append("")
    lines.append("## Headline")
    lines.append("")
    m = summary["metrics"]
    lines.append("| metric | score |")
    lines.append("|---|---:|")
    lines.append(f"| LLM-judge accuracy | {m['llm_judge']:.3f} |")
    lines.append(f"| F1                 | {m['f1']:.3f} |")
    lines.append(f"| Exact match        | {m['exact_match']:.3f} |")
    lines.append("")
    lines.append("## Per category")
    lines.append("")
    lines.append("| category | n | judge | F1 | EM |")
    lines.append("|---|---:|---:|---:|---:|")
    for cat, vals in summary["by_category"].items():
        lines.append(
            f"| {cat} | {vals['n']} | "
            f"{vals['llm_judge']:.3f} | {vals['f1']:.3f} | "
            f"{vals['exact_match']:.3f} |"
        )
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Optional: wipe Mycelium's memories table between conversations
# --------------------------------------------------------------------------


def _reset_mycelium_db(env: dict[str, str]) -> None:
    """Truncate `memories` so per-conversation numbers don't bleed.

    Uses psql via the SUPABASE database URL if set, otherwise tries the
    standard local Docker default. Safe no-op if neither is available —
    the caller will simply get cross-conversation contamination, which
    the report should disclose.
    """
    import shutil
    import subprocess

    if not shutil.which("psql"):
        print("  [reset-db] psql not found, skipping reset", file=sys.stderr)
        return

    db_url = (
        env.get("SUPABASE_DB_URL")
        or env.get("DATABASE_URL")
        or "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    )
    cmd = [
        "psql",
        db_url,
        "-c",
        "TRUNCATE memories, memory_events, experiences CASCADE;",
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=30)
    except Exception as e:
        print(f"  [reset-db] failed: {e}", file=sys.stderr)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main() -> None:
    p = argparse.ArgumentParser(description="LoCoMo benchmark runner for Mycelium")
    p.add_argument("--config", default="config.yaml", help="path to config.yaml")
    p.add_argument("--out-dir", default=None, help="override output.dir")
    p.add_argument("--limit-conversations", type=int, default=None)
    p.add_argument("--limit-questions", type=int, default=None)
    p.add_argument(
        "--reset-db",
        action="store_true",
        help="TRUNCATE memories between conversations (needs psql + SUPABASE_DB_URL)",
    )
    args = p.parse_args()
    asyncio.run(
        run(
            args.config,
            args.out_dir,
            args.limit_conversations,
            args.limit_questions,
            args.reset_db,
        )
    )


if __name__ == "__main__":
    main()
