import anthropic
import os
import pypdf
import io
import json
from typing import Optional
import pandas as pd
from docx import Document as DocxDocument

from services.supabase_service import get_supabase

client = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))


def _file_ext(filename: str) -> str:
    if not filename or '.' not in filename:
        return ''
    return filename.rsplit('.', 1)[-1].lower()


async def ingest_document(
    content: bytes,
    filename: str,
    scope: str,
    school_name: str = None,
    uploaded_by: Optional[str] = None,
    category: Optional[str] = None,
) -> dict:
    supabase = get_supabase()
    ext = _file_ext(filename)
    file_type = ext if ext in ('pdf', 'docx', 'xlsx', 'xls', 'csv') else ext

    def _extract_text_preview_non_pdf(raw: bytes, raw_ext: str) -> str:
        try:
            if raw_ext == 'docx':
                doc = DocxDocument(io.BytesIO(raw))
                text = "\n".join([p.text for p in doc.paragraphs if p.text]).strip()
                if not text:
                    text = filename
                return text[:12000]
            if raw_ext == 'csv':
                df = pd.read_csv(io.BytesIO(raw))
                return df.head(120).to_csv(index=False)[:12000]
            if raw_ext in ('xlsx', 'xls'):
                df = pd.read_excel(io.BytesIO(raw))
                return df.head(120).to_csv(index=False)[:12000]
        except Exception:
            pass
        return filename

    # Non-PDF: extract text and upload as plain text to Anthropic Files when possible.
    if ext != 'pdf':
        preview_text = _extract_text_preview_non_pdf(content, ext)
        tags = []
        try:
            tag_response = client.messages.create(
                model='claude-haiku-4-5-20251001',
                max_tokens=180,
                messages=[{
                    'role': 'user',
                    'content': f'''Read this document excerpt and return a JSON array of 5-10 search tags.
Return ONLY a valid JSON array.

Document excerpt:
{preview_text}'''
                }]
            )
            tags_text = tag_response.content[0].text.strip()
            start = tags_text.find('[')
            end = tags_text.rfind(']') + 1
            tags = json.loads(tags_text[start:end]) if start != -1 else []
        except Exception:
            tags = []

        anthropic_file_id = None
        try:
            stem = filename.rsplit('.', 1)[0]
            txt_name = f"{stem}.txt"
            uploaded = client.beta.files.upload(
                file=(txt_name, preview_text.encode('utf-8', errors='ignore'), 'text/plain'),
                betas=['files-api-2025-04-14'],
            )
            anthropic_file_id = uploaded.id
        except Exception:
            anthropic_file_id = None

        result = supabase.table('kb_documents').insert({
            'filename': filename,
            'scope': scope,
            'school_name': school_name,
            'status': 'pending',
            'anthropic_file_id': anthropic_file_id,
            'tags': tags,
            'uploaded_by': uploaded_by,
            'file_type': file_type,
            'category': category,
        }).execute()
        row = result.data[0] if result.data else {}
        return {
            'document_id': row.get('id'),
            'filename': filename,
            'anthropic_file_id': anthropic_file_id,
            'tags': tags,
            'status': 'pending',
            'file_type': file_type,
        }

    # PDF: upload to Anthropic Files API
    uploaded = client.beta.files.upload(
        file=(filename, content, 'application/pdf'),
        betas=['files-api-2025-04-14'],
    )

    try:
        reader = pypdf.PdfReader(io.BytesIO(content))
        preview_text = ''
        for page in reader.pages[:2]:
            preview_text += page.extract_text() or ''
        preview_text = preview_text[:2000]
    except Exception:
        preview_text = filename

    try:
        tag_response = client.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=200,
            messages=[{
                'role': 'user',
                'content': f'''Read this document excerpt and return a JSON array of 5-10 search tags.
Tags should cover: student risk types targeted (chronic absence, suspensions, academic failure),
intervention strategies, SEL factors addressed, grade levels, implementation approach.
Return ONLY a valid JSON array like: ["chronic absence", "family outreach", "tier 2", "middle school", "attendance"]

Document excerpt:
{preview_text}'''
            }]
        )
        tags_text = tag_response.content[0].text.strip()
        start = tags_text.find('[')
        end = tags_text.rfind(']') + 1
        tags = json.loads(tags_text[start:end]) if start != -1 else []
    except Exception:
        tags = []

    existing = supabase.table('kb_documents').select('tags, filename').eq('status', 'approved').execute()
    existing_docs = existing.data or []

    max_similarity = 0.0
    if existing_docs and tags:
        new_tag_set = set(t.lower() for t in tags)
        for existing_doc in existing_docs:
            existing_tags = set(t.lower() for t in (existing_doc.get('tags') or []))
            if existing_tags:
                uni = new_tag_set | existing_tags
                overlap = len(new_tag_set & existing_tags) / len(uni) if uni else 0.0
                max_similarity = max(max_similarity, overlap)

    auto_approve = scope == 'global' or max_similarity > 0.25
    status = 'approved' if auto_approve else 'pending'

    result = supabase.table('kb_documents').insert({
        'filename': filename,
        'scope': scope,
        'school_name': school_name,
        'status': status,
        'anthropic_file_id': uploaded.id,
        'tags': tags,
        'uploaded_by': uploaded_by,
        'file_type': 'pdf',
        'category': category,
    }).execute()

    row = result.data[0] if result.data else {}
    return {
        'document_id': row.get('id'),
        'filename': filename,
        'anthropic_file_id': uploaded.id,
        'tags': tags,
        'status': status,
        'file_type': 'pdf',
        'similarity': max_similarity,
    }


def _normalize_scopes(scope: str) -> set[str]:
    raw = (scope or 'global').lower()
    out = set()
    for p in [x.strip() for x in raw.split(',') if x.strip()]:
        if p in {'student_success', 'global'}:
            out.add('global')
        elif p == 'school':
            out.add('school')
    return out or {'global'}


async def search_knowledge_base(
    query: str,
    scope: str = 'global',
    top_k: int = 5,
    include_pending_school: bool = False,
) -> list:
    supabase = get_supabase()

    result = supabase.table('kb_documents').select('*').execute()

    allowed_scopes = _normalize_scopes(scope)
    docs = []
    for d in (result.data or []):
        if not d.get('anthropic_file_id'):
            continue
        if d.get('scope') not in allowed_scopes:
            continue
        status = (d.get('status') or '').lower()
        if status == 'approved':
            docs.append(d)
            continue
        # Optional: allow school pending docs for chat drafting before admin approval.
        if include_pending_school and d.get('scope') == 'school' and status == 'pending':
            docs.append(d)
    if not docs:
        return []

    # Score each document by tag + filename match
    query_words = set(query.lower().replace('?', '').replace(',', '').replace("'", '').split())

    scored = []
    for doc in docs:
        # Match against Claude-generated tags
        tag_words = set(' '.join(doc.get('tags') or []).lower().split())
        tag_score = len(query_words & tag_words)

        # Also match against filename as fallback
        name_words = set(doc['filename'].lower().replace('_', ' ').replace('-', ' ').replace('.pdf', '').split())
        name_score = len(query_words & name_words) * 0.5

        total_score = tag_score + name_score
        scored.append((total_score, doc))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Only return docs with score > 0 when possible; otherwise fallback to top 3 so KB is still consulted.
    matched = [(s, d) for s, d in scored if s > 0]
    if not matched:
        matched = scored[:3]

    return [doc for _, doc in matched[:top_k]]


async def delete_document(anthropic_file_id: str) -> bool:
    try:
        client.beta.files.delete(anthropic_file_id, betas=['files-api-2025-04-14'])
        return True
    except Exception:
        return False


def read_approved_kb_pdf(document_id: str) -> tuple[bytes, str]:
    """Load PDF bytes from Anthropic Files for an approved kb_documents row."""
    supabase = get_supabase()
    result = (
        supabase.table('kb_documents')
        .select('anthropic_file_id, filename, status')
        .eq('id', document_id)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    if not rows:
        raise ValueError('Document not found')
    row = rows[0]
    if row.get('status') != 'approved':
        raise ValueError('Document is not available')
    fid = row.get('anthropic_file_id')
    if not fid:
        raise ValueError('No PDF file for this document')
    bio = client.beta.files.download(fid, betas=['files-api-2025-04-14'])
    content = bio.read()
    fn = row.get('filename') or 'document.pdf'
    return content, fn
