"""
Subgroup UI metrics: model picks field + label from the teacher's question.

Not a catalog of "cases" — only validates that `field` exists on precomputed group rows.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

import anthropic

_log = logging.getLogger("edvise.subgroup_metrics")
_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

# Every *_pct on group rows from _subgroup_indicator_breakdown (infrastructure boundary).
ALLOWED_GROUP_PCT_FIELDS: frozenset[str] = frozenset({
    "cohort_pct",
    "chronic_absent_pct",
    "suspended_pct",
    "two_or_more_pct",
    "flagged_pct",
    "all_three_pct",
})

# Semantic glossary for the model — not an enum of allowed questions.
FIELD_GLOSSARY: dict[str, str] = {
    "cohort_pct": "Share of the group failing at least one course (course / academic failure).",
    "chronic_absent_pct": "Share chronically absent (missing at least the chronic absence threshold, e.g. 10%+ days).",
    "suspended_pct": "Share with at least one suspension.",
    "two_or_more_pct": "Share with 2+ risk flags (any two of chronic absence, suspension, course failure).",
    "flagged_pct": "Share with any one or more of the three risk flags.",
    "all_three_pct": "Share with all three risk flags (chronic absence + suspension + course failure).",
}

DEFAULT_SUBGROUP_COMPARE = [
    {"field": "cohort_pct", "label": "Course failure"},
    {"field": "chronic_absent_pct", "label": "Chronic absence"},
]


def field_glossary_for_prompt() -> str:
    return "\n".join(f"  - {field}: {desc}" for field, desc in FIELD_GLOSSARY.items())


def _normalize_field(raw: Any) -> Optional[str]:
    field = str(raw or "").strip()
    if field in ALLOWED_GROUP_PCT_FIELDS:
        return field
    return None


def sanitize_subgroup_compare(raw: Any) -> Optional[list[dict]]:
    """
    Accept model output: [{ "field": "chronic_absent_pct", "label": "...", "description": "..."? }, ...]
    Labels come from the model in the teacher's wording — we only validate field names.
    """
    if not isinstance(raw, list):
        return None
    out: list[dict] = []
    for item in raw[:3]:
        if not isinstance(item, dict):
            continue
        field = _normalize_field(item.get("field"))
        if not field:
            continue
        label = str(item.get("label") or "").strip()[:100]
        if not label:
            label = FIELD_GLOSSARY.get(field, field).split(".")[0][:80]
        desc = str(item.get("description") or "").strip()[:200]
        entry: dict = {"field": field, "label": label}
        if desc:
            entry["description"] = desc
        out.append(entry)
    return out or None


def default_subgroup_compare() -> list[dict]:
    return [dict(m) for m in DEFAULT_SUBGROUP_COMPARE]


def _parse_json_array(text: str) -> Optional[list]:
    text = (text or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else None
    except json.JSONDecodeError:
        start, end = text.find("["), text.rfind("]")
        if start >= 0 and end > start:
            try:
                data = json.loads(text[start : end + 1])
                return data if isinstance(data, list) else None
            except json.JSONDecodeError:
                return None
    return None


def infer_subgroup_compare_from_question(message: str) -> Optional[list[dict]]:
    """
    When the intent classifier omits subgroup_compare, infer field + label from the question.
    Still grounded in ALLOWED_GROUP_PCT_FIELDS — cannot invent new metrics.
    """
    msg = (message or "").strip()
    if not msg:
        return None
    prompt = (
        f'Teacher question: "{msg}"\n\n'
        "They will see a subgroup breakdown card (% of each demographic group).\n"
        "Choose 1–2 rates that best answer their question — any phrasing is allowed.\n\n"
        "Available data fields (use ONLY these exact field names):\n"
        f"{field_glossary_for_prompt()}\n\n"
        "Return ONLY a JSON array (1–2 objects), e.g.:\n"
        '[{"field":"cohort_pct","label":"Course failure","description":"optional short threshold note"},'
        ' {"field":"chronic_absent_pct","label":"Chronic absence"}]\n\n'
        "Rules:\n"
        "- label: short phrase in the teacher's language (not the field name).\n"
        "- Pick fields by meaning, not keywords.\n"
        "- Do not add fields outside the list above.\n"
    )
    try:
        resp = _client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        text_out = ""
        for block in resp.content or []:
            if getattr(block, "type", None) == "text":
                text_out += block.text
        parsed = _parse_json_array(text_out)
        return sanitize_subgroup_compare(parsed)
    except Exception as e:
        _log.warning("infer_subgroup_compare_from_question failed: %s", e)
        return None


def enrich_subgroup_analysis_outputs(message: str, outputs: list) -> list:
    """Fill subgroup_compare from the question when the classifier did not."""
    if not outputs:
        return outputs
    enriched = []
    for step in outputs:
        if not isinstance(step, dict) or step.get("type") != "analysis":
            enriched.append(step)
            continue
        at = str(step.get("analysis_type") or "")
        if not at.startswith("subgroup"):
            enriched.append(step)
            continue
        s = dict(step)
        if not s.get("subgroup_compare"):
            inferred = infer_subgroup_compare_from_question(message)
            if inferred:
                s["subgroup_compare"] = inferred
        subtitle = str(s.get("compare_subtitle") or "").strip()
        if not subtitle and s.get("subgroup_compare"):
            labels = [m.get("label") for m in s["subgroup_compare"] if m.get("label")]
            if labels:
                s["compare_subtitle"] = "Rates within each group · " + " vs ".join(labels)
        enriched.append(s)
    return enriched
