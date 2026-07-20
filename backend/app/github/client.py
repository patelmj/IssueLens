from typing import Any

import httpx

from app.github.auth import GITHUB_API, get_installation_token, make_app_jwt


class GitHubRateLimited(Exception):
    def __init__(self, reset_epoch: int) -> None:
        self.reset_epoch = reset_epoch
        super().__init__(f"GitHub rate limit exceeded; resets at epoch {reset_epoch}")


def make_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=GITHUB_API,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30.0,
    )


def _check_rate_limit(resp: httpx.Response) -> None:
    if resp.status_code == 403 and resp.headers.get("x-ratelimit-remaining") == "0":
        raise GitHubRateLimited(int(resp.headers.get("x-ratelimit-reset", "0")))


async def app_get(client: httpx.AsyncClient, path: str) -> Any:
    resp = await client.get(path, headers={"Authorization": f"Bearer {make_app_jwt()}"})
    _check_rate_limit(resp)
    resp.raise_for_status()
    return resp.json()


async def installation_get_paginated(
    client: httpx.AsyncClient,
    installation_id: int,
    path: str,
    params: dict[str, Any] | None = None,
    items_key: str | None = None,
) -> list[dict[str, Any]]:
    token = await get_installation_token(installation_id, client)
    headers = {"Authorization": f"Bearer {token}"}
    items: list[dict[str, Any]] = []
    url: str = path
    first = True
    while url:
        resp = await client.get(
            url,
            params={"per_page": 100, **(params or {})} if first else None,
            headers=headers,
        )
        _check_rate_limit(resp)
        resp.raise_for_status()
        data = resp.json()
        items.extend(data[items_key] if items_key else data)
        url = resp.links.get("next", {}).get("url", "")
        first = False
    return items


async def installation_get_one(
    client: httpx.AsyncClient, installation_id: int, path: str
) -> dict[str, Any]:
    token = await get_installation_token(installation_id, client)
    resp = await client.get(path, headers={"Authorization": f"Bearer {token}"})
    _check_rate_limit(resp)
    resp.raise_for_status()
    return resp.json()


async def installation_patch(
    client: httpx.AsyncClient,
    installation_id: int,
    path: str,
    json: dict[str, Any],
) -> dict[str, Any]:
    token = await get_installation_token(installation_id, client)
    resp = await client.patch(
        path, json=json, headers={"Authorization": f"Bearer {token}"}
    )
    _check_rate_limit(resp)
    resp.raise_for_status()
    return resp.json()
