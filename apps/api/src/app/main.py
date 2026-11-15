"""FastAPI application factory."""

from fastapi import FastAPI

from . import db, module_loader


def create_app() -> FastAPI:
    app = FastAPI(title="Scholium")

    # Load modules first so their models register on Base.metadata.
    module_loader.load_modules(app)

    # Create database tables after modules have loaded.
    db.Base.metadata.create_all(bind=db.engine)

    @app.get("/healthz", status_code=200)
    def healthz() -> dict:
        return {"status": "ok"}

    return app


app = create_app()