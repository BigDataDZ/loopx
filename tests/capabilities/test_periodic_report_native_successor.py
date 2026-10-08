"""A native accepted Vision successor is a reportable stage at its writeback."""

from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path

import pytest

from loopx.capabilities.periodic_report.post_writeback_hook import (
    evaluate_periodic_report_trigger_evaluation_intent,
)
from loopx.capabilities.periodic_report.pending_intent import pending_periodic_report_intents
from loopx.cli import main as cli_main
from tests.test_loopx_turn_driver import _write_live_fixture


GOAL_ID = "loopx-turn-fixture"
AGENT_ID = "codex-fixture"


def _run_cli(args: list[str]) -> dict[str, object]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        exit_code = cli_main(args)
    payload = json.loads(output.getvalue())
    assert exit_code == 0, payload
    return payload


def _native_successor(
    tmp_path: Path, *, enabled: bool,
) -> tuple[Path, dict[str, object], dict[str, object], dict[str, object]]:
    project, runtime, registry = _write_live_fixture(tmp_path)
    base = [
        "--registry", str(registry), "--runtime-root", str(runtime),
        "--format", "json", "refresh-state", "--goal-id", GOAL_ID,
        "--delivery-workspace-path", str(project),
        "--agent-id", AGENT_ID, "--delivery-batch-scale", "implementation",
        "--delivery-outcome", "outcome_progress", "--no-global-sync",
        "--suppress-external-sinks",
    ]
    closed = _run_cli([
        *base, "--classification", "fixture_stage_closed",
        "--vision-state", "vision_closed",
        "--vision-summary", "The bounded fixture stage is complete.",
        "--vision-acceptance", "Validated local fixture stage accepted.",
    ])
    assert closed["appended"] is True
    assert closed["vision_checkpoint"]["satisfied"] is True

    if enabled:
        data = json.loads(registry.read_text(encoding="utf-8"))
        data["goals"][0]["control_plane"] = {
            "periodic_report": {
                "enabled": True,
                "profile_preset": "weekly",
                "route_ref": "project-room",
            }
        }
        registry.write_text(json.dumps(data), encoding="utf-8")

    turn_id = "native-successor-turn-1"
    guard = [
        "--registry", str(registry), "--runtime-root", str(runtime),
        "--format", "json", "quota", "should-run", "--codex-app",
        "--goal-id", GOAL_ID, "--agent-id", AGENT_ID,
        "--turn-instance-id", turn_id, "--scan-path", str(project),
    ]
    first_guard = _run_cli(guard)
    assert first_guard["decision"] == "autonomous_replan_required"
    selected = first_guard["selected_todo"]["todo_id"]
    bound_guard = _run_cli([*guard, "--todo-id", selected])
    assert bound_guard["heartbeat_receipt"]["settlement_identity"]["todo_id"] == selected

    successor_vision = {
        "schema_version": "goal_vision_replan_contract_v0",
        "state": "active",
        "vision_patch": {
            "vision_summary": "Continue the next bounded fixture check.",
            "acceptance_summary": "Validate the next fixture outcome independently.",
        },
        "path_delta": {
            "schema_version": "goal_path_delta_v0",
            "outcome": "replan",
            "prior_assumption": "The prior fixture stage remained open.",
            "observed_reality": "That stage passed and the next check remains.",
            "evidence_refs": ["fixture:accepted-stage-boundary"],
            "changed": ["Advance the successor fixture check."],
        },
    }
    vision_path = project / "successor-vision.json"
    vision_path.write_text(json.dumps(successor_vision), encoding="utf-8")
    successor_args = [
        *base, "--todo-id", selected, "--turn-instance-id", turn_id,
        "--classification", "fixture_successor_authored",
        "--autonomous-replan-recorded", "--agent-vision-json", str(vision_path),
    ]
    successor = _run_cli(successor_args)
    assert successor["appended"] is True
    ack = successor["autonomous_replan_ack"]
    assert ack["recorded"] is True
    assert ack["semantic_delta"]["accepted"] is True
    assert "fresh_vision_path_outcome" in ack["semantic_delta"]["outcomes"]
    assert "vision_successor_required" in ack["semantic_delta"]["trigger_kinds"]
    assert ack["semantic_delta"]["obligation_id"]
    assert "frontier_identity" not in ack
    replay = _run_cli(successor_args)
    assert replay["appended"] is False
    assert replay["idempotent_replay"] is True
    return runtime, closed, successor, replay


@pytest.mark.parametrize("enabled", [False, True], ids=["feature-off", "enabled"])
def test_native_successor_produces_only_an_enabled_bounded_intent(
    tmp_path: Path, enabled: bool,
) -> None:
    runtime, closed, successor, replay = _native_successor(tmp_path, enabled=enabled)
    pending = pending_periodic_report_intents(
        registry_path=tmp_path / "project" / ".loopx" / "registry.json",
        runtime_root=runtime, goal_id=GOAL_ID, agent_id=AGENT_ID,
    )
    sidecar_dir = runtime / "goals" / GOAL_ID / "post_writeback_hooks"
    if not enabled:
        assert pending == []
        assert not list(sidecar_dir.glob("*.json"))
        assert not successor.get("post_writeback_hooks", {}).get("intents")
        return

    assert not closed.get("post_writeback_hooks", {}).get("intents")
    dispatch = successor["post_writeback_hooks"]
    assert dispatch["invoked_count"] == 1
    assert dispatch["intent_count"] == 1
    assert dispatch["failures"] == []
    intent = dispatch["intents"][0]
    assert pending == [intent]
    assert intent["intent_kind"] == "periodic_report.trigger_evaluation"
    assert intent["requested_write_scope"] == []
    assert intent["payload"]["generation_authorized"] is False
    assert intent["payload"]["external_delivery_authorized"] is False
    stage = intent["payload"]["stage_completion"]
    assert stage["transition"] == "successor_frontier_settled"
    assert stage["acceptance"] == "validated"
    decision = evaluate_periodic_report_trigger_evaluation_intent(intent)
    assert decision["eligible"] is True
    assert decision["selected_trigger_kind"] == "bounded_segment_milestone"
    assert replay["post_writeback_hooks"]["intents"] == [intent]
    assert len(list(sidecar_dir.glob("*.json"))) == 1
