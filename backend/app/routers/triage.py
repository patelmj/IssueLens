from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import IssueSuggestion
from app.triage import service
from app.triage.diff import build_diff

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


class SuggestionOut(BaseModel):
    issue_id: int
    status: str
    base_body: str
    proposed_body: str
    missing_requirements: list[MissingItem]
    edited: bool
    diff: list[dict]
    pushed_at: datetime | None


class SuggestionPatch(BaseModel):
    proposed_body: str | None = None
    status: Literal["suggested", "rejected"] | None = None


def _to_out(sug: IssueSuggestion) -> SuggestionOut:
    return SuggestionOut(
        issue_id=sug.issue_id,
        status=sug.status,
        base_body=sug.base_body,
        proposed_body=sug.proposed_body,
        missing_requirements=sug.missing_requirements,
        edited=sug.edited,
        diff=build_diff(sug.base_body, sug.proposed_body),
        pushed_at=sug.pushed_at,
    )


@router.post("/issues/{issue_id}/suggestion", response_model=SuggestionOut)
async def generate(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> SuggestionOut:
    try:
        sug = await service.generate_suggestion(session, issue_id)
    except service.IssueNotFound:
        raise HTTPException(status_code=404, detail="Issue not found")
    except service.ReadinessRequired:
        raise HTTPException(
            status_code=409, detail="Score the issue's readiness before suggesting fixes"
        )
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)


@router.get("/issues/{issue_id}/suggestion", response_model=SuggestionOut)
async def get_one(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> SuggestionOut:
    sug = await service.get_suggestion(session, issue_id)
    if sug is None:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    return _to_out(sug)


@router.patch("/issues/{issue_id}/suggestion", response_model=SuggestionOut)
async def update(
    issue_id: int,
    patch: SuggestionPatch,
    session: AsyncSession = Depends(get_session),
) -> SuggestionOut:
    try:
        sug = await service.update_suggestion(
            session, issue_id, patch.proposed_body, patch.status
        )
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)


@router.post("/issues/{issue_id}/suggestion/push", response_model=SuggestionOut)
async def push(
    issue_id: int, session: AsyncSession = Depends(get_session)
) -> SuggestionOut:
    try:
        sug = await service.push_suggestion(session, issue_id)
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except service.GitHubWriteError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return _to_out(sug)
