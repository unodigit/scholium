"""The LLM provider settings: ``AI_PROVIDER`` and the Anthropic / OpenAI-compatible knobs.

``AI_PROVIDER`` is checked by the same ``Settings`` check as ``JOBS_MODE``, in
every environment; production additionally refuses an ``openai`` provider that
has no key or no explicitly chosen model.  No test touches a network, and none
may leak a key into an error message or ``repr``.
"""

import pytest

from app.settings import Settings

ACCEPTED = ("fake", "anthropic", "openai", "ollama")

# Distinctive enough that finding one in a message or repr cannot be a coincidence.
OPENAI_SECRET = "sk-test-openai-3f9a1c77d2e84b60"
ANTHROPIC_SECRET = "sk-ant-test-8e51b0c4a9d3f627"


@pytest.fixture(autouse=True)
def clean_provider_env(monkeypatch):
    """No provider variable from the developer's shell reaches a ``Settings()``."""
    for name in (
        "AI_PROVIDER", "AI_HOSTED_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY", "OPENAI_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)


def production(tmp_path, monkeypatch, **overrides) -> Settings:
    """A production ``Settings`` that is safe in every respect but the ones overridden.

    The base is the fully configured production of ``test_app_factory`` (which
    clears ``ANTHROPIC_API_KEY``); ``Settings`` is built from the environment as
    the test has left it.
    """
    from test_app_factory import _safe_production_settings

    prod = _safe_production_settings(tmp_path, monkeypatch)
    for name, value in overrides.items():
        setattr(prod, name, value)
    return prod


def refusal(settings: Settings) -> str:
    with pytest.raises(RuntimeError) as err:
        settings.validate_for_environment()
    return str(err.value)


# --- AI_PROVIDER ---------------------------------------------------------------


def test_the_default_provider_is_fake_and_is_accepted():
    settings = Settings()
    assert settings.AI_PROVIDER == "fake"
    settings.validate_for_environment()


@pytest.mark.parametrize(
    "spelling",
    ["fake", "anthropic", "openai", "ollama", "FAKE", "Anthropic", "OpenAI", "OLLAMA",
     " openai ", "\tOllama\n", "  FAKE"],
)
def test_every_accepted_provider_is_read_case_insensitively_with_spaces_ignored(monkeypatch, spelling):
    monkeypatch.setenv("AI_PROVIDER", spelling)
    Settings().validate_for_environment()


def test_an_empty_provider_means_fake_as_get_provider_reads_it(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "")
    Settings().validate_for_environment()  # accepted in development ...
    # ... and judged as fake in production.
    assert "AI_PROVIDER must not be fake" in refusal(production(tmp_path, monkeypatch, AI_PROVIDER=""))


@pytest.mark.parametrize(
    "value",
    ["gpt", "opnai", "deepseek", "anthropic2", "openai-compatible", "open ai", "anthropic,openai",
     "   ", "none", "0"],
)
@pytest.mark.parametrize("environment", ["dev", "production"])
def test_any_other_provider_is_refused_in_every_environment(tmp_path, monkeypatch, value, environment):
    settings = production(tmp_path, monkeypatch, AI_PROVIDER=value, SCHOLIUM_ENV=environment)
    message = refusal(settings)
    assert "AI_PROVIDER" in message and repr(value) in message
    for accepted in ACCEPTED:
        assert accepted in message, message


def test_an_unknown_provider_is_refused_on_its_own_as_an_unknown_jobs_mode_is(tmp_path, monkeypatch):
    """It is not one more production problem: it is refused before that list is built."""
    unsafe = production(tmp_path, monkeypatch, AI_PROVIDER="gpt", JWT_SECRET="", ORCID_MOCK=1)
    message = refusal(unsafe)
    assert message.startswith("Unknown AI_PROVIDER"), message
    assert "JWT_SECRET" not in message and "Unsafe production configuration" not in message

    assert refusal(production(tmp_path, monkeypatch, JOBS_MODE="extrenal")).startswith("Unknown JOBS_MODE")


def test_an_unknown_provider_is_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "antropic")
    message = refusal(Settings())
    assert "AI_PROVIDER" in message and "'antropic'" in message


def test_every_provider_get_provider_builds_is_accepted_by_settings():
    from app.modules.ai_review.providers import _PROVIDER_CLASSES

    assert set(_PROVIDER_CLASSES) <= set(ACCEPTED)


# --- ANTHROPIC_BASE_URL, OPENAI_API_KEY, OPENAI_BASE_URL -------------------------


def test_provider_settings_default_when_the_environment_is_silent():
    settings = Settings()
    assert settings.ANTHROPIC_BASE_URL == ""
    assert settings.OPENAI_API_KEY == ""
    assert settings.OPENAI_BASE_URL == "https://api.openai.com/v1"


def test_provider_settings_are_read_from_the_environment(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://llm-gateway.example/anthropic")
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_SECRET)
    monkeypatch.setenv("OPENAI_BASE_URL", "http://llm.internal:8080/v1")
    settings = Settings()
    assert settings.ANTHROPIC_BASE_URL == "https://llm-gateway.example/anthropic"
    assert settings.OPENAI_API_KEY == OPENAI_SECRET
    assert settings.OPENAI_BASE_URL == "http://llm.internal:8080/v1"


@pytest.mark.parametrize("written, read", [("", ""), ("  ", ""), (" http://llm.internal:8081 ", "http://llm.internal:8081")])
def test_the_anthropic_base_url_is_empty_unless_it_names_a_server(monkeypatch, written, read):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", written)
    assert Settings().ANTHROPIC_BASE_URL == read


@pytest.mark.parametrize(
    "written, read",
    [
        ("https://llm.example/v1/", "https://llm.example/v1"),
        ("https://llm.example/v1//", "https://llm.example/v1"),
        ("https://llm.example/", "https://llm.example"),
        ("  https://llm.example/v1/  ", "https://llm.example/v1"),
        ("https://llm.example/v1", "https://llm.example/v1"),
        # Unset-like values mean the default rather than a base URL that is not one.
        ("", "https://api.openai.com/v1"),
        ("  ", "https://api.openai.com/v1"),
        ("/", "https://api.openai.com/v1"),
    ],
)
def test_the_openai_base_url_loses_its_trailing_slash(monkeypatch, written, read):
    monkeypatch.setenv("OPENAI_BASE_URL", written)
    assert Settings().OPENAI_BASE_URL == read


def test_the_openai_key_is_not_in_the_repr(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_SECRET)
    settings = Settings()
    assert settings.OPENAI_API_KEY == OPENAI_SECRET
    assert OPENAI_SECRET not in repr(settings) and OPENAI_SECRET not in str(settings)


def test_the_provider_urls_do_not_affect_validation(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "http://llm.internal:8080/v1/")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://llm.internal:8081")
    Settings().validate_for_environment()


# --- production: AI_PROVIDER=openai ----------------------------------------------


def openai_production(tmp_path, monkeypatch, *, key=OPENAI_SECRET, model="gpt-example") -> Settings:
    """Production with ``AI_PROVIDER=openai``, ``key`` and ``model`` (``None``: unset) as configured."""
    if model is None:
        monkeypatch.delenv("AI_HOSTED_MODEL", raising=False)
    else:
        monkeypatch.setenv("AI_HOSTED_MODEL", model)
    return production(tmp_path, monkeypatch, AI_PROVIDER="openai", OPENAI_API_KEY=key)


def test_production_accepts_openai_with_a_key_and_a_model(tmp_path, monkeypatch):
    openai_production(tmp_path, monkeypatch).validate_for_environment()


def test_production_accepts_an_openai_key_and_model_read_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_SECRET)
    monkeypatch.setenv("AI_HOSTED_MODEL", "gpt-example")
    prod = production(tmp_path, monkeypatch, AI_PROVIDER=" OpenAI ")
    assert prod.OPENAI_API_KEY == OPENAI_SECRET and prod.AI_HOSTED_MODEL == "gpt-example"
    prod.validate_for_environment()


@pytest.mark.parametrize("key", ["", "   "], ids=["empty", "blank"])
def test_production_refuses_openai_without_a_key(tmp_path, monkeypatch, key):
    message = refusal(openai_production(tmp_path, monkeypatch, key=key))
    assert "OPENAI_API_KEY must be set when AI_PROVIDER is openai" in message, message
    assert "AI_HOSTED_MODEL" not in message


@pytest.mark.parametrize("model", [None, "", "   "], ids=["unset", "empty", "blank"])
def test_production_refuses_openai_when_the_model_variable_is_unset_or_empty(tmp_path, monkeypatch, model):
    message = refusal(openai_production(tmp_path, monkeypatch, model=model))
    assert "AI_HOSTED_MODEL must be set" in message, message
    assert "Anthropic" in message, message
    assert "OPENAI_API_KEY" not in message


def test_the_model_default_is_an_anthropic_id_which_is_why_openai_needs_it_set(monkeypatch):
    monkeypatch.delenv("AI_HOSTED_MODEL", raising=False)
    assert Settings().AI_HOSTED_MODEL.startswith("claude-")


def test_a_model_variable_that_names_the_default_is_not_second_guessed(tmp_path, monkeypatch):
    """An operator who sets it on purpose (a gateway that serves that id) is believed."""
    openai_production(tmp_path, monkeypatch, model="claude-sonnet-5-5").validate_for_environment()


def test_production_reports_both_openai_problems_together(tmp_path, monkeypatch):
    message = refusal(openai_production(tmp_path, monkeypatch, key="", model=None))
    assert message.startswith("Unsafe production configuration"), message
    assert "OPENAI_API_KEY must be set" in message and "AI_HOSTED_MODEL must be set" in message


def test_the_openai_checks_only_apply_to_the_openai_provider(tmp_path, monkeypatch):
    """Neither a key nor a model variable is demanded of ollama; anthropic needs only its own key."""
    monkeypatch.delenv("AI_HOSTED_MODEL", raising=False)
    production(tmp_path, monkeypatch, AI_PROVIDER="ollama", OPENAI_API_KEY="").validate_for_environment()

    anthropic = production(tmp_path, monkeypatch, AI_PROVIDER="Anthropic", OPENAI_API_KEY="")
    monkeypatch.setenv("ANTHROPIC_API_KEY", ANTHROPIC_SECRET)
    anthropic.validate_for_environment()


def test_production_still_refuses_anthropic_without_its_key(tmp_path, monkeypatch):
    message = refusal(production(tmp_path, monkeypatch, AI_PROVIDER="anthropic"))
    assert "ANTHROPIC_API_KEY must be set when AI_PROVIDER is anthropic" in message


def test_production_still_refuses_fake(tmp_path, monkeypatch):
    assert "AI_PROVIDER must not be fake" in refusal(production(tmp_path, monkeypatch, AI_PROVIDER="fake"))


def test_development_does_not_demand_an_openai_key_or_model(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    settings = Settings()
    assert settings.OPENAI_API_KEY == ""
    settings.validate_for_environment()


# --- no API key in any error message ---------------------------------------------


def test_no_refusal_contains_an_api_key(tmp_path, monkeypatch):
    """Every way of being refused, with both keys configured, quotes neither of them."""
    messages = []

    unknown = production(tmp_path, monkeypatch, AI_PROVIDER="gpt", OPENAI_API_KEY=OPENAI_SECRET)
    messages.append(refusal(unknown))

    no_model = openai_production(tmp_path, monkeypatch, model=None)
    messages.append(refusal(no_model))

    many = openai_production(tmp_path, monkeypatch, model="", key="")
    many.JWT_SECRET = ""
    many.SMTP_URL = ""
    many.ORCID_MOCK = 1
    messages.append(refusal(many))

    fake = production(tmp_path, monkeypatch, AI_PROVIDER="fake", OPENAI_API_KEY=OPENAI_SECRET)
    messages.append(refusal(fake))

    anthropic = production(tmp_path, monkeypatch, AI_PROVIDER="anthropic", OPENAI_API_KEY=OPENAI_SECRET)
    messages.append(refusal(anthropic))

    # ANTHROPIC_API_KEY is only in the environment; set it while every refusal is built.
    monkeypatch.setenv("ANTHROPIC_API_KEY", ANTHROPIC_SECRET)
    for settings in (unknown, no_model, many, fake):
        messages.append(refusal(settings))

    assert len(messages) == 9
    for message in messages:
        for secret in (OPENAI_SECRET, ANTHROPIC_SECRET):
            assert secret not in message and secret[:12] not in message, message


def test_a_key_given_through_the_environment_is_not_quoted_either(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", OPENAI_SECRET)
    prod = openai_production(tmp_path, monkeypatch, key=OPENAI_SECRET, model=None)
    assert prod.OPENAI_API_KEY == OPENAI_SECRET
    message = refusal(prod)
    assert "AI_HOSTED_MODEL must be set" in message
    assert OPENAI_SECRET not in message
