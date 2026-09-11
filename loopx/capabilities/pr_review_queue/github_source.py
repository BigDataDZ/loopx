"""Bounded GitHub reads for the pull-request review queue."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Callable

GitHubJsonRunner = Callable[..., Any]

DETAIL_FIELDS = (
    "body",
    "files",
    "reviewDecision",
    "mergeStateStatus",
    "createdAt",
    "commits",
    "reviews",
    "statusCheckRollup",
)


def run_gh_json(args: list[str], *, cwd: Path | None = None) -> Any:
    proc = subprocess.run(
        ["gh", *args],
        cwd=cwd,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return json.loads(proc.stdout or "null")


def _fetch_complete_pr_files(
    *,
    repository: str,
    number: str,
    expected_count: int,
    cwd: Path | None,
    run_gh_json: GitHubJsonRunner,
) -> list[dict[str, Any]] | None:
    try:
        payload = run_gh_json(
            [
                "api",
                "--paginate",
                "--slurp",
                f"repos/{repository}/pulls/{number}/files?per_page=100",
            ],
            cwd=cwd,
        )
    except Exception:
        return None
    if not isinstance(payload, list):
        return None
    pages = payload if all(isinstance(page, list) for page in payload) else [payload]
    files: list[dict[str, Any]] = []
    for page in pages:
        for item in page:
            if not isinstance(item, dict):
                return None
            path = str(item.get("filename") or item.get("path") or "").strip()
            if not path:
                return None
            files.append(
                {
                    "path": path,
                    "additions": int(item.get("additions") or 0),
                    "deletions": int(item.get("deletions") or 0),
                }
            )
    return files if len(files) == expected_count else None


def attach_pr_review_details(
    row: dict[str, Any],
    *,
    repository: str | None,
    cwd: Path | None = None,
    run_gh_json: GitHubJsonRunner = run_gh_json,
) -> bool:
    """Attach complete per-PR details after the lightweight list scan."""

    number = str(row.get("number") or "").strip()
    if not number or not repository:
        return False
    try:
        details = run_gh_json(
            [
                "pr",
                "view",
                number,
                "--json",
                ",".join(DETAIL_FIELDS),
                "--repo",
                repository,
            ],
            cwd=cwd,
        )
    except Exception:
        return False
    try:
        expected_file_count = int(row["changedFiles"])
    except (KeyError, TypeError, ValueError):
        return False
    if not isinstance(details, dict) or any(
        key not in details for key in DETAIL_FIELDS
    ):
        return False
    detail_files = details["files"]
    if not isinstance(detail_files, list):
        return False
    if len(detail_files) != expected_file_count:
        detail_files = _fetch_complete_pr_files(
            repository=repository,
            number=number,
            expected_count=expected_file_count,
            cwd=cwd,
            run_gh_json=run_gh_json,
        )
        if detail_files is None:
            return False
        details["files"] = detail_files
    for key in DETAIL_FIELDS:
        row[key] = details[key]
    return True
