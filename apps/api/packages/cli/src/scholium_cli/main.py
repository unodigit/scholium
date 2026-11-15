"""Scholium CLI entry point."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from scholium_cli import __version__, verify


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scholium", description="Verify and inspect Scholium papers."
    )
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")

    verify_parser = commands.add_parser(
        "verify",
        help="verify a paper offline from a CAR archive",
        description="Verify a paper offline from a CARv1 archive and print a "
        "plain-language checklist.  Exits 0 when verified, 1 on any signature "
        "or hash mismatch, 2 when the command could not run.",
    )
    verify.add_arguments(verify_parser)
    verify_parser.set_defaults(handler=verify.run)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_usage(sys.stderr)
        return 2
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
