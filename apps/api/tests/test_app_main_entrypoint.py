import os

import uvicorn

import app.__main__ as entrypoint


def test_main_invokes_uvicorn_with_env(monkeypatch):
    captured = {}

    def fake_run(app, **kwargs):
        captured["app"] = app
        captured.update(kwargs)

    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setenv("HOST", "0.0.0.0")
    monkeypatch.setenv("PORT", "9000")
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "10.0.0.1")

    entrypoint.main()

    assert captured["host"] == "0.0.0.0"
    assert captured["port"] == 9000
    assert captured["proxy_headers"] is True
    assert captured["forwarded_allow_ips"] == "10.0.0.1"
