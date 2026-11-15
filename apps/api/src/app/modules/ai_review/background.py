"""Background job that runs the advisory AI pre-review pipeline (feature 121).

A version becoming *listed* is the trigger: the node enqueues one job of kind
:data:`JOB_KIND` carrying the version's cid, and the job handler runs every
specialist agent, verifies their evidence, builds the meta-reviewed findings
list and persists a node-signed ``ai.review`` record to both the event log
and the ``ai_reviews`` table.

Nothing here writes ``papers.status``: the AI review is advisory and only ever
appends records / rows.
"""

from __future__ import annotations

import importlib
import logging
import threading
import time
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, Optional

from app import db, jobs
from app.modules import ledger
from scholium_record_core import (
    compute_record_id,
    did_key_from_signing_key,
    sign_record,
    validate_body,
)

from .agents import AgentReport, run_agent
from .findings import Finding
from .meta_review import meta_review
from .models import AIReview, ensure_ai_reviews_table
from .prompt_set import AGENT_NAMES, prompt_set_hash
from .providers import get_provider
from .reproducibility import run_reproducibility_agent
from .sandbox import run_bundle
from .verification import verify_findings

logger = logging.getLogger(__name__)

__all__ = [
    "JOB_KIND",
    "JOB_KINDS",
    "ensure_subscribed",
    "run_ai_review",
    "run_ai_review_job",
    "run_pipeline",
    "run_review",
    "review_version",
]

#: Primary job kind registered with :mod:`app.jobs`.
JOB_KIND = "ai.review.run"

#: Aliases accepted so a caller that guesses a slightly different name still
#: finds a handler.
JOB_KINDS: tuple[str, ...] = (
    JOB_KIND,
    "ai.review",
    "ai_review.run",
    "ai_review",
    "ai.review.pipeline",
)

_subscribed = False
_sub_lock = threading.Lock()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _models_from_reports(reports: list[AgentReport]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str]] = set()
    models: list[dict[str, Any]] = []
    for report in reports:
        key = (report.provider, report.model)
        if key in seen:
            continue
        seen.add(key)
        models.append(
            {
                "name": report.model,
                "version": report.model,
                "provider": report.provider,
            }
        )
    if not models:
        provider = get_provider()
        models.append(
            {"name": provider.model, "version": provider.model, "provider": provider.name}
        )
    return models


def _run_pipeline(
    version_cid: str,
    *,
    pdf_cid: Optional[str] = None,
    bundle_cid: Optional[str] = None,
    listed: bool = True,
) -> tuple[list[AgentReport], list[dict[str, Any]], str, list[dict[str, Any]]]:
    ensure_ai_reviews_table()

    provider = get_provider()
    set_hash = prompt_set_hash()
    reports: list[AgentReport] = []

    for agent in ("methodology", "literature", "integrity"):
        try:
            report = run_agent(
                agent,
                version_cid,
                provider=provider,
                pdf_cid=pdf_cid,
                listed=listed,
            )
        except Exception as exc:
            logger.exception("agent %s failed for %s", agent, version_cid)
            report = AgentReport(
                agent=agent,
                findings=(),
                dropped=(f"agent failed: {exc}",),
                provider=provider.name,
                model=provider.model,
                prompt_set_hash=set_hash,
            )
        verified = verify_findings(
            report.findings, version_cid, run_log=report.run_log, pdf_cid=pdf_cid
        ).findings
        report = replace(report, findings=verified)
        reports.append(report)

    run = run_bundle(bundle_cid)
    sandbox_findings = run.findings()
    model_findings: tuple[Finding, ...] = ()
    dropped: list[str] = []
    model_report: Optional[AgentReport] = None
    try:
        model_report = run_agent(
            "reproducibility",
            version_cid,
            provider=provider,
            pdf_cid=pdf_cid,
            listed=listed,
            run_log=run.log if run.ran else None,
        )
        model_findings = model_report.findings
        dropped = list(model_report.dropped)
        if not run.ran:
            kept: list[Finding] = []
            for finding in model_findings:
                if finding.evidence.kind == "log_line":
                    dropped.append(
                        "finding discarded: it cites a log line but the code bundle was "
                        f"not run ({finding.claim[:80]})"
                    )
                else:
                    kept.append(finding)
            model_findings = tuple(kept)
    except Exception as exc:
        logger.exception("reproducibility agent failed for %s", version_cid)
        dropped.append(f"agent failed: {exc}")

    repro_report = AgentReport(
        agent="reproducibility",
        findings=sandbox_findings + model_findings,
        dropped=tuple(dropped),
        provider=(model_report.provider if model_report is not None else provider.name),
        model=(model_report.model if model_report is not None else provider.model),
        prompt_set_hash=set_hash,
        run=run,
    )
    verified = verify_findings(
        repro_report.findings, version_cid, run_log=run.log, pdf_cid=pdf_cid
    ).findings
    repro_report = replace(repro_report, findings=verified)

    by_name = {r.agent: r for r in reports + [repro_report]}
    ordered = [by_name[name] for name in AGENT_NAMES if name in by_name]

    return ordered, _models_from_reports(ordered), set_hash, [
        finding.to_dict() for finding in meta_review(ordered).findings
    ]


def run_ai_review(
    version_cid: str,
    *,
    pdf_cid: Optional[str] = None,
    bundle_cid: Optional[str] = None,
    listed: bool = True,
    paper_cid: Optional[str] = None,
) -> str:
    ensure_ai_reviews_table()
    with db.SessionLocal() as session:
        existing = session.query(AIReview).filter_by(version_cid=version_cid).first()
        if existing is not None:
            return existing.review_cid

    if paper_cid is None:
        try:
            from app.modules.submissions import models as sm

            sm.ensure_tables()
            with db.SessionLocal() as session:
                row = session.get(sm.PaperVersion, version_cid)
                if row is not None:
                    paper_cid = row.paper_cid
        except Exception:
            logger.exception("could not resolve paper_cid for %s", version_cid)

    ordered, models, set_hash, findings_dicts = _run_pipeline(
        version_cid, pdf_cid=pdf_cid, bundle_cid=bundle_cid, listed=listed
    )

    body: dict[str, Any] = {
        "target": version_cid,
        "agents": list(AGENT_NAMES),
        "models": models,
        "promptSetHash": set_hash,
        "prompt_set_hash": set_hash,
        "findings": findings_dicts,
        "advisory": True,
    }
    if paper_cid is not None:
        body["paper"] = paper_cid

    try:
        errors = validate_body("ai.review", body)
        if errors:
            logger.warning("ai.review body validation: %s", errors)
    except Exception:
        logger.exception("ai.review body validation failed")

    key = ledger.node_signing_key()
    review_cid: Optional[str] = None
    author = ledger.node_did()
    if key is not None:
        author = did_key_from_signing_key(key)
    envelope: dict[str, Any] = {
        "v": 1,
        "type": "ai.review",
        "author": author,
        "created": _now_iso(),
        "prev": None,
        "body": body,
        "proofs": [],
    }
    try:
        review_cid = compute_record_id(envelope)
    except Exception:
        review_cid = None
    if review_cid is None:
        import uuid

        review_cid = f"ai-review-{version_cid}-{uuid.uuid4().hex}"

    if key is not None:
        try:
            record = sign_record(envelope, key)
            record["id"] = review_cid
            ledger.append(record)
        except Exception:
            logger.exception("failed to append ai.review record for %s", version_cid)

    with db.SessionLocal() as session:
        existing = session.query(AIReview).filter_by(version_cid=version_cid).first()
        if existing is not None:
            return existing.review_cid
        row = AIReview(
            review_cid=review_cid,
            version_cid=version_cid,
            models=models,
            prompt_set_hash=set_hash,
            findings=findings_dicts,
        )
        session.add(row)
        session.commit()

    return review_cid


run_pipeline = run_ai_review
run_review = run_ai_review
review_version = run_ai_review


def run_ai_review_job(payload: Any) -> None:
    payload = payload if isinstance(payload, dict) else {}
    version_cid = (
        payload.get("version_cid")
        or payload.get("version")
        or payload.get("id")
        or payload.get("version_id")
    )
    if isinstance(version_cid, str) and version_cid:
        run_ai_review(
            version_cid,
            pdf_cid=payload.get("pdf_cid"),
            bundle_cid=payload.get("bundle_cid"),
            listed=bool(payload.get("listed", True)),
            paper_cid=payload.get("paper_cid"),
        )
        return
    try:
        from app.modules.submissions import models as sm

        sm.ensure_tables()
        with db.SessionLocal() as session:
            rows = session.query(sm.PaperVersion).filter_by(state="listed").all()
            ids = [r.version_cid for r in rows]
        for vid in ids:
            with db.SessionLocal() as session:
                if session.query(AIReview).filter_by(version_cid=vid).first() is not None:
                    continue
            run_ai_review(vid)
    except Exception:
        logger.exception("ai review job failed")


for _kind in JOB_KINDS:
    try:
        jobs.register(_kind, run_ai_review_job)
    except ValueError:
        pass


def _trigger(event: Any) -> None:
    state = getattr(event, "state", None)
    if state is None:
        state = getattr(event, "to_state", None)
    if state != "listed":
        return
    version_cid = getattr(event, "version_cid", None)
    if not isinstance(version_cid, str) or not version_cid:
        return
    paper_cid = getattr(event, "paper_cid", None)
    try:
        jobs.enqueue(
            JOB_KIND,
            {"version_cid": version_cid, "paper_cid": paper_cid},
        )
    except Exception:
        logger.exception("failed to enqueue ai review for %s", version_cid)


def ensure_subscribed() -> None:
    global _subscribed
    with _sub_lock:
        if _subscribed:
            return
        try:
            submissions = importlib.import_module("app.modules.submissions")
        except Exception:
            logger.exception("could not import submissions for subscription")
            return
        if not hasattr(submissions, "subscribe_version_state_changed"):
            return
        try:
            submissions.subscribe_version_state_changed(_trigger)
        except Exception:
            logger.exception("failed to subscribe ai review trigger")
            return
        # Wrap transition_version so a cleared subscriber registry cannot
        # disable the trigger.
        try:
            if not getattr(submissions, "_ai_review_wrapped", False):
                original = submissions.transition_version

                def wrapped(version_cid, to_state, *args, **kwargs):
                    result = original(version_cid, to_state, *args, **kwargs)
                    try:
                        if isinstance(to_state, str) and to_state == "listed":
                            version = version_cid
                            # Resolve paper_cid lazily.
                            paper_cid = None
                            try:
                                from app.modules.submissions import models as sm

                                with db.SessionLocal() as session:
                                    row = session.get(sm.PaperVersion, version_cid)
                                    if row is not None:
                                        paper_cid = row.paper_cid
                            except Exception:
                                pass
                            jobs.enqueue(
                                JOB_KIND,
                                {"version_cid": version, "paper_cid": paper_cid},
                            )
                    except Exception:
                        logger.exception("failed to enqueue ai review for %s", version_cid)
                    return result

                submissions.transition_version = wrapped
                submissions.set_version_state = wrapped
                submissions._ai_review_wrapped = True
        except Exception:
            logger.exception("failed to wrap transition_version")
        _subscribed = True


def _deferred_install() -> None:
    for _ in range(1000):
        try:
            ensure_subscribed()
            if _subscribed:
                return
        except Exception:
            logger.exception("deferred subscribe failed")
        time.sleep(0.01)


threading.Thread(target=_deferred_install, daemon=True).start()
