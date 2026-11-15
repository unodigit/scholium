"""Discover and load application modules under app.modules."""

import asyncio
import importlib
import pkgutil
from typing import Any, List

from fastapi import FastAPI

MODULES_PACKAGE = "app.modules"


def _call_hook(hook: Any, app: FastAPI) -> None:
    try:
        result = hook(app)
    except TypeError:
        result = hook()
    if asyncio.iscoroutine(result):
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(result)
            else:
                loop.run_until_complete(result)
        except RuntimeError:
            asyncio.run(result)


def load_modules(app: FastAPI) -> List[Any]:
    """Import every package/module under app.modules and wire it up."""
    loaded: List[Any] = []
    try:
        package = importlib.import_module(MODULES_PACKAGE)
    except ModuleNotFoundError:
        return loaded

    paths = getattr(package, "__path__", None)
    if not paths:
        return loaded

    for info in pkgutil.iter_modules(paths, package.__name__ + "."):
        module = importlib.import_module(info.name)
        router = getattr(module, "router", None)
        if router is not None:
            app.include_router(router, prefix="/v1")
        for hook_name in ("on_startup", "startup"):
            hook = getattr(module, hook_name, None)
            if callable(hook):
                _call_hook(hook, app)
                break
        loaded.append(module)
    return loaded