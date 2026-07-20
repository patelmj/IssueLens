from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.triage import service

router = APIRouter(tags=["triage"])


class MissingItem(BaseModel):
    id: str
    label: str


class InboxItem(BaseModel):
    id: int
    number: int
    title: str
    repo_full_name: str
    issue_type: str
    component: str | None
    readiness_score: int
    missing: list[MissingItem]
    suggestion_status: str | None


class InboxPage(BaseModel):
    items: list[InboxItem]
    total: int
    limit: int
    offset: int


@router.get("/triage/inbox", response_model=InboxPage)
async def triage_inbox(
    session: AsyncSession = Depends(get_session),
    repo_id: int | None = None,
    issue_type: str | None = Query(None, alias="type"),
    threshold: int = Query(80, ge=1, le=100),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> InboxPage:
    items, total = await service.inbox(
        session, repo_id, issue_type, threshold, limit, offset
    )
    return InboxPage(items=items, total=total, limit=limit, offset=offset)
