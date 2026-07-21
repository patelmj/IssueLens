from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.db import get_engine
from app.routers.issues import router as issues_router
from app.routers.kanban import router as kanban_router
from app.routers.priority import router as priority_router
from app.routers.repositories import router as repositories_router
from app.routers.stats import router as stats_router
from app.routers.triage import router as triage_router
from app.routers.views import router as views_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="IssueLens API", lifespan=lifespan)

app.include_router(issues_router)
app.include_router(kanban_router)
app.include_router(priority_router)
app.include_router(repositories_router)
app.include_router(stats_router)
app.include_router(triage_router)
app.include_router(views_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/healthz")
async def healthz() -> dict:
    database = "ok"
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        database = "unavailable"
    return {"status": "ok", "database": database}
