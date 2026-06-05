import httpx
from fastapi import APIRouter, UploadFile, File, HTTPException, Header, Query
from fastapi.responses import Response
from postgrest.exceptions import APIError
from pydantic import BaseModel
from typing import Optional

from services.vector_service import (
    ingest_document,
    search_knowledge_base,
    read_approved_kb_pdf,
    delete_document as delete_anthropic_kb_file,
)

_ADMIN_EMAIL = "edvisejhu@gmail.com"


async def _require_admin(authorization: Optional[str]) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    from services.supabase_service import get_current_user

    user = await get_current_user(authorization)
    if (user.get("email") or "").lower() != _ADMIN_EMAIL.lower():
        raise HTTPException(status_code=403, detail="Admin only")
    return user

router = APIRouter()

_INVALID_KEY_HINT = (
    "Supabase rejected the API key. In backend/.env set SUPABASE_SERVICE_KEY to the "
    "service_role JWT or Secret (sb_secret_…) from Project Settings → API (same project as SUPABASE_URL). "
    "Restart uvicorn after changing .env."
)


def _raise_if_invalid_key(exc: APIError) -> None:
    text = f"{exc.message or ''} {exc.details or ''} {exc}"
    if "Invalid API key" in text or str(exc.code) == "401":
        raise HTTPException(status_code=401, detail=_INVALID_KEY_HINT) from exc


_MISSING_TABLE_HINT = (
    "Table public.kb_documents does not exist in this Supabase project. "
    "Open Supabase → SQL Editor and run the script in supabase/migrations/001_kb_documents.sql "
    "(then retry the upload)."
)


def _raise_if_missing_kb_table(exc: APIError) -> None:
    if exc.code == "PGRST205" or (exc.message and "Could not find the table" in exc.message):
        raise HTTPException(status_code=503, detail=_MISSING_TABLE_HINT) from exc


_ALLOWED_EXT = ('.pdf', '.docx', '.xlsx', '.csv', '.xls')


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    scope: str = "school",
    school_name: Optional[str] = None,
    authorization: Optional[str] = Header(None),
):
    """Upload a document to the knowledge base (PDFs go to Anthropic Files API + tags)."""
    name = (file.filename or '').lower()
    if not any(name.endswith(ext) for ext in _ALLOWED_EXT):
        raise HTTPException(
            status_code=400,
            detail=f"Allowed types: {', '.join(_ALLOWED_EXT)}",
        )

    uploaded_by = None
    user_email = None
    if authorization and authorization.startswith('Bearer '):
        try:
            from services.supabase_service import get_current_user, get_supabase
            user = await get_current_user(authorization)
            uploaded_by = user['id']
            user_email = user.get('email')
            # FK kb_documents.uploaded_by -> profiles.id — ensure row exists
            try:
                supabase = get_supabase()
                supabase.table('profiles').upsert(
                    {'id': uploaded_by, 'email': user_email},
                    on_conflict='id',
                ).execute()
            except APIError:
                pass
        except HTTPException:
            pass

    content = await file.read()
    try:
        result = await ingest_document(
            content,
            file.filename,
            scope,
            school_name,
            uploaded_by=uploaded_by,
        )
    except httpx.ConnectError as e:
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot reach Supabase. Check SUPABASE_URL in backend/.env and your network. "
                "If you use a proxy, set SUPABASE_HTTPX_TRUST_ENV=true in backend/.env. "
                "If you do not need a proxy, unset HTTP_PROXY and HTTPS_PROXY in your shell (broken proxy values cause this error)."
            ),
        ) from e
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise
    return result


@router.get("/documents/{document_id}/pdf")
async def download_kb_pdf(document_id: str, authorization: Optional[str] = Header(None)):
    """Stream an approved KB PDF (Anthropic file) for authenticated users."""
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Authentication required')
    try:
        from services.supabase_service import get_current_user
        await get_current_user(authorization)
    except HTTPException:
        raise
    try:
        content, filename = read_approved_kb_pdf(document_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    safe = (filename or 'document.pdf').replace('"', '')
    return Response(
        content=content,
        media_type='application/pdf',
        headers={'Content-Disposition': f'inline; filename="{safe}"'},
    )


@router.get("/documents/{document_id}/download")
async def download_kb_attachment(document_id: str, authorization: Optional[str] = Header(None)):
    """Download an approved KB PDF as an attachment (same bytes as /pdf)."""
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Authentication required')
    try:
        from services.supabase_service import get_current_user
        await get_current_user(authorization)
    except HTTPException:
        raise
    try:
        content, filename = read_approved_kb_pdf(document_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    safe = (filename or 'document.pdf').replace('"', '')
    return Response(
        content=content,
        media_type='application/pdf',
        headers={'Content-Disposition': f'attachment; filename="{safe}"'},
    )


@router.patch("/documents/{doc_id}/approve")
async def approve_document(doc_id: str, authorization: Optional[str] = Header(None)):
    """Approve a pending school KB document (admin only)."""
    await _require_admin(authorization)
    from services.supabase_service import get_supabase

    supabase = get_supabase()
    try:
        supabase.table('kb_documents').update({'status': 'approved'}).eq('id', doc_id).execute()
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise
    return {'status': 'approved'}


@router.delete("/documents/{doc_id}")
async def remove_kb_document(doc_id: str, authorization: Optional[str] = Header(None)):
    """Delete a KB row and its Anthropic file. Global: admin only. School: uploader or admin."""
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Authentication required')
    from services.supabase_service import get_current_user, get_supabase

    user = await get_current_user(authorization)
    is_admin = (user.get('email') or '').lower() == _ADMIN_EMAIL.lower()
    supabase = get_supabase()
    try:
        sel = (
            supabase.table('kb_documents')
            .select('id, scope, uploaded_by, anthropic_file_id')
            .eq('id', doc_id)
            .limit(1)
            .execute()
        )
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise
    rows = sel.data or []
    if not rows:
        raise HTTPException(status_code=404, detail='Document not found')
    doc = rows[0]
    if doc.get('scope') == 'global':
        if not is_admin:
            raise HTTPException(status_code=403, detail='Admin only')
    elif not is_admin and doc.get('uploaded_by') != user.get('id'):
        raise HTTPException(status_code=403, detail='Not allowed')
    fid = doc.get('anthropic_file_id')
    if fid:
        try:
            await delete_anthropic_kb_file(fid)
        except Exception:
            pass
    try:
        supabase.table('kb_documents').delete().eq('id', doc_id).execute()
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise
    return {'deleted': True}


def _annotate_docs_with_uploaders(supabase, docs: list) -> None:
    user_ids = list({d.get('uploaded_by') for d in docs if d.get('uploaded_by')})
    email_map = {}
    if user_ids:
        try:
            profs = (
                supabase.table('profiles')
                .select('id,email')
                .in_('id', user_ids)
                .execute()
            )
            email_map = {p['id']: (p.get('email') or '') for p in (profs.data or [])}
        except APIError:
            pass
    for doc in docs:
        fn = doc.get('filename') or ''
        ext = fn.rsplit('.', 1)[-1].lower() if '.' in fn else ''
        if not doc.get('file_type'):
            doc['file_type'] = ext
        uid = doc.get('uploaded_by')
        doc['uploaded_by_email'] = email_map.get(uid, '') if uid else ''


@router.get("/documents")
async def list_documents(
    scope: str = Query('school'),
    authorization: Optional[str] = Header(None),
):
    """List kb_documents. Default: school (My Library). scope=global requires admin JWT."""
    from services.supabase_service import get_supabase

    supabase = get_supabase()
    want = (scope or 'school').lower()
    if want == 'global':
        await _require_admin(authorization)
        try:
            result = (
                supabase.table('kb_documents')
                .select('*')
                .eq('scope', 'global')
                .order('created_at', desc=True)
                .execute()
            )
        except APIError as e:
            _raise_if_invalid_key(e)
            _raise_if_missing_kb_table(e)
            raise
        docs = list(result.data or [])
        _annotate_docs_with_uploaders(supabase, docs)
        return docs

    # School scope — require auth and filter to current user only
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(status_code=401, detail='Authentication required')
    from services.supabase_service import get_current_user

    user = await get_current_user(authorization)
    user_id = user['id']

    try:
        result = (
            supabase.table('kb_documents')
            .select('*')
            .eq('scope', 'school')
            .eq('uploaded_by', user_id)
            .order('created_at', desc=True)
            .execute()
        )
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise

    docs = list(result.data or [])
    _annotate_docs_with_uploaders(supabase, docs)
    return docs


class SearchRequest(BaseModel):
    query: str
    scope: str = "global"
    top_k: int = 5


@router.post("/search")
async def search(req: SearchRequest):
    """Search the knowledge base with a query."""
    try:
        results = await search_knowledge_base(req.query, req.scope, req.top_k)
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise
    return {"results": results}


@router.get("/pending-count")
async def pending_count(authorization: Optional[str] = Header(None)):
    from services.supabase_service import get_supabase, get_current_user
    try:
        supabase = get_supabase()
        user_id = None
        if authorization and authorization.startswith('Bearer '):
            try:
                user = await get_current_user(authorization)
                user_id = user['id']
            except HTTPException:
                pass
        query = (
            supabase.table("kb_documents")
            .select("id", count="exact")
            .eq("scope", "school")
            .eq("status", "pending")
        )
        if user_id:
            query = query.eq("uploaded_by", user_id)
        result = query.execute()
    except APIError as e:
        _raise_if_invalid_key(e)
        _raise_if_missing_kb_table(e)
        raise
    cnt = getattr(result, "count", None)
    if cnt is None and result.data is not None:
        cnt = len(result.data)
    return {"count": cnt or 0}
