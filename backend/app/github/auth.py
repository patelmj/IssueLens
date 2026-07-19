import base64
import time

import httpx
import jwt

from app.config import get_settings

GITHUB_API = "https://api.github.com"

_token_cache: dict[int, tuple[str, float]] = {}


class GitHubAppNotConfigured(Exception):
    def __init__(self) -> None:
        super().__init__("GitHub App not configured - see README ('GitHub App setup')")


def _private_key_pem() -> str:
    settings = get_settings()
    if not settings.github_app_id or not settings.github_app_private_key_b64:
        raise GitHubAppNotConfigured()
    return base64.b64decode(settings.github_app_private_key_b64).decode()


def make_app_jwt() -> str:
    pem = _private_key_pem()
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 540, "iss": get_settings().github_app_id}
    return jwt.encode(payload, pem, algorithm="RS256")


async def get_installation_token(installation_id: int, client: httpx.AsyncClient) -> str:
    cached = _token_cache.get(installation_id)
    if cached and cached[1] - time.time() > 300:
        return cached[0]
    resp = await client.post(
        f"/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {make_app_jwt()}"},
    )
    resp.raise_for_status()
    token = resp.json()["token"]
    _token_cache[installation_id] = (token, time.time() + 55 * 60)
    return token


def clear_token_cache() -> None:
    _token_cache.clear()
