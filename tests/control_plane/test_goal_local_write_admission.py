"""Local material writes retain scopes and a causal workspace without Git."""

import json
import subprocess

import pytest

from loopx.control_plane.agents.workspace_guard import (
    build_agent_workspace_guard,
    observe_goal_local_write_scopes,
)
from loopx.control_plane.quota.projection_repair import (
    build_boundary_projection_repair_hint,
)
from loopx.control_plane.quota.settlement_workspace_causality import (
    project_goal_local_write_scopes,
)


def declaration():
    return {
        "todo_id": "todo_local_material",
        "role": "agent",
        "status": "open",
        "task_class": "advancement_task",
        "task_domain": "validation",
        "action_kind": "validate_material",
        "continuation_policy": "same_agent_non_delivery",
        "required_write_scopes": ["materials/run/**", "reports/result.md"],
    }


def test_absolute_scope_projection_is_root_bound_and_does_not_widen(tmp_path):
    root = str(tmp_path)
    todo = declaration()
    grants = [f"{root}/materials/**", f"{root}/reports/result.md"]
    assert project_goal_local_write_scopes(root, todo, grants)["admitted"] is True
    for bad in [
        "reports/other.md",
        "materials-elsewhere/run/**",
        "../materials/**",
        "/materials/**",
        "materials/./run/**",
        "materials/run/..\\other",
    ]:
        assert (
            project_goal_local_write_scopes(
                root, {**todo, "required_write_scopes": [bad]}, grants
            )["admitted"]
            is False
        )
    for bad_grant in [
        f"{root}-other/materials/**",
        f"{root}/../materials/**",
        "materials/**",
        f"{root}/material*/**",
    ]:
        assert (
            project_goal_local_write_scopes(root, todo, [bad_grant])["admitted"]
            is False
        )


@pytest.mark.parametrize(
    "metadata",
    [
        {"task_repository": "git:github.com/example/project"},
        {"task_domain": "code"},
        {"task_domain": None},
        {"continuation_policy": "independent_handoff"},
        {"continuation_policy": None},
        {"required_write_scopes": []},
    ],
)
def test_repository_and_unknown_contracts_never_become_local(tmp_path, metadata):
    todo = {**declaration(), **metadata}
    assert (
        project_goal_local_write_scopes(
            str(tmp_path), todo, [f"{tmp_path}/materials/**", f"{tmp_path}/reports/**"]
        )["admitted"]
        is False
    )


def test_peer_local_materials_admit_both_guards_and_reject_foreign_workspace(tmp_path):
    root = tmp_path / "local"
    root.mkdir()
    goal = {
        "id": "local-materials",
        "repo": str(root),
        "coordination": {
            "write_scope": [f"{root}/materials/**", f"{root}/reports/result.md"],
        },
    }
    todo = declaration()
    identity = {"agent_id": "worker", "registered_agents": ["worker", "peer"]}
    local = observe_goal_local_write_scopes(goal, todo)
    assert local["admitted"] is True
    assert (
        build_agent_workspace_guard(
            goal,
            identity,
            selected_todo=todo,
            current_path=root,
            local_write_scopes=local,
        )
        is None
    )

    assert (
        build_boundary_projection_repair_hint(
            goal["coordination"],
            {"first_executable_items": [todo]},
            candidate_should_run=True,
            selected_todo=todo,
            local_write_scopes=local,
        )
        is None
    )
    guard = build_agent_workspace_guard(
        goal,
        identity,
        selected_todo=todo,
        current_path=tmp_path,
        local_write_scopes=local,
    )
    assert guard["blocks_delivery"] is True
    assert guard["required_workspace"] == "local_goal_workspace"
    assert guard["action"] == "move_to_goal_workspace"
    assert (
        build_agent_workspace_guard(
            {
                **goal,
                "workspace_guard_policy": {"peer_independent_worktree_required": True},
            },
            identity,
            selected_todo=todo,
            current_path=root,
            local_write_scopes=local,
        )["blocks_delivery"]
        is True
    )
    # Preserve the explicit off-state policy without creating a new switch.
    assert (
        build_agent_workspace_guard(
            {
                **goal,
                "workspace_guard_policy": {"peer_independent_worktree_required": False},
            },
            identity,
            selected_todo=todo,
            current_path=tmp_path,
            local_write_scopes=local,
        )
        is None
    )
    nested = root / "nested"
    nested.mkdir()
    subprocess.run(["git", "init", "-q", str(nested)], check=True)
    assert (
        build_agent_workspace_guard(
            goal,
            identity,
            selected_todo=todo,
            current_path=nested,
            local_write_scopes=local,
        )["blocks_delivery"]
        is True
    )


def test_registered_root_alias_keeps_its_literal_authorization(tmp_path):
    physical = tmp_path / "physical"
    physical.mkdir()
    registered = tmp_path / "registered"
    registered.symlink_to(physical, target_is_directory=True)
    goal = {
        "id": "local-alias",
        "repo": str(registered),
        "coordination": {
            "write_scope": [
                f"{registered}/materials/**",
                f"{registered}/reports/result.md",
            ],
        },
    }
    assert observe_goal_local_write_scopes(goal, declaration())["admitted"] is True
    # A different spelling is not silently added as a second grant.
    goal["coordination"]["write_scope"] = [
        f"{physical}/materials/**",
        f"{physical}/reports/result.md",
    ]
    assert observe_goal_local_write_scopes(goal, declaration())["admitted"] is False


@pytest.mark.parametrize("provider", ["file", "sqlite"])
def test_real_cli_local_write_guard_replay_and_causal_settlement(
    tmp_path, monkeypatch, provider
):
    from canonical_authority_fixture import (
        initialize_canonical_authority,
        isolate_sqlite_runtime,
    )
    from test_quota_settlement_cli import (
        _write_fixture,
        _run_cli,
        _spend_run_count,
        GOAL_ID,
        AGENT_ID,
        TODO_ID,
    )
    from loopx.control_plane.coordination.runtime_shadow import (
        build_todo_runtime_shadow_projection,
    )
    from loopx.control_plane.todos.active_state_todo_parser import (
        parse_active_state_todos,
    )

    if provider == "sqlite":
        isolate_sqlite_runtime(tmp_path, monkeypatch)
    project, runtime, registry = _write_fixture(tmp_path)
    config = json.loads(registry.read_text())
    goal = config["goals"][0]
    goal["coordination"].update(
        registered_agents=[AGENT_ID, "other-worker"],
        write_scope=[f"{project}/materials/**", f"{project}/reports/result.md"],
    )
    registry.write_text(json.dumps(config))
    state = project / goal["state_file"]
    todos = parse_active_state_todos(state.read_text(), item_limit=None)["agent_todos"][
        "items"
    ]
    todos[0].update(
        {
            **declaration(),
            "todo_id": TODO_ID,
            "claimed_by": AGENT_ID,
            "required_capabilities": ["filesystem_read", "filesystem_write", "shell"],
        }
    )
    initialize_canonical_authority(
        runtime,
        GOAL_ID,
        build_todo_runtime_shadow_projection(
            goal_id=GOAL_ID, todos=todos, handoff_mode="soft_claim"
        ),
        state_path=state,
        provider=provider,
    )
    caps = [
        "--available-capability",
        "filesystem_read",
        "--available-capability",
        "filesystem_write",
        "--available-capability",
        "shell",
    ]
    turn = f"local-writes-{provider}"
    guard_args = [
        "quota",
        "should-run",
        "--goal-id",
        GOAL_ID,
        "--agent-id",
        AGENT_ID,
        "--codex-app",
        "--turn-instance-id",
        turn,
        *caps,
    ]
    rc, outside = _run_cli(registry, runtime, *guard_args, cwd=tmp_path)
    assert rc == 0 and outside["normal_delivery_allowed"] is False, outside
    assert outside["workspace_guard"]["required_workspace"] == "local_goal_workspace"
    assert _spend_run_count(runtime) == 0
    rc, guard = _run_cli(registry, runtime, *guard_args, cwd=project)
    assert rc == 0 and guard["normal_delivery_allowed"] is True, guard
    assert (
        guard["selected_todo"]["required_write_scopes"]
        == todos[0]["required_write_scopes"]
    )
    rc, replay = _run_cli(registry, runtime, *guard_args, cwd=project)
    assert (
        rc == 0
        and replay["interaction_contract"]["cli_channel"]["settlement_plan"]["identity"]
        == guard["interaction_contract"]["cli_channel"]["settlement_plan"]["identity"]
    )
    binding = [
        "--goal-id",
        GOAL_ID,
        "--agent-id",
        AGENT_ID,
        "--todo-id",
        TODO_ID,
        "--turn-instance-id",
        turn,
        *caps,
    ]
    rc, writeback = _run_cli(
        registry,
        runtime,
        "refresh-state",
        *binding,
        "--classification",
        "local_material_validated",
        "--delivery-batch-scale",
        "single_surface",
        "--delivery-outcome",
        "outcome_progress",
        "--delivery-boundary",
        "in_flight_continuation",
        "--progress-result-class",
        "advanced",
        "--progress-surface-id",
        "material:source-review",
        cwd=project,
    )
    assert rc == 0 and writeback["appended"] is True, writeback
    assert writeback["delivery_workspace"]["identity_kind"] == "local_goal"
    assert str(project) not in json.dumps(writeback["delivery_workspace"])
    spend = [
        "quota",
        "spend-slot",
        *binding,
        "--slots",
        "1",
        "--source",
        "heartbeat",
        "--execute",
    ]
    rc, settled = _run_cli(registry, runtime, *spend, cwd=project)
    assert rc == 0 and settled["ok"] is True, settled
    rc, repeated = _run_cli(registry, runtime, *spend, cwd=project)
    assert rc == 0 and repeated["ok"] is True, repeated
    assert repeated["idempotent_replay"] is True
    assert repeated["appended"] is False
    assert _spend_run_count(runtime) == 1
