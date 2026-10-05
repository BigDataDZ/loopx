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


def png(width=2, height=2):
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\x00" + b"\x30\x80\xA0" * width) * height)) + chunk(b"IEND", b""))


def test_image_pixels_and_provenance_are_content_not_json_metadata(configured, monkeypatch):
    from pathlib import Path
    from mcp.types import ImageContent, TextContent
    def run(args, **kwargs):
        import re
        path = json.loads(re.search(r"path:(\"[^\"]+\")", args[-1])[1])
        Path(path).write_bytes(png())
        return response({"url": URL, "index": 8, "alt": "figure"})
    monkeypatch.setattr(reader.subprocess, "run", run)
    content = reader.read_public_image(URL, 8)
    assert isinstance(content[0], TextContent) and isinstance(content[1], ImageContent)
    metadata = json.loads(content[0].text)
    assert metadata["ok"] and metadata["index"] == 8 and metadata["width"] == 2
    assert "image_data" not in metadata and "not atomically" in metadata["limitations"]
    import base64
    assert base64.b64decode(content[1].data) == png()


@pytest.mark.parametrize("index", [True, -1, 128, 1.5, "0"])
def test_image_invalid_index_never_touches_browser(configured, monkeypatch, index):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: pytest.fail("browser accessed"))
    assert json.loads(reader.read_public_image(URL, index)[0].text)["error"] == "source_image_index_invalid"


@pytest.mark.parametrize("url,error", [("https://other.test/", "source_origin_not_authorized"),
                                       ("http://example.com/", "source_url_invalid")])
def test_image_uses_existing_source_authority(configured, monkeypatch, url, error):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: pytest.fail("browser accessed"))
    assert json.loads(reader.read_public_image(url, 0)[0].text)["error"] == error


@pytest.mark.parametrize("value", [
    {"url": "https://other.test/private", "index": 8, "alt": "private"},
    {"url": URL, "index": 9, "alt": "changed"},
    {"url": URL, "index": True, "alt": "changed"},
    {"url": URL, "index": 8, "alt": "x" * 513}, [],
])
def test_image_malformed_or_raced_provenance_returns_no_pixels(tmp_path, value):
    path = tmp_path / "image.png"
    path.write_bytes(png())
    result = reader._image_result(response(value).stdout, "", URL, 8, str(path))
    assert result == {"ok": False, "error": "browser_image_result_invalid"}


@pytest.mark.parametrize("data", [b"not PNG", png(1, 2), png(4097, 2), b"x" * 4_000_001])
def test_image_binary_and_size_limits_preserve_failure(tmp_path, data):
    path = tmp_path / "image.png"
    path.write_bytes(data)
    r = reader._image_result(response({"url": URL, "index": 8, "alt": ""}).stdout, "", URL, 8, str(path))
    assert r == {"ok": False, "error": "browser_image_result_invalid"}


@pytest.mark.parametrize("error", ["source_url_changed", "source_image_unavailable", "source_image_bounds_unsupported"])
def test_image_browser_boundary_rejects_before_file_access(tmp_path, error):
    assert reader._image_result(response({"error": error}).stdout, "", URL, 8, str(tmp_path / "absent")) == {"ok": False, "error": error}


def test_image_and_text_share_the_reserved_page_lock(configured, monkeypatch):
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: pytest.fail("browser accessed"))
    with reader._READ_LOCK:
        assert json.loads(reader.read_public_image(URL, 8)[0].text)["error"] == "source_reader_busy"


@pytest.mark.parametrize("inventory", [[{"index": 0, "alt": "", "natural_width": True, "natural_height": 2}],
                                      [{"index": 1, "alt": "", "natural_width": 2, "natural_height": 2}],
                                      "images"])
def test_image_inventory_is_validated(inventory):
    assert not reader._result(response(extraction(images=inventory)).stdout, "", URL)["ok"]


def test_image_mcp_stdio_returns_native_image_content(configured, monkeypatch):
    import asyncio
    import base64
    import os
    import sys
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from mcp.types import ImageContent
    configured.write_text("#!" + sys.executable + "\n" +
        "import sys,re,json,base64\nfrom pathlib import Path\n" +
        "path=json.loads(re.search(r'path:(\"[^\"]+\")',sys.argv[-1])[1])\n" +
        "Path(path).write_bytes(base64.b64decode(" + repr(base64.b64encode(png()).decode()) + "))\n" +
        "print('LOOPX_PUBLIC_SOURCE:'+" + repr(json.dumps({"url": URL, "index": 8, "alt": "figure"})) + ")\n")
    configured.chmod(0o700)
    async def journey():
        async with stdio_client(StdioServerParameters(command=sys.executable,
            args=["-m", "loopx.extensions.ego_source_reader"], env=dict(os.environ))) as (incoming, outgoing):
            async with ClientSession(incoming, outgoing) as session:
                await session.initialize()
                tools = await session.list_tools()
                image_tool = next(t for t in tools.tools if t.name == "read_public_image")
                assert image_tool.annotations.readOnlyHint is True
                assert set(image_tool.inputSchema["properties"]) == {"url", "index"}
                result = await session.call_tool("read_public_image", {"url": URL, "index": 8})
                assert not result.isError
                assert any(isinstance(c, ImageContent) and base64.b64decode(c.data) == png() for c in result.content)
    asyncio.run(journey())


def test_text_read_exposes_image_indices_without_claiming_visual_read(configured, monkeypatch):
    item = {"index": 0, "alt": "diagram", "natural_width": 1080, "natural_height": 550}
    monkeypatch.setattr(reader.subprocess, "run", lambda *a, **k: response(extraction(images=[item])))
    result = reader.read_public_url(URL)
    assert result["images"] == [item] and result["image_inventory_truncated"] is True
    assert result["images_read"] is False
