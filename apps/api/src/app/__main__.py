"""``uv run python -m app`` serves the Scholium API."""

import os

import uvicorn

from . import main as _app_main
from .main import create_app


def main() -> None:
    create_app = globals().get("create_app", _app_main.create_app)
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    forwarded_allow_ips = os.getenv("FORWARDED_ALLOW_IPS", "127.0.0.1")
    uvicorn.run(
        create_app(),
        host=host,
        port=port,
        proxy_headers=True,
        forwarded_allow_ips=forwarded_allow_ips,
    )


if __name__ == "__main__":
    main()
