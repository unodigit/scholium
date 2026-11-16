"""``python -m app.modules.admin init-node``: give a fresh node its key.

Nothing else in the app creates the file at ``NODE_KEY_PATH`` -- every reader
of it (:func:`app.modules.ledger.origin.node_signing_key` and friends) treats
a missing key as "the node signs nothing of its own".  This command is the
one way a node gets an identity.
"""

from __future__ import annotations

import re
import stat

from nacl.signing import SigningKey
from scholium_record_core import did_key_from_signing_key

from app.modules.admin.cli import build_parser, main
from app.modules.ledger.origin import node_signing_key
from app.settings import settings

from .test_seed_demo import _plain_uv_run

_DID = re.compile(r"did:key:z[1-9A-HJ-NP-Za-km-z]+")


def _read_key(path) -> SigningKey:
    key = node_signing_key(str(path))
    assert key is not None, f"{path} does not hold a key the node can sign with"
    return key


def test_init_node_creates_the_key_the_node_reads_at_node_key_path(tmp_path, monkeypatch, capsys):
    key_file = tmp_path / "keys" / "node.key"  # the directory is not there yet either
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(key_file))

    assert main(["init-node"]) == 0

    out = capsys.readouterr().out
    dids = _DID.findall(out)
    assert len(dids) == 1 and "created" in out
    assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
    key = _read_key(key_file)
    assert did_key_from_signing_key(key) == dids[0]  # what it printed is what it made


def test_init_node_refuses_to_replace_an_existing_key_unless_forced(tmp_path, monkeypatch, capsys):
    key_file = tmp_path / "node.key"
    before = SigningKey.generate().encode().hex()
    key_file.write_text(before)
    monkeypatch.setattr(settings, "NODE_KEY_PATH", str(key_file))

    assert main(["init-node"]) == 1
    err = capsys.readouterr().err
    assert "already exists" in err and "--force" in err
    assert key_file.read_text() == before  # the identity others may know is not thrown away

    assert main(["init-node", "--force"]) == 0
    out = capsys.readouterr().out
    replaced = key_file.read_text().strip()
    assert replaced != before and len(bytes.fromhex(replaced)) == 32
    assert stat.S_IMODE(key_file.stat().st_mode) == 0o600
    key = _read_key(key_file)
    assert bytes(key).hex() == replaced
    assert did_key_from_signing_key(key) in out and "replaced" in out


def test_the_parser_offers_init_node_with_force_off_by_default():
    parser = build_parser()

    args = parser.parse_args(["init-node"])

    assert args.force is False
    assert "init-node" in parser.format_help()


def test_init_node_runs_where_the_record_core_is_not_installed(tmp_path):
    """The command is run as ``uv run python -m app.modules.admin init-node``, no ``--all-packages``."""
    env = {"NODE_KEY_PATH": str(tmp_path / "node.key")}

    result = _plain_uv_run("normal", "init-node", cwd=tmp_path, env=env)

    assert result.returncode == 0, result.stderr[-2000:]
    seed = bytes.fromhex((tmp_path / "node.key").read_text().strip())
    assert len(seed) == 32  # a seed the node can sign with, not an empty gesture
