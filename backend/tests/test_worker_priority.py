import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_readiness_job_enqueues_priority(monkeypatch):
    async def fake_score(session, client, repo_id):
        return 3

    monkeypatch.setattr(worker, "score_repository_issues", fake_score)
    redis = FakeRedis()

    result = await worker.score_readiness_repository({"redis": redis}, 500)

    assert result == 3
    assert redis.calls == [
        (("score_priority_repository", 500), {"_job_id": "priority-500"})
    ]


async def test_readiness_failure_does_not_enqueue_priority(monkeypatch):
    async def failing(session, client, repo_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(worker, "score_repository_issues", failing)
    redis = FakeRedis()
    try:
        await worker.score_readiness_repository({"redis": redis}, 500)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")
    assert redis.calls == []


async def test_priority_job_calls_scorer(monkeypatch):
    seen = {}

    async def fake_score(session, client, repo_id):
        seen["repo_id"] = repo_id
        return 5

    monkeypatch.setattr(worker, "score_repository_priorities", fake_score)

    result = await worker.score_priority_repository({}, 500)

    assert result == 5
    assert seen["repo_id"] == 500


def test_worker_registers_priority_jobs():
    names = {getattr(fn, "name", None) or fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "score_priority_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "priority_all_repositories" in cron_names
