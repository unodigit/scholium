"""Tests for RFC 9457 problem details error responses."""

from fastapi import FastAPI, Query
from fastapi.testclient import TestClient

from app.errors import install_exception_handlers, status_title


def test_not_found_returns_problem_details(client):
    response = client.get("/v1/does-not-exist")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["type"] == "about:blank"
    assert body["title"] == "Not Found"
    assert body["status"] == 404
    assert body["detail"] is not None
    assert body["instance"] == "/v1/does-not-exist"


def test_validation_returns_field_errors(client):
    tmp = FastAPI()
    install_exception_handlers(tmp)

    @tmp.get("/v1/items")
    def items(limit: int = Query(..., gt=0)):
        return {"limit": limit}

    with TestClient(tmp) as c:
        response = c.get("/v1/items", params={"limit": 0})
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["status"] == 422
    assert body["title"] == "Unprocessable Content"
    assert isinstance(body["errors"], list)
    assert len(body["errors"]) >= 1


def test_http_exception_preserves_headers():
    app = FastAPI()
    install_exception_handlers(app)

    @app.get("/v1/limited")
    def limited():
        from fastapi import HTTPException

        raise HTTPException(status_code=429, detail="Slow down", headers={"Retry-After": "10"})

    with TestClient(app) as c:
        response = c.get("/v1/limited")
    assert response.status_code == 429
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers.get("retry-after") == "10"
    assert response.json()["detail"] == "Slow down"


def test_unhandled_exception_returns_500():
    app = FastAPI()
    install_exception_handlers(app)

    @app.get("/v1/boom")
    def boom():
        raise RuntimeError("kaboom")

    with TestClient(app, raise_server_exceptions=False) as c:
        response = c.get("/v1/boom")
    assert response.status_code == 500
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["title"] == "Internal Server Error"


def test_status_title():
    assert status_title(404) == "Not Found"
    assert status_title(422) == "Unprocessable Content"
