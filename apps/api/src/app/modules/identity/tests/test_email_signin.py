from datetime import timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest

from app.modules.identity import email_signin
from app.modules.notifications import emailer
from app.security import decode_access_token
from app.settings import settings

START = "/v1/auth/email/start"
VERIFY = "/v1/auth/email/verify"


@pytest.fixture
def mailbox(monkeypatch):
    messages = []
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    monkeypatch.setattr(settings, "SMTP_URL", "smtp://example.test:587")
    monkeypatch.setattr(settings, "SMTP_FROM", "sender@example.test")
    monkeypatch.setattr(settings, "EMAIL_SIGNIN_KEY", "x" * 32)
    monkeypatch.setattr(settings, "WEB_ORIGINS", "https://scholium.example.test")
    monkeypatch.setattr(emailer, "send_email", lambda message, _, **options: messages.append(message))
    return messages


def token_from(message):
    link = urlsplit(message.body.splitlines()[2])
    assert link.netloc == "scholium.example.test"
    assert link.path == "/signin/email"
    assert not link.query
    return parse_qs(link.fragment)["token"][0]


def test_email_signup_and_returning_signin(client, mailbox, monkeypatch):
    address = f"{uuid4().hex}@example.test"
    now = email_signin._now()
    first_request = now - timedelta(minutes=2)
    monkeypatch.setattr(email_signin, "_now", lambda: first_request)
    response = client.post(START, json={"email": address.upper()})
    assert response.status_code == 202, response.text
    assert mailbox[0].to == address
    assert client.post(START, json={"email": address}).status_code == 202
    assert len(mailbox) == 1

    payload = {"token": token_from(mailbox[0])}
    response = client.post(VERIFY, json=payload)
    assert response.status_code == 200, response.text
    assert "HttpOnly" in response.headers["set-cookie"]
    assert response.headers["cache-control"] == "no-store"
    account = decode_access_token(response.json()["access_token"]).did
    assert client.post(VERIFY, json=payload).status_code == 401

    monkeypatch.setattr(email_signin, "_now", lambda: now)
    assert client.post(START, json={"email": address}).status_code == 202
    assert len(mailbox) == 2
    returning = client.post(VERIFY, json={"token": token_from(mailbox[1])})
    assert returning.status_code == 200, returning.text
    assert decode_access_token(returning.json()["access_token"]).did == account


def test_email_link_expires(client, mailbox, monkeypatch):
    address = f"{uuid4().hex}@example.test"
    assert client.post(START, json={"email": address}).status_code == 202
    later = email_signin._now() + email_signin.LINK_TTL + timedelta(seconds=1)
    monkeypatch.setattr(email_signin, "_now", lambda: later)
    assert client.post(VERIFY, json={"token": token_from(mailbox[0])}).status_code == 401


def test_missing_smtp_reports_unavailable(client, mailbox, monkeypatch):
    monkeypatch.setattr(settings, "SMTP_URL", "")
    assert client.post(START, json={"email": "reader@example.test"}).status_code == 503
    assert mailbox == []


def test_email_delivery_uses_https_when_resend_is_configured(client, mailbox, monkeypatch):
    monkeypatch.setattr(settings, "SMTP_URL", "")
    monkeypatch.setattr(settings, "RESEND_API_KEY", "test-key")
    calls = []

    def send(url, **options):
        calls.append((url, options))
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(email_signin.httpx, "post", send)
    address = f"{uuid4().hex}@example.test"
    assert client.post(START, json={"email": address}).status_code == 202
    assert not mailbox
    [(url, options)] = calls
    assert url == "https://api.resend.com/emails"
    assert options["headers"]["Authorization"] == "Bearer test-key"
    assert options["json"]["from"] == "sender@example.test"
    assert options["json"]["to"] == [address]
    assert "https://scholium.example.test/signin/email#token=" in options["json"]["text"]
