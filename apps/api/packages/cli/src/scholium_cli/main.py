"""Scholium CLI entry point."""

import argparse


def main() -> int:
    parser = argparse.ArgumentParser(prog="scholium")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()
    if args.version:
        from scholium_cli import __version__

        print(__version__)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())