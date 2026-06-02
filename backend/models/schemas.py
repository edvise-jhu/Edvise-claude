from pydantic import BaseModel
from typing import Optional, Any
from uuid import UUID
from datetime import datetime


class UserProfile(BaseModel):
    id: UUID
    email: Optional[str]
    name: Optional[str]
    role: str = "teacher"
    school_name: Optional[str]
    created_at: Optional[datetime]


class ConversationCreate(BaseModel):
    title: Optional[str] = None


class ConversationResponse(BaseModel):
    id: UUID
    user_id: UUID
    title: Optional[str]
    created_at: datetime
    updated_at: datetime


class MessageCreate(BaseModel):
    conversation_id: UUID
    role: str
    content: str
    metadata: Optional[dict] = None


class MessageResponse(BaseModel):
    id: UUID
    conversation_id: UUID
    role: str
    content: str
    metadata: Optional[dict]
    created_at: datetime


class DataFileResponse(BaseModel):
    id: UUID
    user_id: UUID
    filename: str
    file_path: Optional[str]
    file_type: Optional[str]
    row_count: Optional[int]
    variable_mapping: Optional[dict]
    status: str
    created_at: datetime


class ActionPlanCreate(BaseModel):
    conversation_id: Optional[UUID] = None
    title: str
    goal: str
    focus_group: list
    weeks: list


class MeetingAgendaCreate(BaseModel):
    conversation_id: Optional[UUID] = None
    title: str
    date: Optional[datetime] = None
    location: Optional[str] = None
    attendees: Optional[list] = None
    purpose: Optional[str] = None
    items: Optional[list] = None


class ArtifactRequest(BaseModel):
    artifact_type: str  # "action_plan" | "agenda" | "report"
    context: dict
    conversation_id: Optional[str] = None
