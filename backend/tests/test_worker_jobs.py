import worker


def test_sync_job_registered():
    names = [f.__name__ for f in worker.WorkerSettings.functions]
    assert "ping" in names
    assert "sync_repository" in names


def test_reconcile_cron_registered():
    assert len(worker.WorkerSettings.cron_jobs) == 1
    assert worker.WorkerSettings.cron_jobs[0].name == "reconcile_all_repositories"
