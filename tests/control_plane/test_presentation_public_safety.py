"""Public presentation paths are classified by the shared text owner."""

from __future__ import annotations

import pytest

from loopx import public_safe_text
from loopx.presentation import public_safety


def test_presentation_path_rules_are_owned_by_public_safe_text() -> None:
    assert (
        public_safety.LOCAL_PATH_PATTERNS
        is public_safe_text.PRESENTATION_LOCAL_PATH_PATTERNS
    )
    assert (
        public_safety.PUBLIC_BOUNDARY_PATTERNS
        is public_safe_text.PRESENTATION_PUBLIC_BOUNDARY_PATTERNS
    )


@pytest.mark.parametrize(
    "path",
    [
        r"C:\Users\alice\goal.md",
        r"\\fileserver\share\goal.md",
    ],
)
def test_windows_local_paths_are_redacted_and_rejected(path: str) -> None:
    redacted = public_safety.redact_public_text(
        f"private source: {path}", limit=200
    )

    assert path not in redacted
    assert "<local-path-redacted>" in redacted
    assert public_safety.scan_public_boundary_text(path) == {
        "ok": False,
        "warnings": ["absolute local path"],
    }


def test_colon_prefixed_unix_paths_keep_the_existing_boundary() -> None:
    path = "source:/Users/alice/goal.md"

    assert "<local-path-redacted>" in public_safety.redact_public_text(
        path, limit=200
    )
    assert public_safety.scan_public_boundary_text(path) == {
        "ok": False,
        "warnings": ["absolute local path"],
    }
