"""Module shim that installs RFC 9457 handlers when the app is created."""

from app.errors import install_exception_handlers


def on_startup(app) -> None:
    install_exception_handlers(app)


startup = on_startup
