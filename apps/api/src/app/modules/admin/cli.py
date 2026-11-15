"""Command line for the admin plugin: ``python -m app.modules.admin <command>``."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from sqlalchemy.exc import SQLAlchemyError

from app.security import Tier

from .service import InvalidDid, parse_tier, set_tier, validate_did

__all__ = ["build_parser", "main"]


def _did(value: str) -> str:
    try:
        return validate_did(value)
    except InvalidDid as exc:
        raise argparse.ArgumentTypeError(f"{exc}: {value!r}") from None


def _tier(value: str) -> int:
    try:
        return parse_tier(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def _run_set_tier(args: argparse.Namespace) -> int:
    try:
        change = set_tier(args.did, args.tier)
    except SQLAlchemyError as exc:
        print(f"error: could not update the accounts table: {exc}", file=sys.stderr)
        return 1
    if change.created:
        print(
            f"note: {change.did} has not signed in yet; created its account at this tier",
            file=sys.stderr,
        )
    print(f"{change.did} tier {change.tier} ({Tier(change.tier).label})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.modules.admin", description="Scholium administration tools."
    )
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")

    set_tier_parser = commands.add_parser(
        "set-tier",
        help="set an account's trust tier",
        description="Set the trust tier of the account for a did:key and print the new tier. "
        "Tiers are 0 reader, 1 member, 2 author, 3 reviewer, 4 moderator; give the number "
        "or the name. A DID that has not signed in yet gets its account created. The user's "
        "access tokens pick up the new tier when their next one is issued.",
    )
    set_tier_parser.add_argument("did", type=_did, help="the account's did:key identifier")
    set_tier_parser.add_argument("tier", type=_tier, help="0-4, or reader/member/author/reviewer/moderator")
    set_tier_parser.set_defaults(handler=_run_set_tier)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_usage(sys.stderr)
        return 2
    return handler(args)
