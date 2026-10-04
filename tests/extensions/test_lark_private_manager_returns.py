"""Worker returns use the original Core-bound private App, including recovery."""
import json
from types import SimpleNamespace

import pytest
from test_native_steward_private import steward, finish  # noqa: F401

from loopx.capabilities.manager_context import POLICY_SCHEMA, _root, _write, deliver, register_ingress
from loopx.chat_store import _atomic_write_json, _read_json
from loopx.extensions.lark.manager_returns import LarkManagerReturnTransport


@pytest.fixture(params=["native", "legacy"])
def private_return(steward, request):  # noqa: F811
    store, runtime, provider, transport, binding, _, _ = steward
    transport.admit("steward-app", provider.event("steward-app", "delegate", "/delegate --tokens 12000 Inspect README"))
    transport.reconcile()
    proposal = transport.core.actions.store.list()[0]
    transport.admit("steward-app", provider.event("steward-app", "confirm", "/confirm " + proposal["proposal_id"]))
    transport.reconcile()
    applied = transport.core.actions.load(proposal["proposal_id"])
    resources = applied["receipt"]["resource_ids"]
    assert finish(runtime, resources)["status"] == "completed"
    transport.reconcile()
    event = provider.event("steward-app", "original", "Ask the authorized worker to assess the constraint")
    assert transport.admit("steward-app", event)["status"] == "durably_accepted"
    row = next(r for r in transport.core.pending() if r["message"] == event["content"])
    assert finish(runtime, row)["status"] == "completed"
    transport.reconcile()
    session = store.load_session(row["session_id"])
    turn = store.load_turn(row["session_id"], row["turn_id"])
    target = {"goal_id": resources["goal_id"], "agent_id": "codex"}
    _write(_root(transport.runtime_root) / "policy.json", {"schema_version": POLICY_SCHEMA, "sources": {
        session["channel_id"]: {"local_delivery_scope": "selected", "sender_ids": [event["sender_id"]], "targets": [target]}}})
    source_id = row["request_ref"] if request.param == "native" else "lark:" + event["message_id"]
    register_ingress(transport.runtime_root, session_id=session["session_id"], client_turn_id=turn["client_turn_id"],
        channel=session["channel_id"], sender_id=event["sender_id"], message=turn["message"], source_id=source_id)
    delivered = deliver(transport.runtime_root, runtime.registry_path, session=session, turn=turn, request=target)
    route = {**target, "request_id": delivered["request_id"], "session_id": session["session_id"], "source_id": source_id}
    original_runner = provider.__call__
    replies = []

    def runner(args, cwd=None, timeout=None):
        if "+messages-reply" not in args and not ("+messages-send" in args and "--content" in args):
            return original_runner(args, cwd, timeout)
        provider.calls.append(list(args))
        assert args[args.index("--profile") + 1] == "steward-app"
        if "--message-id" in args:
            assert args[args.index("--message-id") + 1] == event["message_id"]
        else:
            assert args[args.index("--chat-id") + 1] == event["chat_id"]
        content = args[args.index("--content") + 1]
        if "--dry-run" in args:
            data = {"api": [{"body": {"msg_type": "post", "content": content}}]}
            if getattr(provider, "revoke_before_send", False):
                _write(_root(transport.runtime_root) / "policy.json", {"schema_version": POLICY_SCHEMA, "sources": {}})
        else:
            replies.append(list(args))
            ref = "om_out_worker"
            provider.messages[ref] = {"message_id": ref, "msg_type": "post", "body": {"content": content}}
            data = {"data": {"message_id": ref}}
        return {"returncode": 0, "stdout": json.dumps(data)}

    transport.runner = runner
    server = SimpleNamespace(registry_path=runtime.registry_path, lark_private_conversations=transport,
        lark_goal_topic_runtime=SimpleNamespace(snapshot_provider=lambda: pytest.fail("private return cannot use legacy Goal bindings")))
    sender = LarkManagerReturnTransport(server, transport.runtime_root)
    # The production transport uses this same profile-aware CLI runner.
    yield sender, session, turn, route, row, provider, transport, replies


def test_original_private_result_and_saved_attempt_recovery(private_return):
    sender, session, turn, route, row, provider, transport, replies = private_return
    provider.verify_replies = False
    attempts = []
    result = sender.send_with_attempt(route, session, turn, "Concrete worker conclusion", attempts.append)
    assert not result["reply_verified"] and len(replies) == 1 and len(attempts) == 1
    # A later ordinary conversation does not redirect the saved worker result.
    transport.admit("steward-app", provider.event("steward-app", "new", "/new"))
    provider.verify_replies = True
    assert sender.verify(route, session, turn, "Concrete worker conclusion", attempts[0])["reply_verified"]
    assert len(replies) == 1
    assert not any("chats" in call or "+chat-members-list" in call for call in provider.calls)
    assert transport.core.read_request(row["request_ref"])["session_id"] == session["session_id"]


def test_private_return_rechecks_grant_after_preview(private_return):
    sender, session, turn, route, _, provider, _, replies = private_return
    provider.revoke_before_send = True
    with pytest.raises(ValueError):
        sender(route, session, turn, "Must not send after revocation")
    assert replies == []


def test_private_return_recovery_rechecks_binding_without_resending(private_return):
    sender, session, turn, route, row, provider, transport, replies = private_return
    provider.verify_replies = False
    attempts = []
    assert not sender.send_with_attempt(route, session, turn, "Worker conclusion", attempts.append)["reply_verified"]
    transport.bindings.disconnect(row["binding_id"], expected_revision=transport.bindings.read()["revision"])
    with pytest.raises(ValueError):
        sender.verify(route, session, turn, "Worker conclusion", attempts[0])
    assert len(replies) == 1


@pytest.mark.parametrize("fault", ["binding", "app", "workspace", "source", "native_turn", "transport_turn", "scope", "policy", "receipt"])
def test_private_return_rejects_changed_authority_or_original_source(private_return, monkeypatch, fault):
    sender, session, turn, route, row, provider, transport, replies = private_return
    if fault == "binding":
        transport.bindings.disconnect(row["binding_id"], expected_revision=transport.bindings.read()["revision"])
    elif fault == "app":
        observe = transport.bindings.observe
        monkeypatch.setattr(transport.bindings, "observe", lambda p: {**observe(p), "provider_ref": "f" * 24})
    elif fault == "workspace":
        monkeypatch.setattr(transport.bindings.projects, "available", lambda: [])
    elif fault == "source":
        record = _read_json(transport.root / f"{row['request_ref']}.json")
        provider.messages[record["event"]["message_id"]]["sender"]["id"] = "ou_other"
    elif fault in {"native_turn", "transport_turn"}:
        root = transport.core.root if fault == "native_turn" else transport.root
        path = root / f"{row['request_ref']}.json"
        value = _read_json(path)
        value["turn_id"] = "another-turn"
        _atomic_write_json(path, value)
    elif fault == "scope":
        value = transport.bindings.read()
        next(b for b in value["bindings"] if b["binding_id"] == row["binding_id"])["goal_ids"] = []
        _atomic_write_json(transport.bindings.path, value)
    elif fault == "policy":
        _write(_root(transport.runtime_root) / "policy.json", {"schema_version": POLICY_SCHEMA, "sources": {}})
    else:
        config, _ = transport.return_inbox(route=route, session=session, turn=turn)
        from loopx.extensions.lark.event_inbox import load_lark_event_inbox_config
        inbox = load_lark_event_inbox_config(project=transport.runtime_root, config_path=config)["inbox_path"]
        (inbox / "processed.json").unlink()
    try:
        result = sender(route, session, turn, "Must not reach another audience")
        assert not result["reply_verified"]
    except ValueError:
        pass
    assert replies == []
