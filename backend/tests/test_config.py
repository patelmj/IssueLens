from app.config import get_settings


def test_settings_read_prefixed_env(monkeypatch):
    monkeypatch.setenv("ISSUELENS_DATABASE_URL", "postgresql+asyncpg://u:p@example:5432/db")
    get_settings.cache_clear()
    assert get_settings().database_url == "postgresql+asyncpg://u:p@example:5432/db"


def test_settings_have_defaults():
    s = get_settings()
    assert s.database_url.startswith("postgresql+asyncpg://")
    assert s.redis_url.startswith("redis://")


def test_github_app_settings_default_none():
    s = get_settings()
    assert s.github_app_id is None
    assert s.github_app_private_key_b64 is None


def test_github_app_settings_read_env(monkeypatch):
    monkeypatch.setenv("ISSUELENS_GITHUB_APP_ID", "12345")
    monkeypatch.setenv("ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64", "cGVt")
    get_settings.cache_clear()
    s = get_settings()
    assert s.github_app_id == "12345"
    assert s.github_app_private_key_b64 == "cGVt"


def test_ollama_settings_read_from_env():
    # pin_env (autouse) sets ISSUELENS_OLLAMA_URL / ISSUELENS_OLLAMA_MODEL,
    # proving the ISSUELENS_ prefix wiring works end to end.
    settings = get_settings()
    assert settings.ollama_url == "http://127.0.0.1:11434"
    assert settings.ollama_model == "test-model"
