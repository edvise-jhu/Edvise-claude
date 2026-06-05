from fastapi import APIRouter, HTTPException, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
import json
import logging
import re
import os

import anthropic

from services.claude_service import stream_response, enforce_inline_citations_once
from services.source_retrieval import gather_sources, KB_KEYWORDS
from services.subgroup_metrics import (
    enrich_subgroup_analysis_outputs,
    field_glossary_for_prompt,
    sanitize_subgroup_compare,
)

router = APIRouter()
logger = logging.getLogger("edvise.chat")


async def _get_user_optional(authorization: Optional[str]) -> Optional[dict]:
    """Return JWT user dict or None if missing/invalid (chat still streams)."""
    if not authorization or not authorization.startswith("Bearer "):
        logger.info("chat persistence: no Authorization bearer token — skipping Supabase save")
        return None
    try:
        from services.supabase_service import get_current_user
        user = await get_current_user(authorization)
        logger.info("chat persistence: resolved user_id=%s from JWT", user.get("id"))
        return user
    except HTTPException as e:
        logger.warning("chat persistence: JWT invalid or expired: %s", e.detail)
        return None


class ChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str


class ChatRequest(BaseModel):
    conversation_id: Optional[str] = None
    message: str
    history: Optional[list[ChatMessage]] = []   # full conversation history
    data_context: Optional[dict] = None          # analysis results
    kb_scope: Optional[str] = "global"           # "global" | "school" | "general"
    internal: Optional[bool] = False              # internal orchestration prompt; do not persist as user message
    document_pdf: Optional[dict] = None          # {base64, filename, mediaType}


class SuggestionsPatchBody(BaseModel):
    suggestions: list[str] = []
    message_content: Optional[str] = None


class AnalysisStatePayload(BaseModel):
    """Payload for saving analysis state to conversation metadata."""
    file_id: Optional[str] = None
    mapping: Optional[dict] = None
    stage: Optional[str] = None  # 'individual' | 'intersection' | 'sel'
    risk: Optional[dict] = None
    intersection: Optional[dict] = None
    sel: Optional[dict] = None
    subgroup: Optional[dict] = None
    thresholds: Optional[dict] = None
    filename: Optional[str] = None
    rows: Optional[int] = None


class ClassifyIntentRequest(BaseModel):
    message: str
    stage: Optional[str] = None
    has_file: bool = False
    context_summary: Optional[dict] = None


class ClarifyOptionModel(BaseModel):
    id: str
    label: str


class ClarifyStepModel(BaseModel):
    id: str
    title: str
    multi: bool = False
    options: list[ClarifyOptionModel] = []


class ClarifyPayloadModel(BaseModel):
    intro: Optional[str] = None
    steps: list[ClarifyStepModel] = []


class IntentFiltersModel(BaseModel):
    min_course_failures: Optional[int] = None
    min_suspension_count: Optional[int] = None
    require_ell: Optional[bool] = None
    demographic_subset: Optional[str] = None
    demographic_sort_roles: Optional[list] = None
    sort_by: Optional[str] = None
    sel_cohort: Optional[str] = None
    sel_compare_dimension: Optional[str] = None
    sel_compare_grade: Optional[str] = None
    sel_compare_grades: Optional[list] = None
    sel_cohort_grade: Optional[str] = None
    sel_baseline: Optional[str] = None


class IntentOutputModel(BaseModel):
    type: str
    tier: Optional[str] = None
    grade: Optional[str] = None
    analysis_type: Optional[str] = None
    artifact_type: Optional[str] = None
    plan_variant: Optional[str] = None
    list_title: Optional[str] = None
    narrative_hint: Optional[str] = None
    filters: Optional[IntentFiltersModel] = None


class IntentClassifyResponse(BaseModel):
    action: str
    confidence: Optional[float] = None
    tier: Optional[str] = None
    grade: Optional[str] = None
    analysis_type: Optional[str] = None
    filters: Optional[IntentFiltersModel] = None
    outputs: Optional[list[IntentOutputModel]] = None
    clarify: Optional[ClarifyPayloadModel] = None
    answerable_from_context: Optional[bool] = None
    kb_scope: Optional[str] = None


def _suggestions_marker_match(text: str):
    return re.search(r"\*{0,2}SUGGESTIONS_JSON\*{0,2}\s*:", text, flags=re.IGNORECASE)


def _clean_before_suggestions(text: str, idx: int) -> str:
    return re.sub(r"\*+$", "", text[:idx]).strip()


def _extract_suggestions_block(text: str) -> tuple[str, Optional[list]]:
    """
    Extract SUGGESTIONS_JSON: [...] from model text (bracket-balanced; robust to long arrays).
    Returns (clean_text_without_line, list_of_strings_or_none).
    """
    if not text:
        return text, None
    m = _suggestions_marker_match(text)
    if not m:
        return text, None
    idx = m.start()
    colon_idx = text.index(":", m.start())
    rest = text[colon_idx + 1 :].strip()
    start = rest.find("[")
    if start == -1:
        return _clean_before_suggestions(text, idx), None
    depth = 0
    end = -1
    for i in range(start, len(rest)):
        ch = rest[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end == -1:
        return _clean_before_suggestions(text, idx), None
    json_str = rest[start:end]
    parsed = None
    try:
        parsed = json.loads(json_str)
    except Exception:
        try:
            import ast
            parsed = ast.literal_eval(json_str)
        except Exception:
            return _clean_before_suggestions(text, idx), None
    if not isinstance(parsed, list):
        return _clean_before_suggestions(text, idx), None
    suggestions = [str(s).strip() for s in parsed if str(s).strip()]
    if not suggestions:
        return _clean_before_suggestions(text, idx), None
    return _clean_before_suggestions(text, idx), suggestions[:4]


def _visible_stream_chunk(full_response: str, chunk: str) -> str:
    """Omit SUGGESTIONS_JSON and everything after it from streamed text deltas."""
    m = _suggestions_marker_match(full_response)
    if not m:
        return chunk
    idx = m.start()
    prev_len = len(full_response) - len(chunk)
    if idx < prev_len:
        return ""
    return chunk[: idx - prev_len]


def _extract_viz_block(text: str) -> tuple[str, Optional[dict]]:
    """
    Extract ```viz JSON block from model text.
    Returns (clean_text_without_block, viz_dict_or_none).
    """
    if not text:
        return text, None
    # Support variants like ```viz\n...\n``` and ```viz json\n...\n```
    m = re.search(r"```viz(?:\s+json)?\s*\n([\s\S]*?)\n```", text, flags=re.IGNORECASE)
    if not m:
        return text, None
    viz_raw = m.group(1).strip()
    clean = (text[:m.start()] + text[m.end():]).strip()
    try:
        parsed = json.loads(viz_raw)
        if isinstance(parsed, dict):
            return clean, parsed
    except Exception:
        pass
    return clean, None


INTENT_ACTIONS = {"clarify", "execute", "chat", "show_students", "run_sel", "run_analysis", "generate_artifact"}
INTENT_OUTPUT_TYPES = {"student_list", "sel", "analysis", "artifact", "group_comparison", "row_level"}
INTENT_ARTIFACT_TYPES = {"action_plan", "agenda", "report"}
INTENT_TIERS = {
    "critical", "high", "moderate", "on_track", "all", "triple",
    "two_or_more", "absent_academic", "academic_only",
}
INTENT_GRADES = {"6", "7", "8", "9", "10", "11", "12"}
INTENT_ANALYSIS_TYPES = {
    "unified",
    "subgroup_school_wide",
    "subgroup_triple_cohort",
    "subgroup_grade_driver",
    "subgroup_picker",
    "grade_breakdown",
}
_intent_client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


def _extract_token(authorization: Optional[str]) -> Optional[str]:
    """Extract Bearer token from Authorization header."""
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


def _extract_grade_from_text(lower: str) -> Optional[str]:
    grade_match = re.search(r"grade\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*grade", lower)
    grade = (grade_match.group(1) or grade_match.group(2)) if grade_match else None
    if grade not in INTENT_GRADES:
        return None
    return grade


def _fallback_analysis_type(lower: str, analysis_stage: Optional[str]) -> Optional[str]:
    """Regex fallback when Haiku is unavailable — mirrors frontend wants* helpers."""
    stage = (analysis_stage or "").strip().lower()
    if "grade breakdown" in lower or "view grade breakdown" in lower:
        return "grade_breakdown"

    grade = _extract_grade_from_text(lower)
    student_list = bool(
        re.search(
            r"show me the students|student list|pull a list|sortable table|which students(?!.*subgroup)",
            lower,
        )
    )
    subgroup_kw = bool(
        re.search(
            r"subgroup|subgroups|demographic|race|ethnicity|sped|ell|ses|driving|disparit|break\s*down|breakdown",
            lower,
        )
    )
    if not subgroup_kw or student_list:
        return None

    academic = bool(re.search(r"academic|failure|failing|fail", lower))
    if grade and academic:
        return "subgroup_grade_driver"

    triple = bool(
        re.search(r"all\s*3|three\s*flags|triple|all\s*three|three\s*indicators|119\s*student", lower)
        and re.search(r"flag|flags|risk|indicator", lower)
    ) or bool(re.search(r"119\s*student", lower))
    full_school = bool(
        re.search(r"4,?651|entire|whole\s*school|every\s*student|full\s*subgroup", lower)
        or re.search(r"not\s*just\s*the\s*triple|not\s*only\s*the\s*triple", lower)
    )
    if triple and not full_school:
        return "subgroup_triple_cohort"
    if full_school or re.search(r"run subgroup|subgroup analysis", lower):
        return "subgroup_school_wide"
    if stage == "unified":
        return "subgroup_picker"
    return "subgroup_school_wide"


def _fallback_intent(text: str, analysis_stage: Optional[str]) -> dict:
    """When the classifier model is unavailable, do not guess — fall back to chat."""
    grade = _extract_grade_from_text((text or "").lower())
    return {
        "action": "chat",
        "confidence": 0.0,
        "tier": None,
        "grade": grade,
        "analysis_type": None,
        "clarify": None,
    }


def _sanitize_clarify(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    intro = str(raw.get("intro") or "").strip() or None
    steps_in = raw.get("steps")
    if not isinstance(steps_in, list):
        return None
    steps = []
    for i, step in enumerate(steps_in[:4]):
        if not isinstance(step, dict):
            continue
        step_id = str(step.get("id") or f"step_{i + 1}").strip()
        title = str(step.get("title") or "").strip()
        if not title:
            continue
        multi = bool(step.get("multi"))
        opts_in = step.get("options")
        if not isinstance(opts_in, list):
            continue
        options = []
        for j, opt in enumerate(opts_in[:8]):
            if not isinstance(opt, dict):
                continue
            oid = str(opt.get("id") or f"opt_{j + 1}").strip()
            label = str(opt.get("label") or "").strip()
            if label:
                options.append({"id": oid, "label": label})
        if options:
            steps.append({"id": step_id, "title": title, "multi": multi, "options": options})
    if not steps:
        return None
    return {"intro": intro, "steps": steps}


def _sanitize_intent_filters(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    for key in ("min_course_failures", "min_suspension_count"):
        val = raw.get(key)
        if val is not None:
            try:
                out[key] = int(val)
            except (TypeError, ValueError):
                pass
    if raw.get("require_ell") is True:
        out["require_ell"] = True
    subset = raw.get("demographic_subset")
    if subset is not None:
        s = str(subset).strip().lower()
        if s in ("ell", "lep", "low_ses", "special_ed"):
            out["demographic_subset"] = "ell" if s == "lep" else s
    sort_roles = raw.get("demographic_sort_roles")
    if isinstance(sort_roles, list):
        cleaned_roles = []
        for item in sort_roles:
            r = str(item).strip().lower()
            if r == "lep":
                r = "ell"
            if r in ("ell", "low_ses", "special_ed") and r not in cleaned_roles:
                cleaned_roles.append(r)
        if cleaned_roles:
            out["demographic_sort_roles"] = cleaned_roles
    sort_by = raw.get("sort_by")
    if sort_by is not None:
        s = str(sort_by).strip().lower()
        if s in ("courses_failed", "failtot", "days_missed"):
            out["sort_by"] = "courses_failed" if s in ("courses_failed", "failtot") else s
    sel_cohort = raw.get("sel_cohort")
    if sel_cohort is not None and str(sel_cohort).strip().lower() in ("triple", "triple_flag", "all_three"):
        out["sel_cohort"] = "triple"
    cohort_grade = raw.get("sel_cohort_grade")
    if cohort_grade is not None:
        g = str(cohort_grade).strip().replace("Grade ", "")
        if g in INTENT_GRADES:
            out["sel_cohort_grade"] = g
    dim = raw.get("sel_compare_dimension")
    if dim is not None:
        d = str(dim).strip().lower()
        if d in ("low_ses", "special_ed", "ell"):
            out["sel_compare_dimension"] = d
    grade = raw.get("sel_compare_grade")
    if grade is not None:
        g = str(grade).strip().replace("Grade ", "")
        if g in INTENT_GRADES:
            out["sel_compare_grade"] = g
    grades = raw.get("sel_compare_grades")
    if isinstance(grades, list):
        cleaned = [str(g).strip().replace("Grade ", "") for g in grades if str(g).strip()]
        cleaned = [g for g in cleaned if g in INTENT_GRADES]
        if cleaned:
            out["sel_compare_grades"] = cleaned
    return out or None


def _sanitize_one_output(raw: dict, default_grade: Optional[str] = None) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    otype = str(raw.get("type") or "").strip().lower()
    if otype not in INTENT_OUTPUT_TYPES:
        return None
    # group_comparison has its own handling — pass through with metric only
    if otype == "group_comparison":
        metric = str(raw.get("metric") or "flags").strip().lower()
        if metric not in ("sel", "absence", "failure", "suspension", "flags"):
            metric = "flags"
        return {"type": "group_comparison", "metric": metric}
    if otype == "row_level":
        return {"type": "row_level"}
    tier = raw.get("tier")
    tier = str(tier).strip().lower() if tier is not None else None
    if tier not in INTENT_TIERS:
        tier = None
    grade = raw.get("grade")
    grade = str(grade).strip().replace("Grade ", "") if grade is not None else None
    if grade not in INTENT_GRADES:
        grade = default_grade
    analysis_type = raw.get("analysis_type")
    analysis_type = str(analysis_type).strip().lower() if analysis_type is not None else None
    if analysis_type not in INTENT_ANALYSIS_TYPES:
        analysis_type = None
    artifact_type = raw.get("artifact_type")
    artifact_type = str(artifact_type).strip().lower() if artifact_type is not None else None
    if artifact_type not in INTENT_ARTIFACT_TYPES:
        artifact_type = None
    plan_variant = raw.get("plan_variant")
    plan_variant = str(plan_variant).strip().lower() if plan_variant else None
    list_title = raw.get("list_title")
    list_title = str(list_title).strip()[:120] if list_title else None
    narrative_hint = raw.get("narrative_hint")
    narrative_hint = str(narrative_hint).strip()[:500] if narrative_hint else None
    filters = _sanitize_intent_filters(raw.get("filters"))
    out = {"type": otype}
    if tier:
        out["tier"] = tier
    if grade:
        out["grade"] = grade
    if analysis_type:
        out["analysis_type"] = analysis_type
    if artifact_type:
        out["artifact_type"] = artifact_type
    if plan_variant:
        out["plan_variant"] = plan_variant
    if list_title:
        out["list_title"] = list_title
    if narrative_hint:
        out["narrative_hint"] = narrative_hint
    if filters:
        out["filters"] = filters
    if otype == "analysis":
        compare = sanitize_subgroup_compare(raw.get("subgroup_compare"))
        if compare:
            out["subgroup_compare"] = compare
        subtitle = raw.get("compare_subtitle")
        if subtitle:
            out["compare_subtitle"] = str(subtitle).strip()[:300]
    if otype == "artifact" and not artifact_type:
        out["artifact_type"] = "action_plan"
    return out


def _outputs_from_legacy(
    action: str,
    tier: Optional[str],
    grade: Optional[str],
    analysis_type: Optional[str],
    filters: Optional[dict],
) -> list:
    """Map legacy single-action classifier responses to execute outputs."""
    if action == "show_students":
        return [{"type": "student_list", "tier": tier or "critical", "grade": grade, "filters": filters}]
    if action == "run_sel":
        return [{"type": "sel", "grade": grade, "filters": filters}]
    if action == "run_analysis" and analysis_type:
        return [{"type": "analysis", "analysis_type": analysis_type, "grade": grade}]
    if action == "generate_artifact":
        return [{"type": "artifact", "artifact_type": "action_plan", "filters": filters}]
    return []


def _sanitize_outputs(raw_outputs, default_grade: Optional[str] = None) -> list:
    if not isinstance(raw_outputs, list):
        return []
    out = []
    sel_step: Optional[dict] = None
    for item in raw_outputs:
        step = _sanitize_one_output(item, default_grade=default_grade) if isinstance(item, dict) else None
        if not step:
            continue
        if step.get("type") == "sel":
            if sel_step:
                merged_filters = {**(sel_step.get("filters") or {}), **(step.get("filters") or {})}
                sel_step = {**sel_step, **step}
                if merged_filters:
                    sel_step["filters"] = merged_filters
            else:
                sel_step = step
            continue
        out.append(step)
    if sel_step:
        # Drop any subgroup analysis outputs when SEL is present —
        # SEL and subgroup cards should never render together
        out = [o for o in out if not (
            o.get("type") == "analysis" and
            str(o.get("analysis_type") or "").startswith("subgroup")
        )]
        out.append(sel_step)
    return out


def _message_explicitly_wants_roster(lower: str) -> bool:
    return bool(
        re.search(
            r"show me the students|student list|pull a list|sortable table|list (every|all) student|"
            r"which students|view (the )?students|full (student )?list|roster",
            lower,
        )
    )


def _message_wants_artifact(lower: str) -> Optional[str]:
    """High-confidence document requests (safety net when classifier returns a roster only)."""
    if re.search(
        r"\b(intervention|action|implementation|tutoring)\s+plan\b|"
        r"\bintervention\s+strateg",
        lower,
    ):
        return "action_plan"
    if re.search(r"\b(meeting\s+)?agenda\b", lower) and re.search(
        r"\b(create|generate|build|draft|make)\b", lower
    ):
        return "agenda"
    if re.search(r"\b(report)\b", lower) and re.search(
        r"\b(create|generate|build|draft|make|summarize|summarise)\b", lower
    ):
        return "report"
    if re.search(r"\b(build|create|design|draft|make)\b", lower) and re.search(
        r"\b(plan|intervention)\b", lower
    ):
        return "action_plan"
    return None


def _message_implies_triple_flag(lower: str) -> bool:
    return bool(
        re.search(
            r"triple[- ]?flag|all\s*three|three\s*flags|three\s*indicators|all\s*3\s*flags|"
            r"all\s*3\s*indicators",
            lower,
        )
    )


def _message_wants_foundational_analysis(lower: str) -> bool:
    """Unified risk overview — not subgroup breakdown."""
    if re.search(r"\bsubgroup\b", lower):
        return False
    return bool(
        re.search(
            r"\bfoundational\s+analysis\b|"
            r"\brun\s+foundational\b|"
            r"\brun\s+unified\b|"
            r"^run\s+analysis\b|"
            r"\brun\s+analysis\b(?!\s+subgroup)",
            lower,
        )
    )


def _coerce_outputs_for_message(message: str, outputs: list) -> list:
    """Prefer artifact panel over student table when the teacher asked for a plan."""
    lower = (message or "").lower()
    if _message_wants_foundational_analysis(lower):
        return [{"type": "analysis", "analysis_type": "unified"}]
    artifact_type = _message_wants_artifact(lower)
    if not artifact_type:
        outputs = _coerce_triple_flag_tier(message, outputs)
        return _coerce_subgroup_comparison_outputs(message, outputs)

    has_artifact = any(o.get("type") == "artifact" for o in outputs)
    wants_roster = _message_explicitly_wants_roster(lower)

    if has_artifact:
        artifacts = [o for o in outputs if o.get("type") == "artifact"]
        if wants_roster:
            return [o for o in outputs if o.get("type") in ("student_list", "artifact")]
        outputs = _coerce_subgroup_comparison_outputs(message, outputs)
        return artifacts or outputs

    list_step = next((o for o in outputs if o.get("type") == "student_list"), None)
    if outputs and not list_step:
        return outputs

    grade = (list_step or {}).get("grade")
    tier = (list_step or {}).get("tier")
    step = {"type": "artifact", "artifact_type": artifact_type}
    if grade:
        step["grade"] = grade
    if tier:
        step["tier"] = tier
    return [step]


def _message_is_subgroup_comparison(lower: str) -> bool:
    """Demographic rate comparison — not a student roster request."""
    if _message_explicitly_wants_roster(lower):
        return False
    has_demographic = bool(
        re.search(
            r"subgroup|subgroups|demographic|race|ethnicity|gender|"
            r"\bsped\b|\bell\b|\blep\b|\biep\b|special\s+ed|"
            r"low\s+ses|socioeconomic|\bses\b",
            lower,
        )
    )
    has_rate_question = bool(
        re.search(
            r"which\s+subgroup|highest\s+rates?|compare|comparison|"
            r"academic\s+fail|multi[- ]?flag|overlap|2\+\s*flag|"
            r"break\s*down\s+by|disparit",
            lower,
        )
    )
    return has_demographic and has_rate_question


def _coerce_subgroup_comparison_outputs(message: str, outputs: list) -> list:
    """Subgroup comparison → analysis card only; drop student_list unless roster explicitly requested."""
    lower = (message or "").lower()
    if not outputs or _message_explicitly_wants_roster(lower):
        return outputs
    has_subgroup_analysis = any(
        isinstance(o, dict)
        and o.get("type") == "analysis"
        and str(o.get("analysis_type") or "").startswith("subgroup")
        for o in outputs
    )
    if not has_subgroup_analysis and not _message_is_subgroup_comparison(lower):
        return outputs
    kept = [o for o in outputs if isinstance(o, dict) and o.get("type") != "student_list"]
    return kept if kept else outputs


def _coerce_triple_flag_tier(message: str, outputs: list) -> list:
    """Align student_list tier with unified all_three (flag_count == 3), not broad critical."""
    lower = (message or "").lower()
    if not _message_implies_triple_flag(lower):
        return outputs
    out = []
    for step in outputs:
        if not isinstance(step, dict):
            continue
        s = dict(step)
        if s.get("type") == "student_list":
            tier = str(s.get("tier") or "").strip().lower()
            if tier in ("", "critical", "high"):
                s["tier"] = "triple"
        out.append(s)
    return out or outputs


def _sanitize_intent(parsed: dict, message: str = "") -> dict:
    action = str(parsed.get("action") or "chat").strip().lower()
    tier = parsed.get("tier")
    grade = parsed.get("grade")
    analysis_type = parsed.get("analysis_type")
    confidence = parsed.get("confidence")
    clarify_raw = parsed.get("clarify")
    filters = _sanitize_intent_filters(parsed.get("filters"))

    if action not in INTENT_ACTIONS:
        action = "chat"
    try:
        confidence = float(confidence) if confidence is not None else None
        if confidence is not None:
            confidence = max(0.0, min(1.0, confidence))
    except (TypeError, ValueError):
        confidence = None

    tier = str(tier).strip().lower() if tier is not None else None
    if tier not in INTENT_TIERS:
        tier = None
    grade = str(grade).strip() if grade is not None else None
    if grade not in INTENT_GRADES:
        grade = None
    analysis_type = str(analysis_type).strip().lower() if analysis_type is not None else None
    if analysis_type not in INTENT_ANALYSIS_TYPES:
        analysis_type = None

    clarify = _sanitize_clarify(clarify_raw) if action == "clarify" else None
    outputs = _sanitize_outputs(parsed.get("outputs"), default_grade=grade)

    if action == "clarify":
        if not clarify:
            action = "chat"
        else:
            tier = None
            analysis_type = None
            outputs = []
    elif action in {"show_students", "run_sel", "run_analysis", "generate_artifact"}:
        outputs = outputs or _outputs_from_legacy(action, tier, grade, analysis_type, filters)
        action = "execute"
    elif action == "execute" and not outputs:
        action = "chat"

    if action == "execute" and outputs:
        outputs = _coerce_triple_flag_tier(message, outputs)
        outputs = _coerce_outputs_for_message(message, outputs)
        outputs = enrich_subgroup_analysis_outputs(message, outputs)
        if not outputs:
            action = "chat"

    # Low confidence with clarify steps → clarify
    # Low confidence without clarify steps → still execute, don't silently downgrade to chat
    if action == "execute" and confidence is not None and confidence < 0.72:
        if clarify:
            action = "clarify"
            outputs = []
        # Don't downgrade to chat — if Haiku returned execute with outputs, trust it

    if action == "clarify" and clarify and len(clarify.get("steps") or []) > 2:
        clarify["steps"] = (clarify.get("steps") or [])[:2]

    answerable_from_context = bool(parsed.get("answerable_from_context"))

    kb_scope = parsed.get("kb_scope")
    if kb_scope not in ("student_success", "general"):
        kb_scope = None

    return {
        "action": action,
        "confidence": confidence,
        "tier": tier,
        "grade": grade,
        "analysis_type": analysis_type,
        "filters": filters,
        "outputs": outputs if action == "execute" else None,
        "clarify": clarify if action == "clarify" else None,
        "answerable_from_context": answerable_from_context,
        "kb_scope": kb_scope,
    }


def _classify_teacher_intent(
    message: str,
    stage: Optional[str],
    has_file: bool,
    context_summary: Optional[dict] = None,
) -> dict:
    stage_text = (stage or "none").strip().lower()
    ctx_json = json.dumps(context_summary or {}, default=str)[:4000]
    prompt = (
        f'A teacher using an education analytics tool sent this message: "{message}"\n\n'
        f"Current analysis stage: {stage_text}\n"
        f"File uploaded: {'yes' if has_file else 'no'}\n"
        f"Analysis context (JSON, may be empty): {ctx_json}\n\n"
        "Return ONLY valid JSON. Use this decision tree:\n\n"

        "STEP 1 — CONTEXT INHERITANCE\n"
        "If message references a previously shown list OR a previously discussed group "
        "('these students', 'those 80', 'same list', 'can you show me the list', "
        "'show me the list', 'show me those students') → inherit tier/grade from "
        "last_student_list OR from the most recently discussed cohort in the conversation. "
        "If the previous assistant message discussed '80 Grade 7 triple-flag students', "
        "inherit tier=triple, grade=7. Always prefer the most specific recent group.\n\n"

        "STEP 2 — WHAT ACTION TO TAKE\n\n"

        "Use action=execute for:\n"
        "A) Explicit run/show/view commands:\n"
        "   - 'run foundational analysis', 'foundational analysis', 'run analysis' (without 'subgroup') → analysis, analysis_type=unified\n"
        "     NEVER route these to subgroup_school_wide or subgroup_picker.\n"
        "   - 'run subgroup analysis', 'show subgroup breakdown', 'view subgroup' → analysis, subgroup_school_wide\n"
        "   - 'run well-being analysis', 'run SEL analysis', 'show SEL' → sel\n"
        "   - 'view grade breakdown', 'show grade breakdown', 'grade breakdown' → analysis, grade_breakdown\n"
        "   - 'show me students', 'student list', 'pull a list', 'who are the...' → student_list\n"
        "   - 'create action plan', 'build intervention plan', 'generate agenda', 'create report' → artifact\n\n"
        "B) Any comparison or question where the exact answer is NOT already in loaded results:\n"
        "   → group_comparison. Let resolve_custom_groups figure out the groups from the message.\n"
        "   This includes: grade vs grade, demographic vs demographic, cohort vs cohort,\n"
        "   threshold-based groups, any cross-tab not pre-computed.\n"
        "   NEVER respond with 'I don't have that data' — always compute it.\n\n"
        "C) Student list with filters:\n"
        "   - 'show me Grade 7 students with all 3 flags', 'list ELL students who are failing' → student_list\n"
        "   - 'which students X', 'which Grade 7 students have X' → student_list, NOT chat\n"
        "   - 'which' + any student characteristic → always student_list\n"
        "D) SEL subgroup comparisons:\n"
        "   - 'do Low SES students score lower on SEL in Grade 7', 'compare ELL vs non-ELL SEL in Grade 6' → sel, sel_compare_dimension + sel_compare_grade\n"
        "   - 'compare triple-flag vs on-track on SEL' → sel, sel_cohort=triple, sel_baseline=school\n\n"

        "Use action=clarify ONLY when:\n"
        "   - Teacher names multiple options without choosing: 'Low SES or SPED?', 'Grade 6 or 7?'\n"
        "   - Ask ONE question with 2-4 button options.\n"
        '   - Example: "do Low SES or SPED students score lower on SEL in Grade 7" → '
        '     clarify: {"intro": "Which comparison?", "steps": [{"id": "s1", "title": "Which group?", "multi": false, "options": [{"id": "low_ses", "label": "Low SES vs non-Low SES"}, {"id": "sped", "label": "SPED vs non-SPED"}, {"id": "both", "label": "Both"}]}]}\n\n'

        "Use action=chat for EVERYTHING ELSE — any question about rates, counts, "
        "comparisons, patterns, gaps, intersections, interpretations, "
        "interventions, strategies, or what to do next. "
        "Set answerable_from_context=true by default when a file is uploaded — "
        "Claude will determine what it can answer from loaded data vs what needs computation.\n\n"

        "STEP 3 — SET answerable_from_context\n"
        "Set answerable_from_context=true whenever a file is uploaded and the question "
        "is about the uploaded data. Claude will use loaded data when available and "
        "gracefully explain what requires additional computation.\n\n"

        "STEP 4 — OUTPUT TYPES (for execute only)\n"
        "- student_list: tier (critical|high|moderate|on_track|all|triple), grade, and filters for ANY additional conditions mentioned:\n"
        "  - demographic conditions (ell, special_ed, low_ses, overage etc.) → set as demographic_subset if single, or include in the message for resolve_dynamic_filters\n"
        "  - academic conditions (\"failing courses\", \"failing math\") → tier=academic_only or keep tier=all and let the message carry the condition\n"
        "  - NEVER drop demographic or academic filters — if the teacher says \"ELL students failing courses\", both conditions must be preserved\n"
        "  - When multiple filters are needed that filters{} can't express, set tier=all and ensure the full message text is passed so resolve_dynamic_filters can extract all conditions\n"
        f"- analysis: analysis_type (unified|subgroup_school_wide|subgroup_triple_cohort|subgroup_grade_driver|grade_breakdown), subgroup_compare fields from: {field_glossary_for_prompt()}\n"
        "  unified = foundational risk overview. 'run foundational analysis' / 'run analysis' → unified, NEVER subgroup.\n"
        "- row_level: ONLY for individual student profile, Pearson/Spearman correlation between "
        "two raw columns, or top/bottom N students ranked by a single raw column value. "
        "If risk.grade_summary already contains the answer (grade rates, counts, overlaps), "
        "it is action=chat, never row_level.\n"
        "- sel: full SEL analysis card ONLY for these specific cases:\n"
        "  1. 'run SEL analysis' / 'run well-being analysis' — no chart type mentioned\n"
        "  2. 'compare ELL vs non-ELL SEL in Grade 7' — demographic split requiring backend computation\n"
        "  3. 'compare triple-flag vs on-track on SEL' — cohort vs baseline requiring backend computation\n"
        "  NEVER use sel when:\n"
        "  - Teacher asks for a chart/radar/visualization of SEL data already in sel.groups → action=chat\n"
        "  - Teacher asks for a chart of non-SEL data (suspension, absence, failure) by grade → action=chat\n"
        "  - The word 'radar', 'bar', 'chart', 'plot' appears with data already in loaded results → action=chat\n"
        "- sel filters: sel_cohort, sel_cohort_grade, sel_baseline, sel_compare_dimension (low_ses|special_ed|ell), sel_compare_grade, sel_compare_grades\n"
        "- group_comparison: set metric to match what the teacher wants to compare:\n"
        "  metric=sel for SEL/well-being/social-emotional questions\n"
        "  metric=absence for attendance/absence questions\n"
        "  metric=suspension for suspension/behavior questions\n"
        "  metric=failure for course failure/academic questions\n"
        "  metric=flags for questions about risk indicators, flags, or multiple indicators at once\n"
        "  When multiple indicators are mentioned (e.g. absence AND suspension), use metric=flags\n\n"
        "- artifact: artifact_type (action_plan|agenda|report)\n\n"

        "STEP 5 — SEL filters (when action=execute, type=sel)\n"
        "Pick ONE pattern:\n"
        "- Focal cohort vs baseline: sel_cohort=triple, optional sel_cohort_grade, sel_baseline=grade|school\n"
        "- Demographic split in one grade: sel_compare_dimension + sel_compare_grade\n"
        "- Two grades vs school: sel_compare_grades array\n"
        "Never duplicate sel outputs. Never add student_list for SEL-only questions.\n"
        "If teacher names multiple demographics without choosing (Low SES or SPED) → clarify first.\n\n"

        "CRITICAL OUTPUT RULE:\n"
        "- Never return student_list alongside group_comparison or sel in the same outputs array.\n"
        "- student_list is a terminal output — if the answer is a roster, that is the complete answer.\n"
        "- group_comparison is only valid when the question explicitly asks to compare two or more groups with no roster.\n"
        "- sel is only valid when the question explicitly asks for the full SEL analysis card (cohort vs baseline, demographic SEL comparison).\n"
        "- Charts of loaded aggregates (grade rates, subgroup rates, SEL group averages) → action=chat, not row_level or sel.\n"
        "- row_level vs sel: full SEL analysis card → sel; individual student / correlation / rank by one column → row_level.\n\n"

        "CARD vs CHART RULE:\n"
        "- Use action=execute when the answer requires fetching new data from the backend\n"
        "  (student roster, subgroup breakdown, SEL analysis, grade breakdown, group comparison).\n"
        "  These always produce a structured card. Set answerable_from_context=false.\n"
        "- Use action=chat when the answer can be computed from CURRENT ANALYSIS DATA already\n"
        "  loaded in context. Claude will answer in text and emit a viz block if a chart helps.\n"
        "  Set answerable_from_context=true.\n"
        "- NEVER return action=execute with answerable_from_context=true for analysis output types.\n"
        "  If it is answerable from context it is action=chat.\n"
        "  If it needs computation it is action=execute with answerable_from_context=false.\n\n"

        "ROUTING DECISION MATRIX (use this, not pattern matching on keywords):\n\n"
        "1. Is the answer already in risk.grade_summary, risk.indicators, risk.overlap, subgroup.categories, or sel.groups?\n"
        "   → action=chat, answerable_from_context=true\n"
        "   This covers: grade comparisons, indicator rates, overlap counts, subgroup rates, SEL group averages.\n"
        "   Charts/visualizations of this data are also chat — Claude emits a viz block.\n"
        "   CRITICAL: Check context_summary before routing to execute:\n"
        "   - subgroup.categories present → 'which subgroups have highest X' is action=chat\n"
        "   - sel.groups present → 'which SEL factor is lowest for X' is action=chat\n"
        "   - risk.grade_summary present → 'which grade has most X' is action=chat\n"
        "   NEVER route to execute+analysis if the data to answer the question is already loaded.\n"
        "   Re-running analysis that is already in context wastes time and duplicates cards.\n\n"
        "2. Does the answer require fetching a NEW dataset not in loaded results?\n"
        "   → action=execute\n"
        "   - Student roster → student_list\n"
        "   - Full SEL analysis card (cohort vs baseline) → sel\n"
        "   - Subgroup breakdown card → analysis, subgroup_*\n"
        "   - Foundational risk overview → analysis, analysis_type=unified (NOT subgroup)\n"
        "   - Custom group comparison → group_comparison\n"
        "   - Document generation → artifact\n\n"
        "3. Does the answer require raw row-level values (individual record lookup, Pearson correlation, ranking by a raw column)?\n"
        "   → action=execute, type=row_level\n"
        "   ONLY for: individual student profile, correlation between two raw columns, top/bottom N by a raw column.\n"
        "   NOT for: grade comparisons, indicator rates, anything derivable from aggregates.\n\n"
        "4. Does the message name multiple options without choosing?\n"
        "   → action=clarify\n\n"
        "5. Everything else (interventions, strategies, explanations, what to do next)?\n"
        "   → action=chat, answerable_from_context=true\n\n"
        "KB SCOPE RULE:\n"
        "Set kb_scope=student_success when the question asks about:\n"
        "  - interventions, strategies, programs, approaches for at-risk students\n"
        "  - what to do about chronic absence, course failure, suspensions, low SEL scores\n"
        "  - evidence-based practices, research-backed methods\n"
        "  - how to support SPED, ELL, or other subgroups\n"
        "Set kb_scope=general for everything else (data questions, analysis requests, artifact generation).\n\n"
        "ARCHETYPES (one per route — generalize from these):\n"
        "chat+context: any rate/count/comparison question on loaded data, any chart of loaded data, "
        "'which subgroups make up the triple-flag students', "
        "'how many Grade 7 students are Low SES AND ELL', "
        "any demographic composition question answerable from subgroup.categories, "
        "'show me a radar chart of SEL factors', 'SEL scores for chronically absent students', "
        "'chart the SEL factors by risk group', any request for a chart/visualization of SEL data "
        "when sel.groups is already loaded — answer from sel.groups in context, emit viz block\n"
        "execute+student_list: 'show me students with X'\n"
        "execute+row_level: 'which student has the highest X', 'correlate X and Y', 'student 1001s profile'\n"
        "execute+sel: 'run SEL analysis', 'run well-being analysis', "
        "'compare ELL vs non-ELL SEL in Grade 7', "
        "'compare triple-flag vs on-track on SEL' — full SEL card only\n"
        "execute+analysis: 'run foundational analysis', 'run subgroup analysis'\n"
        "execute+artifact: 'create action plan', 'generate agenda'\n"
        "clarify: 'Low SES or SPED?' — multiple options named without choosing\n\n"

        "SCHEMA:\n"
        "{\n"
        '  "action": "chat"|"execute"|"clarify",\n'
        '  "confidence": 0.0-1.0,\n'
        '  "answerable_from_context": true|false|null,\n'
        '  "kb_scope": "student_success"|"general"|null,\n'
        '  "outputs": [...] or null,\n'
        '  "clarify": {...} or null\n'
        "}\n"
        "tier: critical|high|moderate|on_track|all|triple|two_or_more|absent_academic|academic_only\n"
        "grade: \"6\"-\"12\" or null\n"
    )
    try:
        resp = _intent_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=900,
            messages=[{"role": "user", "content": prompt}],
        )
        text_out = ""
        for block in (resp.content or []):
            if getattr(block, "type", "") == "text":
                text_out += getattr(block, "text", "")
        text_out = text_out.strip()
        start = text_out.find("{")
        end = text_out.rfind("}") + 1
        if start == -1 or end == 0:
            return _fallback_intent(message, stage)
        payload = json.loads(text_out[start:end])
        if not isinstance(payload, dict):
            return _fallback_intent(message, stage)
        return _sanitize_intent(payload, message=message)
    except Exception as e:
        logger.warning("[classify-intent] Error: %s", e)
        return _fallback_intent(message, stage)


@router.post("/classify-intent", response_model=IntentClassifyResponse)
async def classify_intent(req: ClassifyIntentRequest):
    message = (req.message or "").strip()
    if not message:
        return {
            "action": "chat",
            "confidence": 0.0,
            "tier": None,
            "grade": None,
            "analysis_type": None,
            "clarify": None,
        }
    return _classify_teacher_intent(
        message,
        req.stage,
        req.has_file,
        req.context_summary,
    )


@router.post("/send")
async def send_message(
    req: ChatRequest,
    authorization: Optional[str] = Header(None),
):
    print(f"[send_message] authorization present: {bool(authorization)}, internal: {req.internal}, conversation_id: {req.conversation_id}")
    is_internal = bool(req.internal)
    gathered = await gather_sources(req.message, req.kb_scope, internal=is_internal)
    print(f"[gather_sources] kb_scope={req.kb_scope} internal={is_internal} kb_docs={len(gathered['kb_docs'])} selected={gathered['selected']} use_web={gathered['use_web_search']}")
    selected = gathered["selected"]
    kb_docs = gathered["kb_docs"]
    use_web_search = gathered["use_web_search"]
    prefetched_web_initial = gathered["prefetched_web"]

    _dc = req.data_context if isinstance(req.data_context, dict) else {}
    _cid = (req.conversation_id or "").strip() or None
    logger.info(
        "chat /send: conversation_id=%s internal=%s kb_docs=%s web=%s data_context_keys=%s message_len=%s",
        (str(_cid)[:12] + "…") if _cid and len(_cid) > 12 else _cid,
        is_internal,
        len(kb_docs),
        use_web_search,
        list(_dc.keys())[:24],
        len(req.message or ""),
    )

    # Build message history
    messages = []
    for msg in (req.history or []):
        if msg.role in ('user', 'assistant') and msg.content.strip():
            messages.append({'role': msg.role, 'content': msg.content})
    if req.document_pdf and req.document_pdf.get('base64'):
        messages.append({
            'role': 'user',
            'content': [
                {
                    'type': 'document',
                    'source': {
                        'type': 'base64',
                        'media_type': req.document_pdf.get('mediaType', 'application/pdf'),
                        'data': req.document_pdf['base64'],
                    },
                },
                {'type': 'text', 'text': req.message},
            ]
        })
    else:
        messages.append({'role': 'user', 'content': req.message})

    user = await _get_user_optional(authorization)
    conversation_id: Optional[str] = None

    if user:
        try:
            from services.supabase_service import get_supabase

            supabase = get_supabase()
            user_id = user["id"]
            # conversations.user_id FK -> profiles.id — ensure row exists if auth trigger missed
            supabase.table("profiles").upsert(
                {"id": user_id, "email": user.get("email")},
                on_conflict="id",
            ).execute()

            conversation_id = (req.conversation_id or "").strip() or None

            if conversation_id:
                own = (
                    supabase.table("conversations")
                    .select("id")
                    .eq("id", conversation_id)
                    .eq("user_id", user_id)
                    .execute()
                )
                if not own.data:
                    logger.warning(
                        "chat persistence: conversation_id=%s not found or not owned by user_id=%s — starting new",
                        conversation_id,
                        user_id,
                    )
                    conversation_id = None

            if not conversation_id:
                raw = (req.message or "").strip()
                if len(raw) > 10:
                    title = raw[:60] if len(raw) > 60 else raw
                else:
                    title = "New conversation"
                logger.info(
                    "chat persistence: inserting conversation user_id=%s title=%r",
                    user_id,
                    title[:60],
                )
                ins = (
                    supabase.table("conversations")
                    .insert({
                        "user_id": user_id,
                        "title": title,
                    })
                    .execute()
                )
                if ins.data:
                    conversation_id = ins.data[0]["id"]
                    logger.info("chat persistence: created conversation id=%s", conversation_id)
                else:
                    logger.error("chat persistence: conversation insert returned no data: %s", ins)

            if conversation_id and not is_internal:
                supabase.table("messages").insert({
                    "conversation_id": conversation_id,
                    "role": "user",
                    "content": req.message,
                    "metadata": {},
                }).execute()
                logger.info("chat persistence: saved user message conversation_id=%s", conversation_id)
        except Exception as e:
            logger.exception("chat persistence: failed before stream (conversation/messages): %s", e)
            conversation_id = None

    async def generate():
        full_response = ""
        viz_payload: Optional[dict] = None
        suggestions_payload: Optional[list] = None
        web_sources: list = []

        prefetched_web: list = list(prefetched_web_initial or [])
        source_index: list = gathered["source_index"]

        try:
            if conversation_id:
                yield f"data: {json.dumps({'conversation_id': conversation_id})}\n\n"

            async for chunk in stream_response(
                messages,
                req.data_context or None,
                kb_docs if kb_docs else None,
                use_web_search=use_web_search,
                prefetched_web=prefetched_web if (use_web_search and kb_docs) else None,
            ):
                if "__WEB_SOURCES__" in chunk:
                    parts = chunk.split("__WEB_SOURCES__", 1)
                    if parts[0]:
                        full_response += parts[0]
                        yield f"data: {json.dumps({'text': parts[0]})}\n\n"
                    try:
                        rest = parts[1].split("__END_SOURCES__", 1)[0].strip()
                        web_sources = json.loads(rest)
                    except Exception:
                        web_sources = []
                else:
                    full_response += chunk
                    visible = _visible_stream_chunk(full_response, chunk)
                    if visible:
                        yield f"data: {json.dumps({'text': visible})}\n\n"

            # Web-only: build index from streamed URLs (matches [1].. in web-only hint order).
            if use_web_search and not kb_docs and web_sources:
                source_index.clear()
                for i, src in enumerate(web_sources[:3], 1):
                    source_index.append({
                        "num": i,
                        "type": "web",
                        "label": (src.get("title") or src.get("url") or "Web source")[:80],
                        "url": src.get("url"),
                    })

            # Single cleanup pass: strip suggestions, numeric citations, and viz block
            # before any citation indexing. Emit one replace_text so the client never
            # sees a partially-cleaned version.
            raw_for_suggestions = full_response

            cleaned_text, suggestions_payload = _extract_suggestions_block(full_response)
            if suggestions_payload is None and _suggestions_marker_match(raw_for_suggestions):
                m = _suggestions_marker_match(raw_for_suggestions)
                cleaned_text = _clean_before_suggestions(raw_for_suggestions, m.start()) if m else cleaned_text
            full_response = cleaned_text

            if not kb_docs and not use_web_search:
                no_cites = re.sub(r"\s*\[(\d+)\]", "", full_response)
                no_cites = re.sub(r"[ \t]{2,}", " ", no_cites)
                full_response = no_cites

            cleaned_text, viz_payload = _extract_viz_block(full_response)
            full_response = cleaned_text

            logger.info(
                "viz_extraction: found=%s response_len=%s preview=%r",
                viz_payload is not None,
                len(full_response),
                full_response[:150],
            )
            logger.info("full_response_tail: %r", full_response[-300:])

            # Emit cleaned text once, then payloads.
            yield f"data: {json.dumps({'replace_text': full_response})}\n\n"
            if suggestions_payload:
                yield f"data: {json.dumps({'suggestions': suggestions_payload})}\n\n"
            if viz_payload is not None:
                yield f"data: {json.dumps({'viz': viz_payload})}\n\n"

            used_nums = {int(n) for n in re.findall(r"\[(\d+)\]", full_response)}
            # Strict pass: if KB docs were used but no inline [n], run one citation-only rewrite.
            if kb_docs and not used_nums:
                kb_rows = [
                    {"num": src.get("num"), "label": src.get("label")}
                    for src in source_index
                    if src.get("type") == "kb"
                ]
                revised = enforce_inline_citations_once(full_response, kb_rows)
                if revised and revised != full_response:
                    full_response = revised
                    yield f"data: {json.dumps({'replace_text': full_response})}\n\n"
                    used_nums = {int(n) for n in re.findall(r"\[(\d+)\]", full_response)}

            # Final fallback: append all KB ids if citations still missing.
            if kb_docs and not used_nums:
                kb_nums = [s["num"] for s in source_index if s.get("type") == "kb"]
                if kb_nums:
                    logger.warning(
                        "KB docs present but no inline [n] citations after rewrite; appending fallback ids=%s.",
                        kb_nums,
                    )
                    suffix = " " + "".join(f"[{n}]" for n in kb_nums)
                    full_response += suffix
                    yield f"data: {json.dumps({'text': suffix})}\n\n"
                    used_nums = set(kb_nums)
            logger.info("Used citation numbers: %s", sorted(used_nums))
            sources_to_show: list = []

            if conversation_id and full_response.strip() and user:
                try:
                    from services.supabase_service import get_supabase
                    supabase = get_supabase()
                    supabase.table("messages").insert({
                        "conversation_id": conversation_id,
                        "role": "assistant",
                        "content": full_response,
                        "metadata": {
                            **({"viz": viz_payload} if viz_payload else {}),
                            **({"suggestions": suggestions_payload} if suggestions_payload else {}),
                        },
                    }).execute()
                    logger.info(
                        "chat persistence: saved assistant message conversation_id=%s len=%s",
                        conversation_id,
                        len(full_response),
                    )
                except Exception as e:
                    logger.exception("chat persistence: failed to save assistant message: %s", e)

            if used_nums:
                for src in source_index:
                    if src["num"] in used_nums:
                        kb_cls = "src-student-success"
                        if src["type"] == "kb" and src.get("doc"):
                            scope = str(src["doc"].get("scope", "")).lower()
                            kb_cls = "src-school" if scope == "school" else "src-student-success"
                        pill: dict = {
                            "num": src["num"],
                            "label": src["label"],
                            "cls": kb_cls if src["type"] == "kb" else "src-web",
                        }
                        if src["type"] == "kb" and src.get("doc"):
                            pill["document_id"] = str(src["doc"].get("id", ""))
                        if src.get("url"):
                            pill["url"] = src["url"]
                        sources_to_show.append(pill)
            else:
                kb_only = [s for s in source_index if s["type"] == "kb"][:3]
                for src in kb_only:
                    scope = str((src.get("doc") or {}).get("scope", "")).lower()
                    sources_to_show.append({
                        "num": src["num"],
                        "label": src["label"],
                        "cls": "src-school" if scope == "school" else "src-student-success",
                        "document_id": str(src["doc"].get("id", "")),
                    })

            if not is_internal:
                if use_web_search and not kb_docs and not web_sources and not sources_to_show:
                    sources_to_show.append({"label": "Web search", "cls": "src-web"})
                if "general" in selected and not sources_to_show:
                    sources_to_show.append({"label": "General knowledge", "cls": "src-general"})

            if sources_to_show and (not is_internal or kb_docs):
                yield f"data: {json.dumps({'sources': sources_to_show})}\n\n"

            yield 'data: [DONE]\n\n'

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            yield 'data: [DONE]\n\n'

    return StreamingResponse(
        generate(),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'}
    )


@router.get("/conversations")
async def list_conversations(authorization: Optional[str] = Header(None)):
    """List conversations for the authenticated user."""
    try:
        from services.supabase_service import get_current_user, get_supabase
        user = await get_current_user(authorization)
        supabase = get_supabase()
        result = (
            supabase.table("conversations")
            .select("*")
            .eq("user_id", user["id"])
            .order("updated_at", desc=True)
            .execute()
        )
        rows = result.data or []
        logger.info("list_conversations: user_id=%s count=%s", user["id"], len(rows))
        return rows
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("list_conversations: %s", e)
        raise HTTPException(status_code=401, detail=str(e))


@router.get("/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: str,
    authorization: Optional[str] = Header(None),
):
    """Get all messages for a conversation (owner only)."""
    try:
        from services.supabase_service import get_current_user, get_supabase

        user = await get_current_user(authorization)
        supabase = get_supabase()
        conv = (
            supabase.table("conversations")
            .select("id")
            .eq("id", conversation_id)
            .eq("user_id", user["id"])
            .execute()
        )
        if not conv.data:
            raise HTTPException(status_code=404, detail="Conversation not found")

        result = (
            supabase.table("messages")
            .select("*")
            .eq("conversation_id", conversation_id)
            .order("created_at")
            .execute()
        )
        return result.data or []
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/conversations/{conversation_id}/suggestions")
async def update_suggestions(
    conversation_id: str,
    body: SuggestionsPatchBody,
    authorization: Optional[str] = Header(None),
):
    """Merge suggestion pills into the latest assistant message metadata (owner only)."""
    try:
        from services.supabase_service import get_current_user, get_supabase

        user = await get_current_user(authorization)
        supabase = get_supabase()
        conv = (
            supabase.table("conversations")
            .select("id")
            .eq("id", conversation_id)
            .eq("user_id", user["id"])
            .execute()
        )
        if not conv.data:
            raise HTTPException(status_code=404, detail="Conversation not found")

        sel = (
            supabase.table("messages")
            .select("id, metadata, content")
            .eq("conversation_id", conversation_id)
            .eq("role", "assistant")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = sel.data or []
        if not rows:
            raise HTTPException(status_code=404, detail="No assistant message to update")

        row = rows[0]
        if body.message_content is not None:
            want = (body.message_content or "").strip()
            got = (row.get("content") or "").strip()
            if want and got and want != got:
                logger.warning(
                    "update_suggestions: content mismatch for message id=%s (client may be stale)",
                    row.get("id"),
                )

        meta = dict(row.get("metadata") or {})
        meta["suggestions"] = list(body.suggestions or [])

        upd = (
            supabase.table("messages")
            .update({"metadata": meta})
            .eq("id", row["id"])
            .execute()
        )
        return upd.data or []
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("update_suggestions: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/conversations/{conversation_id}/analysis")
async def save_analysis_state(
    conversation_id: str,
    payload: AnalysisStatePayload,
    authorization: Optional[str] = Header(None),
):
    """
    Save analysis state to conversation metadata.
    Merges with existing metadata so partial updates don't overwrite other fields.
    """
    token = _extract_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        from services.supabase_service import get_current_user, get_supabase

        user = await get_current_user(authorization)
        supabase = get_supabase()
        conv = (
            supabase.table("conversations")
            .select("id, metadata")
            .eq("id", conversation_id)
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
        if not conv.data:
            raise HTTPException(status_code=404, detail="Conversation not found")

        current_metadata = conv.data.get("metadata") or {}
        update = {**current_metadata}
        payload_dict = payload.model_dump(exclude_none=True)
        update.update(payload_dict)

        (
            supabase.table("conversations")
            .update({"metadata": update})
            .eq("id", conversation_id)
            .eq("user_id", user["id"])
            .execute()
        )
        return {"ok": True, "metadata": update}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("save_analysis_state: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/conversations/{conversation_id}/analysis")
async def get_analysis_state(
    conversation_id: str,
    authorization: Optional[str] = Header(None),
):
    """
    Get analysis state from conversation metadata.
    Called when restoring a conversation to re-render analysis cards.
    """
    token = _extract_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Unauthorized")
    try:
        from services.supabase_service import get_current_user, get_supabase

        user = await get_current_user(authorization)
        supabase = get_supabase()
        conv = (
            supabase.table("conversations")
            .select("metadata")
            .eq("id", conversation_id)
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
        if not conv.data:
            raise HTTPException(status_code=404, detail="Conversation not found")

        metadata = conv.data.get("metadata") or {}
        return {
            "file_id": metadata.get("file_id"),
            "mapping": metadata.get("mapping"),
            "stage": metadata.get("stage"),
            "risk": metadata.get("risk"),
            "intersection": metadata.get("intersection"),
            "sel": metadata.get("sel"),
            "subgroup": metadata.get("subgroup"),
            "thresholds": metadata.get("thresholds"),
            "filename": metadata.get("filename"),
            "rows": metadata.get("rows"),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("get_analysis_state: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/conversations/{conversation_id}/messages")
async def save_message(conversation_id: str, role: str, content: str, metadata: Optional[dict] = None):
    """Save a message to a conversation."""
    try:
        from services.supabase_service import get_supabase
        supabase = get_supabase()
        result = (
            supabase.table("messages")
            .insert({
                "conversation_id": conversation_id,
                "role": role,
                "content": content,
                "metadata": metadata or {}
            })
            .execute()
        )
        return result.data[0] if result.data else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))