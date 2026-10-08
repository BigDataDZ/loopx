"""Read compatibility at the live Goal-frontier import boundary."""

import pytest
import json
import subprocess
import sys

from loopx.control_plane.todos.todo_semantics import (
    agent_scoped_selectable_advancement_todo_ids,
    todo_advancement_frontier_counts,
    todo_advancement_frontier_items,
)


def item(identity, **fields):
    return {"todo_id": identity, "status": "open", "task_class": "advancement_task", **fields}


@pytest.mark.parametrize("agent", ["worker-a", None])
def test_executable_slot_wins_and_peer_visibility_never_grants_selection(agent):
    source = [item("todo_own", claimed_by="worker-a"), item("todo_free"),
              item("todo_peer", claimed_by="worker-b"),
              item("todo_excluded", excluded_agents=["worker-a"]),
              item("todo_closed", status="done"),
              item("todo_monitor", task_class="continuous_monitor"),
              item("todo_blocked", goal_acceptance_guard={"allowed": False})]
    summary = {"executable_backlog_items": source,
               "unclaimed_priority_open_items": [item("todo_stale")],
               "current_agent_claimed_advancement_count": 9,
               "claim_scope": {"other_agent_claimed_items": [item("todo_peer_1"), item("todo_peer_2")]}}
    projected = todo_advancement_frontier_items(summary, agent_id=agent)
    assert projected["current_agent_claimed_items"] == ([source[0]] if agent else [source[0], source[2]])
    assert projected["unclaimed_items"] == ([source[1]] if agent else [source[1], source[3]])
    assert projected["other_agent_claimed_items"] == ([source[2]] if agent else [])
    assert agent_scoped_selectable_advancement_todo_ids(summary, agent_id=agent) == (
        {"todo_own", "todo_free"} if agent else {"todo_own", "todo_free", "todo_peer", "todo_excluded"})
    assert todo_advancement_frontier_counts(summary, agent_id=agent) == {
        "current_agent_claimed_advancement_count": 9,
        "unclaimed_advancement_count": 1 if agent else 2,
        "other_agent_claimed_advancement_count": 2,
    }


def test_empty_executable_slot_is_authoritative_and_missing_slot_uses_legacy_views():
    summary = {"unclaimed_priority_open_items": [item("todo_free"), item("todo_excluded", excluded_agents=["worker-a"])],
               "claimed_advancement_open_items": [item("todo_own", claimed_by="worker-a"),
                    item("todo_excluded_own", claimed_by="worker-a", excluded_agents=["worker-a"]),
                    item("todo_peer", claimed_by="worker-b")]}
    assert agent_scoped_selectable_advancement_todo_ids(summary, agent_id="worker-a") == {"todo_free", "todo_own"}
    assert todo_advancement_frontier_items(summary, agent_id="worker-a")["other_agent_claimed_items"] == [summary["claimed_advancement_open_items"][2]]
    assert agent_scoped_selectable_advancement_todo_ids({**summary, "executable_backlog_items": []}, agent_id="worker-a") == set()
    assert todo_advancement_frontier_counts(None, agent_id="worker-a") == {
        "current_agent_claimed_advancement_count": 0, "unclaimed_advancement_count": 0,
        "other_agent_claimed_advancement_count": 0,
    }


def test_resume_readiness_is_an_observation_not_a_raw_condition_guess():
    source = [item("todo_closed", status="done"),
              item("todo_wait", resume_when="todo_done:todo_prior", resume_ready=False),
              item("todo_ready", resume_when="todo_done:todo_prior", resume_ready=True)]
    assert agent_scoped_selectable_advancement_todo_ids({"executable_backlog_items": source}, agent_id="worker-a") == {"todo_ready"}


@pytest.mark.parametrize("provider", ["file", "sqlite"])
def test_real_quota_frontier_reads_canonical_claims(tmp_path, monkeypatch, provider):
    from canonical_authority_fixture import promoted_create_fixture, isolate_sqlite_runtime
    from loopx.todos import add_goal_todo

    isolate_sqlite_runtime(tmp_path, monkeypatch)
    registry, runtime, state = promoted_create_fixture(tmp_path, provider=provider)
    configuration = json.loads(registry.read_text())
    configuration["goals"][0]["coordination"]["registered_agents"].append("agent-b")
    configuration["goals"][0].update({"domain": "control-plane-read-path", "status": "active",
        "adapter": {"kind": "smoke_v0", "status": "connected-read-only"}})
    registry.write_text(json.dumps(configuration))
    for name, fields in [
        ("Own direction", {"claimed_by": "agent-a"}),
        ("Free direction", {}),
        ("Peer direction", {"claimed_by": "agent-b"}),
        ("Excluded direction", {"excluded_agents": ["agent-a"]}),
        ("Deferred direction", {"status": "deferred", "resume_when": "resume_at:2030-01-01T00:00:00Z"}),
    ]:
        created = add_goal_todo(registry_path=registry, goal_id="goal-a", role="agent",
            text=name, task_class="advancement_task", action_kind="implement",
            operation_id=name.lower().replace(" ", "-"), **fields)
        assert created["source_authority"] == f"{provider}_v0"
    # Keep the permanent narrative projection: canonical authority does not
    # retire document IO, and status still reads the Goal's narrative state.
    result = subprocess.run([sys.executable, "-m", "loopx.cli", "--registry", str(registry),
        "--format", "json", "quota", "should-run", "--goal-id", "goal-a", "--agent-id", "agent-a",
        "--runtime-profile", "generic_cli"],
        text=True, capture_output=True, timeout=60)
    packet = json.loads(result.stdout)
    assert result.returncode == 0, (packet.get("error"), packet.get("reason"), packet.get("status_health_ok"))
    assert packet["goal_frontier_projection"]["remaining_advancement_frontier"] == {
        "current_agent_claimed_advancement_count": 1, "unclaimed_advancement_count": 1,
        "other_agent_claimed_advancement_count": 1,
    }
    assert packet["selected_todo"]["text"] == "Own direction"
    assert state.exists()
