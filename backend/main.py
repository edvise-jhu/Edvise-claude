from pathlib import Path
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os

# Always load backend/.env even when uvicorn is started from the repo root.
# override=True: a blank SUPABASE_URL in the shell must not block values from .env
_env_file = Path(__file__).resolve().parent / ".env"
load_dotenv(_env_file, override=True)

# Ensure edvise.chat INFO logs appear (root logger often defaults to WARNING under uvicorn).
_chat_logger = logging.getLogger("edvise.chat")
_chat_logger.setLevel(logging.INFO)
if not _chat_logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(levelname)s [edvise.chat] %(message)s"))
    _chat_logger.addHandler(_h)
_chat_logger.propagate = False

from routes import auth, chat, analysis, knowledge, artifacts
from services.supabase_service import supabase_connectivity_report


def _cors_allow_origins() -> list[str]:
    """
    Origins allowed for credentialed CORS (cannot use '*' with allow_credentials=True).
    Set FRONTEND_URL to your Vercel app URL after deploy, e.g.:
      FRONTEND_URL=https://your-app.vercel.app
    Comma-separate multiple origins. Local Vite dev hosts are added automatically.
    """
    raw = os.getenv("FRONTEND_URL", "http://localhost:5173").strip()
    base = [o.strip() for o in raw.split(",") if o.strip()]
    extra: list[str] = []
    if any("localhost" in o or "127.0.0.1" in o for o in base):
        extra = ["http://localhost:5173", "http://127.0.0.1:5173"]
    merged = list(dict.fromkeys([*base, *extra]))
    return merged


app = FastAPI(title="EdVise API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/auth", tags=["auth"])
app.include_router(chat.router, prefix="/chat", tags=["chat"])
app.include_router(analysis.router, prefix="/analysis", tags=["analysis"])
app.include_router(knowledge.router, prefix="/knowledge", tags=["knowledge"])
app.include_router(artifacts.router, prefix="/artifacts", tags=["artifacts"])

@app.get("/health")
def health(): return {"status": "ok"}


@app.get("/health/supabase")
def health_supabase():
    """DNS + HTTPS probe for Supabase (hostname only; no keys returned)."""
    return supabase_connectivity_report()
