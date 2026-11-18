"""Fixtures for the end-to-end tests.

A fixture here starts programs, never an application object: ``nodes`` hands out
:class:`~e2e_harness.Node` objects whose ``start_api()`` runs ``python -m app``
(and whose ``start_worker()`` runs ``python -m app.worker``), each in its own
data directory on its own port.  Everything a module starts is stopped when the
module ends, and the logs of a failed test are printed with its report.
"""

from __future__ import annotations

import signal
from pathlib import Path
from typing import Callable, Iterator, Optional

import httpx
import pytest

from e2e_harness import FakeClamd, FakeS3, Node, Published, SmtpSink, publish_listed_paper


def _interrupt(signum, frame):  # pragma: no cover - only on an external kill
    """A SIGTERM (a timeout, a CI cancel) stops the run the way Ctrl-C does: fixtures unwind first."""
    raise KeyboardInterrupt(f"terminated by signal {signum}")


signal.signal(signal.SIGTERM, _interrupt)


class NodeFactory:
    """Creates nodes (and the S3 endpoint and mail server they talk to) and cleans up after them."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.nodes: list[Node] = []
        self._closers: list[Callable[[], None]] = []

    def s3(self, bucket: str = "scholium-e2e") -> FakeS3:
        endpoint = FakeS3(bucket)
        self._closers.append(endpoint.close)
        return endpoint

    def clamd(self) -> FakeClamd:
        daemon = FakeClamd()
        self._closers.append(daemon.close)
        return daemon

    def smtp(self) -> SmtpSink:
        sink = SmtpSink()
        self._closers.append(sink.close)
        return sink

    def make(
        self,
        name: str = "node",
        *,
        storage: str = "fs",
        jobs: str = "thread",
        s3: Optional[FakeS3] = None,
        smtp: "Optional[SmtpSink] | bool" = True,
        **env: Optional[str],
    ) -> Node:
        """A node in a fresh directory.  ``smtp=True`` gives it a mail server of its own."""
        sink = self.smtp() if smtp is True else (smtp or None)
        if storage == "s3" and s3 is None:
            s3 = self.s3()
        directory = self.root / f"{name}-{len(self.nodes)}"
        node = Node(root=directory, name=name, storage=storage, jobs=jobs, s3=s3, smtp=sink, env=dict(env))
        self.nodes.append(node)
        return node

    def close(self) -> None:
        for node in self.nodes:
            node.stop()
        for closer in self._closers:
            closer()


@pytest.fixture(scope="module")
def nodes(tmp_path_factory: pytest.TempPathFactory) -> Iterator[NodeFactory]:
    factory = NodeFactory(tmp_path_factory.mktemp("e2e"))
    try:
        yield factory
    finally:
        factory.close()


#: The deployment shapes the journeys run against.  The code is the same; what
#: differs is where blobs live and who runs the jobs.
#:
#: ``fs+worker``  SQLite, blobs under CONTENT_DIR, a separate ``python -m app.worker``
#: ``s3+thread``  blobs in an S3 bucket, jobs run by the API's own worker thread
DEPLOYMENTS = {
    "fs+worker": dict(storage="fs", jobs="external", worker=True),
    "s3+thread": dict(storage="s3", jobs="thread", worker=False),
}


@pytest.fixture(scope="module", params=sorted(DEPLOYMENTS))
def node(request, nodes: NodeFactory) -> Node:
    """A provisioned, running node: ``init-node``, then ``python -m app`` (and the worker)."""
    spec = dict(DEPLOYMENTS[request.param])
    worker = spec.pop("worker")
    started = nodes.make(request.param.replace("+", "-"), **spec)
    started.init_key()
    started.start_api()
    if worker:
        started.start_worker()
    return started


@pytest.fixture(scope="module")
def http(node: Node) -> Iterator[httpx.Client]:
    with node.client() as client:
        yield client


@pytest.fixture(scope="module")
def paper(node: Node, http: httpx.Client) -> Published:
    """A paper by an author and two co-authors, scanned and listed by a moderator."""
    return publish_listed_paper(node, http, title="Journey paper")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Attach the logs of every program of the node(s) a failing test used."""
    outcome = yield
    report = outcome.get_result()
    if report.when != "call" or report.passed:
        return
    factory: Optional[NodeFactory] = item.funcargs.get("nodes")
    if factory is None:
        for value in item.funcargs.values():
            if isinstance(value, Node):
                factory = NodeFactory(value.root)
                factory.nodes = [value]
                break
    if factory is None:
        return
    for node in factory.nodes:
        for process in (node.api, node.worker, *node.extra):
            if process is not None and process.log.strip():
                tail = "\n".join(process.log.splitlines()[-60:])
                report.sections.append((f"log of {process.name}", tail))
