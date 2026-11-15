"""Command line for the admin plugin: ``python -m app.modules.admin <command>``."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy.exc import SQLAlchemyError

from app.security import Tier

from .bootstrap import RecordCoreUnavailable, ensure_record_core
from .service import InvalidDid, parse_tier, set_tier, validate_did

if TYPE_CHECKING:
    from .demo.seed import SeededPaper, SeedResult

__all__ = ["build_parser", "main"]

#: Where ``seed-demo`` keeps the demo accounts' keys unless told otherwise:
#: next to where it runs, like the default ``scholium.db`` it seeds.
DEFAULT_KEYS_FILE = ".demo-keys.json"


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


def _log(message: str) -> None:
    print(message, file=sys.stderr)


def _run_seed_demo(args: argparse.Namespace) -> int:
    # The demo code signs records, so it needs the record core, which a plain
    # ``uv run`` does not install.  Imported only here: ``set-tier`` and the app
    # itself never pay for (or depend on) any of it.
    try:
        ensure_record_core()
    except RecordCoreUnavailable as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    from .demo.keys import DemoKeysError
    from .demo.seed import SeedError, seed_demo

    try:
        result = seed_demo(args.keys_file, log=_log, verbose=args.verbose)
    except (SeedError, DemoKeysError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except SQLAlchemyError as exc:
        print(f"error: could not write the demo data: {exc}", file=sys.stderr)
        return 1
    _print_seed_summary(result)
    return 0


def _paper_details(paper: SeededPaper) -> str:
    details = []
    if paper.state != "listed":
        details.append("waiting in the moderation queue")
    if paper.reviews_revealed or paper.reviews_sealed:
        details.append(f"{paper.reviews_revealed} review revealed, {paper.reviews_sealed} sealed")
    if paper.ai_reviewed:
        details.append("AI pre-review")
    return ", ".join(details)


def _print_seed_summary(result: SeedResult) -> None:
    print(f"Demo data is in place on {result.database}")
    print()
    print("Papers")
    for paper in result.papers:
        note = "created" if paper.created else "already there"
        print(f"  {paper.short_id}  {paper.state:<10}  {note:<13}  {paper.title}")
        details = _paper_details(paper)
        if details:
            print(f"  {'':<18}  {details}")
    print()
    print("Accounts")
    for account in result.accounts:
        print(f"  {account.role:<9}  tier {account.tier}  {account.name:<20}  {account.did}")
    print()
    cast = "a new cast" if result.keys_created else "the same cast as before"
    print(f"Keys for {cast} are in {result.keys_path}")
    print("They sign as these accounts: keep that file private, and out of version control.")
    if result.node_log:
        total = sum(result.node_log.values())
        print(file=sys.stderr)
        print(
            f"note: the node logged {total} warnings or errors while seeding, from background jobs "
            "that it tolerates and retries; run with --verbose to see them in full:",
            file=sys.stderr,
        )
        for headline, count in sorted(result.node_log.items(), key=lambda item: -item[1])[:5]:
            print(f"  {count}x {headline}", file=sys.stderr)


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

    seed_parser = commands.add_parser(
        "seed-demo",
        help="load demo authors, reviewers, a moderator and papers",
        description="Load fictional demo data into the node DATABASE_URL names: authors endorsed "
        "to submit, reviewers, a moderator, and papers that are scanned, listed and reviewed. "
        "Every record is signed here, client-side, with keys written to the keys file, then "
        "submitted to the node's own API; the sch: ids of the papers are printed. Safe to run "
        "again: the same keys sign the same records, which the node already has. Refuses to run "
        "when SCHOLIUM_ENV=production.",
    )
    seed_parser.add_argument(
        "--keys-file",
        type=Path,
        default=Path(DEFAULT_KEYS_FILE),
        metavar="PATH",
        help=f"where the demo accounts' keys are kept (default: ./{DEFAULT_KEYS_FILE}); "
        "created on the first run and reused after",
    )
    seed_parser.add_argument(
        "--verbose",
        action="store_true",
        help="print the node's own warnings and errors in full as they happen, instead of a short summary",
    )
    seed_parser.set_defaults(handler=_run_seed_demo)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_usage(sys.stderr)
        return 2
    return handler(args)
