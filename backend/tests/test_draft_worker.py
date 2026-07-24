import worker


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return object()


async def test_priority_worker_chains_draft_job(monkeypatch):
    async def fake_score(session, client, repo_id):
        return 0

    monkeypatch.setattr(worker, "score_repository_priorities", fake_score)
    redis = FakeRedis()

    result = await worker.score_priority_repository({"redis": redis}, 500)

    assert result == 0
    assert redis.calls == [
        (("draft_suggestions_repository", 500), {"_job_id": "draft-500"})
    ]


def test_worker_settings_register_draft_functions():
    names = {getattr(fn, "name", None) or fn.__name__ for fn in worker.WorkerSettings.functions}
    assert "draft_suggestions_repository" in names
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "draft_all_repositories" in cron_names
