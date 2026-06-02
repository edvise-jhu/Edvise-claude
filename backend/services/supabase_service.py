import os
import socket
from urllib.parse import urlparse

import httpx
from supabase import create_client, Client
from supabase.lib.client_options import SyncClientOptions
from fastapi import HTTPException, Header
from typing import Optional

_client: Optional[Client] = None
_client_fingerprint: Optional[str] = None
_httpx_sync: Optional[httpx.Client] = None


def _httpx_trust_env() -> bool:
    """If True, use HTTP(S)_PROXY from the environment. Default False avoids broken proxy DNS errors."""
    return _env("SUPABASE_HTTPX_TRUST_ENV").lower() in ("1", "true", "yes")


def _shared_httpx() -> httpx.Client:
    global _httpx_sync
    if _httpx_sync is None:
        # Match postgrest default (http2=True); trust_env=False avoids bad HTTP_PROXY DNS errors
        _httpx_sync = httpx.Client(
            trust_env=_httpx_trust_env(),
            timeout=httpx.Timeout(120.0),
            http2=True,
            follow_redirects=True,
        )
    return _httpx_sync


def supabase_connectivity_report() -> dict:
    """Diagnostics for /health/supabase — no secrets."""
    raw = _env("SUPABASE_URL")
    if not raw:
        return {"configured": False, "error": "SUPABASE_URL is empty"}
    try:
        url = _require_supabase_http_url(raw)
    except RuntimeError as e:
        return {"configured": False, "error": str(e)}
    host = urlparse(url).hostname or ""
    report: dict = {"configured": True, "host": host}
    for label, fam in (("dns_ipv4", socket.AF_INET), ("dns_ipv6", socket.AF_INET6)):
        try:
            socket.getaddrinfo(host, 443, fam, socket.SOCK_STREAM)
            report[label] = True
        except OSError as e:
            report[label] = False
            report[f"{label}_error"] = str(e)
    try:
        with httpx.Client(
            trust_env=_httpx_trust_env(),
            timeout=httpx.Timeout(15.0),
            http2=True,
            follow_redirects=True,
        ) as c:
            r = c.get(url.rstrip("/") + "/", headers={"User-Agent": "edvise-health"})
            report["https_get_status"] = r.status_code
    except Exception as e:
        report["https_error"] = f"{type(e).__name__}: {e}"
    return report


def _supabase_options() -> SyncClientOptions:
    return SyncClientOptions(httpx_client=_shared_httpx())


def _service_key() -> str:
    """Service role secret (JWT or sb_secret_…); supports common env names."""
    return (
        _env("SUPABASE_SERVICE_KEY")
        or _env("SUPABASE_SERVICE_ROLE_KEY")
        or _env("SUPABASE_SECRET_KEY")
    )


def _env(name: str) -> str:
    v = os.getenv(name)
    if v is None:
        return ""
    # Strip BOM (UTF-8 .env), quotes, whitespace
    return v.strip().strip("\ufeff").strip('"').strip("'")


def _require_supabase_http_url(url: str) -> str:
    if not url or not url.startswith("http"):
        raise RuntimeError("SUPABASE_URL must start with https://")
    parsed = urlparse(url)
    if not parsed.netloc:
        raise RuntimeError("SUPABASE_URL has no hostname — check backend/.env for typos or stray quotes.")
    return url.rstrip("/")


def get_supabase() -> Client:
    """Singleton; rebuilds client if URL or service key in env changes (no stale key after .env edit)."""
    global _client, _client_fingerprint
    url = _require_supabase_http_url(_env("SUPABASE_URL"))
    key = _service_key()
    if not key:
        raise RuntimeError(
            "SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY) is missing. "
            "Paste the service_role JWT or Secret (sb_secret_…) from Supabase → Project Settings → API."
        )
    fp = f"{url}\0{key}"
    if _client is None or _client_fingerprint != fp:
        _client = create_client(url, key, options=_supabase_options())
        _client_fingerprint = fp
    return _client


def get_supabase_anon() -> Client:
    url = _require_supabase_http_url(_env("SUPABASE_URL"))
    key = _env("SUPABASE_ANON_KEY")
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY is missing.")
    return create_client(url, key, options=_supabase_options())


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """Verify JWT and return user profile."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization header")

    token = authorization.split(" ")[1]
    supabase = get_supabase_anon()

    try:
        user = supabase.auth.get_user(token)
        if not user or not user.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        return {"id": user.user.id, "email": user.user.email}
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Auth error: {str(e)}")


async def save_message(conversation_id: str, role: str, content: str, metadata: dict = None) -> dict:
    """Save a message to the database."""
    supabase = get_supabase()
    result = supabase.table("messages").insert({
        "conversation_id": conversation_id,
        "role": role,
        "content": content,
        "metadata": metadata or {},
    }).execute()
    return result.data[0] if result.data else {}


async def get_or_create_conversation(user_id: str, conversation_id: str = None, title: str = None) -> dict:
    """Get existing conversation or create a new one."""
    supabase = get_supabase()

    if conversation_id:
        result = supabase.table("conversations").select("*").eq("id", conversation_id).execute()
        if result.data:
            return result.data[0]

    result = supabase.table("conversations").insert({
        "user_id": user_id,
        "title": title or "New Conversation",
    }).execute()
    return result.data[0]


async def get_conversation_messages(conversation_id: str) -> list:
    """Retrieve all messages for a conversation."""
    supabase = get_supabase()
    result = supabase.table("messages") \
        .select("*") \
        .eq("conversation_id", conversation_id) \
        .order("created_at") \
        .execute()
    return result.data or []
