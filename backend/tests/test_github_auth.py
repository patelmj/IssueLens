import base64

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import get_settings
from app.github.auth import (
    GitHubAppNotConfigured,
    clear_token_cache,
    get_installation_token,
    make_app_jwt,
)
from app.github.client import make_http_client


@pytest.fixture
def app_creds(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    monkeypatch.setenv("ISSUELENS_GITHUB_APP_ID", "12345")
    monkeypatch.setenv(
        "ISSUELENS_GITHUB_APP_PRIVATE_KEY_B64", base64.b64encode(pem).decode()
    )
    get_settings.cache_clear()
    clear_token_cache()
    yield key
    get_settings.cache_clear()
    clear_token_cache()


def test_jwt_raises_when_unconfigured():
    with pytest.raises(GitHubAppNotConfigured):
        make_app_jwt()


def test_jwt_claims(app_creds):
    token = make_app_jwt()
    public_pem = app_creds.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    claims = jwt.decode(token, public_pem, algorithms=["RS256"])
    assert claims["iss"] == "12345"
    assert claims["exp"] > claims["iat"]


@respx.mock
async def test_installation_token_cached(app_creds):
    route = respx.post(
        "https://api.github.com/app/installations/42/access_tokens"
    ).mock(
        return_value=httpx.Response(
            201, json={"token": "ghs_test", "expires_at": "2099-01-01T00:00:00Z"}
        )
    )
    async with make_http_client() as client:
        t1 = await get_installation_token(42, client)
        t2 = await get_installation_token(42, client)
    assert t1 == t2 == "ghs_test"
    assert route.call_count == 1
