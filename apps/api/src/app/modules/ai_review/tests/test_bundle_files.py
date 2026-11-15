"""Tests for unpacking a code bundle (feature 119).

A bundle is untrusted.  What these pin: only regular files and directories are
written, anything that could write outside the destination or smuggle in a
link rejects the whole bundle (and nothing escapes), sizes are limited by what
is written rather than by what a header claims, and the result is readable by
the container's unprivileged user whatever the host umask.
"""

from __future__ import annotations

import os
import stat
import tarfile
from pathlib import Path

import pytest

from app.modules.ai_review import BundleError
from app.modules.ai_review import bundle_files
from app.modules.ai_review.bundle_files import (
    REASON_BUNDLE_REJECTED,
    REASON_BUNDLE_UNAVAILABLE,
    extract_bundle,
    find_entrypoint,
)

from .sandbox_support import tar_bytes, tar_member, zip_bytes, zip_info


@pytest.fixture
def dest(tmp_path) -> Path:
    """The empty directory to unpack into, with a neighbour an escape would hit."""
    target = tmp_path / "dest"
    target.mkdir()
    return target


def write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def tree(root: Path) -> dict[str, str]:
    """Every file under ``root`` as relative path -> text."""
    return {
        str(path.relative_to(root)): path.read_text()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def rejected(archive: Path, dest: Path, **limits) -> BundleError:
    with pytest.raises(BundleError) as caught:
        extract_bundle(archive, dest, **limits)
    return caught.value


class TestUnpacking:
    FILES = {
        "reproduce.sh": "python run.py\n",
        "src/run.py": "print(1)\n",
        "src/lib/util.py": "X = 1\n",
    }

    def test_zip_is_unpacked(self, tmp_path, dest):
        archive = write(tmp_path, "b.zip", zip_bytes(self.FILES))

        root = extract_bundle(archive, dest)

        assert root == dest
        assert tree(root) == self.FILES

    @pytest.mark.parametrize("mode", ["w", "w:gz", "w:bz2", "w:xz"])
    def test_tar_in_every_compression_is_unpacked(self, tmp_path, dest, mode):
        archive = write(tmp_path, "b.tar", tar_bytes(self.FILES, mode=mode))

        root = extract_bundle(archive, dest)

        assert tree(root) == self.FILES

    def test_a_single_top_level_directory_is_the_root(self, tmp_path, dest):
        files = {f"project-1.0/{name}": text for name, text in self.FILES.items()}
        archive = write(tmp_path, "b.tar.gz", tar_bytes(files))

        root = extract_bundle(archive, dest)

        assert root == dest / "project-1.0"
        assert tree(root) == self.FILES

    def test_two_top_level_entries_keep_the_destination_as_root(self, tmp_path, dest):
        archive = write(tmp_path, "b.zip", zip_bytes({"a/x.txt": "1", "b/y.txt": "2"}))

        assert extract_bundle(archive, dest) == dest

    def test_macos_resource_fork_directory_is_dropped(self, tmp_path, dest):
        files = {
            "paper/reproduce.sh": "echo\n",
            "__MACOSX/paper/._reproduce.sh": "junk",
        }
        archive = write(tmp_path, "b.zip", zip_bytes(files))

        root = extract_bundle(archive, dest)

        assert root == dest / "paper"
        assert not (dest / "__MACOSX").exists()

    def test_modes_are_normalized_whatever_the_host_umask(self, tmp_path, dest):
        members = [
            (tar_member("tool.sh", tarfile.REGTYPE, mode=0o700), b"#!/bin/sh\n"),
            (tar_member("data/plain.txt", tarfile.REGTYPE, mode=0o600), b"x"),
        ]
        archive = write(tmp_path, "b.tar", tar_bytes(members=members, mode="w"))
        previous = os.umask(0o077)
        try:
            root = extract_bundle(archive, dest)
        finally:
            os.umask(previous)

        assert stat.S_IMODE(root.stat().st_mode) == 0o755
        assert stat.S_IMODE((root / "data").stat().st_mode) == 0o755
        assert stat.S_IMODE((root / "tool.sh").stat().st_mode) == 0o755
        assert stat.S_IMODE((root / "data/plain.txt").stat().st_mode) == 0o644

    def test_zip_exec_bit_is_kept_and_other_bits_dropped(self, tmp_path, dest):
        entries = [
            (zip_info("run.sh", stat.S_IFREG | 0o750), b"echo\n"),
            (zip_info("notes.txt", stat.S_IFREG | 0o666), b"hi"),
        ]
        archive = write(tmp_path, "b.zip", zip_bytes(entries=entries))

        root = extract_bundle(archive, dest)

        assert stat.S_IMODE((root / "run.sh").stat().st_mode) == 0o755
        assert stat.S_IMODE((root / "notes.txt").stat().st_mode) == 0o644

    def test_empty_directories_are_kept(self, tmp_path, dest):
        entries = [
            (zip_info("results", stat.S_IFDIR | 0o755, directory=True), b""),
            (zip_info("run.sh", stat.S_IFREG | 0o644), b"echo\n"),
        ]
        archive = write(tmp_path, "b.zip", zip_bytes(entries=entries))

        root = extract_bundle(archive, dest)

        assert (root / "results").is_dir()


class TestUnsafeEntries:
    """Each one rejects the whole bundle, and nothing is written outside ``dest``."""

    @pytest.fixture(autouse=True)
    def no_escape(self, tmp_path):
        yield
        stray = sorted(p.name for p in tmp_path.iterdir() if p.name not in ("dest", "b"))
        assert stray == [], f"something was written outside the destination: {stray}"

    @pytest.mark.parametrize(
        "name",
        [
            "../pwned",
            "a/../../pwned",
            "..\\pwned",
            "a\\..\\..\\pwned",
            "/etc/pwned",
            "\\windows\\pwned",
            "C:/pwned",
            "c:\\pwned",
        ],
    )
    def test_zip_paths_that_escape(self, tmp_path, dest, name):
        archive = write(tmp_path, "b", zip_bytes({"ok.txt": "fine", name: "x"}))

        error = rejected(archive, dest)

        assert error.reason == REASON_BUNDLE_REJECTED

    @pytest.mark.parametrize("name", ["../pwned", "a/../../pwned", "/etc/pwned"])
    def test_tar_paths_that_escape(self, tmp_path, dest, name):
        archive = write(tmp_path, "b", tar_bytes({"ok.txt": "fine", name: "x"}))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    def test_zip_symlink(self, tmp_path, dest):
        entries = [(zip_info("link", stat.S_IFLNK | 0o777), b"/etc/passwd")]
        archive = write(tmp_path, "b", zip_bytes({"ok.txt": "fine"}, entries))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    @pytest.mark.parametrize(
        "kind, link",
        [
            (tarfile.SYMTYPE, "/etc/passwd"),
            (tarfile.SYMTYPE, "../../outside"),
            (tarfile.LNKTYPE, "ok.txt"),
            (tarfile.CHRTYPE, ""),
            (tarfile.BLKTYPE, ""),
            (tarfile.FIFOTYPE, ""),
        ],
    )
    def test_tar_links_and_special_files(self, tmp_path, dest, kind, link):
        members = [(tar_member("odd", kind, link=link), b"")]
        archive = write(tmp_path, "b", tar_bytes({"ok.txt": "fine"}, members))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    def test_a_file_where_a_directory_is_needed(self, tmp_path, dest):
        archive = write(tmp_path, "b", tar_bytes({"a": "file", "a/b": "inside"}))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    def test_a_directory_where_a_file_was_written(self, tmp_path, dest):
        members = [
            (tar_member("a", tarfile.REGTYPE), b"file"),
            (tar_member("a", tarfile.DIRTYPE, mode=0o755), b""),
        ]
        archive = write(tmp_path, "b", tar_bytes(members=members))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    def test_a_name_that_is_too_long(self, tmp_path, dest):
        long_name = "d/" + "x" * (bundle_files.MAX_NAME_LENGTH + 1)
        archive = write(tmp_path, "b", tar_bytes({long_name: "x"}))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    def test_a_path_component_that_is_too_long(self, tmp_path, dest):
        archive = write(tmp_path, "b", tar_bytes({"x" * 300: "x"}))

        assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED

    def test_dot_segments_that_stay_inside_are_fine(self, tmp_path, dest):
        archive = write(tmp_path, "b", tar_bytes({"./a/./b.txt": "ok"}))

        root = extract_bundle(archive, dest)

        # Everything is under ``a``, so ``a`` is the bundle root.
        assert root == dest / "a"
        assert tree(root) == {"b.txt": "ok"}


class TestPathRules:
    """The two independent layers that keep a write inside the destination.

    Zip-slip is stopped by the name rules, and again by checking where the
    path really lands; these pin each layer on its own so that neither can
    be removed unnoticed behind the other.
    """

    @pytest.mark.parametrize(
        "name",
        ["../x", "a/../../x", "a/..", "..", "..\\x", "/x", "\\x", "C:/x", "z:\\x", "a\0b"],
    )
    def test_names_that_could_escape_are_refused(self, name):
        with pytest.raises(BundleError) as caught:
            bundle_files._member_parts(name)

        assert caught.value.reason == REASON_BUNDLE_REJECTED

    @pytest.mark.parametrize(
        "name, parts",
        [
            ("a/b.txt", ("a", "b.txt")),
            ("./a//b.txt", ("a", "b.txt")),
            ("a\\b.txt", ("a", "b.txt")),  # Windows separators
            ("dir/", ("dir",)),
            ("..hidden/file", ("..hidden", "file")),
            ("a/b..c", ("a", "b..c")),
            ("./", None),
            ("", None),
            ("__MACOSX/x/._y", None),
        ],
    )
    def test_names_that_stay_inside_are_split_into_parts(self, name, parts):
        assert bundle_files._member_parts(name) == parts

    def test_a_path_that_lands_outside_is_refused_even_if_its_name_looks_fine(self, tmp_path):
        # A symlink already in the destination (the extractor never makes one,
        # but the check must not depend on that) would carry a write out.
        outside = tmp_path / "outside"
        outside.mkdir()
        dest = tmp_path / "dest"
        dest.mkdir()
        (dest / "link").symlink_to(outside, target_is_directory=True)
        writer = bundle_files._Writer(dest, max_files=10, max_bytes=1_000)

        with pytest.raises(BundleError) as caught:
            writer._target(("link", "stolen.txt"))

        assert caught.value.reason == REASON_BUNDLE_REJECTED
        assert writer._target(("fine", "x.txt")) == dest / "fine" / "x.txt"
        assert list(outside.iterdir()) == []


class TestLimits:
    def test_zip_whose_declared_size_is_over_the_limit(self, tmp_path, dest):
        archive = write(tmp_path, "b", zip_bytes({"big.bin": b"\0" * 10_000}))

        error = rejected(archive, dest, max_bytes=1_000)

        assert error.reason == REASON_BUNDLE_REJECTED
        assert "unpacks to more than" in error.detail
        assert list(dest.iterdir()) == []

    def test_tar_is_counted_as_it_is_written(self, tmp_path, dest):
        # A compression bomb: 1 MB of zeros is a few hundred bytes of gzip.
        data = tar_bytes({"zeros": b"\0" * 1_000_000})
        assert len(data) < 5_000
        archive = write(tmp_path, "b", data)

        error = rejected(archive, dest, max_bytes=100_000)

        assert error.reason == REASON_BUNDLE_REJECTED
        # Counted before each chunk is written, so the cap is never exceeded.
        assert (dest / "zeros").stat().st_size <= 100_000

    def test_too_many_entries(self, tmp_path, dest):
        files = {f"f{i}.txt": "x" for i in range(11)}
        for name, data in (("b.zip", zip_bytes(files)), ("b.tar", tar_bytes(files))):
            target = dest / name.split(".")[1]
            target.mkdir()
            error = rejected(write(tmp_path, name, data), target, max_files=10)
            assert error.reason == REASON_BUNDLE_REJECTED
            assert "more than 10 entries" in error.detail

    def test_an_archive_with_no_files(self, tmp_path, dest):
        for data in (zip_bytes({}), tar_bytes(members=[(tar_member("d", tarfile.DIRTYPE), b"")])):
            archive = write(tmp_path, "b", data)
            assert rejected(archive, dest).reason == REASON_BUNDLE_REJECTED


class TestUnreadable:
    def test_not_an_archive(self, tmp_path, dest):
        archive = write(tmp_path, "b", b"%PDF-1.7 definitely not an archive")

        error = rejected(archive, dest)

        assert error.reason == REASON_BUNDLE_UNAVAILABLE
        assert "not a zip or tar archive" in error.detail

    def test_missing_file(self, tmp_path, dest):
        assert rejected(tmp_path / "absent", dest).reason == REASON_BUNDLE_UNAVAILABLE

    def test_truncated_tar(self, tmp_path, dest):
        data = tar_bytes({"big.bin": os.urandom(200_000)})
        archive = write(tmp_path, "b", data[: len(data) // 2])

        assert rejected(archive, dest).reason == REASON_BUNDLE_UNAVAILABLE

    def test_zip_with_a_corrupt_member(self, tmp_path, dest):
        data = bytearray(zip_bytes({"a.txt": os.urandom(5_000)}))
        data[60] ^= 0xFF  # inside the stored member's data
        archive = write(tmp_path, "b", bytes(data))

        assert rejected(archive, dest).reason == REASON_BUNDLE_UNAVAILABLE

    @pytest.mark.parametrize("mode", ["w:gz", "w:bz2", "w:xz"])
    def test_corrupt_compressed_tar_is_unreadable_not_a_crash(self, tmp_path, dest, mode):
        # zlib.error and lzma.LZMAError are not OSErrors.
        data = bytearray(tar_bytes({"big.bin": os.urandom(50_000)}, mode=mode))
        # Just past the container header, where the first block's own header
        # is: damage there is always structural, whereas a flipped payload byte
        # of an incompressible file is silently accepted by tarfile.
        for at in range(12, 52):
            data[at] ^= 0xA5
        archive = write(tmp_path, "b", bytes(data))

        assert rejected(archive, dest).reason == REASON_BUNDLE_UNAVAILABLE

    def test_zip_with_a_corrupt_deflate_stream(self, tmp_path, dest):
        data = bytearray(zip_bytes({"a.txt": b"abc" * 5_000}))
        for at in range(40, 60):
            data[at] ^= 0xFF
        archive = write(tmp_path, "b", bytes(data))

        assert rejected(archive, dest).reason == REASON_BUNDLE_UNAVAILABLE

    def test_encrypted_zip(self, tmp_path, dest):
        archive = write(tmp_path, "b", zip_bytes({"a.txt": "secret"}))
        raw = bytearray(archive.read_bytes())
        # Set the "encrypted" general-purpose flag on the local and central headers.
        for signature, flag_at in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
            raw[raw.find(signature) + flag_at] |= 0x01
        archive.write_bytes(bytes(raw))

        assert rejected(archive, dest).reason == REASON_BUNDLE_UNAVAILABLE

    def test_the_error_is_a_value_error_carrying_a_reason_and_detail(self):
        error = BundleError(REASON_BUNDLE_REJECTED, "too big")

        assert isinstance(error, ValueError)
        assert (error.reason, error.detail, str(error)) == (REASON_BUNDLE_REJECTED, "too big", "too big")


class TestEntrypoint:
    def test_reproduce_sh_wins_over_run_sh(self, tmp_path):
        (tmp_path / "run.sh").write_text("a")
        (tmp_path / "reproduce.sh").write_text("b")

        assert find_entrypoint(tmp_path) == "reproduce.sh"

    def test_run_sh_is_the_fallback(self, tmp_path):
        (tmp_path / "run.sh").write_text("a")

        assert find_entrypoint(tmp_path) == "run.sh"

    def test_none_when_neither_exists(self, tmp_path):
        (tmp_path / "main.py").write_text("a")

        assert find_entrypoint(tmp_path) is None

    def test_a_directory_with_the_name_does_not_count(self, tmp_path):
        (tmp_path / "reproduce.sh").mkdir()

        assert find_entrypoint(tmp_path) is None
