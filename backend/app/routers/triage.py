from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.llm.ollama import make_ollama_client
from app.models import IssueSuggestion
from app.triage import drafting, service

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


class SectionOut(BaseModel):
    requirement_id: str
    heading: str
    body_md: str
    origin: Literal["ai", "scaffold"]
    model: str | None
    edited: bool
    removed: bool
    stale: bool


class SuggestionOut(BaseModel):
    issue_id: int
    status: str
    base_body: str
    proposed_body: str
    missing_requirements: list[MissingItem]
    edited: bool
    sections: list[SectionOut]
    drafted_at: datetime | None
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
        sections=sug.sections or [],
        drafted_at=sug.drafted_at,
        pushed_at=sug.pushed_at,
    )


class SectionPatch(BaseModel):
    body_md: str | None = None
    removed: bool | None = None


class SteerBody(BaseModel):
    steer: str | None = None


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


@router.post(
    "/issues/{issue_id}/suggestion/sections/{requirement_id}/regenerate",
    response_model=SuggestionOut,
)
async def regenerate_section(
    issue_id: int,
    requirement_id: str,
    body: SteerBody,
    session: AsyncSession = Depends(get_session),
) -> SuggestionOut:
    try:
        async with make_ollama_client() as ollama:
            sug = await drafting.regenerate_section(
                session, ollama, None, issue_id, requirement_id, steer=body.steer
            )
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except drafting.SectionNotFound:
        raise HTTPException(status_code=404, detail="No such section")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)


@router.patch(
    "/issues/{issue_id}/suggestion/sections/{requirement_id}",
    response_model=SuggestionOut,
)
async def patch_section(
    issue_id: int,
    requirement_id: str,
    patch: SectionPatch,
    session: AsyncSession = Depends(get_session),
) -> SuggestionOut:
    try:
        sug = await drafting.patch_section(
            session, issue_id, requirement_id,
            body_md=patch.body_md, removed=patch.removed,
        )
    except service.SuggestionNotFound:
        raise HTTPException(status_code=404, detail="No suggestion for this issue")
    except drafting.SectionNotFound:
        raise HTTPException(status_code=404, detail="No such section")
    except service.SuggestionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return _to_out(sug)
