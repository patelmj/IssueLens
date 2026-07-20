import worker


def test_sync_job_registered():
    names = [getattr(f, "name", None) or f.__name__ for f in worker.WorkerSettings.functions]
    assert "ping" in names
    assert "sync_repository" in names


def test_reconcile_cron_registered():
    assert len(worker.WorkerSettings.cron_jobs) == 4
    cron_names = {job.name for job in worker.WorkerSettings.cron_jobs}
    assert "reconcile_all_repositories" in cron_names
    assert "classify_all_repositories" in cron_names
    assert "score_all_repositories" in cron_names
    assert "priority_all_repositories" in cron_names
