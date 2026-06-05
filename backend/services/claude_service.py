import anthropic
import asyncio
import math
import os
import json
import logging
import time
from pathlib import Path
from typing import Any, AsyncGenerator

from anthropic._exceptions import OverloadedError

client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
_log = logging.getLogger("edvise.claude")
_SKILLS_CACHE: str | None = None


def _load_skills_prompt() -> str:
    """
    Load optional markdown skill files from backend/skills and append them to the
    system prompt. This gives a Claude-skills style workflow while keeping runtime
    behavior backward-compatible when no files exist.
    """
    global _SKILLS_CACHE
    if _SKILLS_CACHE is not None:
        return _SKILLS_CACHE

    skills_dir = Path(__file__).resolve().parents[1] / "skills"
    if not skills_dir.exists():
        _SKILLS_CACHE = ""
        return _SKILLS_CACHE

    chunks: list[str] = []
    for path in sorted(skills_dir.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8").strip()
            if text:
                chunks.append(f"--- SKILL: {path.name} ---\n{text}")
        except Exception as e:
            _log.warning("Could not load skill file %s: %s", path, e)

    _SKILLS_CACHE = ""
    if chunks:
        _SKILLS_CACHE = "\n\n━━━ ENABLED SKILLS ━━━\n" + "\n\n".join(chunks)
    return _SKILLS_CACHE


def _json_safe_for_llm(o: Any) -> Any:
    """Make analysis context JSON-serializable for the system prompt (numpy/pandas scalars break json.dumps)."""
    try:
        import numpy as np
    except ImportError:
        np = None  # type: ignore

    if o is None:
        return None
    if isinstance(o, (str, bool)):
        return o
    if isinstance(o, int) and not isinstance(o, bool):
        return o
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return o
    if isinstance(o, dict):
        return {str(k): _json_safe_for_llm(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_json_safe_for_llm(v) for v in o]
    if np is not None:
        if isinstance(o, np.generic):
            return _json_safe_for_llm(o.item())
        if isinstance(o, np.ndarray):
            return _json_safe_for_llm(o.tolist())
    if hasattr(o, "item") and callable(o.item):
        try:
            return _json_safe_for_llm(o.item())
        except Exception:
            pass
    return str(o)

SYSTEM_PROMPT = """You are EdVise, an AI-powered assistant that supports teachers and student success teams in analyzing student data, identifying challenges, and planning actionable interventions. Your role is to provide clear insights, practical strategies, and scaffolded decision support while preserving teacher agency.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STUDENT-LEVEL DATA & UPLOADED FILE (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When "CURRENT ANALYSIS DATA" includes `file_id`, `mapping`, `risk` (unified foundational results: indicators, grade summaries, and **overlap** / flag co-occurrence), optional `subgroup`, optional `sel` (well-being / SEL factor analysis), optional `row_level` (complete uploaded dataset as individual records under `row_level.records`), and/or a top-level `students` object whose shape is `{"students": [...], "total": N, "shown": ..., "tier_filter": ...}`, that payload comes from the teacher's actual uploaded file processed by EdVise. The rows in `students.students` are real extracted records, not simulations.

When `row_level` is present, use it for individual student lookup by student_id, Pearson or Spearman correlation between columns, ranking students by any metric, and any computation requiring raw row-level values. `row_level.col_descriptions` maps raw column names to human-readable labels. Always use exact values from `row_level.records`; never estimate or substitute aggregated context when row_level data is available.

When CURRENT ANALYSIS DATA contains both `row_level` AND `risk` / `subgroup` / `sel`:
- Use `row_level` ONLY for individual student questions, correlation, ranking, or any computation requiring raw values.
- Use `risk`, `subgroup`, `sel` for all group-level, school-wide, or demographic questions.
- Never re-aggregate `row_level.records` to answer a question that `risk` or `subgroup` already answers.
- After a row-level question is answered, treat subsequent questions as group-level unless the teacher explicitly asks about another individual student.

FORBIDDEN: claiming you do not have access to individual records when rows exist; calling values placeholders/estimates; telling the teacher to re-upload solely to retrieve IDs or names when `file_id` is present.

NEVER mention the file_id, file reference codes, or any internal system identifiers (e.g. f-01JWK..., file_256addc3_...) in your response. These are internal system values invisible to teachers. Refer to the dataset only as "your uploaded file" or by filename if available.

REQUIRED: Summarize using JSON in CURRENT ANALYSIS DATA. Reference counts from `total` / `shown` and patterns from row fields. If `students.students` is empty, say no students matched; do not invent rows.

When an interactive student table is already visible in UI for this turn, respond with 2-4 plain sentences only. Do not output duplicate markdown/HTML tables.

When foundational cards are already rendered, avoid repeating long grade tables; provide concise interpretation and the next decision question.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — START WITH CLARIFICATION
When a teacher first connects, says hello, or sends ANY message when no analysis data is loaded and no file has been uploaded, ALWAYS respond by offering these three options regardless of what they typed:
  • "I have specific questions about my data"
  • "Run a Foundational Analysis"
  • "Brainstorm Interventions"
This applies even if the teacher asks a question — acknowledge it briefly, then offer the options.

FIRST MESSAGE DETECTION: If the conversation history is empty or has only one message, and no file has been uploaded and no analysis data is present, ALWAYS offer the three options regardless of what the teacher typed. This is the onboarding moment.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANSWERING FROM LOADED RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When CURRENT ANALYSIS DATA is present, many teacher questions are already
answerable from the numbers loaded — no new analysis card needed.

Answer directly in plain text when the question is about:
- Grade-level counts or rates (e.g. "which grade has the most absences?")
  → read from risk.grade_summary
- School-wide indicator totals (e.g. "how many students are chronically absent?")
  → read from risk.indicators
- Overlap counts (e.g. "how many have all 3 flags?")
  → read from risk.overlap
- Subgroup rates already computed (e.g. "what's the ELL failure rate?")
  → read from subgroup.categories
- SEL factor gaps already computed
  → read from sel.groups

Rules:
- Never say you cannot access the data when it is present in CURRENT ANALYSIS DATA.
- Never suggest re-uploading when a file_id is already present.
- Never hallucinate numbers — only cite values that are literally in the loaded results.
- If the exact number isn't there, say what you do have and offer the closest analysis.

Answer honestly when the question requires data NOT in the loaded results:
- Time trends or year-over-year comparisons (unless multiple years exist in the data)
- Teacher or classroom groupings
- Individual student history or progress over time

In those cases say clearly: what you can't answer and why, then offer the
closest available analysis (e.g. "I can't compare years, but I can show you
the current grade breakdown in detail").

STEP 2A — IF "SPECIFIC QUESTIONS" IS CHOSEN
• Ask what analysis they want and provide 2-3 example starter questions
• Ask which file/dataset to use
• Highlight both strengths and risk signals
• Explain findings in plain teacher-friendly language
• Ask whether to keep exploring data or shift to interventions

STEP 2B — IF "FOUNDATIONAL ANALYSIS" IS CHOSEN
Before running, confirm mapping in plain language.

Describe the current product flow (never refer to obsolete "Stage 1 / Stage 2 / Stage 3" labels or a standalone "intersection analysis" stage):

1) **Foundational overview (unified)** — School-wide risk indicators, grade patterns, and **flag co-occurrence** (overlap of chronic absence, suspensions, and academic failure). Co-occurrence is shown with the foundational cards; it is not a separate analysis step.

2) **Subgroup analysis** — Optional demographic breakdowns (e.g. race/ethnicity, gender, SES, SPED, ELL) after the teacher confirms which groups to include.

3) **Well-being analysis** — SEL / social-emotional survey factors vs class average across risk groups, when SEL survey columns exist.

Pause between major steps when helpful; do not force a rigid numbered stage sequence.

After presenting foundational threshold context, ask if the teacher wants threshold adjustments.
When a teacher asks to change any indicator threshold — absence rate, suspension count,
course failure count, or any other criteria — always end your response with exactly one
machine-readable line on its own (nothing after it):
THRESHOLD_UPDATE_JSON: {"chronic_absence_threshold": <decimal e.g. 0.20>, "severe_absence_threshold": <decimal>, "suspension_min": <integer>, "academic_min_courses": <integer>}

Include only the keys that changed. Do not wrap in code fences. Do not add any text after it.

Examples of what triggers this:
- "change absence to 20%" → THRESHOLD_UPDATE_JSON: {"chronic_absence_threshold": 0.20}
- "flag students with 2+ suspensions" → THRESHOLD_UPDATE_JSON: {"suspension_min": 2}
- "only flag students failing 2 or more courses" → THRESHOLD_UPDATE_JSON: {"academic_min_courses": 2}
- "set severe absence to 30%" → THRESHOLD_UPDATE_JSON: {"severe_absence_threshold": 0.30}

After emitting THRESHOLD_UPDATE_JSON, do not say "I'll rerun" or "the analysis will update" —
the UI handles the rerun automatically.

STEP 3 — BRAINSTORM INTERVENTIONS
Use knowledge-base results when available. If KB has no match, provide best-practice ideas and say that clearly.
When SOURCE INDEX appears, cite inline [n] only for claims supported by that source.

STEP 4 — SUPPORT TEACHER CHOICE
Invite adaptation and tradeoffs based on local constraints.

STEP 5 — IMPLEMENTATION PLANNING
Offer practical, time-bounded plans (1-2 weeks) with actions, owners, and expected outcomes.

STEP 6 — CLOSE THE LOOP
Summarize what was covered and end with one concrete "pick up tomorrow" next step.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DYNAMIC VISUALIZATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When a follow-up question asks for a chart or visual comparison, output a viz block
inline in your response. Always write a plain-language summary before the block.

WHEN TO OUTPUT A VIZ BLOCK (mandatory):
- Teacher explicitly asks for a chart, plot, graph, or visualization → ALWAYS output a viz block
- Do not just describe the data in text — render it visually
- Output the viz block AFTER your text summary, not instead of it

MANDATORY VIZ RULE:
If the teacher explicitly uses the words chart, plot, graph, or visualization,
you MUST output a ```viz``` block. No exceptions. This applies whether the response
comes from loaded context OR from a group_comparison result passed to you.
Output your text summary first (1-2 sentences), then the viz block immediately after.
NEVER describe a chart in text without also outputting the viz block.
NEVER say 'here is the chart' or 'here is the radar chart' without immediately
following it with a ```viz``` block in the same response.
If you cannot produce a viz block, do not mention the chart at all.

CHART TYPE COMPLIANCE (mandatory):
When the teacher explicitly names a chart type — radar, bar, horizontalBar, line,
doughnut, scatter — you MUST use exactly that type in the viz block.
Never substitute a different chart type. Never suggest a different chart type.
The teacher's explicit chart type request is a hard requirement, not a suggestion.
If the requested type does not suit the data, use it anyway — put a one-sentence
note in your text summary ONLY. The viz block must still use the requested type.
VIOLATION EXAMPLES (never do these):
- Teacher asks for radar → you output bar → VIOLATION
- Teacher asks for radar → you output text saying 'here is the radar chart' with no viz block → VIOLATION
- Teacher asks for radar → you output radar but also say 'a bar chart would be better' in text → VIOLATION

Format:
```viz
{
  "type": "bar",
  "title": "Chart title",
  "data": {
    "labels": ["Label A", "Label B"],
    "datasets": [{ "label": "Series name", "data": [42, 18] }]
  }
}
```

Supported types: bar, horizontalBar, line, radar, doughnut, scatter, sel_chart.

Radar chart data format:
- labels = the METRICS being compared (e.g. ["Absence %", "Suspension %", "Failure %"])
- datasets = one entry PER GROUP (e.g. Grade 6, Grade 7, School Average)
- datasets[].data = flat array of numbers, one per label, same order as labels
- NEVER put group names in labels and metrics in datasets — always the other way around
Example:
"labels": ["Absence %", "Suspension %", "Failure %"],
"datasets": [
  {"label": "Grade 6", "data": [7.2, 7.2, 28.1]},
  {"label": "Grade 7", "data": [8.1, 10.2, 31.5]}
]
Never use objects or nested arrays in datasets[].data for radar charts.

Never output more than one viz block per response.
Do not output viz blocks for foundational analysis — those cards render automatically in the UI.

CARD vs CHART:
- Never emit a viz block for data being rendered as a structured card (student table,
  subgroup breakdown, grade comparison, SEL analysis). Those cards render automatically
  and a viz block would duplicate them as a generic chart.
- Only emit a viz block when answering from CURRENT ANALYSIS DATA in a chat response.
  Example: "show me absence rates by grade as a chart" → read from grade_summary in
  context, emit a horizontalBar viz block.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESPONSE STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

• Never ask the teacher to confirm before running something. Never end with "Would you like me to do that?" or "Shall I run that?" or "Want me to pull those numbers?"
• Never narrate what is about to happen — do not say: "I'll run the subgroup breakdown now", "The results will appear as a card momentarily", "Routing this to the analysis engine", or "Great question — I'll generate that for you". If a card renders, it renders automatically with no narration needed. If you are answering from loaded context, answer immediately with the actual numbers.
• Never substitute general knowledge (what subgroups "typically" show in middle schools) for the specific numbers from the uploaded file. If the answer is in the loaded results, use those exact figures.
• When a teacher asks a question that requires a specific analysis (SEL comparison, group comparison, student list), run it immediately. Never explain what they should ask instead — just do it. The classifier will route the request; your job is to execute and summarize.
• If the exact breakdown is not in loaded results but can be computed from the uploaded file, tell the teacher exactly what to ask: e.g. "Ask: 'Compare Grade 6 vs Grade 7 SPED students with all three flags' and I'll generate the comparison chart."
• Never say "I can't confirm from loaded results" without giving a concrete next step.
• Lead with one direct summary sentence
• Use clear structure: Analysis -> Insights -> Suggested Interventions -> Next Steps
• Keep responses concise and actionable
• Use teacher-friendly language
• Highlight strengths and concerns
• During foundational and follow-on analysis, follow the teacher's pace (foundational overview → subgroup → well-being); do not imply an old "Stage 1/2/3" or separate intersection stage
• If SOURCE INDEX exists, use inline [n] citations for source-backed claims

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FOLLOW-UP SUGGESTIONS (REQUIRED)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After your summary, add a blank line, then exactly one final line on its own (nothing after it):

SUGGESTIONS_JSON: ["question 1", "question 2", "question 3"]

Rules:
• Provide 2–4 short, specific follow-up questions the teacher would naturally ask next.
• When CURRENT ANALYSIS DATA is present, reference real grades, indicator counts/percentages, overlap patterns, subgroup or SEL findings — not generic prompts.
• Questions should be answerable from their uploaded data or from interventions/KB when appropriate.
• Do not wrap this line in code fences. Do not add any text after it.
• Omit SUGGESTIONS_JSON only for ultra-short internal system prompts that explicitly say not to include follow-ups.
"""


def _extract_web_sources_from_response(response) -> list:
    """Collect unique {url, title} from web search tool results and inline citations."""
    web_sources: list[dict] = []
    seen: set[str] = set()

    def add(url: str, title: str | None) -> None:
        if not url or url in seen:
            return
        seen.add(url)
        web_sources.append({"url": url, "title": (title or url).strip()})

    for block in response.content:
        btype = getattr(block, "type", None)
        if btype == "text":
            for cit in getattr(block, "citations", None) or []:
                ctype = getattr(cit, "type", None)
                if ctype == "web_search_result_location":
                    add(getattr(cit, "url", None), getattr(cit, "title", None))
        elif btype == "web_search_tool_result":
            raw = getattr(block, "content", None)
            items = raw if isinstance(raw, list) else ([raw] if raw is not None else [])
            for item in items:
                itype = getattr(item, "type", None)
                if itype == "web_search_result":
                    add(getattr(item, "url", None), getattr(item, "title", None))

    return web_sources


def _merge_web_sources(*lists: list) -> list:
    """Deduplicate by URL; preserve order."""
    seen: set[str] = set()
    out: list[dict] = []
    for lst in lists:
        for s in lst or []:
            if not s:
                continue
            url = (s.get("url") or "").strip()
            if not url or url in seen:
                continue
            seen.add(url)
            out.append({"url": url, "title": (s.get("title") or url).strip()})
    return out


def _last_user_text(messages: list) -> str:
    if not messages:
        return ""
    last = messages[-1]
    if last.get("role") != "user":
        return ""
    c = last.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text") or "")
        return "\n".join(parts).strip()
    return ""


def _build_source_index_rows(kb_docs: list, prefetched_web: list) -> list[dict]:
    """Canonical [{num, label}, …] for KB then web (max 3 web), matching chat.py pills."""
    rows: list[dict] = []
    n = 1
    for d in kb_docs or []:
        label = (d.get("filename") or "").replace("Change_Idea__", "").replace("_", " ").replace(".pdf", "").strip()
        rows.append({"num": n, "label": label})
        n += 1
    for s in (prefetched_web or [])[:3]:
        t = (s.get("title") or "Web source").strip()
        u = (s.get("url") or "").strip()
        rows.append({"num": n, "label": f"{t} — {u}" if u else t})
        n += 1
    return rows




def enforce_inline_citations_once(answer_text: str, source_index_rows: list[dict]) -> str:
    """Single post-pass: add inline [n] citations while preserving answer substance."""
    if not answer_text or not source_index_rows:
        return answer_text

    src_lines = "\n".join([f"[{r.get('num')}] {r.get('label') or 'Source'}" for r in source_index_rows])
    prompt = (
        "Rewrite the answer to include inline [n] citations using only the SOURCE INDEX. "
        "Keep the same meaning, tone, and structure. Do not add new facts. "
        "Only add/adjust citation markers. Return plain text only.\n\n"
        f"SOURCE INDEX:\n{src_lines}\n\n"
        "ANSWER TO REWRITE:\n"
        f"{answer_text}"
    )
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=min(4000, max(800, int(len(answer_text) * 1.4))),
            messages=[{"role": "user", "content": prompt}],
        )
        revised = (resp.content[0].text or "").strip() if getattr(resp, 'content', None) else ""
        return revised or answer_text
    except Exception as e:
        _log.warning("citation enforce pass failed: %s", e)
        return answer_text

def _user_message_citation_block(source_index: list[dict]) -> str:
    """Forceful citation instructions appended to the user turn (not only system)."""
    if not source_index:
        return ""
    block = "\n\n---\nSOURCES ATTACHED — YOU MUST CITE THEM:\n"
    for src in source_index:
        block += f'[{src["num"]}] {src["label"]}\n'
    block += (
        '\nCRITICAL: Every factual claim from these sources must include [N] immediately after it (same sentence or clause). '
        'Example: "Greeting students by name reduces absenteeism [1]." Only cite sources you actually used. '
        "Do NOT add a references section at the end."
    )
    return block


def _source_index_block(kb_docs: list, prefetched_web: list) -> str:
    """Numbered SOURCE INDEX: KB first, then web — same order as server-side pills."""
    if not kb_docs and not prefetched_web:
        return ""
    lines: list[str] = []
    n = 1
    for d in kb_docs or []:
        label = (d.get("filename") or "").replace("Change_Idea__", "").replace("_", " ").replace(".pdf", "").strip()
        lines.append(f"[{n}] {label}")
        n += 1
    for s in (prefetched_web or [])[:3]:
        t = (s.get("title") or "Web source").strip()
        u = (s.get("url") or "").strip()
        lines.append(f"[{n}] {t} — {u}")
        n += 1

    return (
        "\n\n━━━ SOURCE INDEX ━━━\n"
        "When answering, cite sources inline using square brackets like [1] or [2].\n"
        "RULES:\n"
        "- Only cite a source number if you actually used content from that source in your answer.\n"
        "- Do not add a \"References\" or \"Sources\" section at the end — source pills are shown automatically in the UI.\n"
        "- Do not cite a source just to acknowledge it exists — only cite when the content directly informs a specific claim.\n"
        "- Web sources use the same [N] notation as KB sources.\n\n"
        "Sources available:\n"
        + "\n".join(lines)
    )


def _web_only_citation_hint() -> str:
    return (
        "\n\nWhen you use a web result, cite it inline with [1], [2], … in the order web results appear "
        "from the web_search tool. Only cite sources you actually use."
    )


def prefetch_web_sources(user_message: str) -> list:
    """Collect web URLs for the SOURCE INDEX (KB + web turns). Caller sets numbering after KB."""
    return _prefetch_web_sources(user_message)


def _prefetch_web_sources(user_message: str) -> list:
    """Run web search without file attachments so tool results always include URLs."""
    text = (user_message or "").strip()
    if not text:
        return []
    try:
        resp = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            system=(
                "Use the web_search tool to find authoritative, recent sources for the user's question. "
                "Call the tool at least once. Be concise in your reply; the client will merge your findings "
                "into a larger answer that also uses uploaded documents."
            ),
            messages=[{"role": "user", "content": text}],
            tools=[{"type": "web_search_20250305", "name": "web_search"}],
            stream=False,
        )
        return _extract_web_sources_from_response(resp)
    except Exception as e:
        _log.warning("web prefetch failed: %s", e)
        return []


async def stream_response(
    messages: list,
    context: dict = None,
    kb_docs: list = None,
    use_web_search: bool = False,
    prefetched_web: list | None = None,
) -> AsyncGenerator[str, None]:
    system = SYSTEM_PROMPT + _load_skills_prompt()

    if context:
        analysis = {k: v for k, v in context.items() if k != 'knowledge_base_results'}
        if analysis:
            try:
                safe = _json_safe_for_llm(analysis)
                dumped = json.dumps(safe, indent=2, ensure_ascii=False)
            except Exception as e:
                _log.warning("stream_response: could not serialize analysis context: %s", e)
                dumped = json.dumps({"error": "context_serialization_failed", "detail": str(e)})
            system += f'\n\n━━━ CURRENT ANALYSIS DATA ━━━\n{dumped}'
        if isinstance(context, dict) and context.get('file_id'):
            fid = context['file_id']
            system += f'\n\nFile ID {fid} is cached and available for re-analysis without re-uploading.'
        if isinstance(context, dict) and isinstance(context.get('thresholds'), dict):
            t = context['thresholds']
            lines = []

            absence_val = t.get('chronic_absence_threshold')
            if absence_val is not None:
                try:
                    lines.append(f"  Chronic absence: missing {round(float(absence_val) * 100)}%+ of school days")
                except (TypeError, ValueError):
                    pass

            severe_val = t.get('severe_absence_threshold')
            if severe_val is not None:
                try:
                    lines.append(f"  Severe absence: missing {round(float(severe_val) * 100)}%+ of school days")
                except (TypeError, ValueError):
                    pass

            susp_val = t.get('suspension_min')
            if susp_val is not None:
                try:
                    n = int(susp_val)
                    lines.append(f"  Suspensions: {n} or more suspension{'s' if n != 1 else ''}")
                except (TypeError, ValueError):
                    pass

            courses_val = t.get('academic_min_courses')
            if courses_val is not None:
                try:
                    n = int(courses_val)
                    lines.append(f"  Academic failure: failing {n} or more course{'s' if n != 1 else ''}")
                except (TypeError, ValueError):
                    pass

            course_rules = t.get('course_rules')
            if isinstance(course_rules, list) and course_rules:
                rule_labels = [
                    r.get('label') or r.get('key', '')
                    for r in course_rules
                    if isinstance(r, dict) and (r.get('label') or r.get('key'))
                ]
                if rule_labels:
                    lines.append(f"  Courses counted: {', '.join(rule_labels)}")

            if lines:
                system += (
                    '\n\nIndicator thresholds confirmed by teacher:\n'
                    + '\n'.join(lines)
                    + '\n\nCRITICAL: Always use these exact thresholds when describing indicators. '
                    'Never substitute generic defaults — for example, never say "failing at least one course" '
                    'if the threshold is 2 or more courses. Reference the teacher-confirmed values above.'
                )
        if isinstance(context, dict) and isinstance(context.get('mapping'), dict):
            mapping = context.get('mapping') or {}
            mapping_lines = []
            for role, col in mapping.items():
                if str(role).startswith('_') or role == 'text_columns':
                    continue
                if isinstance(col, list):
                    mapping_lines.append(f"  {role}: {', '.join(str(x) for x in col)}")
                else:
                    mapping_lines.append(f"  {role}: {col}")
            if mapping_lines:
                system += '\n\nVariables confirmed by teacher:\n' + '\n'.join(mapping_lines)
                system += '\n\nDo not ask the teacher to re-confirm these. Reference them by role name in responses.'

    # KB + web: prefetch URLs (caller may pass prefetched_web; cap 3 web).
    pf: list = []
    if use_web_search and kb_docs:
        if prefetched_web is not None:
            pf = list(prefetched_web or [])[:3]
        else:
            pf = _prefetch_web_sources(_last_user_text(messages))[:3]
    elif use_web_search and not kb_docs:
        pf = _prefetch_web_sources(_last_user_text(messages))[:3]

    web_for_index = pf if use_web_search else []
    source_index_rows = _build_source_index_rows(kb_docs or [], web_for_index)
    citation_block = _user_message_citation_block(source_index_rows)

    if kb_docs or (use_web_search and pf):
        system += _source_index_block(kb_docs or [], web_for_index)
    elif use_web_search and not kb_docs:
        system += _web_only_citation_hint()

    # Attach KB documents to the last user message if available
    if kb_docs:
        last_msg = messages[-1]
        content_blocks = []

        for doc in kb_docs:
            content_blocks.append({
                'type': 'document',
                'source': {
                    'type': 'file',
                    'file_id': doc['anthropic_file_id']
                },
                'title': doc['filename'].replace('_', ' ').replace('.pdf', ''),
                'citations': {'enabled': True}
            })

        user_text = last_msg['content'] if isinstance(last_msg['content'], str) else ''
        content_blocks.append({
            'type': 'text',
            'text': user_text + (citation_block if citation_block else ''),
        })

        messages = messages[:-1] + [{'role': 'user', 'content': content_blocks}]
    elif citation_block:
        last_msg = messages[-1]
        if last_msg.get('role') == 'user':
            base = last_msg['content'] if isinstance(last_msg.get('content'), str) else ''
            messages = messages[:-1] + [{'role': 'user', 'content': base + citation_block}]
    elif use_web_search and not kb_docs:
        last_u = messages[-1]
        if last_u.get('role') == 'user' and isinstance(last_u.get('content'), str):
            messages = messages[:-1] + [{
                'role': 'user',
                'content': last_u['content'] + '\n\n(Cite [n] inline only for web sources you actually use.)',
            }]

    # SEL single-tab artifact JSON is large; give extra headroom vs default chat
    is_sel = bool(
        context
        and isinstance(context, dict)
        and (context.get("sel") is not None or "sel" in str(context).lower())
    )
    if kb_docs or use_web_search:
        max_out = 4096
    elif is_sel:
        max_out = 6000
    else:
        max_out = 4000

    _log.info(
        "stream_response: max_tokens=%s is_sel=%s kb_docs=%s use_web_search=%s user_preview=%r",
        max_out,
        is_sel,
        bool(kb_docs),
        use_web_search,
        (_last_user_text(messages) or "")[:120],
    )

    kwargs = {
        "model": "claude-sonnet-4-6",
        "max_tokens": max_out,
        "system": system,
        "messages": messages,
    }
    if kb_docs:
        kwargs["betas"] = ["files-api-2025-04-14"]
    # If we prefetched web URLs, skip attaching web_search tool again (avoids duplicate searches).
    if use_web_search and not (kb_docs and pf):
        kwargs["tools"] = [{"type": "web_search_20250305", "name": "web_search"}]

    # Web search: non-streaming call so we can read tool/citation blocks for source URLs
    if use_web_search:
        create_kwargs = {**kwargs, "stream": False}
        max_retries = 3
        retry_delay = 2.0
        response = None
        for attempt in range(max_retries):
            try:
                if kb_docs:
                    response = client.beta.messages.create(**create_kwargs)
                else:
                    response = client.messages.create(**create_kwargs)
                break
            except OverloadedError:
                if attempt < max_retries - 1:
                    _log.warning(
                        "stream_response (web): Anthropic overloaded, retrying in %ss (attempt %s/%s)",
                        retry_delay,
                        attempt + 1,
                        max_retries,
                    )
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    yield "Anthropic is temporarily busy. Please try again in a moment."
                    return

        text_parts: list[str] = []
        for block in response.content:
            if getattr(block, "type", None) == "text":
                text_parts.append(block.text)
        full_text = "".join(text_parts)
        for char in full_text:
            yield char

        # KB+web: emit the same ordered list as SOURCE INDEX (pf) so pill [n] matches the prompt.
        if kb_docs:
            if pf:
                yield f"\n\n__WEB_SOURCES__{json.dumps(pf)}__END_SOURCES__"
        else:
            extracted = _extract_web_sources_from_response(response)
            web_sources = _merge_web_sources(pf, extracted)
            if web_sources:
                yield f"\n\n__WEB_SOURCES__{json.dumps(web_sources)}__END_SOURCES__"
        return

    max_retries = 3
    retry_delay = 2.0
    for attempt in range(max_retries):
        try:
            if kb_docs:
                stream_ctx = client.beta.messages.stream(**kwargs)
            else:
                stream_ctx = client.messages.stream(**kwargs)
            with stream_ctx as stream:
                for text in stream.text_stream:
                    yield text
            break
        except OverloadedError:
            if attempt < max_retries - 1:
                _log.warning(
                    "stream_response: Anthropic overloaded, retrying in %ss (attempt %s/%s)",
                    retry_delay,
                    attempt + 1,
                    max_retries,
                )
                await asyncio.sleep(retry_delay)
                retry_delay *= 2
            else:
                yield "Anthropic is temporarily busy. Please try again in a moment."


def _build_artifact_messages(
    prompt_text: str,
    kb_docs: list | None = None,
    prefetched_web: list | None = None,
    use_web_search: bool = False,
) -> tuple[list, dict]:
    """User turn for artifact generation with optional KB attachments and source index."""
    citation_rows = _build_source_index_rows(kb_docs or [], (prefetched_web or [])[:3] if use_web_search else [])
    citation_block = _user_message_citation_block(citation_rows)
    extra = _source_index_block(kb_docs or [], (prefetched_web or [])[:3] if use_web_search else [])
    full_prompt = prompt_text + (extra or "")
    if citation_block:
        full_prompt += citation_block

    if kb_docs:
        content_blocks: list = []
        for doc in kb_docs:
            content_blocks.append({
                "type": "document",
                "source": {"type": "file", "file_id": doc["anthropic_file_id"]},
                "title": (doc.get("filename") or "Document").replace("_", " ").replace(".pdf", ""),
                "citations": {"enabled": True},
            })
        content_blocks.append({"type": "text", "text": full_prompt})
        return [{"role": "user", "content": content_blocks}], {"betas": ["files-api-2025-04-14"]}

    return [{"role": "user", "content": full_prompt}], {}


def generate_artifact(
    artifact_type: str,
    context: dict,
    *,
    user_message: str | None = None,
    kb_docs: list | None = None,
    prefetched_web: list | None = None,
    use_web_search: bool = False,
) -> dict:
    """Generate action plan, agenda, or report from conversation context and optional KB/web sources."""
    ctx = context if isinstance(context, dict) else {}
    if user_message:
        ctx = {**ctx, "teacher_question": user_message}
    base = f"Context about the students and analysis:\n{json.dumps(_json_safe_for_llm(ctx), indent=2)}\n\n"

    ctx_block = (
        "Context: " + json.dumps(ctx, indent=2)
        if ctx
        else "No specific data provided — generate a general template."
    )
    report_prompt = f"""Generate a concise but complete summary report based on this student risk analysis and conversation.
{ctx_block}

Requirements:
- Use the whole context, including conversation_snapshot and report_items when provided.
- Summarize the progression of the conversation (what was asked, what was analyzed, what decisions emerged).
- Include the key charts/graphs and tables that were used or generated in the conversation.
- If chart/table details are present in context, reference them concretely (names/types/what they showed).
- Keep language school-leader friendly and specific with numbers when available.

Return ONLY valid JSON, no markdown, no explanation:
{{
  "title": "Student Risk Analysis Report",
  "date": "April 2026",
  "summary": "2-3 sentence executive summary of the key findings",
  "conversation_summary": [
    "1-2 bullets summarizing major conversation moments and analysis requests"
  ],
  "visualizations_used": [
    "Chart/graph name or type and what insight it showed"
  ],
  "tables_used": [
    "Table/list name and what it showed"
  ],
  "key_findings": [
    "Finding 1 with specific numbers",
    "Finding 2 with specific numbers",
    "Finding 3 with specific numbers"
  ],
  "recommendations": [
    "Recommendation 1",
    "Recommendation 2",
    "Recommendation 3"
  ],
  "next_steps": [
    "Next step 1",
    "Next step 2"
  ]
}}"""

    source_note = ""
    if kb_docs or (use_web_search and prefetched_web):
        source_note = (
            "\nWhen SOURCE INDEX / attached documents are present, ground each action in evidence: "
            "put concise inline [n] citations in action `detail` fields where a source supports the strategy.\n"
        )

    action_plan_standard = base + source_note + """You are generating a structured 2-week action plan based on the analysis above and the teacher's question in context.

Use real student counts from context (grade, failing students, SEL gaps). Prioritize strategies that address low connectedness/caring when mentioned.

Return ONLY valid JSON (no markdown, no explanation) with this exact structure:
{
  "goal": "One specific, measurable goal sentence referencing the actual student numbers",
  "focus_group": ["18 critical risk", "42 chronically absent", "Grade 9 · Term 2"],
  "weeks": [
    {
      "week_number": 1,
      "week_label": "Week 1 · 7–11 Apr 2026",
      "theme": "Build Relationships & Gather Information",
      "actions": [
        {
          "id": "w1_1",
          "action": "Assign trusted adult contacts",
          "detail": "One consistent adult per student. See Wellbeing Framework p.7.",
          "owner": "J. Lee",
          "duration_days": 2,
          "status": "not_started",
          "done": false
        }
      ]
    },
    {
      "week_number": 2,
      "week_label": "Week 2 · 14–18 Apr 2026",
      "theme": "Deepen Support & Expand Impact",
      "actions": []
    }
  ]
}"""

    action_plan_tutoring = base + """You are generating a TIERED TUTORING PLAN based on the analysis above and any student_list in context.

The teacher asked to design a tutoring plan that prioritizes students by course-failure severity (e.g. 5+ failures first). Use real counts from context.

Return ONLY valid JSON (no markdown, no explanation) with this exact structure (same schema as a 2-week plan, but goal/focus/actions must describe tutoring tiers):
{
  "goal": "One sentence: tiered tutoring rollout prioritized by total courses failed",
  "focus_group": ["Tier 1: N students with 5+ course failures", "Tier 2: ...", "Grade if known"],
  "weeks": [
    {
      "week_number": 1,
      "week_label": "Week 1 · Tutoring launch",
      "theme": "Tier 1 — highest course failures (intensive small-group / 1:1)",
      "actions": [
        {
          "id": "t1_1",
          "action": "Launch Tier 1 tutoring sessions",
          "detail": "Specific to students at top of the prioritized list; reference failure counts from data.",
          "owner": "Counselor / teacher lead",
          "duration_days": 5,
          "status": "not_started",
          "done": false
        }
      ]
    },
    {
      "week_number": 2,
      "week_label": "Week 2 · Expand tiers",
      "theme": "Tier 2–3 — moderate failures and monitoring",
      "actions": []
    }
  ]
}"""

    action_plan_body = (
        action_plan_tutoring
        if ctx.get("plan_variant") == "tutoring_tiers"
        else action_plan_standard
    )

    prompts = {
        "action_plan": action_plan_body,

        "agenda": base + """Generate a meeting agenda for a student support team meeting based on the analysis above.

Return ONLY valid JSON (no markdown, no explanation) in this format:
{
  "title": "Meeting title",
  "date_suggestion": "Thursday 10 Apr 2026",
  "time": "9:00 – 10:00 am",
  "location": "Room 214",
  "purpose": "One sentence describing the meeting purpose",
  "attendees": ["J. Lee", "S. Ran", "Mk Kim"],
  "items": [
    {
      "time": "9:00",
      "title": "Item title",
      "detail": "Brief description of what will be covered",
      "duration_min": 20,
      "lead": "J. Lee"
    }
  ]
}""",

        "report": report_prompt,
    }

    if artifact_type not in prompts:
        return {"error": f"Unknown artifact type: {artifact_type}"}

    _log.info(
        "generate_artifact: start type=%s context_keys=%s kb_docs=%s web=%s",
        artifact_type,
        list(ctx.keys())[:30],
        bool(kb_docs),
        use_web_search,
    )

    messages, extra_kwargs = _build_artifact_messages(
        prompts[artifact_type],
        kb_docs=kb_docs,
        prefetched_web=prefetched_web,
        use_web_search=use_web_search,
    )

    max_retries = 3
    retry_delay = 2
    text = ""
    for attempt in range(max_retries):
        try:
            create_kwargs = {
                "model": "claude-sonnet-4-6" if (kb_docs or use_web_search) else "claude-haiku-4-5-20251001",
                "max_tokens": 2500 if artifact_type == "action_plan" else 2000,
                "messages": messages,
            }
            create_kwargs.update(extra_kwargs)
            if use_web_search and not kb_docs:
                create_kwargs["tools"] = [{"type": "web_search_20250305", "name": "web_search"}]
            if kb_docs:
                response = client.beta.messages.create(**create_kwargs)
            else:
                response = client.messages.create(**create_kwargs)
            text_parts: list[str] = []
            for block in response.content:
                if getattr(block, "type", None) == "text":
                    text_parts.append(block.text)
            text = "".join(text_parts).strip()
            break
        except OverloadedError:
            if attempt < max_retries - 1:
                _log.warning(
                    "generate_artifact: Anthropic overloaded, retrying in %ss (attempt %s/%s)",
                    retry_delay,
                    attempt + 1,
                    max_retries,
                )
                time.sleep(retry_delay)
                retry_delay *= 2
            else:
                raise

    _log.info("generate_artifact: done type=%s raw_len=%s", artifact_type, len(text))

    try:
        # Strip any accidental markdown fences
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        start = text.find('{')
        end = text.rfind('}') + 1
        return json.loads(text[start:end])
    except Exception as e:
        return {"error": f"Could not parse artifact: {str(e)}", "raw": text}