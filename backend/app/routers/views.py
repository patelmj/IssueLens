from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Repository, SavedView

router = APIRouter(tags=["views"])

VIEW_KINDS = {"matrix"}


class SavedViewOut(BaseModel):
    id: int
    name: str
    view_kind: str
    repository_id: int | None
    filters: dict
    created_at: datetime


class SavedViewIn(BaseModel):
    name: str = Field(max_length=120)
    view_kind: str
    repository_id: int | None = None
    filters: dict = Field(default_factory=dict)


class RenameIn(BaseModel):
    name: str = Field(max_length=120)


def _clean_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="View name must not be empty")
    return cleaned


def _integrity_conflict(exc: IntegrityError, view_kind: str, name: str) -> HTTPException:
    """Map an IntegrityError to the right HTTP error by constraint name.

    The unique (view_kind, name) constraint means a duplicate name; the FK
    constraint fires only when the repository vanished between the
    existence check and the commit.
    """
    if "uq_saved_views_kind_name" in str(exc.orig):
        return HTTPException(
            status_code=409,
            detail=f'A {view_kind} view named "{name}" already exists',
        )
    return HTTPException(status_code=404, detail="Unknown repository")


def _to_out(view: SavedView) -> SavedViewOut:
    return SavedViewOut(
        id=view.id,
        name=view.name,
        view_kind=view.view_kind,
        repository_id=view.repository_id,
        filters=view.filters,
        created_at=view.created_at,
    )


@router.get("/views", response_model=list[SavedViewOut])
async def list_views(session: AsyncSession = Depends(get_session)) -> list[SavedViewOut]:
    views = (
        (
            await session.execute(
                select(SavedView).order_by(
                    SavedView.created_at.desc(), SavedView.id.desc()
                )
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(view) for view in views]


@router.post("/views", response_model=SavedViewOut, status_code=201)
async def create_view(
    body: SavedViewIn, session: AsyncSession = Depends(get_session)
) -> SavedViewOut:
    name = _clean_name(body.name)
    if body.view_kind not in VIEW_KINDS:
        raise HTTPException(
            status_code=422, detail=f"Unknown view kind: {body.view_kind}"
        )
    if body.view_kind == "matrix" and body.repository_id is None:
        raise HTTPException(
            status_code=422, detail="Matrix views require a repository"
        )
    if body.repository_id is not None:
        repo = (
            await session.execute(
                select(Repository).where(Repository.id == body.repository_id)
            )
        ).scalar_one_or_none()
        if repo is None:
            raise HTTPException(status_code=404, detail="Unknown repository")
    view = SavedView(
        name=name,
        view_kind=body.view_kind,
        repository_id=body.repository_id,
        filters=body.filters,
    )
    session.add(view)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise _integrity_conflict(exc, body.view_kind, name) from None
    await session.refresh(view)
    return _to_out(view)


@router.patch("/views/{view_id}", response_model=SavedViewOut)
async def rename_view(
    view_id: int, body: RenameIn, session: AsyncSession = Depends(get_session)
) -> SavedViewOut:
    name = _clean_name(body.name)
    view = (
        await session.execute(select(SavedView).where(SavedView.id == view_id))
    ).scalar_one_or_none()
    if view is None:
        raise HTTPException(status_code=404, detail="Unknown view")
    view.name = name
    view_kind = view.view_kind
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail=f'A {view_kind} view named "{name}" already exists',
        ) from None
    await session.refresh(view)
    return _to_out(view)


@router.delete("/views/{view_id}", status_code=204)
async def delete_view(
    view_id: int, session: AsyncSession = Depends(get_session)
) -> Response:
    await session.execute(delete(SavedView).where(SavedView.id == view_id))
    await session.commit()
    return Response(status_code=204)
