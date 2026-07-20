import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_classify_repository_enqueues_readiness(monkeypatch):
    async def fake_classify(session, client, repo_id):
        return 7

    monkeypatch.setattr(worker, "classify_repository_issues", fake_classify)
    redis = FakeRedis()

    result = await worker.classify_repository({"redis": redis}, 500)

    assert result == 7
    assert redis.calls == [
        (("score_readiness_repository", 500), {"_job_id": "readiness-500"})
    ]


async def test_classify_failure_does_not_enqueue_readiness(monkeypatch):
    async def failing(session, client, repo_id):
        raise RuntimeError("ollama down")

    monkeypatch.setattr(worker, "classify_repository_issues", failing)
    redis = FakeRedis()
    try:
        await worker.classify_repository({"redis": redis}, 500)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert redis.calls == []


def test_worker_registers_readiness_jobs():
    names = {getattr(fn, "name", None) or fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "score_readiness_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "score_all_repositories" in cron_names


async def test_readiness_sweep_enqueues_with_dedupe_key(clean_db):
    from app.db import get_sessionmaker
    from app.models import Installation, Repository

    async with get_sessionmaker()() as session:
        session.add(Installation(id=42, account_login="patelmj"))
        await session.flush()
        session.add(
            Repository(id=500, installation_id=42, full_name="patelmj/mehova",
                       owner="patelmj", name="mehova")
        )
        await session.commit()

    redis = FakeRedis()
    result = await worker.score_all_repositories({"redis": redis})
    assert result == 1
    assert redis.calls == [
        (("score_readiness_repository", 500), {"_job_id": "readiness-500"})
    ]
