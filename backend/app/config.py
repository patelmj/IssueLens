from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ISSUELENS_", extra="ignore")

    database_url: str = "postgresql+asyncpg://issuelens:issuelens@localhost:5432/issuelens"
    redis_url: str = "redis://localhost:6379/0"
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "qwen3:14b"
    github_app_id: str | None = None
    github_app_private_key_b64: str | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
