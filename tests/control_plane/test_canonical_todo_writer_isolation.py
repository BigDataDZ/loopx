"""Canonical callers must not load an unpromoted Goal's line writer."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from canonical_authority_fixture import isolate_sqlite_runtime, promoted_create_fixture


@pytest.fixture
def without_source_line_writer(tmp_path, monkeypatch):
    isolate_sqlite_runtime(tmp_path, monkeypatch)
    package_root = tmp_path / "package"
    package = package_root / "loopx"
    shutil.copytree(Path(__file__).resolve().parents[2] / "loopx", package,
                    ignore=shutil.ignore_patterns("__pycache__"))
    (package / "control_plane/todos/line_update.py").unlink()
    monkeypatch.setenv("PYTHONPATH", str(package_root))
    provenance = subprocess.check_output(
        [sys.executable, "-c", "import loopx; print(loopx.__file__)"],
        cwd=tmp_path, text=True,
    ).strip()
    assert Path(provenance) == package / "__init__.py"


@pytest.mark.parametrize("provider", ["file", "sqlite"])
def test_canonical_cli_lifecycle_without_source_line_writer(tmp_path, provider, without_source_line_writer):
    registry, _runtime, state = promoted_create_fixture(tmp_path, provider=provider)

    def cli(*args):
        actor = ["--agent-id", "agent-a"] if args[0] in ("update", "complete", "supersede") else []
        result = subprocess.run(
            [sys.executable, "-m", "loopx.cli", "--format", "json",
             "--registry", str(registry), "todo", *args, *actor],
            cwd=tmp_path, capture_output=True, text=True, timeout=45,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        payload = json.loads(result.stdout)
        assert payload["ok"], payload
        return payload

    def add(role, text, operation):
        return cli("add", "--goal-id", "goal-a", "--role", role,
                   "--text", text, "--operation-id", operation,
                   *(["--task-class", "user_action"] if role == "user" else []))["todo_id"]

    original = add("agent", "Original work", "original")
    replacement = add("agent", "Replacement work", "replacement")
    user = add("user", "User action", "user")
    listing = cli("list", "--goal-id", "goal-a")
    updated = cli("update", "--goal-id", "goal-a", "--todo-id", original,
                  "--note", "Retain source identity", "--update-operation-id", "update",
                  "--update-expected-provider-revision", listing["authority_read"]["provider_revision"])
    assert updated["todo_id"] == original
    updated_records = cli("list", "--goal-id", "goal-a", "--todo-id", original)["todos"]
    assert updated_records[0]["note"] == "Retain source identity"
    completed = cli("complete", "--goal-id", "goal-a", "--todo-id", user,
                    "--no-follow-up", "--note", "Independent user action accepted")
    assert completed["completed"] and completed["todo_id"] == user
    superseded = cli("supersede", "--goal-id", "goal-a", "--todo-id", original,
                     "--successor-todo-id", replacement)
    assert superseded["superseded"] and superseded["todo_id"] == original
    archived = cli("archive-completed", "--goal-id", "goal-a", "--role", "user",
                   "--max-active-done", "0", "--execute")
    assert archived["moved_todo_ids"] == [user]
    final = cli("list", "--goal-id", "goal-a", "--role", "agent")
    records = {todo["todo_id"]: todo for todo in final["todos"]}
    assert records[original]["status"] == "done"
    assert records[original]["superseded_by"] == replacement
    assert records[replacement]["status"] == "open"
    assert "Original work" in state.read_text()


@pytest.mark.parametrize("provider", ["file", "sqlite"])
def test_new_goal_and_original_creation_recovery_without_source_line_writer(tmp_path, provider, without_source_line_writer):
    project = tmp_path / "project"
    project.mkdir()
    runtime = tmp_path / "runtime"
    registry = project / ".loopx/registry.json"
    config = runtime / "machine/configuration.json"
    config.parent.mkdir(parents=True)

    def configure(selected_provider):
        config.write_text(json.dumps({"schema_version": "loopx_machine_configuration_v0", "namespaces": {
            "goal_storage": {"schema_version": "loopx_goal_storage_defaults_v1", "new_goal_provider": selected_provider,
                             "canonical_creation": True, "new_goal_handoff_mode": "soft_claim"}}}))

    def cli(*args, succeeds=True):
        result = subprocess.run(
            [sys.executable, "-m", "loopx.cli", "--format", "json", "--registry", str(registry),
             "--runtime-root", str(runtime), *args],
            cwd=tmp_path, capture_output=True, text=True, timeout=45,
        )
        assert (result.returncode == 0) is succeeds, result.stdout + result.stderr
        return json.loads(result.stdout)

    def bootstrap():
        return cli("bootstrap", "--project", str(project), "--goal-id", "new-goal",
                   "--objective", "Preserve canonical creation and recovery", "--no-global-sync")

    configure(provider)
    created = bootstrap()
    assert created["storage_selection"]["authority_initialized"] is True
    added = cli("todo", "add", "--goal-id", "new-goal", "--role", "agent",
                "--text", "Retain work added after original creation", "--operation-id", "later-work")
    before = cli("todo", "list", "--goal-id", "new-goal")
    assert before["todos"][0]["todo_id"] == added["todo_id"]
    state = Path(created["state_file"])
    state.unlink()
    configure("sqlite" if provider == "file" else "file")
    recovered = bootstrap()
    selection = recovered["storage_selection"]
    assert selection["provider"] == provider
    assert selection["creation_operation_id"] == created["storage_selection"]["creation_operation_id"]
    assert selection["provider_revision"] == created["storage_selection"]["provider_revision"]
    assert selection["legacy_fallback_used"] is False
    assert not state.exists()
    after = cli("todo", "list", "--goal-id", "new-goal")
    assert after["todos"] == before["todos"]
    assert after["authority_read"]["provider_revision"] == before["authority_read"]["provider_revision"]

    backend = runtime / "authority" / f"{provider}-v0"
    offline = backend.with_name(backend.name + "-offline")
    backend.rename(offline)
    try:
        rejected = cli("bootstrap", "--project", str(project), "--goal-id", "new-goal",
                       "--objective", "Preserve canonical creation and recovery", "--no-global-sync", succeeds=False)
        assert rejected["ok"] is False
        assert "restore" in rejected["error"]
        assert not state.exists() and not backend.exists()
    finally:
        offline.rename(backend)
    restored = cli("todo", "list", "--goal-id", "new-goal")
    assert restored["todos"] == before["todos"]
    assert restored["authority_read"]["provider_revision"] == before["authority_read"]["provider_revision"]


def test_explicit_source_writer_import_preserves_the_existing_seam(tmp_path):
    result = subprocess.run(
        [sys.executable, "-c", """
import sys
import loopx.todos as todos
assert 'loopx.control_plane.todos.line_update' not in sys.modules
from loopx.todos import apply_todo_update_to_lines
from loopx.control_plane.todos import line_update
assert apply_todo_update_to_lines is line_update.apply_todo_update_to_lines
for name in ('link_generated_successor_todo_ids', 'link_superseding_todo_id', 'upsert_todo_metadata'):
    assert getattr(todos, name) is getattr(line_update, name)
try:
    getattr(todos, 'unknown_writer_export')
except AttributeError:
    pass
else:
    raise AssertionError('unknown export must remain unavailable')
"""],
        capture_output=True, text=True, timeout=45,
    )
    assert result.returncode == 0, result.stdout + result.stderr
