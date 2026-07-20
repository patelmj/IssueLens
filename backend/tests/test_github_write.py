import httpx
import respx

from app.github.client import (
    installation_get_one,
    installation_patch,
    make_http_client,
)
from tests.test_github_auth import app_creds  # noqa: F401 - reused fixture


def _token_route():
    return respx.post("https://api.github.com/app/installations/42/access_tokens").mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )


@respx.mock
async def test_installation_get_one(app_creds):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/repos/o/r/issues/5").mock(
        return_value=httpx.Response(200, json={"number": 5, "body": "hi"})
    )
    async with make_http_client() as client:
        issue = await installation_get_one(client, 42, "/repos/o/r/issues/5")
    assert issue["body"] == "hi"


@respx.mock
async def test_installation_patch_sends_body(app_creds):  # noqa: F811
    _token_route()
    route = respx.patch("https://api.github.com/repos/o/r/issues/5").mock(
        return_value=httpx.Response(200, json={"number": 5, "body": "new"})
    )
    async with make_http_client() as client:
        updated = await installation_patch(
            client, 42, "/repos/o/r/issues/5", {"body": "new"}
        )
    assert updated["body"] == "new"
    assert route.calls.last.request.method == "PATCH"
    import json as _json

    assert _json.loads(route.calls.last.request.content)["body"] == "new"
