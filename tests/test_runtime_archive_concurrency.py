from __future__ import annotations

import json
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from loopx import runtime as runtime_module
from loopx.control_plane.coordination.shadow_management import (
    shadow_maintenance_lock_target,
)
from loopx.control_plane.effect_runtime import (
    effect_runtime_result as actual_effect_runtime_result,
)
from loopx.control_plane.projects.registry_codec import (
    source_session_registry_transaction,
)
from loopx.control_plane.quota import spend_commit
from loopx.control_plane.turn_driver import journal_store
from loopx.file_lock import (
    exclusive_cross_runtime_file_lock as actual_cross_runtime_file_lock,
)


GOAL_ID = "archive-writer-race"
GOAL_INSTANCE_ID = "ginst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def _decision(spent_slots: int) -> dict[str, Any]:
    return {
        "should_run": True,
        "normal_delivery_allowed": True,
        "recovery_delivery_allowed": False,
        "effective_action": "advance",
        "self_repair_allowed": False,
        "capability_repair_allowed": False,
        "workspace_repair_allowed": False,
        "state": "eligible",
        "safe_bypass_allowed": False,
        "safe_bypass_kind": None,
        "blocked_action_scope": None,
        "quota": {
            "compute": 1,
            "window_hours": 24,
            "slot_minutes": 1,
            "spent_slots": spent_slots,
            "allowed_slots": 1440,
        },
    }


def _preview() -> dict[str, Any]:
    return {
        "ok": True,
        "mode": "spend-slot",
        "dry_run": True,
        "goal_id": GOAL_ID,
        "slots": 1,
        "agent_id": "codex-main-control",
        "appended": False,
        "registry_mutated": False,
        "before": _decision(0),
        "after": _decision(1),
        "after_recommended_action": "inspect next quota should-run decision",
        "would_throttle": False,
        "delivery_completion_spend": False,
        "safe_bypass_spend": False,
        "delivery_workspace_validated": False,
        "expected_index_digest": None,
    }


def _write_legacy_registry(registry_path: Path, runtime_root: Path) -> None:
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "common_runtime_root": str(runtime_root),
                "goals": [],
            }
        ),
        encoding="utf-8",
    )


def _write_source_registry(registry_path: Path, runtime_root: Path) -> None:
    payload = {
        "schema_version": "0.2",
        "registry_role": "project-local",
        "profile_id": "source_session_v1",
        "common_runtime_root": str(runtime_root),
        "projects": [],
        "goals": [
            {
                "id": GOAL_ID,
                "goal_instance_id": GOAL_INSTANCE_ID,
                "status": "active",
                "execution_authority": False,
            }
        ],
        "session_bindings": [],
        "session_receipts": [],
        "lifetime_receipts": [],
        "retired_goal_instances": [],
    }
    with source_session_registry_transaction(
        registry_path,
        operation="runtime_archive_writer_test",
        create=lambda: payload,
    ) as transaction:
        transaction.commit(payload)


def _run_archive_race(
    *,
    registry_path: Path,
    writer: Callable[[], Any],
    writer_paused: threading.Event,
    continue_writer: threading.Event,
    allow_registered: bool,
) -> tuple[Any, dict[str, Any]]:
    archive_finished = threading.Event()
    writer_results: list[Any] = []
    archive_results: list[dict[str, Any]] = []
    errors: list[BaseException] = []

    def run_writer() -> None:
        try:
            writer_results.append(writer())
        except BaseException as error:
            errors.append(error)

    def archive() -> None:
        try:
            archive_results.append(
                runtime_module.archive_runtime_goal(
                    registry_path=registry_path,
                    runtime_root_override=None,
                    goal_id=GOAL_ID,
                    archive_root=None,
                    allow_registered=allow_registered,
                    execute=True,
                )
            )
        except BaseException as error:
            errors.append(error)
        finally:
            archive_finished.set()

    writer_thread = threading.Thread(target=run_writer)
    archive_thread = threading.Thread(target=archive)
    writer_thread.start()
    blocked = False
    try:
        assert writer_paused.wait(timeout=5), "writer did not reach its commit barrier"
        archive_thread.start()
        blocked = not archive_finished.wait(timeout=0.2)
    finally:
        continue_writer.set()
        writer_thread.join(timeout=20)
        if archive_thread.ident is not None:
            archive_thread.join(timeout=20)

    assert blocked, f"archive completed while the writer was committing: {errors!r}"
    assert not writer_thread.is_alive()
    assert not archive_thread.is_alive()
    assert errors == []
    assert len(writer_results) == 1
    assert len(archive_results) == 1
    return writer_results[0], archive_results[0]


@pytest.mark.parametrize("exact_source", [False, True], ids=["legacy", "exact"])
def test_archive_waits_for_quota_writer_before_moving_goal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    exact_source: bool,
) -> None:
    runtime_root = tmp_path / "runtime"
    source = runtime_root / "goals" / GOAL_ID
    (source / "runs").mkdir(parents=True)
    (source / "before.txt").write_text("before", encoding="utf-8")
    writer_paused = threading.Event()
    continue_writer = threading.Event()
    goal_ref = None

    if exact_source:
        source_registry = tmp_path / "project" / ".loopx" / "registry.json"
        _write_source_registry(source_registry, runtime_root)
        registry_path = runtime_root / "registry.global.json"
        registry_path.write_text(
            json.dumps(
                {
                    "schema_version": "0.1",
                    "registry_role": "global-local",
                    "common_runtime_root": str(runtime_root),
                    "goals": [
                        {
                            "id": GOAL_ID,
                            "source_registry": str(source_registry),
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        goal_ref = {
            "goal_id": GOAL_ID,
            "goal_instance_id": GOAL_INSTANCE_ID,
        }

        @contextmanager
        def paused_maintenance_lock(
            path: Path,
            **kwargs: Any,
        ) -> Iterator[Path]:
            writer_paused.set()
            if not continue_writer.wait(timeout=10):
                raise TimeoutError("exact quota writer barrier was not released")
            with actual_cross_runtime_file_lock(path, **kwargs) as lock_path:
                yield lock_path

        monkeypatch.setattr(
            spend_commit,
            "exclusive_cross_runtime_file_lock",
            paused_maintenance_lock,
        )
    else:
        source_registry = None
        registry_path = tmp_path / "registry.json"
        _write_legacy_registry(registry_path, runtime_root)

        def paused_effect(method: str, params: dict[str, Any]) -> Any:
            writer_paused.set()
            if not continue_writer.wait(timeout=10):
                raise TimeoutError("legacy quota writer barrier was not released")
            return actual_effect_runtime_result(method, params)

        monkeypatch.setattr(spend_commit, "effect_runtime_result", paused_effect)

    writer_result, archive_result = _run_archive_race(
        registry_path=registry_path,
        writer=lambda: spend_commit.record_quota_slot_spend_from_preview(
            _preview(),
            {"runtime_root": str(runtime_root)},
            goal_id=GOAL_ID,
            execute=True,
            registry_path=source_registry,
            goal_ref=goal_ref,
        ),
        writer_paused=writer_paused,
        continue_writer=continue_writer,
        allow_registered=exact_source,
    )

    assert writer_result["appended"] is True
    assert archive_result["archived"] is True
    archive_path = Path(archive_result["archive_path"])
    assert not source.exists()
    assert (archive_path / "before.txt").read_text(encoding="utf-8") == "before"
    assert (archive_path / "runs" / "index.jsonl").is_file()


def test_archive_waits_for_turn_journal_writer_before_moving_goal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_root = tmp_path / "runtime"
    source = runtime_root / "goals" / GOAL_ID
    source.mkdir(parents=True)
    journal_path = source / "turns" / f"{'a' * 64}.json"
    registry_path = tmp_path / "registry.json"
    _write_legacy_registry(registry_path, runtime_root)
    writer_paused = threading.Event()
    continue_writer = threading.Event()

    def paused_write(
        path: str,
        journal: dict[str, Any],
        **_: Any,
    ) -> None:
        writer_paused.set()
        if not continue_writer.wait(timeout=10):
            raise TimeoutError("Turn journal writer barrier was not released")
        output = Path(path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(journal), encoding="utf-8")

    monkeypatch.setattr(journal_store, "write_turn_journal", paused_write)
    _, archive_result = _run_archive_race(
        registry_path=registry_path,
        writer=lambda: journal_store.write_turn_journal_checkpoint(
            journal_path,
            {"schema_version": "loopx_turn_journal_v0", "goal_id": GOAL_ID},
        ),
        writer_paused=writer_paused,
        continue_writer=continue_writer,
        allow_registered=False,
    )

    archive_path = Path(archive_result["archive_path"])
    assert not source.exists()
    assert json.loads(
        (archive_path / "turns" / journal_path.name).read_text(encoding="utf-8")
    )["goal_id"] == GOAL_ID


def test_archive_rechecks_registry_membership_after_waiting_for_writer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_root = tmp_path / "runtime"
    source = runtime_root / "goals" / GOAL_ID
    source.mkdir(parents=True)
    registry_path = tmp_path / "registry.json"
    _write_legacy_registry(registry_path, runtime_root)
    archive_ready = threading.Event()
    archive_finished = threading.Event()
    errors: list[BaseException] = []
    actual_source_paths = runtime_module._archive_source_registry_paths

    def observed_source_paths(*args: Any, **kwargs: Any) -> tuple[Path, ...]:
        result = actual_source_paths(*args, **kwargs)
        archive_ready.set()
        return result

    monkeypatch.setattr(
        runtime_module,
        "_archive_source_registry_paths",
        observed_source_paths,
    )

    def archive() -> None:
        try:
            runtime_module.archive_runtime_goal(
                registry_path=registry_path,
                runtime_root_override=None,
                goal_id=GOAL_ID,
                archive_root=None,
                allow_registered=False,
                execute=True,
            )
        except BaseException as error:
            errors.append(error)
        finally:
            archive_finished.set()

    worker = threading.Thread(target=archive)
    with actual_cross_runtime_file_lock(
        shadow_maintenance_lock_target(runtime_root, GOAL_ID),
        operation="runtime_archive_registration_test",
    ):
        worker.start()
        assert archive_ready.wait(timeout=5), "archive did not finish preflight"
        assert not archive_finished.wait(timeout=0.2)
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["goals"] = [{"id": GOAL_ID}]
        registry_path.write_text(json.dumps(registry), encoding="utf-8")
    worker.join(timeout=10)

    assert not worker.is_alive()
    assert len(errors) == 1
    assert isinstance(errors[0], ValueError)
    assert "goal exists in registry" in str(errors[0])
    assert source.is_dir()
