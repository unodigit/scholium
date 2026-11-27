"""Passwordless sign-in using a single-use link delivered to an email address."""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from typing import TYPE_CHECKING
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Request, Response
from nacl.signing import SigningKey
from pydantic import BaseModel, Field
from scholium_record_core import did_key_from_public_key
from sqlalchemy import delete, update
from sqlalchemy.exc import IntegrityError

from app import db
from app.errors import ProblemException
from app.security import issue_access_token
from app.settings import settings

from .cookies import set_refresh_cookie
from .models import Account, EmailSignIn, ensure_account_table, ensure_email_signins_table
from .service import issue_refresh_token
from .verify import ACCESS_TOKEN_EXPIRES_IN, VERIFY_FAILED_TYPE, VerifyResponse

if TYPE_CHECKING:
    from app.modules.notifications.emailer import Email

router = APIRouter(prefix="/auth/email", tags=["auth"])
logger = logging.getLogger(__name__)
LINK_TTL = timedelta(minutes=15)
RESEND_DELAY = timedelta(minutes=1)
EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")


class EmailStart(BaseModel):
    email: str = Field(max_length=254)


class EmailVerify(BaseModel):
    token: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _unavailable() -> ProblemException:
    return ProblemException(503, "Email sign-in is temporarily unavailable. Try again later.")


def _email_hash(email: str) -> str:
    return hmac.new(
        settings.EMAIL_SIGNIN_KEY.encode(), b"scholium:email-signin:" + email.encode(), hashlib.sha256
    ).hexdigest()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _web_origin() -> str:
    for origin in settings.web_origins:
        parts = urlsplit(origin.rstrip("/"))
        if parts.scheme in ("http", "https") and parts.netloc:
            return origin.rstrip("/")
    raise _unavailable()


def _reserve_link(email_hash: str, token_hash: str, now: datetime) -> bool:
    ensure_email_signins_table()
    values = dict(token_hash=token_hash, expires_at=now + LINK_TTL, requested_at=now)
    with db.SessionLocal() as session:
        session.execute(delete(EmailSignIn).where(
            EmailSignIn.did.is_(None), EmailSignIn.expires_at <= now
        ))
        result = session.execute(
            update(EmailSignIn)
            .where(EmailSignIn.email_hash == email_hash, EmailSignIn.requested_at <= now - RESEND_DELAY)
            .values(**values)
        )
        if result.rowcount == 0:
            session.add(EmailSignIn(email_hash=email_hash, **values))
        try:
            session.commit()
        except IntegrityError:
            # A recent request or a concurrent insert already reserved the address.
            return False
    return True


def _deliver(message: Email) -> None:
    from app.modules.notifications.emailer import send_email

    if settings.RESEND_API_KEY:
        response = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
            json={
                "from": message.from_addr,
                "to": [message.to],
                "subject": message.subject,
                "text": message.body,
            },
            timeout=10,
        )
        response.raise_for_status()
    else:
        send_email(message, settings.SMTP_URL, timeout=10)


@router.post("/start", status_code=202)
def start_email_signin(body: EmailStart, response: Response) -> dict[str, str]:
    from app.modules.notifications.emailer import Email

    email = body.email.strip().lower()
    if not EMAIL.fullmatch(email):
        raise ProblemException(422, "Enter a valid email address.")
    if (
        not (settings.RESEND_API_KEY or settings.SMTP_URL.strip())
        or not settings.SMTP_FROM
        or len(settings.EMAIL_SIGNIN_KEY) < 32
    ):
        raise _unavailable()
    origin = _web_origin()
    now = _now()
    token = token_urlsafe(32)
    digest = _token_hash(token)
    response.headers["Cache-Control"] = "no-store"
    if _reserve_link(_email_hash(email), digest, now):
        # Fragments stay out of request URLs and server access logs.
        link = f"{origin}/signin/email#{urlencode({'token': token})}"
        try:
            _deliver(Email(
                to=email,
                from_addr=settings.SMTP_FROM,
                subject="Your Scholium sign-in link",
                body=f"Open this link to continue to Scholium:\n\n{link}\n\n"
                     "The link expires in 15 minutes and can be used once.",
            ))
        except Exception as exc:
            logger.warning(
                "Email sign-in delivery failed (%s, status %s)",
                type(exc).__name__,
                exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else "-",
            )
            with db.SessionLocal() as session:
                session.execute(update(EmailSignIn).where(EmailSignIn.token_hash == digest).values(
                    token_hash=None, expires_at=now, requested_at=now - RESEND_DELAY
                ))
                session.commit()
            raise _unavailable() from None
    return {"status": "accepted"}


@router.post("/verify", response_model=VerifyResponse)
def verify_email_signin(body: EmailVerify, response: Response, request: Request) -> VerifyResponse:
    ensure_email_signins_table()
    ensure_account_table()
    now = _now()
    with db.SessionLocal() as session:
        # Claim the token and establish the account in the same transaction.
        result = session.execute(
            update(EmailSignIn)
            .where(EmailSignIn.token_hash == _token_hash(body.token), EmailSignIn.expires_at > now)
            .values(token_hash=None)
            .returning(EmailSignIn.email_hash, EmailSignIn.did)
        ).one_or_none()
        if result is None:
            raise ProblemException(401, "This sign-in link is invalid or has expired.", type=VERIFY_FAILED_TYPE)
        email_hash, did = result
        if did is None:
            # An email account gets its own DID. No server-held signing key is retained.
            did = did_key_from_public_key(bytes(SigningKey.generate().verify_key))
            account = Account(did=did, tier=0, created_at=now)
            session.add(account)
            session.execute(update(EmailSignIn).where(EmailSignIn.email_hash == email_hash).values(did=did))
        else:
            account = session.get(Account, did)
        if account is None:
            raise ProblemException(401, "This email account is unavailable.", type=VERIFY_FAILED_TYPE)
        tier = int(account.tier)
        session.commit()
    access_token = issue_access_token(did, tier, now=now)
    set_refresh_cookie(response, request, issue_refresh_token(did, now=now))
    response.headers["Cache-Control"] = "no-store"
    return VerifyResponse(access_token=access_token, expires_in=ACCESS_TOKEN_EXPIRES_IN)
