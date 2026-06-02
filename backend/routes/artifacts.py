import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from typing import Optional
from postgrest.exceptions import APIError

from services.claude_service import generate_artifact
from services.source_retrieval import gather_sources
from services.supabase_service import get_supabase, get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()


def _is_missing_artifact_table(exc: APIError) -> bool:
    """PostgREST PGRST205: table not in schema cache (migration not applied)."""
    if exc.code == "PGRST205":
        return True
    msg = (exc.message or "").lower()
    return "schema cache" in msg and "could not find the table" in msg


ARTIFACT_TABLES_NOT_READY_DETAIL = (
    "Artifact tables are not set up in Supabase. Run the SQL in "
    "supabase/migrations/004_action_plans_artifacts.sql in the Supabase SQL editor, "
    "then reload the schema (or wait for PostgREST cache refresh)."
)


class ArtifactRequest(BaseModel):
    artifact_type: str  # "action_plan" | "agenda" | "report"
    context: dict
    conversation_id: Optional[str] = None
    user_id: Optional[str] = None
    message: Optional[str] = None  # teacher question (drives KB/web retrieval)
    kb_scope: Optional[str] = None  # enabled sources, e.g. "student_success,school,web"


class SaveArtifactRequest(BaseModel):
    artifact_type: str  # "action_plan" | "agenda" | "report"
    data: dict
    conversation_id: Optional[str] = None
    id: Optional[str] = None  # when set, update this row instead of inserting


@router.post("/generate")
async def generate(req: ArtifactRequest):
    """Generate an artifact (action plan, agenda, or report) from context."""
    if req.artifact_type not in ("action_plan", "agenda", "report"):
        raise HTTPException(status_code=400, detail="artifact_type must be action_plan, agenda, or report")

    message = (req.message or "").strip()
    if not message:
        focus = (req.context or {}).get("action_plan_focus") or (req.context or {}).get("focus_group")
        if isinstance(focus, str):
            message = focus.strip()
        elif isinstance(focus, list) and focus:
            message = str(focus[0])

    gathered = await gather_sources(message or "intervention plan", req.kb_scope)
    result = generate_artifact(
        req.artifact_type,
        req.context,
        user_message=message or None,
        kb_docs=gathered["kb_docs"],
        prefetched_web=gathered["prefetched_web"],
        use_web_search=gathered["use_web_search"],
    )
    if isinstance(result, dict) and "error" not in result:
        result["sources"] = gathered["sources_ui"]
    return result


@router.post("/save")
async def save_artifact(
    req: SaveArtifactRequest,
    authorization: Optional[str] = Header(None),
):
    """Persist a generated artifact to Supabase (service role insert; RLS applies to client reads)."""
    if req.artifact_type not in ("action_plan", "agenda", "report"):
        raise HTTPException(status_code=400, detail="artifact_type must be action_plan, agenda, or report")

    user = await get_current_user(authorization)
    supabase = get_supabase()

    table = (
        "action_plans"
        if req.artifact_type == "action_plan"
        else "meeting_agendas"
        if req.artifact_type == "agenda"
        else "reports"
    )

    raw_title = (
        req.data.get("goal")
        or req.data.get("title")
        or "Untitled"
    )
    title = (raw_title if isinstance(raw_title, str) else str(raw_title))[:200]

    try:
        if req.id:
            result = (
                supabase.table(table)
                .update({
                    "title": title,
                    "data": req.data,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                })
                .eq("id", req.id)
                .eq("user_id", user["id"])
                .execute()
            )
            rows = result.data or []
            if not rows:
                raise HTTPException(status_code=404, detail="Artifact not found")
            return rows[0]
        result = (
            supabase.table(table)
            .insert({
                "user_id": user["id"],
                "title": title,
                "data": req.data,
            })
            .execute()
        )
    except HTTPException:
        raise
    except APIError as e:
        if _is_missing_artifact_table(e):
            logger.warning("save_artifact: %s", e.message)
            raise HTTPException(status_code=503, detail=ARTIFACT_TABLES_NOT_READY_DETAIL)
        raise

    return result.data[0] if result.data else {}


def _artifact_table(artifact_type: str) -> str:
    if artifact_type == "action_plan":
        return "action_plans"
    if artifact_type == "agenda":
        return "meeting_agendas"
    if artifact_type == "report":
        return "reports"
    raise HTTPException(status_code=400, detail="artifact_type must be action_plan, agenda, or report")


@router.get("/list/{artifact_type}")
async def list_artifacts(artifact_type: str, authorization: Optional[str] = Header(None)):
    """List saved artifacts for the authenticated user."""
    table = _artifact_table(artifact_type)
    user = await get_current_user(authorization)
    supabase = get_supabase()
    try:
        result = (
            supabase.table(table)
            .select("*")
            .eq("user_id", user["id"])
            .order("created_at", desc=True)
            .execute()
        )
    except APIError as e:
        if _is_missing_artifact_table(e):
            logger.warning("list_artifacts: %s — returning empty list until migration is applied", e.message)
            return []
        raise
    return result.data or []


@router.get("/{artifact_type}/{artifact_id}")
async def get_artifact(
    artifact_type: str,
    artifact_id: str,
    authorization: Optional[str] = Header(None),
):
    """Fetch one saved artifact; must belong to the authenticated user."""
    table = _artifact_table(artifact_type)
    user = await get_current_user(authorization)
    supabase = get_supabase()
    try:
        result = (
            supabase.table(table)
            .select("*")
            .eq("id", artifact_id)
            .eq("user_id", user["id"])
            .single()
            .execute()
        )
    except APIError as e:
        if _is_missing_artifact_table(e):
            logger.warning("get_artifact: %s", e.message)
            raise HTTPException(status_code=503, detail=ARTIFACT_TABLES_NOT_READY_DETAIL)
        raise
    if not result.data:
        raise HTTPException(status_code=404, detail="Not found")
    return result.data
