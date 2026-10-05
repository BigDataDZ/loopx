"""Exact source grants, task-bound dispatch, revocation and truthful fallback.

The governed integration uses the existing explicit fixture host. Live model,
provider delivery and routing quality require separate product qualification.
"""

import json
from pathlib import Path

import pytest

from loopx.capabilities.manager_context import (
    POLICY_SCHEMA, _root, _write, deliver, register_ingress,
)
from loopx.capabilities.manager_context import execution
from loopx.chat import normalize_agent_response
from loopx.chat_agent import _turn_prompt
from loopx.chat_store import ChatSessionStore
from loopx.capabilities.manager_context.inspection import manager_index
from test_local_delegation import brief, wait, service as delegation_service  # noqa: F401
from test_independent_delegation_validation import independent_binding


def source(root, registry, *, goal_id, agent_id, requester, binding, source_id="lark:exact-message"):
    store = ChatSessionStore(root)
    session = store.create_session(goal_id="loopx-manager", agent_id="codex",
                                   adapter_kind="codex_app_server", upstream_thread_id="original",
                                   channel_id="manager.external.test")
    turn, _ = store.create_turn(session["session_id"], client_turn_id="current-request",
                                message="Do the authorized bounded review and return here.", origin="lark")
    grant = {"goal_id": goal_id, "agent_id": agent_id, "requester_agent_id": requester, "binding_id": binding}
    policy = {"schema_version": POLICY_SCHEMA, "sources": {session["channel_id"]: {
        "sender_ids": ["owner"], "execution_bindings": [grant],
    }}}
    _write(_root(root) / "policy.json", policy)
    register_ingress(root, session_id=session["session_id"], client_turn_id=turn["client_turn_id"],
                     channel=session["channel_id"], sender_id="owner", message=turn["message"],
                     source_id=source_id)
    request = {"goal_id": goal_id, "agent_id": agent_id, "execution_binding_id": binding, "brief": brief()}
    receipt = deliver(root, registry, session=session, turn=turn, request=request)
    return store, session, turn, request, receipt, policy


@pytest.fixture
def flow(tmp_path, monkeypatch):
    registry = tmp_path / "registry.json"
    registry.write_text(json.dumps({"goals": [{"id": "research", "repo": str(tmp_path),
        "spawn_policy": {"execution_config": ".loopx/config/delegations.json"},
        "coordination": {"registered_agents": ["lead", "worker"]}}]}))
    config = tmp_path / ".loopx/config/delegations.json"
    config.parent.mkdir(parents=True)
    config.write_text("{}")
    started = []

    class BoundService:
        def __init__(self, *args):
            pass

        def binding(self, binding_id, **kwargs):
            assert binding_id == "review"
            return {"id": binding_id, "agent_id": "worker", "todo_id": "todo_current"}

        def path(self, operation):
            return tmp_path / operation

        def inspect(self, binding_id):
            return {"state": "launchable", "turn_eligible": True, "acceptance_ready": True, "authority_ready": True}

        def start(self, binding_id, operation, semantic_brief, **kwargs):
            started.append((binding_id, operation, semantic_brief, kwargs))
            self.path(operation).write_text("prepared")
            return {"status": "prepared"}

        def read(self, operation):
            return {"status": "accepted"}

    monkeypatch.setattr(execution, "Delegations", BoundService)
    values = source(tmp_path, registry, goal_id="research", agent_id="worker", requester="lead", binding="review")
    return tmp_path, registry, values, started


def dispatch(flow, **changes):
    root, registry, (_, session, turn, request, receipt, _), _ = flow
    return execution.dispatch(root, registry, session=session, turn=turn, request=request, receipt=receipt,
                              execution_allowed=lambda: True, **changes)


def test_exact_catalog_and_launch_keep_original_conversation_and_operation(flow):
    root, registry, (_, session, turn, request, receipt, _), started = flow
    assert execution.catalog(root, registry, session, turn) == {"available": True, "bindings": [
        {"goal_id": "research", "agent_id": "worker", "binding_id": "review", "todo_id": "todo_current"}]}
    normalized = normalize_agent_response({"context_handoff": request})
    assert normalized["context_handoff"]["execution_binding_id"] == "review"
    assert dispatch(flow)["status"] == "prepared"
    assert started[0][1] == "context-" + receipt["request_id"]
    assert started[0][3]["conversation"] == {"session_id": session["session_id"], "turn_id": turn["turn_id"]}
    assert receipt["request_id"] in started[0][2]["return_requirement"]
    assert dispatch(flow)["replayed"]
    assert len(started) == 1


def test_model_receives_authorized_task_choices_after_manager_context_compaction(flow):
    root, registry, (_, session, turn, _, _, _), _ = flow
    choices = execution.catalog(root, registry, session, turn)
    prompt = _turn_prompt(turn["message"], context_summary=json.dumps(manager_index({
        "context_execution": choices,
    })))
    # The production prompt projection must retain the operator's exact task
    # choice. Registration/route discovery cannot substitute for this grant.
    assert '"binding_id": "review"' in prompt and '"todo_id": "todo_current"' in prompt
    assert str(root) not in prompt and "delegations.json" not in prompt
    disabled = manager_index({})
    assert "context_execution" not in disabled
    assert "execution_binding_id" not in _turn_prompt(turn["message"], context_summary=json.dumps(disabled))


def test_handoff_response_preserves_receipt_and_separate_execution_status(flow):
    root, registry, (_, session, turn, request, _, _), started = flow
    response = execution.handoff_response(root, registry, session=session, turn=turn,
        response={"context_handoff": request, "message": "Unverified model completion claim.",
                  "proposals": [{"kind": "unused"}], "gate": {"kind": "unused"}},
        source_authorized=lambda: True, execution_allowed=lambda: True)
    assert response["context_handoff_receipt"]["status"] == "delivered"
    assert response["context_execution"]["status"] == "prepared"
    assert "受理不代表完成" in response["message"]
    assert response["proposals"] == [] and response["gate"] is None
    assert len(started) == 1


def test_handoff_scope_revocation_stops_before_inbox_delivery(flow, monkeypatch):
    root, registry, (_, session, turn, request, _, _), started = flow
    from loopx.capabilities import manager_context
    def forbidden_delivery(*args, **kwargs):
        pytest.fail("revoked manager scope must not publish an inbox request")
    monkeypatch.setattr(manager_context, "deliver", forbidden_delivery)
    response = execution.handoff_response(root, registry, session=session, turn=turn,
        response={"context_handoff": request}, source_authorized=lambda: False,
        execution_allowed=lambda: True)
    assert "尚未转交" in response["message"]
    assert "context_handoff_receipt" not in response and not started


@pytest.mark.parametrize("change", ["sender", "body", "channel", "revoke", "blocked", "requester", "stopped", "binding"])
def test_no_launch_after_source_or_registration_changes(flow, change):
    root, registry, (_, session, turn, _, _, policy), started = flow
    if change == "sender":
        policy["sources"][session["channel_id"]]["sender_ids"] = ["someone-else"]
    elif change == "body":
        turn["message"] = "Different input"
    elif change == "channel":
        session["channel_id"] = "manager.external.other-app"
    elif change == "binding":
        # A newly configured choice in the same Goal/Agent is not covered by
        # the existing source's exact binding consent.
        flow[2][3]["execution_binding_id"] = "new-task-choice"
    elif change == "revoke":
        policy["sources"][session["channel_id"]].pop("execution_bindings")
    elif change == "blocked":
        policy["sources"][session["channel_id"]]["blocked_targets"] = [{"goal_id": "research"}]
    else:
        data = json.loads(registry.read_text())
        if change == "requester":
            data["goals"][0]["coordination"]["registered_agents"] = ["worker"]
        else:
            data["goals"][0]["activation_state"] = "stopped"
        registry.write_text(json.dumps(data))
    _write(_root(root) / "policy.json", policy)
    assert not dispatch(flow)["submitted"]
    assert not started


@pytest.mark.parametrize("state", ["turn_blocked", "acceptance_unavailable", "runtime_unavailable"])
def test_preflight_never_becomes_a_launch_permit(flow, monkeypatch, state):
    monkeypatch.setattr(execution.Delegations, "inspect", lambda *_: {"state": state})
    result = dispatch(flow)
    assert result["preflight"]["state"] == state and not result["submitted"]
    assert not flow[3]


def test_stop_during_preview_and_context_only_selection_do_not_launch(flow, monkeypatch):
    root, registry, (_, session, turn, request, receipt, _), started = flow
    active = [True]
    def preview(*_):
        active[0] = False
        return {"state": "launchable", "turn_eligible": True, "acceptance_ready": True, "authority_ready": True}
    monkeypatch.setattr(execution.Delegations, "inspect", preview)
    result = execution.dispatch(root, registry, session=session, turn=turn, request=request, receipt=receipt,
                                execution_allowed=lambda: active[0])
    assert not result["submitted"] and not started
    request.pop("execution_binding_id")
    assert dispatch(flow) == {"submitted": False}
    assert "尚未启动执行" in execution.handoff_message(receipt, {"submitted": False})


def test_governed_worker_adopts_original_request_and_returns_without_another_model_turn(delegation_service):  # noqa: F811
    root, service = delegation_service
    independent_binding(delegation_service)
    registry = service.registry
    data = json.loads(registry.read_text())
    project = Path(data["goals"][0]["repo"])
    config = project / ".loopx/config/delegations.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_bytes(service.config.read_bytes())
    data["goals"][0]["spawn_policy"] = {"execution_config": ".loopx/config/delegations.json"}
    registry.write_text(json.dumps(data))
    store, session, turn, request, receipt, _ = source(service.root, registry, goal_id=service.goal_id,
        agent_id="analyst", requester="lead", binding="analysis")
    # The fixture receiver (not the Chat caller) reads, decides and returns the
    # original owner request as well as its separately accepted peer result.
    host = root / "fixture-host.py"
    content = host.read_text()
    anchor = "print(json.dumps(build_result"
    statement = (
        "from loopx.control_plane.collaboration.peers import read_inbox\n"
        "from loopx.capabilities.manager_context.roundtrip import report\n"
        "for item in read_inbox(root / 'runtime', root / 'registry.json', envelope['goal_id'], actor)['items']:\n"
        "    if item.get('source_kind') != 'peer':\n"
        "        acknowledge(root / 'runtime', envelope['goal_id'], actor, item['request_id'], 'adopt', 'Receiver independently read the original scope.')\n"
        "        report(root / 'runtime', envelope['goal_id'], actor, item['request_id'], 'conclusion', 'Independent fixture result returned to the original request.')\n"
    )
    host.write_text(content.replace(anchor, statement + anchor))
    launched = execution.dispatch(service.root, registry, session=session, turn=turn, request=request, receipt=receipt,
                                   execution_allowed=lambda: True)
    assert launched["submitted"], launched
    assert launched["runtime_readiness"] == "runtime_unverified"
    worker = execution._service(service.root, registry, {"goal_id": service.goal_id, "agent_id": "analyst",
        "requester_agent_id": "lead", "binding_id": "analysis"})[0]
    result = wait(worker, launched["operation_id"])
    assert result["status"] == "accepted", result
    store.update_turn(session["session_id"], turn["turn_id"], status="completing",
                      response={"context_handoff_receipt": receipt})
    store.finalize_managed_turn_completion(session["session_id"], turn["turn_id"])
    from loopx.capabilities.manager_context.roundtrip import drain
    sends = []
    def transport(route, *_args, **_kwargs):
        sends.append(route["session_id"])
        return {"message_id": "provider-return", "reply_verified": True}
    drain(service.root, registry, store, transport)
    assert sends == [session["session_id"]]
    assert worker.read(launched["operation_id"])["status"] == "accepted"
    assert (Path(worker.binding("analysis")["workspace"]) / "host-invocations").read_text() == "1"
    # A new user request cannot reactivate the completed task merely because
    # its source grant and registered Agent still exist.
    _, new_session, new_turn, new_request, new_receipt, _ = source(service.root, registry,
        goal_id=service.goal_id, agent_id="analyst", requester="lead", binding="analysis", source_id="lark:second-message")
    refused = execution.dispatch(service.root, registry, session=new_session, turn=new_turn,
        request=new_request, receipt=new_receipt, execution_allowed=lambda: True)
    assert not refused["submitted"] and refused["reason"] == "execution_not_launchable", refused
    assert (Path(worker.binding("analysis")["workspace"]) / "host-invocations").read_text() == "1"
