"""The S3 driver against moto: the shared contract, plus what is true only of S3.

moto answers the S3 API in-process, so nothing here needs a network, a
container or credentials.  Beyond the contract (``tests/__init__.py``) this
covers multipart upload (when it is used, that it streams, that it is aborted
on failure), how client and server failures surface, how the client is wired
from its settings, and the ``STORAGE_BACKEND=s3`` production checks.
"""

from __future__ import annotations

import io
import random
from urllib.parse import urlparse

import boto3
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError, ReadTimeoutError
from moto import mock_aws

from app.settings import Settings, settings
from app.storage import (
    InvalidRangeError,
    ObjectNotFoundError,
    ObjectStoreError,
    StorageConfigError,
    _s3_store,
    get_object_store,
)
from app.storage.base import CHUNK_SIZE
from app.storage.s3 import MIN_PART_SIZE, S3ObjectStore

from .test_filesystem import LARGE, Failing, ObjectStoreContract, put, read

BUCKET = "scholium-test"
REGION = "test-region-1"
ACCESS_KEY_ID = "test-access-key-id"
SECRET = "test-SECRET-access-key-0123456789"
ENDPOINT = "http://objects.test:9000"


@pytest.fixture(autouse=True)
def moto_endpoint(monkeypatch):
    """Let moto answer for ``ENDPOINT`` too, so a custom endpoint can be exercised."""
    monkeypatch.setenv("MOTO_S3_CUSTOM_ENDPOINTS", ENDPOINT)


@pytest.fixture
def raw(moto_endpoint):
    """A plain client on the mocked service, for looking at what the driver left behind."""
    with mock_aws():
        client = boto3.client(
            "s3", region_name=REGION, aws_access_key_id="admin", aws_secret_access_key="admin-secret"
        )
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        yield client


def make_store(**overrides) -> S3ObjectStore:
    options = dict(
        region=REGION,
        access_key_id=ACCESS_KEY_ID,
        secret_access_key=SECRET,
        part_size=MIN_PART_SIZE,
    )
    options.update(overrides)
    return S3ObjectStore(BUCKET, **options)


@pytest.fixture
def s3_store(raw):
    return make_store()


class TestS3Contract(ObjectStoreContract):
    @pytest.fixture
    def store(self, s3_store):
        return s3_store


def payload(size: int) -> bytes:
    return random.Random(size).randbytes(size)


def etag(raw, key: str) -> str:
    return raw.head_object(Bucket=BUCKET, Key=key)["ETag"].strip('"')


def part_count(raw, key: str) -> int:
    """How many parts an object was uploaded in (a single put counts as one)."""
    tag = etag(raw, key)
    return int(tag.rsplit("-", 1)[1]) if "-" in tag else 1


def client_error(code: str, operation: str = "Operation", message: str = "refused") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


class Counting:
    """A binary stream that counts the bytes handed out so far."""

    def __init__(self, data: bytes) -> None:
        self._data = io.BytesIO(data)
        self.consumed = 0

    def read(self, size: int = -1, /) -> bytes:
        chunk = self._data.read(size)
        self.consumed += len(chunk)
        return chunk


# -- multipart upload ---------------------------------------------------------------


@pytest.mark.parametrize(
    "size, parts",
    [
        (0, 1),
        (1, 1),
        (MIN_PART_SIZE - 1, 1),
        (MIN_PART_SIZE, 1),
        (MIN_PART_SIZE + 1, 2),
        (2 * MIN_PART_SIZE, 2),
        (2 * MIN_PART_SIZE + 1, 3),
        (3 * MIN_PART_SIZE, 3),
    ],
    ids=lambda value: str(value),
)
def test_a_stream_is_one_put_up_to_a_part_and_multipart_beyond(raw, s3_store, size, parts):
    data = payload(size)

    stored = put(s3_store, "obj", data)

    assert stored.size == size
    assert part_count(raw, "obj") == parts
    assert read(s3_store, "obj") == data
    assert raw.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []) == []


def test_the_default_part_size_is_comfortably_above_the_minimum():
    from app.storage.s3 import DEFAULT_PART_SIZE

    assert DEFAULT_PART_SIZE >= MIN_PART_SIZE


def test_a_large_stream_is_uploaded_in_parts_of_the_configured_size(raw):
    store = make_store(part_size=2 * MIN_PART_SIZE)

    put(store, "large", LARGE)  # 11 MiB and a bit

    assert part_count(raw, "large") == 2
    assert read(store, "large") == LARGE


def test_a_stream_is_not_read_ahead_of_the_part_being_sent(raw, s3_store, monkeypatch):
    seen = []
    source = Counting(payload(4 * MIN_PART_SIZE))
    real = s3_store._client.upload_part

    def upload_part(**kwargs):
        seen.append(source.consumed)
        return real(**kwargs)

    monkeypatch.setattr(s3_store._client, "upload_part", upload_part)

    s3_store.put_stream("big", source)

    assert len(seen) == 4
    # Memory stays near one part: when part n goes out, at most one chunk
    # beyond it has been read, never the rest of the stream.
    for number, consumed in enumerate(seen, start=1):
        assert consumed <= number * MIN_PART_SIZE + CHUNK_SIZE


def test_a_failing_stream_aborts_the_multipart_upload(raw, s3_store):
    with pytest.raises(RuntimeError, match="went away"):
        s3_store.put_stream("broken", Failing(good=3 * MIN_PART_SIZE))

    assert raw.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []) == []
    assert raw.list_objects_v2(Bucket=BUCKET).get("Contents", []) == []


def test_a_text_stream_after_the_first_part_aborts_the_multipart_upload(raw, s3_store):
    class Turns:
        def __init__(self):
            self._calls = 0

        def read(self, size=-1, /):
            self._calls += 1
            return b"b" * size if self._calls <= 12 else "text now"

    with pytest.raises(TypeError):
        s3_store.put_stream("turned", Turns())

    assert raw.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []) == []
    assert raw.list_objects_v2(Bucket=BUCKET).get("Contents", []) == []


def test_a_failure_completing_the_upload_aborts_it_and_is_an_object_store_error(raw, s3_store, monkeypatch):
    def refuse(**kwargs):
        raise client_error("InternalError", "CompleteMultipartUpload", "try later")

    monkeypatch.setattr(s3_store._client, "complete_multipart_upload", refuse)

    with pytest.raises(ObjectStoreError, match="InternalError"):
        put(s3_store, "k", payload(2 * MIN_PART_SIZE + 5))

    assert raw.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []) == []
    assert s3_store.exists("k") is False


def test_a_failing_abort_does_not_hide_the_original_failure(raw, s3_store, monkeypatch):
    def refuse(**kwargs):
        raise client_error("InternalError", "AbortMultipartUpload")

    monkeypatch.setattr(s3_store._client, "abort_multipart_upload", refuse)

    with pytest.raises(RuntimeError, match="went away"):
        s3_store.put_stream("broken", Failing(good=2 * MIN_PART_SIZE))


def test_a_part_that_fails_to_upload_aborts_the_upload(raw, s3_store, monkeypatch):
    calls = []
    real = s3_store._client.upload_part

    def flaky(**kwargs):
        calls.append(kwargs["PartNumber"])
        if kwargs["PartNumber"] == 2:
            raise client_error("SlowDown", "UploadPart")
        return real(**kwargs)

    monkeypatch.setattr(s3_store._client, "upload_part", flaky)

    with pytest.raises(ObjectStoreError, match="SlowDown"):
        put(s3_store, "k", payload(3 * MIN_PART_SIZE))

    assert calls == [1, 2]
    assert raw.list_multipart_uploads(Bucket=BUCKET).get("Uploads", []) == []


def test_a_part_size_below_the_s3_minimum_is_refused():
    with pytest.raises(StorageConfigError, match="part_size"):
        make_store(part_size=MIN_PART_SIZE - 1)


# -- errors -------------------------------------------------------------------------------


def test_a_missing_bucket_is_an_error_not_an_empty_store(raw):
    store = S3ObjectStore("no-such-bucket", region=REGION, access_key_id=ACCESS_KEY_ID, secret_access_key=SECRET)

    with pytest.raises(ObjectStoreError, match="NoSuchBucket") as put_error:
        put(store, "k", b"v")
    with pytest.raises(ObjectStoreError, match="NoSuchBucket"):
        list(store.list())

    assert not isinstance(put_error.value, ObjectNotFoundError)


@pytest.mark.parametrize("code", ["403", "AccessDenied", "InternalError", "SlowDown"])
def test_failures_other_than_not_found_are_not_mistaken_for_absence(s3_store, monkeypatch, code):
    def refuse(**kwargs):
        raise client_error(code)

    monkeypatch.setattr(s3_store._client, "head_object", refuse)
    monkeypatch.setattr(s3_store._client, "get_object", refuse)

    with pytest.raises(ObjectStoreError) as exists_error:
        s3_store.exists("k")
    with pytest.raises(ObjectStoreError):
        s3_store.size("k")
    with pytest.raises(ObjectStoreError) as open_error:
        s3_store.open("k")
    with pytest.raises(ObjectStoreError):
        s3_store.open("k", offset=3, length=2)
    for error in (exists_error.value, open_error.value):
        assert not isinstance(error, ObjectNotFoundError)
        assert code in str(error)


def test_delete_and_list_failures_are_object_store_errors(s3_store, monkeypatch):
    def refuse(**kwargs):
        raise client_error("AccessDenied")

    monkeypatch.setattr(s3_store._client, "delete_object", refuse)
    monkeypatch.setattr(s3_store._client, "list_objects_v2", refuse)

    with pytest.raises(ObjectStoreError, match="AccessDenied"):
        s3_store.delete("k")
    with pytest.raises(ObjectStoreError, match="AccessDenied"):
        list(s3_store.list())


def test_a_connection_failure_is_an_object_store_error(s3_store, monkeypatch):
    def unreachable(**kwargs):
        raise EndpointConnectionError(endpoint_url=ENDPOINT)

    for operation in ("put_object", "get_object", "head_object", "delete_object"):
        monkeypatch.setattr(s3_store._client, operation, unreachable)

    with pytest.raises(ObjectStoreError):
        put(s3_store, "k", b"v")
    with pytest.raises(ObjectStoreError):
        s3_store.open("k")
    with pytest.raises(ObjectStoreError):
        s3_store.size("k")
    with pytest.raises(ObjectStoreError):
        s3_store.exists("k")
    with pytest.raises(ObjectStoreError):
        s3_store.delete("k")


def test_a_body_that_fails_while_streaming_is_an_object_store_error(s3_store, monkeypatch):
    class Dying:
        def read(self, size):
            raise ReadTimeoutError(endpoint_url=ENDPOINT)

        def close(self):
            pass

    monkeypatch.setattr(s3_store._client, "get_object", lambda **kwargs: {"Body": Dying()})

    with s3_store.open("k") as body:
        with pytest.raises(ObjectStoreError):
            body.read(10)


def test_the_secret_never_appears_in_an_error(s3_store, monkeypatch):
    def refuse(**kwargs):
        raise client_error("SignatureDoesNotMatch", message="the request signature we calculated does not match")

    monkeypatch.setattr(s3_store._client, "put_object", refuse)

    with pytest.raises(ObjectStoreError) as error:
        put(s3_store, "k", b"v")

    assert SECRET not in str(error.value)
    assert SECRET not in repr(error.value)


def test_not_found_on_a_head_with_only_a_status_code_is_recognised(s3_store, monkeypatch):
    """A real ``HEAD`` of a missing key has no body, so the error code is just the status."""

    def not_found(**kwargs):
        raise client_error("404", "HeadObject", "Not Found")

    monkeypatch.setattr(s3_store._client, "head_object", not_found)

    assert s3_store.exists("k") is False
    with pytest.raises(ObjectNotFoundError):
        s3_store.size("k")


def test_an_unsatisfiable_range_at_the_end_is_empty_and_past_it_is_invalid(s3_store, monkeypatch):
    """Servers answer a range that starts at or after the end with 416; only the end is fine."""
    put(s3_store, "k", b"12345")

    def unsatisfiable(**kwargs):
        raise client_error("InvalidRange", "GetObject", "The requested range is not satisfiable")

    monkeypatch.setattr(s3_store._client, "get_object", unsatisfiable)

    with s3_store.open("k", offset=5) as body:
        assert body.read() == b""
    with pytest.raises(InvalidRangeError):
        s3_store.open("k", offset=6)
    with pytest.raises(ObjectNotFoundError):
        s3_store.open("absent", offset=6)


# -- client wiring ---------------------------------------------------------------------------


def requests_of(store: S3ObjectStore) -> list:
    """Collect the requests the store's client builds (before moto answers them)."""
    seen: list = []
    store._client.meta.events.register("request-created.s3", lambda request, **kwargs: seen.append(request))
    return seen


def test_a_bucket_is_addressed_by_host_unless_path_style_is_forced(raw):
    hosted = make_store()
    forced = make_store(force_path_style=True)
    hosted_requests, forced_requests = requests_of(hosted), requests_of(forced)

    put(hosted, "a/b", b"v")
    put(forced, "a/b", b"v")

    hosted_url, forced_url = urlparse(hosted_requests[0].url), urlparse(forced_requests[0].url)
    assert hosted_url.hostname.startswith(BUCKET + ".")
    assert hosted_url.path == "/a/b"
    assert not forced_url.hostname.startswith(BUCKET + ".")
    assert forced_url.path == f"/{BUCKET}/a/b"


def test_a_custom_endpoint_is_used_with_path_style_addressing(raw):
    store = make_store(endpoint_url=ENDPOINT, force_path_style=True)
    requests = requests_of(store)

    put(store, "a/b", b"through the endpoint")

    assert read(store, "a/b") == b"through the endpoint"
    assert {urlparse(request.url).netloc for request in requests} == {"objects.test:9000"}
    assert urlparse(requests[0].url).path == f"/{BUCKET}/a/b"
    assert raw.get_object(Bucket=BUCKET, Key="a/b")["Body"].read() == b"through the endpoint"


def test_requests_are_signed_with_the_configured_credentials_and_region(raw):
    store = make_store()
    requests = requests_of(store)

    store.exists("anything")

    authorization = requests[0].headers["Authorization"]
    assert f"Credential={ACCESS_KEY_ID}/" in authorization
    assert f"/{REGION}/s3/aws4_request" in authorization


def test_no_extra_checksum_headers_are_sent(raw):
    """Many S3-compatible servers reject the integrity headers newer clients add by default."""
    store = make_store()
    requests = requests_of(store)

    put(store, "small", b"v")
    put(store, "large", payload(MIN_PART_SIZE + 1))

    assert len(requests) >= 4
    for request in requests:
        names = {name.lower() for name in request.headers.keys()}
        assert not {name for name in names if name.startswith("x-amz-checksum")}
        assert "x-amz-sdk-checksum-algorithm" not in names
        assert "x-amz-trailer" not in names


@pytest.mark.parametrize("key_id, secret", [(ACCESS_KEY_ID, ""), ("", SECRET), (ACCESS_KEY_ID, None), (None, SECRET)])
def test_one_credential_without_the_other_is_refused(key_id, secret):
    with pytest.raises(StorageConfigError, match="together"):
        S3ObjectStore(BUCKET, region=REGION, access_key_id=key_id, secret_access_key=secret)


def test_no_credentials_leaves_them_to_the_client(raw, monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "from-the-environment")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "from-the-environment-secret")
    store = S3ObjectStore(BUCKET, region=REGION)
    requests = requests_of(store)

    store.exists("k")

    assert "Credential=from-the-environment/" in requests[0].headers["Authorization"]


@pytest.mark.parametrize("bucket", ["", "   ", None])
def test_a_blank_bucket_is_refused(bucket):
    with pytest.raises(StorageConfigError, match="S3_BUCKET"):
        S3ObjectStore(bucket, region=REGION)


# -- settings -------------------------------------------------------------------------------------


@pytest.fixture
def s3_settings(monkeypatch):
    """Point the live settings at the mocked service (restored after the test)."""
    _s3_store.cache_clear()
    for name, value in (
        ("STORAGE_BACKEND", "s3"),
        ("S3_BUCKET", BUCKET),
        ("S3_ENDPOINT_URL", ""),
        ("S3_REGION", REGION),
        ("S3_ACCESS_KEY_ID", ACCESS_KEY_ID),
        ("S3_SECRET_ACCESS_KEY", SECRET),
        ("S3_FORCE_PATH_STYLE", 0),
    ):
        monkeypatch.setattr(settings, name, value)
    yield settings
    _s3_store.cache_clear()


def test_the_s3_backend_builds_the_store_from_settings(raw, s3_settings):
    store = get_object_store()

    assert isinstance(store, S3ObjectStore)
    assert store.bucket == BUCKET
    put(store, "via/settings", b"routed")
    assert raw.get_object(Bucket=BUCKET, Key="via/settings")["Body"].read() == b"routed"
    assert read(get_object_store(), "via/settings") == b"routed"


def test_the_s3_store_is_built_once_per_configuration(raw, s3_settings, monkeypatch):
    first = get_object_store()

    assert get_object_store() is first
    monkeypatch.setattr(settings, "S3_BUCKET", "another-bucket")
    other = get_object_store()
    assert other is not first and other.bucket == "another-bucket"
    monkeypatch.setattr(settings, "S3_BUCKET", BUCKET)
    assert get_object_store() is first


def test_the_s3_store_uses_the_endpoint_and_path_style_settings(raw, s3_settings, monkeypatch):
    monkeypatch.setattr(settings, "S3_ENDPOINT_URL", ENDPOINT)
    monkeypatch.setattr(settings, "S3_FORCE_PATH_STYLE", 1)
    store = get_object_store()
    requests = requests_of(store)

    put(store, "k", b"v")

    assert urlparse(requests[0].url).netloc == "objects.test:9000"
    assert urlparse(requests[0].url).path == f"/{BUCKET}/k"


@pytest.mark.parametrize("bucket", ["", "   "])
def test_an_unconfigured_bucket_is_refused(s3_settings, monkeypatch, bucket):
    monkeypatch.setattr(settings, "S3_BUCKET", bucket)

    with pytest.raises(StorageConfigError, match="S3_BUCKET"):
        get_object_store()


def test_the_backend_is_read_from_the_environment(monkeypatch):
    values = {
        "STORAGE_BACKEND": " S3 ",
        "S3_BUCKET": " scholium-bucket ",
        "S3_ENDPOINT_URL": "http://minio:9000",
        "S3_REGION": "eu-test-1",
        "S3_ACCESS_KEY_ID": "id",
        "S3_SECRET_ACCESS_KEY": SECRET,
        "S3_FORCE_PATH_STYLE": "1",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)

    loaded = Settings()

    assert loaded.STORAGE_BACKEND == "s3"
    assert loaded.S3_BUCKET == "scholium-bucket"
    assert loaded.S3_ENDPOINT_URL == "http://minio:9000"
    assert loaded.S3_REGION == "eu-test-1"
    assert loaded.S3_ACCESS_KEY_ID == "id"
    assert loaded.S3_SECRET_ACCESS_KEY == SECRET
    assert loaded.S3_FORCE_PATH_STYLE == 1


def test_the_s3_settings_default_to_unset(monkeypatch):
    for name in (
        "STORAGE_BACKEND",
        "S3_BUCKET",
        "S3_ENDPOINT_URL",
        "S3_REGION",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
        "S3_FORCE_PATH_STYLE",
    ):
        monkeypatch.delenv(name, raising=False)

    loaded = Settings()

    assert loaded.STORAGE_BACKEND == "fs"
    assert (loaded.S3_BUCKET, loaded.S3_ENDPOINT_URL, loaded.S3_REGION) == ("", "", "")
    assert (loaded.S3_ACCESS_KEY_ID, loaded.S3_SECRET_ACCESS_KEY) == ("", "")
    assert loaded.S3_FORCE_PATH_STYLE == 0


@pytest.mark.parametrize(
    "raw_value, expected",
    [("1", 1), ("true", 1), ("TRUE", 1), (" yes ", 1), ("on", 1), ("0", 0), ("false", 0), ("no", 0), ("off", 0), ("", 0), ("maybe", 0)],
)
def test_force_path_style_reads_the_usual_spellings(monkeypatch, raw_value, expected):
    monkeypatch.setenv("S3_FORCE_PATH_STYLE", raw_value)

    assert Settings().S3_FORCE_PATH_STYLE == expected


def test_the_secret_is_kept_out_of_repr(monkeypatch):
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", SECRET)
    monkeypatch.setenv("S3_ACCESS_KEY_ID", ACCESS_KEY_ID)

    assert SECRET not in repr(Settings())


# -- production validation -----------------------------------------------------------------------


def production(tmp_path, monkeypatch, **overrides) -> Settings:
    from test_app_factory import _safe_production_settings

    prod = _safe_production_settings(tmp_path, monkeypatch)
    prod.STORAGE_BACKEND = "s3"
    prod.S3_BUCKET = BUCKET
    prod.S3_ACCESS_KEY_ID = ACCESS_KEY_ID
    prod.S3_SECRET_ACCESS_KEY = SECRET
    for name, value in overrides.items():
        setattr(prod, name, value)
    return prod


def test_production_accepts_a_complete_s3_backend(tmp_path, monkeypatch):
    production(tmp_path, monkeypatch).validate_for_environment()


def test_production_does_not_need_an_endpoint_or_region_for_s3(tmp_path, monkeypatch):
    production(tmp_path, monkeypatch, S3_ENDPOINT_URL="", S3_REGION="").validate_for_environment()


def test_production_refuses_the_default_filesystem_backend(tmp_path, monkeypatch):
    """``fs`` is a development backend: production keeps objects in an S3-API bucket."""
    prod = production(tmp_path, monkeypatch, STORAGE_BACKEND="fs", S3_BUCKET="", S3_ACCESS_KEY_ID="", S3_SECRET_ACCESS_KEY="")

    with pytest.raises(RuntimeError, match="STORAGE_BACKEND must be s3 in production"):
        prod.validate_for_environment()


@pytest.mark.parametrize("bucket", ["", "   "])
def test_production_rejects_s3_without_a_bucket(tmp_path, monkeypatch, bucket):
    prod = production(tmp_path, monkeypatch, S3_BUCKET=bucket)

    with pytest.raises(RuntimeError, match="S3_BUCKET must be set"):
        prod.validate_for_environment()


@pytest.mark.parametrize(
    "overrides",
    [
        {"S3_ACCESS_KEY_ID": ""},
        {"S3_SECRET_ACCESS_KEY": ""},
        {"S3_ACCESS_KEY_ID": "  ", "S3_SECRET_ACCESS_KEY": "  "},
        {"S3_ACCESS_KEY_ID": "", "S3_SECRET_ACCESS_KEY": ""},
    ],
    ids=["no key id", "no secret", "blank pair", "neither"],
)
def test_production_rejects_s3_without_credentials(tmp_path, monkeypatch, overrides):
    prod = production(tmp_path, monkeypatch, **overrides)

    with pytest.raises(RuntimeError, match="S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set"):
        prod.validate_for_environment()


def test_production_reports_every_missing_s3_setting_at_once(tmp_path, monkeypatch):
    prod = production(tmp_path, monkeypatch, S3_BUCKET="", S3_ACCESS_KEY_ID="", S3_SECRET_ACCESS_KEY="", JWT_SECRET="short")

    with pytest.raises(RuntimeError) as error:
        prod.validate_for_environment()

    message = str(error.value)
    assert "S3_BUCKET" in message and "S3_ACCESS_KEY_ID" in message and "JWT_SECRET" in message


def test_a_production_failure_never_quotes_the_secret(tmp_path, monkeypatch):
    prod = production(tmp_path, monkeypatch, S3_BUCKET="", S3_ACCESS_KEY_ID="")

    with pytest.raises(RuntimeError) as error:
        prod.validate_for_environment()

    assert SECRET not in str(error.value)


def test_development_does_not_require_s3_settings(tmp_path, monkeypatch):
    dev = Settings()
    dev.SCHOLIUM_ENV = "dev"
    dev.STORAGE_BACKEND = "s3"
    dev.S3_BUCKET = dev.S3_ACCESS_KEY_ID = dev.S3_SECRET_ACCESS_KEY = ""

    dev.validate_for_environment()


@pytest.mark.parametrize("environment", ["dev", "production"])
def test_an_unknown_storage_backend_is_refused_everywhere(tmp_path, monkeypatch, environment):
    prod = production(tmp_path, monkeypatch, STORAGE_BACKEND="gcs", SCHOLIUM_ENV=environment)

    with pytest.raises(RuntimeError, match="STORAGE_BACKEND"):
        prod.validate_for_environment()


def test_the_backend_name_is_case_and_space_insensitive_when_validated(tmp_path, monkeypatch):
    production(tmp_path, monkeypatch, STORAGE_BACKEND=" S3 ").validate_for_environment()
    with pytest.raises(RuntimeError, match="S3_BUCKET"):
        production(tmp_path, monkeypatch, STORAGE_BACKEND=" S3 ", S3_BUCKET="").validate_for_environment()

