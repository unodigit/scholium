"""The ObjectStore contract, and the filesystem driver's tests.

:class:`ObjectStoreContract` holds the behaviour *any* driver must have.  It
is not collected itself (its name does not start with ``Test``); each driver's
test module subclasses it and supplies a ``store`` fixture::

    class TestFilesystemContract(ObjectStoreContract):
        @pytest.fixture
        def store(self, root):
            return FilesystemObjectStore(root)

This module runs it against the filesystem driver and ``test_s3.py`` imports
it to run it against the S3 driver on moto, so the two cannot drift apart
without a test failing.  It lives in a test module (not ``__init__.py``) so
pytest rewrites its assertions and a failure shows what was compared.
Anything specific to one driver belongs in that driver's tests, below here
for the filesystem.

The rest of this module is the filesystem driver's own: the on-disk layout
(which existing ``CONTENT_DIR`` data depends on), the atomic temp-file /
fsync / rename write, directory housekeeping, and the ``STORAGE_BACKEND=fs``
default.
"""

from __future__ import annotations

import hashlib
import io
import os
import random
import stat
import threading

import pytest

from app.settings import Settings, settings
from app.storage import (
    TMP_DIRNAME,
    FilesystemObjectStore,
    InvalidKeyError,
    InvalidRangeError,
    KeyConflictError,
    ObjectNotFoundError,
    ObjectStore,
    StorageConfigError,
    StoredObject,
    get_object_store,
)


#: Larger than any single read chunk (1 MiB) and than the S3 part size the S3
#: tests use (5 MiB), so a driver that mishandles chunk or part boundaries
#: shows up here, whatever the boundaries are.
LARGE = random.Random(20260518).randbytes(11 * 1024 * 1024 + 123)

DIGITS = b"0123456789"


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def put(store: ObjectStore, key: str, data: bytes) -> StoredObject:
    return store.put_stream(key, io.BytesIO(data))


def read(store: ObjectStore, key: str, **range_arguments) -> bytes:
    with store.open(key, **range_arguments) as body:
        return body.read()


class Dribble:
    """A binary stream that hands over at most ``step`` bytes per read, whatever is asked."""

    def __init__(self, data: bytes, step: int = 7) -> None:
        self._data = io.BytesIO(data)
        self._step = step

    def read(self, size: int = -1, /) -> bytes:
        return self._data.read(min(size, self._step) if size >= 0 else self._step)


class Failing:
    """A binary stream that delivers ``good`` bytes and then raises."""

    def __init__(self, good: int) -> None:
        self._good = good

    def read(self, size: int = -1, /) -> bytes:
        if self._good <= 0:
            raise RuntimeError("the source went away")
        count = min(size, self._good) if size >= 0 else self._good
        self._good -= count
        return b"x" * count


#: Keys no driver may accept, with why.
INVALID_KEYS = {
    "empty": "",
    "leading slash": "/a",
    "trailing slash": "a/",
    "empty segment": "a//b",
    "parent segment": "../a",
    "inner parent segment": "a/../b",
    "dot segment": "a/./b",
    "only a dot": ".",
    "hidden segment": "a/.hidden",
    "hidden first segment": ".tmp/blob",
    "legacy staging directory": ".uploads/abc",
    "backslash": "a\\b",
    "nul": "a\x00b",
    "newline": "a\nb",
    "control character": "a\x1fb",
    "delete character": "a\x7fb",
    "lone surrogate": "a\ud800b",
    "segment over 255 bytes": "a" * 256,
    "key over 1024 bytes": "/".join(["a" * 200] * 6),
    "none": None,
    "bytes": b"a",
    "int": 5,
}

#: Awkward but valid keys: they must round-trip and be listed as written.
AWKWARD_KEYS = {
    "spaces": "a b/c d",
    "url characters": "q?x=1&y=2#frag/100%/a+b",
    "unicode": "résumé/日本語/ключ",
    "dots inside": "a.b/c..d/e.",
    "longest segment": "s" * 255,
    "longest key": "/".join(["k" * 200] * 5),
    "cid-like": "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
}


class ObjectStoreContract:
    """Behaviour every :class:`ObjectStore` driver has.  Subclass and provide ``store``."""

    # -- put_stream -----------------------------------------------------------

    def test_put_stream_reports_what_it_stored(self, store):
        data = b"the quick brown fox"

        stored = put(store, "doc", data)

        assert stored == StoredObject(key="doc", size=len(data), sha256=sha256(data))

    @pytest.mark.parametrize(
        "data",
        [b"", b"x", b"hello world", bytes(range(256)) * 41, b"\x00" * 1000, b"\xff\xfe\r\n"],
        ids=["empty", "one byte", "text", "every byte value", "zeros", "binary line ends"],
    )
    def test_bytes_round_trip(self, store, data):
        put(store, "obj", data)

        assert read(store, "obj") == data
        assert store.size("obj") == len(data)
        assert store.exists("obj") is True

    def test_a_large_stream_round_trips(self, store):
        stored = put(store, "large", LARGE)

        assert stored.size == len(LARGE)
        assert stored.sha256 == sha256(LARGE)
        assert store.size("large") == len(LARGE)
        assert read(store, "large") == LARGE

    def test_a_stream_that_returns_short_reads_is_stored_whole(self, store):
        data = bytes(range(256)) * 30

        stored = store.put_stream("slow", Dribble(data))

        assert stored.size == len(data)
        assert read(store, "slow") == data

    def test_put_replaces_the_object_at_a_key(self, store):
        put(store, "k", b"a long original value")
        put(store, "k", b"short")

        assert read(store, "k") == b"short"
        assert store.size("k") == 5
        assert list(store.list()) == ["k"]

    def test_putting_the_same_bytes_again_is_harmless(self, store):
        put(store, "k", b"same")
        stored = put(store, "k", b"same")

        assert stored.size == 4
        assert read(store, "k") == b"same"

    def test_the_same_bytes_can_live_at_two_keys(self, store):
        put(store, "one", b"shared")
        put(store, "two", b"shared")
        store.delete("one")

        assert store.exists("one") is False
        assert read(store, "two") == b"shared"

    def test_a_text_stream_is_refused_and_stores_nothing(self, store):
        with pytest.raises(TypeError):
            store.put_stream("text", io.StringIO("not bytes"))

        assert store.exists("text") is False
        assert list(store.list()) == []

    def test_something_that_is_not_a_stream_is_refused(self, store):
        with pytest.raises(TypeError):
            store.put_stream("notastream", b"raw bytes, not a stream")  # type: ignore[arg-type]

        assert store.exists("notastream") is False

    def test_a_stream_that_fails_stores_nothing(self, store):
        with pytest.raises(RuntimeError, match="went away"):
            store.put_stream("broken", Failing(good=6 * 1024 * 1024))

        assert store.exists("broken") is False
        assert list(store.list()) == []

    def test_a_stream_that_fails_before_any_byte_stores_nothing(self, store):
        with pytest.raises(RuntimeError, match="went away"):
            store.put_stream("broken", Failing(good=0))

        assert store.exists("broken") is False

    def test_a_stream_that_fails_leaves_the_previous_object_untouched(self, store):
        put(store, "k", b"precious original")

        with pytest.raises(RuntimeError, match="went away"):
            store.put_stream("k", Failing(good=6 * 1024 * 1024))

        assert read(store, "k") == b"precious original"

    def test_concurrent_puts_of_different_keys_all_land_whole(self, store):
        values = {f"worker/{n}": bytes([n]) * (300_000 + n) for n in range(1, 7)}
        errors = []

        def writer(key, value):
            try:
                for _ in range(3):
                    put(store, key, value)
                    assert read(store, key) == value
            except BaseException as exc:  # noqa: BLE001 -- surfaced below
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=item) for item in values.items()]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert errors == []
        assert list(store.list("worker/")) == sorted(values)
        for key, value in values.items():
            assert read(store, key) == value

    # -- open -----------------------------------------------------------------

    def test_open_streams_in_pieces(self, store):
        data = bytes(range(200)) * 5
        put(store, "obj", data)

        pieces = []
        with store.open("obj") as body:
            while piece := body.read(64):
                assert len(piece) <= 64
                pieces.append(piece)

        assert b"".join(pieces) == data

    def test_open_returns_something_that_closes(self, store):
        put(store, "obj", b"data")

        with store.open("obj") as body:
            assert body.readable()
        assert body.closed

    def test_open_of_a_missing_object_is_not_found(self, store):
        with pytest.raises(ObjectNotFoundError):
            store.open("missing")

    def test_not_found_is_also_a_file_not_found_error(self, store):
        with pytest.raises(FileNotFoundError):
            store.open("missing")
        with pytest.raises(FileNotFoundError):
            store.size("missing")

    # -- byte ranges ----------------------------------------------------------

    @pytest.mark.parametrize(
        "offset, length",
        [
            (0, 1),
            (0, 4),
            (0, 10),
            (0, 11),
            (0, 1000),
            (3, 4),
            (3, None),
            (9, 1),
            (9, 5),
            (9, None),
            (10, None),
            (10, 5),
            (5, 0),
            (0, 0),
            (10, 0),
        ],
    )
    def test_a_byte_range_is_that_slice(self, store, offset, length):
        put(store, "digits", DIGITS)
        end = None if length is None else offset + length

        assert read(store, "digits", offset=offset, length=length) == DIGITS[offset:end]

    def test_an_offset_alone_reads_to_the_end(self, store):
        put(store, "large", LARGE)
        offset = 5 * 1024 * 1024 - 17  # straddles the S3 test part size

        assert read(store, "large", offset=offset) == LARGE[offset:]

    def test_a_range_can_cross_chunk_and_part_boundaries(self, store):
        put(store, "large", LARGE)
        start, count = 5 * 1024 * 1024 - 100, 2 * 1024 * 1024 + 300

        assert read(store, "large", offset=start, length=count) == LARGE[start : start + count]

    def test_a_ranged_stream_stops_at_the_end_of_the_range(self, store):
        put(store, "digits", DIGITS)

        with store.open("digits", offset=2, length=3) as body:
            assert body.read(2) == b"23"
            assert body.read(100) == b"4"
            assert body.read(100) == b""
            assert body.read() == b""

    def test_the_default_range_is_the_whole_object(self, store):
        put(store, "digits", DIGITS)

        assert read(store, "digits", offset=0, length=None) == DIGITS

    @pytest.mark.parametrize("offset, length", [(11, None), (11, 1), (11, 0), (500, None), (500, 3)])
    def test_an_offset_past_the_end_is_an_invalid_range(self, store, offset, length):
        put(store, "digits", DIGITS)

        with pytest.raises(InvalidRangeError):
            store.open("digits", offset=offset, length=length)

    def test_an_empty_object_has_only_empty_ranges(self, store):
        put(store, "nothing", b"")

        assert read(store, "nothing") == b""
        assert read(store, "nothing", offset=0, length=5) == b""
        assert read(store, "nothing", offset=0, length=0) == b""
        with pytest.raises(InvalidRangeError):
            store.open("nothing", offset=1)

    @pytest.mark.parametrize("offset, length", [(0, None), (0, 3), (2, 0), (50, None)])
    def test_a_range_of_a_missing_object_is_not_found(self, store, offset, length):
        with pytest.raises(ObjectNotFoundError):
            store.open("missing", offset=offset, length=length)

    @pytest.mark.parametrize(
        "offset, length",
        [(-1, None), (0, -1), (-1, -1), ("1", None), (0, "1"), (1.5, None), (0, 1.5), (None, None)],
    )
    def test_nonsense_range_arguments_are_a_value_error(self, store, offset, length):
        put(store, "digits", DIGITS)

        with pytest.raises(ValueError):
            store.open("digits", offset=offset, length=length)

    # -- size, exists, delete -------------------------------------------------

    def test_size_of_a_missing_object_is_not_found(self, store):
        with pytest.raises(ObjectNotFoundError):
            store.size("missing")

    def test_exists_is_false_for_a_missing_object(self, store):
        assert store.exists("missing") is False

    def test_a_key_prefix_is_not_an_object(self, store):
        put(store, "dir/leaf", b"x")

        assert store.exists("dir") is False
        with pytest.raises(ObjectNotFoundError):
            store.size("dir")
        with pytest.raises(ObjectNotFoundError):
            store.open("dir")

    def test_delete_removes_the_object(self, store):
        put(store, "gone", b"bye")

        store.delete("gone")

        assert store.exists("gone") is False
        assert list(store.list()) == []
        with pytest.raises(ObjectNotFoundError):
            store.open("gone")

    def test_delete_of_a_missing_object_is_a_no_op(self, store):
        store.delete("never-there")
        put(store, "k", b"v")
        store.delete("k")
        store.delete("k")

        assert store.exists("k") is False

    def test_delete_touches_only_its_own_key(self, store):
        for key in ("a-b", "a/b", "a/bc", "a/c/d", "ab"):
            put(store, key, key.encode())

        store.delete("a/b")

        assert list(store.list()) == ["a-b", "a/bc", "a/c/d", "ab"]
        assert read(store, "a/c/d") == b"a/c/d"

    def test_delete_of_a_prefix_deletes_nothing(self, store):
        put(store, "dir/leaf", b"x")

        store.delete("dir")

        assert read(store, "dir/leaf") == b"x"

    def test_a_key_can_be_reused_after_delete(self, store):
        put(store, "dir/leaf", b"one")
        store.delete("dir/leaf")
        put(store, "dir/leaf", b"two")
        put(store, "dir/other", b"three")
        store.delete("dir/other")

        assert read(store, "dir/leaf") == b"two"

    # -- list -----------------------------------------------------------------

    def test_list_of_an_empty_store_is_empty(self, store):
        assert list(store.list()) == []
        assert list(store.list("anything")) == []

    def test_list_returns_every_key_in_order(self, store):
        keys = ["zebra", "apple", "uploads/b/2", "uploads/a/1", "mango", "uploads/a/0"]
        for key in keys:
            put(store, key, b"v")

        assert list(store.list()) == sorted(keys)
        assert list(store.list("")) == sorted(keys)

    def test_list_filters_by_prefix(self, store):
        for key in ("uploads/a/1", "uploads/a/2", "uploads/b/1", "uploadsX", "other/uploads/a/1", "u"):
            put(store, key, b"v")

        assert list(store.list("uploads/a/")) == ["uploads/a/1", "uploads/a/2"]
        assert list(store.list("uploads/")) == ["uploads/a/1", "uploads/a/2", "uploads/b/1"]
        assert list(store.list("uploads")) == ["uploads/a/1", "uploads/a/2", "uploads/b/1", "uploadsX"]
        assert list(store.list("nothing/")) == []
        assert list(store.list("uploads/c")) == []

    def test_a_prefix_is_a_string_prefix_not_a_segment_prefix(self, store):
        for key in ("ab/c", "ab/cd/e", "abc", "abd/x", "b"):
            put(store, key, b"v")

        assert list(store.list("ab")) == ["ab/c", "ab/cd/e", "abc", "abd/x"]
        assert list(store.list("ab/")) == ["ab/c", "ab/cd/e"]
        assert list(store.list("ab/c")) == ["ab/c", "ab/cd/e"]
        assert list(store.list("abd/")) == ["abd/x"]
        assert list(store.list("a")) == ["ab/c", "ab/cd/e", "abc", "abd/x"]

    def test_a_prefix_equal_to_a_whole_key_includes_it(self, store):
        put(store, "k", b"v")

        assert list(store.list("k")) == ["k"]

    def test_list_is_in_utf8_byte_order(self, store):
        keys = ["a/b", "a-b", "a.b", "a0", "aB", "é", "z", "日本", "a/c/d", "b/x"]
        for key in keys:
            put(store, key, b"v")

        assert list(store.list()) == sorted(keys, key=lambda key: key.encode("utf-8"))

    def test_list_checks_the_prefix_when_called(self, store):
        with pytest.raises(InvalidKeyError):
            store.list("../x")

    @pytest.mark.parametrize("prefix", ["..", "a/..", "a//b", "/", "/a", ".hidden", "a/.b", "a\\b", "a\x00", None, 7])
    def test_list_refuses_an_unusable_prefix(self, store, prefix):
        with pytest.raises(InvalidKeyError):
            store.list(prefix)

    def test_list_lists_awkward_keys_as_written(self, store):
        for key in AWKWARD_KEYS.values():
            put(store, key, b"v")

        assert list(store.list()) == sorted(AWKWARD_KEYS.values(), key=lambda key: key.encode("utf-8"))

    # -- keys -----------------------------------------------------------------

    @pytest.mark.parametrize("key", AWKWARD_KEYS.values(), ids=AWKWARD_KEYS.keys())
    def test_awkward_but_valid_keys_round_trip(self, store, key):
        put(store, key, key.encode("utf-8"))

        assert store.exists(key) is True
        assert store.size(key) == len(key.encode("utf-8"))
        assert read(store, key) == key.encode("utf-8")
        store.delete(key)
        assert store.exists(key) is False

    @pytest.mark.parametrize("key", INVALID_KEYS.values(), ids=INVALID_KEYS.keys())
    def test_an_invalid_key_is_refused_by_every_operation(self, store, key):
        put(store, "innocent", b"v")

        with pytest.raises(InvalidKeyError):
            store.put_stream(key, io.BytesIO(b"x"))
        with pytest.raises(InvalidKeyError):
            store.open(key)
        with pytest.raises(InvalidKeyError):
            store.size(key)
        with pytest.raises(InvalidKeyError):
            store.exists(key)
        with pytest.raises(InvalidKeyError):
            store.delete(key)
        assert list(store.list()) == ["innocent"]

    def test_an_invalid_key_is_also_a_value_error(self, store):
        with pytest.raises(ValueError):
            store.exists("../escape")

    def test_a_path_that_looks_like_traversal_stores_nothing_outside(self, store):
        with pytest.raises(InvalidKeyError):
            put(store, "../outside", b"x")
        with pytest.raises(InvalidKeyError):
            put(store, "a/../../outside", b"x")

        assert list(store.list()) == []


# ===== the filesystem driver ================================================

#: A real raw-codec CID, as the content store names its files.
CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy"


@pytest.fixture
def root(tmp_path):
    return tmp_path / "content"


class TestFilesystemContract(ObjectStoreContract):
    @pytest.fixture
    def store(self, root):
        return FilesystemObjectStore(root)


# -- layout: what existing CONTENT_DIR data looks like ----------------------------


def test_an_object_is_a_plain_file_named_by_its_key(root):
    store = FilesystemObjectStore(root)

    put(store, CID, b"flat, like it has always been")

    assert (root / CID).read_bytes() == b"flat, like it has always been"
    assert sorted(path.name for path in root.iterdir()) == [TMP_DIRNAME, CID]


def test_a_nested_key_is_a_nested_path(root):
    store = FilesystemObjectStore(root)

    put(store, "uploads/Zk3x/00000001", b"part")

    assert (root / "uploads" / "Zk3x" / "00000001").read_bytes() == b"part"
    assert store.path_for("uploads/Zk3x/00000001") == root / "uploads" / "Zk3x" / "00000001"


def test_files_already_in_the_directory_are_readable_byte_for_byte(root):
    root.mkdir()
    (root / CID).write_bytes(b"written before this driver existed")
    (root / ".uploads").mkdir()
    (root / ".uploads" / "in-flight").write_bytes(b"a staged upload")
    store = FilesystemObjectStore(root)

    assert store.exists(CID)
    assert store.size(CID) == 34
    assert read(store, CID) == b"written before this driver existed"
    assert read(store, CID, offset=8, length=6) == b"before"
    assert list(store.list()) == [CID]  # the legacy staging directory is not an object


def test_what_the_content_store_wrote_is_readable_and_the_reverse(root, monkeypatch):
    from app.modules.content import store as content_store

    monkeypatch.setattr(settings, "CONTENT_DIR", str(root))
    legacy = content_store.write_bytes(b"stored by the content store")
    store = FilesystemObjectStore(root)

    assert read(store, legacy.cid) == b"stored by the content store"
    assert store.size(legacy.cid) == legacy.size
    assert list(store.list()) == [legacy.cid]

    put(store, CID, b"stored by the object store")
    assert content_store.open_blob(CID).read() == b"stored by the object store"
    assert content_store.exists(CID)


def test_nothing_is_created_until_the_first_write(root):
    store = FilesystemObjectStore(root)

    assert store.exists("k") is False
    assert list(store.list()) == []
    assert list(store.list("a/b")) == []
    store.delete("k")
    with pytest.raises(ObjectNotFoundError):
        store.open("k")
    with pytest.raises(ObjectNotFoundError):
        store.size("k")
    assert not root.exists()

    put(store, "k", b"v")

    assert root.is_dir()


def test_the_root_is_not_read_until_it_is_used(tmp_path):
    store = FilesystemObjectStore(tmp_path / "later")

    (tmp_path / "later").mkdir()
    (tmp_path / "later" / "k").write_bytes(b"appeared")

    assert read(store, "k") == b"appeared"


@pytest.mark.parametrize("blank", ["", "   ", "\t"])
def test_a_blank_root_is_refused(blank):
    with pytest.raises(StorageConfigError):
        FilesystemObjectStore(blank)


# -- writes: temp file, fsync, rename ---------------------------------------------


def test_a_write_goes_through_a_temp_file_fsync_and_rename(root, monkeypatch):
    store = FilesystemObjectStore(root)
    events = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd):
        mode = os.fstat(fd).st_mode
        events.append(("fsync", "dir" if stat.S_ISDIR(mode) else "file"))
        return real_fsync(fd)

    def replace(src, dst):
        events.append(("replace", os.path.dirname(src), str(dst), os.path.exists(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)

    put(store, CID, b"durable")

    kinds = [event[:2] if event[0] == "fsync" else event[0] for event in events]
    assert kinds == [("fsync", "file"), "replace", ("fsync", "dir")]
    _, source_dir, destination, existed = events[1]
    assert source_dir == str(root / TMP_DIRNAME)  # written beside the destination's filesystem
    assert destination == str(root / CID)
    assert existed is False  # nothing was visible at the key before the rename


def test_the_object_is_not_visible_at_its_key_until_it_is_complete(root):
    store = FilesystemObjectStore(root)
    seen = []

    class Watching:
        def __init__(self):
            self._data = io.BytesIO(b"x" * (3 * 1024 * 1024))

        def read(self, size=-1, /):
            seen.append(store.exists("k"))  # between chunks, mid-write
            return self._data.read(size)

    store.put_stream("k", Watching())

    assert seen and not any(seen)
    assert store.exists("k")


def test_a_replacement_is_atomic_for_readers(root):
    store = FilesystemObjectStore(root)
    old, new = b"o" * 2_000_000, b"n" * 2_000_000
    put(store, "k", old)
    stop = threading.Event()
    torn = []

    def reader():
        while not stop.is_set():
            data = read(store, "k")
            if data not in (old, new):
                torn.append(len(data))

    thread = threading.Thread(target=reader)
    thread.start()
    try:
        for value in (new, old, new, old, new):
            put(store, "k", value)
    finally:
        stop.set()
        thread.join()

    assert torn == []


def test_concurrent_puts_of_one_key_leave_exactly_one_whole_value(root):
    store = FilesystemObjectStore(root)
    values = [bytes([n]) * (300_000 + n) for n in range(1, 5)]
    errors = []

    def writer(value):
        try:
            for _ in range(3):
                put(store, "contended", value)
        except BaseException as exc:  # noqa: BLE001 -- surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(value,)) for value in values]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert read(store, "contended") in values
    assert list(store.list()) == ["contended"]
    assert list((root / TMP_DIRNAME).iterdir()) == []


def test_the_temp_directory_is_empty_after_success_and_after_failure(root):
    store = FilesystemObjectStore(root)

    put(store, "good", b"v")
    with pytest.raises(RuntimeError):
        store.put_stream("bad", Failing(good=1000))
    with pytest.raises(TypeError):
        store.put_stream("text", io.StringIO("x"))
    with pytest.raises(InvalidKeyError):
        put(store, "../bad", b"v")

    assert list((root / TMP_DIRNAME).iterdir()) == []


def test_the_temp_directory_is_never_listed_or_addressable(root):
    store = FilesystemObjectStore(root)
    put(store, "k", b"v")
    (root / TMP_DIRNAME / "blob-in-flight").write_bytes(b"half a write")

    assert list(store.list()) == ["k"]
    with pytest.raises(InvalidKeyError):
        store.list(".tmp/")
    with pytest.raises(InvalidKeyError):
        store.open(".tmp/blob-in-flight")


def test_a_write_is_readable_by_a_second_store_on_the_same_root(root):
    put(FilesystemObjectStore(root), "k", b"shared")

    assert read(FilesystemObjectStore(root), "k") == b"shared"


def test_a_write_can_be_split_over_many_short_reads(root):
    store = FilesystemObjectStore(root)
    data = bytes(range(256)) * 1000

    store.put_stream("k", Dribble(data, step=1000))

    assert (root / "k").read_bytes() == data


# -- key conflicts and directory housekeeping -------------------------------------


def test_a_key_cannot_sit_inside_another_key(root):
    store = FilesystemObjectStore(root)
    put(store, "a", b"an object")

    with pytest.raises(KeyConflictError):
        put(store, "a/b", b"under it")

    assert read(store, "a") == b"an object"
    assert list((root / TMP_DIRNAME).iterdir()) == []


def test_a_key_cannot_replace_a_directory_of_keys(root):
    store = FilesystemObjectStore(root)
    put(store, "a/b", b"nested")

    with pytest.raises(KeyConflictError):
        put(store, "a", b"over the directory")

    assert read(store, "a/b") == b"nested"
    assert list((root / TMP_DIRNAME).iterdir()) == []


def test_deleting_the_last_object_removes_the_empty_directories_it_leaves(root):
    store = FilesystemObjectStore(root)
    put(store, "uploads/Zk3x/00000001", b"1")
    put(store, "uploads/Zk3x/00000002", b"2")
    put(store, "uploads/Ab9y/00000001", b"3")

    store.delete("uploads/Zk3x/00000001")
    assert (root / "uploads" / "Zk3x").is_dir()  # still holds a part
    store.delete("uploads/Zk3x/00000002")
    assert not (root / "uploads" / "Zk3x").exists()
    assert (root / "uploads" / "Ab9y").is_dir()
    store.delete("uploads/Ab9y/00000001")

    assert not (root / "uploads").exists()
    assert root.is_dir()  # the root itself is never removed
    assert (root / TMP_DIRNAME).is_dir()


def test_directories_of_other_keys_survive_a_delete(root):
    store = FilesystemObjectStore(root)
    put(store, "a/b/c", b"1")
    put(store, "a/d", b"2")

    store.delete("a/b/c")

    assert not (root / "a" / "b").exists()
    assert read(store, "a/d") == b"2"


def test_writes_and_deletes_racing_in_one_directory_lose_nothing(root):
    store = FilesystemObjectStore(root)
    errors = []

    def churn(name):
        try:
            for round_ in range(40):
                put(store, f"shared/dir/{name}", b"v" * round_)
                store.delete(f"shared/dir/{name}")
            put(store, f"shared/dir/{name}", b"final-" + name.encode())
        except BaseException as exc:  # noqa: BLE001 -- surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=churn, args=(f"w{n}",)) for n in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert list(store.list("shared/")) == [f"shared/dir/w{n}" for n in range(4)]
    assert read(store, "shared/dir/w2") == b"final-w2"


def test_a_symlink_is_not_an_object_unless_it_points_at_a_file(root):
    store = FilesystemObjectStore(root)
    put(store, "real", b"v")
    os.symlink(root / "real", root / "alias")
    os.symlink(root / "nowhere", root / "dangling")

    assert list(store.list()) == ["alias", "real"]
    assert store.exists("dangling") is False


# -- backend selection ---------------------------------------------------------------


def test_fs_is_the_default_backend(monkeypatch):
    monkeypatch.delenv("STORAGE_BACKEND", raising=False)

    assert Settings().STORAGE_BACKEND == "fs"
    monkeypatch.setenv("STORAGE_BACKEND", "")
    assert Settings().STORAGE_BACKEND == "fs"
    monkeypatch.setenv("STORAGE_BACKEND", " FS ")
    assert Settings().STORAGE_BACKEND == "fs"


def test_the_default_store_is_the_filesystem_store_on_content_dir(root, monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "fs")
    monkeypatch.setattr(settings, "CONTENT_DIR", str(root))

    store = get_object_store()

    assert isinstance(store, FilesystemObjectStore)
    assert store.root == root
    put(store, "k", b"v")
    assert (root / "k").read_bytes() == b"v"


def test_the_store_follows_changes_to_content_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "fs")
    monkeypatch.setattr(settings, "CONTENT_DIR", str(tmp_path / "one"))
    put(get_object_store(), "k", b"in one")

    monkeypatch.setattr(settings, "CONTENT_DIR", str(tmp_path / "two"))

    assert get_object_store().exists("k") is False
    assert (tmp_path / "one" / "k").read_bytes() == b"in one"


@pytest.mark.parametrize("blank", ["", "  "])
def test_an_unconfigured_content_dir_is_refused(blank, monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "fs")
    monkeypatch.setattr(settings, "CONTENT_DIR", blank)

    with pytest.raises(StorageConfigError, match="CONTENT_DIR"):
        get_object_store()


def test_an_unknown_backend_is_refused(monkeypatch):
    monkeypatch.setattr(settings, "STORAGE_BACKEND", "tape")

    with pytest.raises(StorageConfigError, match="tape"):
        get_object_store()


def test_choosing_fs_never_loads_the_s3_client(root):
    import subprocess
    import sys

    code = (
        "import sys, os\n"
        f"os.environ['CONTENT_DIR'] = {str(root)!r}\n"
        "os.environ.pop('STORAGE_BACKEND', None)\n"
        "from app.storage import get_object_store\n"
        "get_object_store()\n"
        "print('boto3' in sys.modules)\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        check=True,
        env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
    )

    assert result.stdout.strip() == "False"
