from typing import Optional

from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from services.supabase_service import get_supabase_anon, get_supabase

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class SignupRequest(BaseModel):
    email: str
    password: str
    name: str
    school_name: str


@router.post("/login")
async def login(req: LoginRequest):
    """Sign in with email and password."""
    supabase = get_supabase_anon()
    try:
        result = supabase.auth.sign_in_with_password({
            "email": req.email,
            "password": req.password,
        })
        return {
            "access_token": result.session.access_token,
            "user": {
                "id": result.user.id,
                "email": result.user.email,
            }
        }
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))


@router.post("/signup")
async def signup(req: SignupRequest):
    """Create a new teacher account."""
    supabase = get_supabase_anon()
    try:
        result = supabase.auth.sign_up({
            "email": req.email,
            "password": req.password,
        })

        if result.user:
            # Create profile record
            get_supabase().table("profiles").insert({
                "id": result.user.id,
                "email": req.email,
                "name": req.name,
                "school_name": req.school_name,
                "role": "teacher",
            }).execute()

        return {"message": "Account created. Check your email to confirm."}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/me")
async def me(authorization: Optional[str] = Header(None)):
    """Get current user profile."""
    from services.supabase_service import get_current_user
    user = await get_current_user(authorization)
    supabase = get_supabase()
    profile = supabase.table("profiles").select("*").eq("id", user["id"]).single().execute()
    return profile.data
