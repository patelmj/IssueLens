from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.analytics import completed as agg
from app.db import get_session

router = APIRouter(tags=["analytics"])


class Totals(BaseModel):
    completed: int
    median_cycle_days: float | None
    p90_cycle_days: float | None
    do_first_pct: int | None
    streak_weeks: int


class WeekRow(BaseModel):
    week_start: str
    bug: int
    feature: int
    debt: int
    other: int


class HeatCell(BaseModel):
    u_bin: int
    i_bin: int
    count: int
    sample_issues: list[int]


class CycleBucket(BaseModel):
    label: str
    count: int


class RepoRow(BaseModel):
    repository_id: int
    full_name: str
    count: int
    pct: int


class StreakWeek(BaseModel):
    week_start: str
    count: int


class Streak(BaseModel):
    weeks: list[StreakWeek]
    current: int


class RecentRow(BaseModel):
    number: int
    title: str
    repo: str
    type: str
    quadrant: str | None
    cycle_days: float
    closed_at: str


class CompletedAnalytics(BaseModel):
    totals: Totals
    weekly: list[WeekRow]
    heatmap: list[HeatCell]
    cycle_buckets: list[CycleBucket]
    repos: list[RepoRow]
    streak: Streak
    recent: list[RecentRow]


@router.get("/analytics/completed", response_model=CompletedAnalytics)
async def completed_analytics(
    window: Literal["30d", "90d", "1y", "all"] = "90d",
    repo_id: int | None = None,
    session: AsyncSession = Depends(get_session),
) -> CompletedAnalytics:
    start = agg.window_start(window, datetime.now(timezone.utc))
    totals = await agg.totals(session, start, repo_id)
    streak = await agg.streak(session, repo_id)
    totals["streak_weeks"] = streak["current"]
    return CompletedAnalytics(
        totals=totals,
        weekly=await agg.weekly(session, start, repo_id),
        heatmap=await agg.heatmap(session, start, repo_id),
        cycle_buckets=await agg.cycle_buckets(session, start, repo_id),
        repos=await agg.repos(session, start, repo_id),
        streak=streak,
        recent=await agg.recent(session, start, repo_id),
    )
