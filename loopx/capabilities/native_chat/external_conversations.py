"""Native Chat admission/recovery IO for explicitly bound external sources.

Sessions and Turns remain in ChatSessionStore. This journal only correlates a
provider request with those canonical objects; it is not a second queue or model
runner. Write it before admission so a crash can replay the same client identity.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ...chat_store import _atomic_write_json, _read_json
from ...file_lock import exclusive_file_lock


class ChatExternalConversations:
    def __init__(self, controller: Any) -> None:
        self.controller = controller
        self.bindings = controller.project_contexts.conversation_bindings
        self.root = controller.store.root / "external-requests"

    def admit(self, *, binding_id: str, source: dict[str, Any], request_ref: str,
              message: str, command: str | None = None) -> dict[str, Any]:
        import re
        if not re.fullmatch(r"[a-f0-9]{24}", request_ref):
            raise ValueError("invalid external request reference")
        if command not in {None, "status", "new", "stop", "unsupported"}:
            raise ValueError("unsupported external conversation command")
        selected = self.bindings.resolve(binding_id=binding_id, **source)
        path = self.root / f"{request_ref}.json"
        with exclusive_file_lock(path, operation="admit_external_chat_request"):
            expected = {"binding_id": binding_id, "source": source, "message": message, "command": command}
            if path.exists():
                row = _read_json(path)
                if any(row.get(key) != value for key, value in expected.items()):
                    raise ValueError("external request identity was reused with different content")
                if row.get("status") != "prepared":
                    return row
            else:
                row = {"schema_version": "loopx_chat_external_request_v0", "request_ref": request_ref,
                       **expected, "status": "prepared", "session_id": None, "turn_id": None}
                _atomic_write_json(path, row)
            return self._admit_prepared(path, row, selected)

    def _admit_prepared(self, path: Path, row: dict[str, Any], selected: dict[str, Any]) -> dict[str, Any]:
        controller = self.controller
        current = controller.store.latest_session(goal_id=None,
            agent_id=selected["binding"]["executor_endpoint_id"], channel_id=selected["channel_id"])
        if row.get("session_id") and row["command"] is None:
            current = controller.store.load_session(row["session_id"])
            if current is None:
                raise ValueError("the original request Session is unavailable")
            client_id = f"external-{row['request_ref']}"
            if controller.store.turn_for_client(current["session_id"], client_id) is not None:
                # The canonical store validates exact replay before its closed
                # Session check. Never move an accepted request to a new Session.
                turn, _ = controller.store.create_queued_turn(current["session_id"],
                    client_turn_id=client_id, message=row["message"], origin="lark")
                row.update(status="accepted", turn_id=turn["turn_id"])
                _atomic_write_json(path, row)
                return row
        from ...control_plane.effect_runtime import effect_runtime_result
        plan = effect_runtime_result("collaboration.conversation.request", {"request": row, "current_session": current})
        operation = plan["operation"]
        if operation == "reply":
            row.update(status="command_completed", session_id=plan["session_id"], response_code=plan["response_code"])
        elif operation in {"new", "stop"}:
            row.update(target_recorded=True, session_id=plan["session_id"], turn_id=plan["turn_id"])
            _atomic_write_json(path, row)
            if operation == "stop" and row["session_id"] and row["turn_id"]:
                controller.interrupt_turn(session_id=row["session_id"], turn_id=row["turn_id"])
            elif operation == "new" and row["session_id"]:
                controller.close_session(row["session_id"])
            row.update(status="command_completed", response_code=plan["response_code"])
        else:
            # Opening uses the shared route fence, canonical grant and native
            # adapter. It never creates a Goal or waits for a terminal answer.
            if current is None:
                current, _ = controller.open_session(goal_id=None,
                    agent_id=selected["binding"]["executor_endpoint_id"], work_dir=Path("."), objective="",
                    mode="resume_latest", conversation_binding_id=row["binding_id"], source_context=row["source"])
            row["session_id"] = current["session_id"]
            _atomic_write_json(path, row)
            try:
                turn, _ = controller.enqueue_turn(session_id=current["session_id"],
                    client_turn_id=plan["client_turn_id"], message=row["message"],
                    work_dir=Path("."), objective="", origin="lark")
                row.update(status="accepted", turn_id=turn["turn_id"])
            except RuntimeError as exc:
                if str(exc) != "session_queue_full":
                    raise
                row.update(status="rejected", response="队列已满，本条没有被受理；请稍后重新发送。")
        _atomic_write_json(path, row)
        return row

    def pending(self) -> list[dict[str, Any]]:
        return [_read_json(path) for path in sorted(self.root.glob("*.json"))]

    def record_delivery(self, request_ref: str, *, session_id: str | None, turn_id: str | None) -> None:
        # This transport receipt does not alter a canonical Turn or grant.
        path = self.root / f"{request_ref}.json"
        with exclusive_file_lock(path, operation="record_external_chat_delivery"):
            row = _read_json(path)
            if (row.get("session_id"), row.get("turn_id")) != (session_id, turn_id):
                raise ValueError("delivery correlation changed")
            row["delivery_verified"] = True
            _atomic_write_json(path, row)

    def recover(self) -> None:
        for row in self.pending():
            try:
                if row.get("delivery_verified"):
                    continue
                self.bindings.resolve(binding_id=row["binding_id"], **row["source"])
                if row["status"] == "prepared":
                    self.admit(binding_id=row["binding_id"], source=row["source"], request_ref=row["request_ref"],
                               message=row["message"], command=row["command"])
                elif row["status"] == "accepted":
                    session = self.controller.store.load_session(row["session_id"])
                    if session and session.get("status") != "closed":
                        context = self.controller.project_contexts.session_context(session)
                        self.controller.resume_session_queue(session_id=row["session_id"],
                            work_dir=context["project"], objective=context["objective"])
            except (KeyError, ValueError, RuntimeError, OSError):
                # Revoked/missing grants never fall back to a new model thread.
                continue
