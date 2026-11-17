"""``python -m app.sandbox_service`` serves the sandbox service.

Configuration is read from the environment (see :mod:`app.sandbox_service.app`);
``--host`` and ``--port`` override ``HOST`` and ``PORT``.  The default is
``127.0.0.1:8001``: listening on every interface (``HOST=0.0.0.0``, as in a
container) has to be asked for.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from typing import Optional, Sequence

import uvicorn

from .app import ServiceConfigError, create_app

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Start the service; the process exit status (2 for a configuration error)."""
    parser = argparse.ArgumentParser(
        prog="python -m app.sandbox_service",
        description="Run the reproducibility sandbox as a service for SANDBOX_BACKEND=remote.",
    )
    parser.add_argument("--host", help=f"address to listen on (HOST, default {DEFAULT_HOST})")
    parser.add_argument(
        "--port", type=int, help=f"port to listen on (PORT, default {DEFAULT_PORT})"
    )
    args = parser.parse_args(argv)

    try:
        port = args.port if args.port is not None else int(os.getenv("PORT") or DEFAULT_PORT)
    except ValueError:
        print("sandbox service: PORT must be an integer", file=sys.stderr)
        return 2
    host = args.host or os.getenv("HOST") or DEFAULT_HOST

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        application = create_app()
    except ServiceConfigError as exc:
        print(f"sandbox service: {exc}", file=sys.stderr)
        return 2
    uvicorn.run(application, host=host, port=port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
