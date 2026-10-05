"""Source adapter boundaries; actual browser/host acceptance is separate."""
import hashlib
import json
import subprocess

import pytest

from loopx.extensions import ego_source_reader as reader

URL = "https://example.com/article?q=1"


@pytest.fixture
def configured(monkeypatch, tmp_path):
    executable = tmp_path / "ego-browser"
    executable.write_text("installed executable fixture")
    monkeypatch.setenv("LOOPX_EGO_READ_BIN", str(executable))
    monkeypatch.setenv("LOOPX_EGO_READ_TASK_SPACE", "7")
    monkeypatch.setenv("LOOPX_EGO_READ_PAGE", "p2")
    monkeypatch.setenv("LOOPX_EGO_READ_ORIGINS", "https://example.com")
    return executable


def extraction(**changes):
    return {"url": URL, "title": "Article", "text": "Source evidence 原文",
            "truncated": False, "image_count": 2, **changes}


def response(value, *, stderr=False):
    output = reader.MARKER + json.dumps(value)
    return subprocess.CompletedProcess([], 0, "" if stderr else output,
                                       output if stderr else "")


@pytest.mark.parametrize("stderr", [False, True])
def test_read_returns_evidence_without_visual_or_write_claim(configured, monkeypatch, stderr):
    calls = []

    def run(args, **kwargs):
        calls.append((args, kwargs))
        return response(extraction(), stderr=stderr)

    monkeypatch.setattr(reader.subprocess, "run", run)
    result = reader.read_public_url(URL)
    assert result["ok"] and result["text"] == "Source evidence 原文"
    assert result["sha256"] == hashlib.sha256(result["text"].encode()).hexdigest()
    assert result["images_read"] is False and result["image_count"] == 2
    args, kwargs = calls[0]
    assert args[:3] == [str(configured), "nodejs", "-e"]
    assert kwargs["stdin"] == subprocess.DEVNULL and kwargs["timeout"] == 30
    assert "shell" not in kwargs
    assert "does not prove article" in result["limitations"]


@pytest.mark.parametrize("url,error", [
    ("http://example.com/article", "source_url_invalid"),
    ("https://user:secret@example.com/article", "source_url_invalid"),
    ("https://@example.com/article", "source_url_invalid"),
    ("https://example.com:8443/article", "source_url_invalid"),
    ("https://example.com.evil.test/article", "source_origin_not_authorized"),
    ("https://other.test/article", "source_origin_not_authorized"),
    ("https://example.com\n.evil.test/article", "source_url_invalid"),
    ("https://example.com\\@evil.test/article", "source_url_invalid"),
    ("javascript:alert(1)", "source_url_invalid"),
])
def test_rejects_url_before_browser_access(configured, monkeypatch, url, error):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: pytest.fail("browser accessed"))
    assert reader.read_public_url(url) == {"ok": False, "error": error}


@pytest.mark.parametrize("key,value", [
    ("LOOPX_EGO_READ_PAGE", "p1);process.exit()"),
    ("LOOPX_EGO_READ_TASK_SPACE", "0"),
    ("LOOPX_EGO_READ_ORIGINS", "https://example.com/private"),
    ("LOOPX_EGO_READ_ORIGINS", "https://example.com/#fragment"),
    ("LOOPX_EGO_READ_BIN", "relative-command"),
])
def test_bad_operator_configuration_fails_closed(configured, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: pytest.fail("browser accessed"))
    assert reader.read_public_url(URL)["error"] == "source_reader_not_configured"


@pytest.mark.parametrize("value", [
    extraction(url="https://other.test/private"),
    extraction(url="https://example.com/another-article"),
    extraction(text=""), extraction(text="x" * (reader.MAX_TEXT_CHARS + 1)),
    extraction(text=None), extraction(truncated="false"),
    extraction(image_count=True), extraction(title=None), [], {},
])
def test_malformed_or_raced_result_does_not_escape(configured, monkeypatch, value):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: response(value))
    assert reader.read_public_url(URL) == {"ok": False, "error": "browser_read_result_invalid"}


def test_redirect_fence_returns_no_text(configured, monkeypatch):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: response({"error": "source_url_changed"}))
    assert reader.read_public_url(URL) == {"ok": False, "error": "source_url_changed"}


def test_browser_failures_are_sanitized(configured, monkeypatch):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k:
                        subprocess.CompletedProcess([], 4, "", "private bootstrap output"))
    assert reader.read_public_url(URL) == {"ok": False, "error": "browser_read_failed", "exit_code": 4}

    def timeout(*a, **k):
        raise subprocess.TimeoutExpired("private command", 30)

    monkeypatch.setattr(reader.subprocess, "run", timeout)
    assert reader.read_public_url(URL) == {"ok": False, "error": "browser_read_timeout"}


def test_truncation_and_verification_page_remain_observable(configured, monkeypatch):
    # A provider success is not semantic evidence that an article was readable.
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k:
                        response(extraction(text="Complete verification to continue", truncated=True)))
    result = reader.read_public_url(URL)
    assert result["ok"] and result["truncated"]
    assert "verification wall" in result["limitations"]


def test_concurrent_call_does_not_navigate_reserved_page(configured, monkeypatch):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: pytest.fail("browser accessed"))
    with reader._READ_LOCK:
        assert reader.read_public_url(URL)["error"] == "source_reader_busy"


def test_duplicate_or_non_json_result_is_rejected():
    assert not reader._result(reader.MARKER + "not json", "", URL)["ok"]
    output = reader.MARKER + json.dumps(extraction())
    assert not reader._result(output, output, URL)["ok"]


def test_url_is_json_data_and_fence_precedes_dom_read(configured):
    config = reader.ReaderConfig.from_environment()
    url = 'https://example.com/?q=";process.exit();//'
    script = reader._script(config, url)
    assert "p.goto(" + json.dumps(url) + ")" in script
    assert script.index("current.href!==request.url") < script.index("document.body")
