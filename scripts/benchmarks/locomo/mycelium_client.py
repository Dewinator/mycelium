"""Thin async wrapper around the Mycelium MCP server (stdio).

The benchmark spawns `node mcp-server/dist/index.js` as a subprocess and
talks to it via the standard Model Context Protocol (JSON-RPC over stdio)
— exactly like Claude Code, Cursor, Cline, or any other MCP client. The
upside is that the benchmark exercises the same code path real users hit.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Optional

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class MyceliumClient:
    """Minimal MCP client wrapper exposing the tools we need."""

    def __init__(self, session: ClientSession):
        self.session = session

    @classmethod
    @asynccontextmanager
    async def connect(
        cls,
        command: str,
        args: list[str],
        env: Optional[dict[str, str]] = None,
    ):
        params = StdioServerParameters(command=command, args=args, env=env)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield cls(session)

    # ---- Ingestion -------------------------------------------------------

    async def remember(
        self,
        content: str,
        *,
        category: str = "general",
        tags: Optional[list[str]] = None,
        source: Optional[str] = None,
        importance: Optional[float] = None,
    ) -> str:
        args: dict[str, Any] = {"content": content, "category": category}
        if tags:
            args["tags"] = tags
        if source:
            args["source"] = source
        if importance is not None:
            args["importance"] = importance
        return await self._call_text("remember", args)

    async def absorb(
        self,
        text: str,
        *,
        context: Optional[str] = None,
    ) -> str:
        args: dict[str, Any] = {"text": text}
        if context:
            args["context"] = context
        return await self._call_text("absorb", args)

    # ---- Retrieval -------------------------------------------------------

    async def recall(
        self,
        query: str,
        *,
        limit: int = 10,
        vector_weight: float = 0.6,
        spread: bool = False,
        ignore_affect: bool = True,
        with_experiences: bool = False,
    ) -> str:
        """Return the formatted recall text — the same string an LLM agent
        would see in its tool result. The answerer gets this verbatim, so
        we measure the actual retrieval quality Mycelium delivers, not a
        re-massaged version.
        """
        return await self._call_text(
            "recall",
            {
                "query": query,
                "limit": limit,
                "vector_weight": vector_weight,
                "spread": spread,
                "ignore_affect": ignore_affect,
                "with_experiences": with_experiences,
            },
        )

    # ---- Plumbing --------------------------------------------------------

    async def _call_text(self, tool: str, args: dict[str, Any]) -> str:
        result = await self.session.call_tool(tool, args)
        chunks: list[str] = []
        for block in getattr(result, "content", []) or []:
            text = getattr(block, "text", None)
            if text:
                chunks.append(text)
        return "\n".join(chunks)
