"""Tests for the notifications module (feature 57: system notify).

Covers: persistence to the ``notifications`` table, unread default, outbox
logging when ``SMTP_URL`` is unset, SMTP delivery when it is set, recipient
resolution and failure fallback.  No test touches a real network.

Isolation note: the test database is shared by pytest-xdist workers, so each
test writes to its own unique DID and filters reads by it instead of assuming
the table is empty.
"""

import logging
import smtplib
import uuid

import pytest

from app import db
from app.modules.notifications import (
    Notification,
    build_email,
    clear_outbox,
    ensure_table,
    get_outbox,
    notify,
    parse_smtp_url,
)
from app.settings import settings


class FakeSMTP:
    """Records connection, login and sendmail calls."""

    instances: list["FakeSMTP"] = []
    fail_connect = False

    def __init__(self, host, port):
        if FakeSMTP.fail_connect:
            raise smtplib.SMTPConnectError(421, "no server")
        self.host = host
        self.port = port
        self.starttls_called = False
        self.login_args = None
        self.sent = []
        self.quit_called = False
        FakeSMTP.instances.append(self)

    def starttls(self):
        self.starttls_called = True

    def login(self, username, password):
        self.login_args = (username, password)

    def sendmail(self, from_addr, to_addrs, message):
        self.sent.append((from_addr, to_addrs, message))

    def quit(self):
        self.quit_called = True


@pytest.fixture(autouse=True)
def clean_state():
    """Fresh outbox, no SMTP_URL and fresh fakes for every test."""
    ensure_table()
    clear_outbox()
    FakeSMTP.instances = []
    FakeSMTP.fail_connect = False
    previous = settings.SMTP_URL
    settings.SMTP_URL = ""
    yield
    settings.SMTP_URL = previous


@pytest.fixture
def dids():
    """Two unique DIDs so concurrent workers cannot see each other's rows."""
    tag = uuid.uuid4().hex
    return f"did:example:alice-{tag}", f"did:example:bob-{tag}"


def _rows_for(*dids):
    """Return notification rows for the given DIDs, oldest first."""
    with db.SessionLocal() as session:
        query = session.query(Notification).filter(Notification.did.in_(dids))
        return [
            {
                "id": row.id,
                "did": row.did,
                "kind": row.kind,
                "payload": row.payload,
                "read": row.read,
            }
            for row in query.order_by(Notification.id).all()
        ]


def _use_smtp(monkeypatch, url="smtp://mail.example.org:25"):
    settings.SMTP_URL = url
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)


def test_notify_persists_unread_row(dids):
    alice, _ = dids
    notification = notify(alice, "consent.request", {"paper_cid": "bafyrei1"})

    assert notification.id is not None
    assert _rows_for(alice) == [
        {
            "id": notification.id,
            "did": alice,
            "kind": "consent.request",
            "payload": {"paper_cid": "bafyrei1"},
            "read": False,
        }
    ]


def test_notify_defaults_missing_payload_to_empty_object(dids):
    alice, _ = dids
    notify(alice, "digest")

    rows = _rows_for(alice)
    assert rows[0]["payload"] == {}
    assert rows[0]["read"] is False


def test_notify_persists_one_row_per_call(dids):
    alice, bob = dids
    notify(alice, "first", {"n": 1})
    notify(bob, "second", {"n": 2})

    rows = _rows_for(alice, bob)
    assert [(row["did"], row["kind"]) for row in rows] == [
        (alice, "first"),
        (bob, "second"),
    ]


def test_notify_logs_to_outbox_without_smtp(dids, caplog):
    alice, _ = dids
    with caplog.at_level(logging.INFO, logger="outbox"):
        notify(alice, "consent.request", {"email": "alice@example.org", "link": "https://x.test/c"})

    rows = _rows_for(alice)
    assert len(rows) == 1
    outbox = get_outbox()
    assert len(outbox) == 1
    assert outbox[0]["to"] == "alice@example.org"
    assert outbox[0]["kind"] == "consent.request"
    assert outbox[0]["notification_id"] == rows[0]["id"]
    assert "consent.request" in outbox[0]["subject"]
    assert "https://x.test/c" in outbox[0]["body"]
    assert "outbox email" in caplog.text


def test_notify_sends_through_smtp_when_configured(monkeypatch, dids):
    alice, _ = dids
    _use_smtp(monkeypatch)
    notify(alice, "consent.request", {"email": "alice@example.org", "paper_cid": "bafyrei1"})

    assert len(_rows_for(alice)) == 1
    assert get_outbox() == []
    (server,) = FakeSMTP.instances
    assert (server.host, server.port) == ("mail.example.org", 25)
    (from_addr, to_addrs, message), = server.sent
    assert from_addr == "noreply@scholium.local"
    assert to_addrs == ["alice@example.org"]
    assert "consent.request" in message
    assert "bafyrei1" in message
    assert server.quit_called


def test_notify_uses_starttls_and_credentials_from_url(monkeypatch, dids):
    alice, _ = dids
    _use_smtp(monkeypatch, "smtp://user:secret@mail.example.org:587")
    notify(alice, "digest", {"email": "alice@example.org"})

    (server,) = FakeSMTP.instances
    assert (server.host, server.port) == ("mail.example.org", 587)
    assert server.starttls_called is True
    assert server.login_args == ("user", "secret")
    assert len(server.sent) == 1


def test_notify_uses_implicit_tls_for_smtps(monkeypatch, dids):
    alice, _ = dids
    ssl_instances = []

    class FakeSMTPSSL(FakeSMTP):
        def __init__(self, host, port):
            super().__init__(host, port)
            ssl_instances.append(self)

    settings.SMTP_URL = "smtps://mail.example.org:465"
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTPSSL)

    notify(alice, "digest", {"email": "alice@example.org"})

    (server,) = ssl_instances
    assert (server.host, server.port) == ("mail.example.org", 465)
    assert server.starttls_called is False
    assert len(server.sent) == 1


def test_notify_falls_back_to_outbox_when_smtp_fails(monkeypatch, dids, caplog):
    alice, _ = dids
    _use_smtp(monkeypatch)
    FakeSMTP.fail_connect = True

    with caplog.at_level(logging.INFO):
        notification = notify(alice, "consent.request", {"email": "alice@example.org"})

    assert notification.id is not None
    assert len(_rows_for(alice)) == 1
    outbox = get_outbox()
    assert len(outbox) == 1
    assert outbox[0]["reason"] == "smtp delivery failed"


def test_recipient_falls_back_to_did_with_at_sign():
    email = build_email("alice@example.org", "digest")
    assert email.to == "alice@example.org"


def test_notify_rejects_empty_arguments(dids):
    alice, _ = dids
    with pytest.raises(ValueError):
        notify("", "kind")
    with pytest.raises(ValueError):
        notify(alice, "")
    assert _rows_for(alice) == []


@pytest.mark.parametrize(
    "url,host,port,use_ssl,starttls",
    [
        ("smtp://localhost", "localhost", 25, False, False),
        ("smtp://localhost:2525", "localhost", 2525, False, False),
        ("localhost:2525", "localhost", 2525, False, False),
        ("smtp://localhost:587", "localhost", 587, False, True),
        ("smtp://localhost:25?tls=1", "localhost", 25, False, True),
        ("smtps://localhost", "localhost", 465, True, False),
        ("smtp+starttls://localhost:25", "localhost", 25, False, True),
    ],
)
def test_parse_smtp_url(url, host, port, use_ssl, starttls):
    config = parse_smtp_url(url)
    assert config.host == host
    assert config.port == port
    assert config.use_ssl is use_ssl
    assert config.starttls is starttls
