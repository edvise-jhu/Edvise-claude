"""Gather KB / web sources for chat and artifact generation from enabled scope tokens."""

from __future__ import annotations

import logging
from typing import Any, Optional

from services.claude_service import prefetch_web_sources
from services.vector_service import search_knowledge_base

logger = logging.getLogger("edvise.sources")

# Keywords that trigger KB search (student_success / global corpus)
KB_KEYWORDS = [
    "intervention",
    "interventions",
    "strategy",
    "strategies",
    "research",
    "evidence",
    "support",
    "brainstorm",
    "idea",
    "approach",
    "what works",
    "how to help",
    "reduce",
    "improve",
    "program",
    "practice",
    "connectedness",
    "caring",
    "wellbeing",
    "well-being",
    "sel",
    "action plan",
    "address",
]

# Always search school KB when school scope is on (teachers refer to local doc names).
# Always search global KB for explicit intervention / plan phrasing.
INTERVENTION_PHRASES = (
    "intervention",
    "action plan",
    "what works",
    "best address",
    "how to support",
    "connectedness",
    "caring score",
    "well-being",
    "wellbeing",
)


def selected_sources(kb_scope: Optional[str]) -> set[str]:
    """
    Parse source tokens from frontend.
    Supports CSV (e.g. "student_success,school,web") and legacy single values.
    """
    raw = (kb_scope or "").strip().lower()
    if not raw:
        return {"general"}
    if raw == "both":
        return {"student_success", "web"}
    parts = {p.strip() for p in raw.split(",") if p.strip()}
    out: set[str] = set()
    for p in parts:
        if p in {"student_success", "global"}:
            out.add("student_success")
        elif p in {"school", "general", "web"}:
            out.add(p)
    return out or {"general"}


def _message_wants_intervention_research(lower: str) -> bool:
    return any(p in lower for p in INTERVENTION_PHRASES)


def should_search_kb(message: str, kb_scopes: list[str]) -> bool:
    if not kb_scopes:
        return False
    if "school" in kb_scopes:
        return True
    lower = (message or "").lower()
    if _message_wants_intervention_research(lower):
        return True
    return any(kw in lower for kw in KB_KEYWORDS)


def build_source_index(kb_docs: list, prefetched_web: list) -> list[dict]:
    """Pills / citation numbering: KB [1..k], then web [k+1..]."""
    index: list[dict] = []
    for i, doc in enumerate(kb_docs or [], 1):
        label = (
            (doc.get("filename") or "Document")
            .replace("Change_Idea__", "")
            .replace("_", " ")
            .replace(".pdf", "")
            .strip()
        )
        index.append({"num": i, "type": "kb", "label": label, "doc": doc})
    offset = len(kb_docs or [])
    for j, src in enumerate((prefetched_web or [])[:3], 1):
        index.append({
            "num": offset + j,
            "type": "web",
            "label": ((src.get("title") or src.get("url") or "Web source"))[:80],
            "url": src.get("url"),
        })
    return index


def sources_for_frontend(source_index: list[dict]) -> list[dict]:
    """Shape expected by MessageList source pills."""
    out: list[dict] = []
    for src in source_index:
        if src.get("type") == "kb":
            doc = src.get("doc") or {}
            out.append({
                "type": "kb",
                "label": src.get("label"),
                "filename": doc.get("filename"),
                "url": doc.get("url"),
            })
        elif src.get("type") == "web":
            out.append({
                "type": "web",
                "label": src.get("label"),
                "url": src.get("url"),
            })
    return out


async def gather_sources(
    message: str,
    kb_scope: Optional[str] = None,
    *,
    internal: bool = False,
    top_k: int = 3,
) -> dict[str, Any]:
    """
    Load KB documents and optional prefetched web URLs according to enabled scopes.
    Returns kb_docs, prefetched_web, source_index, use_web_search, selected.
    """
    selected = selected_sources(kb_scope)
    use_web_search = "web" in selected

    kb_docs: list = []
    kb_scopes: list[str] = []
    if internal:
        kb_scopes = []
    elif "student_success" in selected:
        kb_scopes.append("global")
    if "school" in selected:
        kb_scopes.append("school")

    if kb_scopes and should_search_kb(message, kb_scopes):
        try:
            kb_docs = await search_knowledge_base(
                message,
                scope=",".join(kb_scopes),
                top_k=top_k,
                include_pending_school=("school" in kb_scopes),
            )
        except Exception as e:
            logger.warning("gather_sources: KB search failed: %s", e)
            kb_docs = []

    prefetched_web: list = []
    if use_web_search and (kb_docs or _message_wants_intervention_research((message or "").lower())):
        try:
            prefetched_web = prefetch_web_sources(message)[:3]
        except Exception as e:
            logger.warning("gather_sources: web prefetch failed: %s", e)
            prefetched_web = []

    source_index = build_source_index(kb_docs, prefetched_web)
    return {
        "selected": selected,
        "kb_docs": kb_docs,
        "prefetched_web": prefetched_web,
        "source_index": source_index,
        "use_web_search": use_web_search,
        "sources_ui": sources_for_frontend(source_index),
    }
