"""Tests for manifest body validation."""

import pytest

from scholium_record_core import (
    FILE_FIELDS,
    FILE_ROLES,
    FILES_FIELD,
    MANIFEST_TYPE,
    MAX_FILE_SIZE,
    MAX_PATH_LENGTH,
    compute_file_id,
    validate_manifest_body,
    validate_manifest_entry,
)

PDF_CID = compute_file_id(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n%%EOF\n")
SVG_CID = compute_file_id(
    b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n'
)


def entry(**overrides):
    good = {
        "path": "main.pdf",
        "cid": PDF_CID,
        "size": 21,
        "mediaType": "application/pdf",
        "role": "manuscript",
    }
    good.update(overrides)
    return good


def body(*entries):
    return {FILES_FIELD: list(entries)}


def test_constants_pin_the_contract():
    assert MANIFEST_TYPE == "manifest"
    assert FILES_FIELD == "files"
    assert FILE_FIELDS == ("path", "cid", "size", "mediaType", "role")
    assert "manuscript" in FILE_ROLES
    assert "figure" in FILE_ROLES
    assert "other" in FILE_ROLES  # the catch-all: nothing reasonable is excluded
    assert MAX_FILE_SIZE == 2**53 - 1  # JSON-number-safe
    assert MAX_PATH_LENGTH == 1024


def test_valid_body_returns_canonical_copy():
    original = body(entry())
    result = validate_manifest_body(original)
    assert result == original
    assert result is not original  # a copy: mutating it cannot corrupt input
    assert result[FILES_FIELD][0] is not original[FILES_FIELD][0]
    original[FILES_FIELD][0]["path"] = "tampered.pdf"
    assert result[FILES_FIELD][0]["path"] == "main.pdf"


def test_canonical_result_orders_fields():
    scrambled = {"role": "manuscript", "size": 21, "path": "main.pdf",
                 "cid": PDF_CID, "mediaType": "application/pdf"}
    assert list(validate_manifest_entry(scrambled)) == list(FILE_FIELDS)


def test_entry_order_is_preserved():
    manifest = body(
        entry(path="b.pdf", size=2),
        entry(path="a.pdf", size=1),
    )
    files = validate_manifest_body(manifest)[FILES_FIELD]
    assert [f["path"] for f in files] == ["b.pdf", "a.pdf"]


def test_multiple_files_and_nested_paths():
    manifest = body(
        entry(path="main.pdf"),
        entry(path="figures/plot.svg", cid=SVG_CID, size=65,
              mediaType="image/svg+xml", role="figure"),
        entry(path="data/run/2026-11/raw.hdf5", size=2**33,
              mediaType="application/x-hdf5", role="dataset"),
    )
    assert len(validate_manifest_body(manifest)[FILES_FIELD]) == 3


@pytest.mark.parametrize(
    "path",
    [
        "main.pdf",
        "figures/plot.svg",
        "deeply/nested/directory/tree/file.tex",
        "a b c.pdf",           # spaces are legal filename characters
        "Café méthodes.md",    # so is unicode
        "中文论文/图1.svg",
        ".hidden",             # dotfiles are fine; only '.' and '..' are not
        "v1.2.3-final.tar.gz",
        "a" * MAX_PATH_LENGTH,
    ],
)
def test_accepts_normalized_relative_paths(path):
    assert validate_manifest_entry(entry(path=path))["path"] == path


@pytest.mark.parametrize(
    "path",
    [
        "/etc/paper/main.pdf",      # absolute
        "/main.pdf",
        "../../escape.pdf",         # traversal
        "figures/../plot.svg",
        "figures/./plot.svg",       # not normalized
        "./main.pdf",
        "..",
        ".",
        "figures//plot.svg",        # empty component
        "figures/",                 # trailing slash
        "",                         # empty path
        "figures\\plot.svg",        # windows separator
        "main.pdf\n",               # control character
        "main\x00.pdf",
        "a" * (MAX_PATH_LENGTH + 1),
    ],
)
def test_rejects_bad_paths(path):
    with pytest.raises(ValueError, match="path"):
        validate_manifest_entry(entry(path=path))


def test_rejects_non_string_path():
    with pytest.raises(ValueError, match="path"):
        validate_manifest_entry(entry(path=5))


def test_duplicate_paths_are_rejected_across_entries():
    manifest = body(entry(path="main.pdf"), entry(path="figures/x.pdf"),
                    entry(path="main.pdf", cid=SVG_CID))
    with pytest.raises(ValueError, match=r"files\[2\].*main\.pdf.*files\[0\]"):
        validate_manifest_body(manifest)


@pytest.mark.parametrize(
    "size",
    [0, 1, 21, 4096, 2**32, 2**33, 2**53 - 1],
)
def test_accepts_json_safe_integer_sizes(size):
    assert validate_manifest_entry(entry(size=size))["size"] == size


@pytest.mark.parametrize(
    "size",
    [-1, 2**53, 2**64, "1024", 12.5, None, True, False],
)
def test_rejects_bad_sizes(size):
    with pytest.raises(ValueError, match="size"):
        validate_manifest_entry(entry(size=size))


@pytest.mark.parametrize(
    "media_type",
    [
        "application/pdf",
        "image/svg+xml",
        "text/plain",
        "text/csv",
        "application/gzip",
        "application/x-hdf5",
        "application/vnd.api+json",  # structured suffix
        "application/x-custom-vendor.format+v1",
        "font/woff2",
        "a/b",  # minimal
    ],
)
def test_accepts_bare_lowercase_media_types(media_type):
    result = validate_manifest_entry(entry(mediaType=media_type))
    assert result["mediaType"] == media_type


@pytest.mark.parametrize(
    "media_type",
    [
        "pdf",                          # no subtype
        "/pdf",                         # empty type
        "application/",                 # empty subtype
        "Application/PDF",              # uppercase
        "application/PDF",
        "application/pdf; charset=utf-8",  # parameters
        "application/pdf charset=utf-8",
        "image/*",                      # wildcard
        "*/*",
        "application//pdf",
        "application pdf",
        "",                             # empty
        "application/pdf ",             # trailing space
        7,                              # not a string
        None,
    ],
)
def test_rejects_bad_media_types(media_type):
    with pytest.raises(ValueError, match="mediaType"):
        validate_manifest_entry(entry(mediaType=media_type))


def test_known_roles_are_accepted():
    for role in sorted(FILE_ROLES):
        assert validate_manifest_entry(entry(role=role))["role"] == role


@pytest.mark.parametrize(
    "role",
    ["figrue", "Figure", "FIGURE", "figure ", "", "figures", 5, None,
     "guest", "reviewer"],
)
def test_unknown_roles_are_rejected(role):
    with pytest.raises(ValueError, match="role"):
        validate_manifest_entry(entry(role=role))


def test_unknown_role_error_lists_the_vocabulary():
    with pytest.raises(ValueError, match=r"role.*manuscript.*other"):
        validate_manifest_entry(entry(role="banana"))


def test_accepts_well_formed_file_cids():
    for cid in (PDF_CID, SVG_CID, compute_file_id(b"")):
        assert validate_manifest_entry(entry(cid=cid))["cid"] == cid


@pytest.mark.parametrize(
    "cid",
    [
        "bafyreihklcd3fihc4tzuxk5ljuxo6ooru46tfsp7gs6p5mjqriw25cutz4",  # record id
        "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR",              # CIDv0
        "BAFKREIBM6JG3UX5QUMHCN2B3FLC3TYU6DMLB4XA7U5BF44YEGNRJHC4YEQ",  # uppercase
        "zb2rhZfjRh2FHHB2RkHVEvL2vJnCTcu7kwRqgVsf9gpkLgteo",           # base58btc
        "bafkreiabf3clzqizbyvthhz4yqetd7ab5cimxcj2wvbailc26snnaaw4qey",  # bad pad bits
        "main.pdf",
        "",
        5,
        None,
    ],
)
def test_rejects_bad_file_cids(cid):
    with pytest.raises(ValueError, match="cid"):
        validate_manifest_entry(entry(cid=cid))


def test_missing_fields_are_named():
    broken = entry()
    del broken["role"]
    with pytest.raises(ValueError, match="missing required field.*role"):
        validate_manifest_entry(broken)

    worse = entry()
    del worse["size"]
    del worse["path"]
    with pytest.raises(ValueError, match=r"path, size|size, path"):
        validate_manifest_entry(worse)


def test_extra_fields_are_rejected():
    padded = entry(checksum="sha256:2cf24d")
    with pytest.raises(ValueError, match="unexpected field.*checksum"):
        validate_manifest_entry(padded)


def test_entry_must_be_a_mapping():
    for bad in ("main.pdf", 5, None, [entry()]):
        with pytest.raises(ValueError, match="mapping"):
            validate_manifest_entry(bad)


def test_body_must_be_a_mapping():
    for bad in ([], "files", 5, None):
        with pytest.raises(ValueError, match="manifest body must be a mapping"):
            validate_manifest_body(bad)


def test_body_must_carry_files():
    with pytest.raises(ValueError, match="missing required field.*files"):
        validate_manifest_body({"entries": [entry()]})


def test_body_rejects_extra_keys():
    with pytest.raises(ValueError, match="unexpected field.*note"):
        validate_manifest_body({**body(entry()), "note": "hello"})
    with pytest.raises(ValueError, match="unexpected field"):
        validate_manifest_body({**body(entry()), "manifestVersion": 2})


def test_files_must_be_a_non_empty_sequence():
    with pytest.raises(ValueError, match="at least one file"):
        validate_manifest_body(body())
    for bad in ("main.pdf", 7, None, {"0": entry()}):
        with pytest.raises(ValueError, match="must be a sequence"):
            validate_manifest_body({FILES_FIELD: bad})


def test_error_messages_name_the_entry():
    manifest = body(entry(path="good.pdf"), entry(role="figrue"))
    with pytest.raises(ValueError, match=r"files\[1\] field 'role'"):
        validate_manifest_body(manifest)


def test_manifest_from_real_uploads_validates():
    """The full flow: compute ids for bytes, build the body, validate it."""
    pdf_bytes = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n%%EOF\n"
    svg_bytes = b'<svg xmlns="http://www.w3.org/2000/svg"/>'
    manifest = body(
        entry(path="main.pdf", cid=compute_file_id(pdf_bytes),
              size=len(pdf_bytes), role="manuscript"),
        entry(path="figures/plot.svg", cid=compute_file_id(svg_bytes),
              size=len(svg_bytes), mediaType="image/svg+xml", role="figure"),
    )
    result = validate_manifest_body(manifest)
    assert result[FILES_FIELD][0]["size"] == len(pdf_bytes)
    assert result[FILES_FIELD][1]["cid"] == compute_file_id(svg_bytes)
