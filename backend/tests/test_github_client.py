import httpx
import pytest
import respx

from app.github.client import (
    GitHubRateLimited,
    installation_get_paginated,
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
async def test_pagination_follows_link_header(app_creds):  # noqa: F811
    _token_route()
    page2_url = "https://api.github.com/repos/o/r/issues?page=2"
    # NOTE: respx matches routes in registration order, and a URL pattern with no
    # query string (like the base "issues" route below) matches ANY query string on
    # that path - it does not require an empty query. Registering the page=2 route
    # first ensures it is tried before the query-agnostic base route; otherwise the
    # base route would also swallow the page-2 request (same Link header, same
    # response), causing the pager to loop on page 2 forever.
    respx.get(page2_url).mock(return_value=httpx.Response(200, json=[{"n": 2}]))
    respx.get("https://api.github.com/repos/o/r/issues").mock(
        return_value=httpx.Response(
            200, json=[{"n": 1}], headers={"Link": f'<{page2_url}>; rel="next"'}
        )
    )
    async with make_http_client() as client:
        items = await installation_get_paginated(client, 42, "/repos/o/r/issues")
    assert [i["n"] for i in items] == [1, 2]


@respx.mock
async def test_rate_limit_raises_with_reset(app_creds):  # noqa: F811
    _token_route()
    respx.get("https://api.github.com/repos/o/r/issues").mock(
        return_value=httpx.Response(
            403,
            json={"message": "rate limited"},
            headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000"},
        )
    )
    async with make_http_client() as client:
        with pytest.raises(GitHubRateLimited) as exc:
            await installation_get_paginated(client, 42, "/repos/o/r/issues")
    assert exc.value.reset_epoch == 1790000000
