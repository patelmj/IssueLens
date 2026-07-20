import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_sync_repository_enqueues_classification(monkeypatch):
    async def fake_sync(session, client, repo_id, full=False):
        return 3

    monkeypatch.setattr(worker, "sync_repository_issues", fake_sync)
    redis = FakeRedis()

    result = await worker.sync_repository({"redis": redis}, 500)

    assert result == 3
    assert redis.calls == [
        (("classify_repository", 500), {"_job_id": "classify-500"})
    ]


async def test_sync_repository_failure_does_not_enqueue(monkeypatch):
    async def failing_sync(session, client, repo_id, full=False):
        raise RuntimeError("github down")

    monkeypatch.setattr(worker, "sync_repository_issues", failing_sync)
    redis = FakeRedis()

    try:
        await worker.sync_repository({"redis": redis}, 500)
    except RuntimeError:
        pass
    else:
        raise AssertionError("expected RuntimeError")

    assert redis.calls == []


def test_worker_registers_classification_jobs():
    names = {getattr(fn, "name", None) or fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "classify_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "classify_all_repositories" in cron_names
