import assert from "node:assert/strict";
import test from "node:test";
import {planConversationBinding, resolveBoundConversation, planBoundConversationRequest} from "../../loopx/control_plane/collaboration/conversation_binding.ts";
import {resolveConversationScope} from "../../loopx/control_plane/collaboration/conversation_scope.ts";

const project = {kind: "project_workspace", project_ref: "a".repeat(24), workspace_path: "/authorized/notes",
  audience: "local_owner", grant: "workspace_read"};
const row = {schema_version: "loopx_chat_conversation_binding_v0", binding_id: "b".repeat(24),
  transport_ref: "notes-app", provider_ref: "c".repeat(24), operator_ref: "d".repeat(24),
  context_kind: "project", project_ref: project.project_ref, executor_endpoint_id: "codex",
  grant: "workspace_read", enabled: true};
const observation = {transport_ref: row.transport_ref, provider_ref: row.provider_ref,
  operator_ref: row.operator_ref, verified: true};
const current = {schema_version: "loopx_chat_conversation_bindings_v0", revision: 0, bindings: []};
const request = {current, expected_revision: 0, operation: "configure", binding: row, observation,
  available_projects: [project]};

test("binding independently verifies the owner and does not create a Goal", () => {
  const result = planConversationBinding(request);
  assert.equal(result.changed, true);
  const next = result.state as typeof current;
  assert.equal(next.revision, 1);
  assert.equal("goal_id" in next.bindings[0], false);
  const repeat = planConversationBinding({...request, current: next, expected_revision: 1,
    binding: {...row, binding_id: "e".repeat(24)}});
  assert.equal(repeat.changed, false);
  for (const proof of [{...observation, verified: false}, {...observation, operator_ref: "f".repeat(24)},
    {...observation, provider_ref: "e".repeat(24)}]) {
    assert.throws(() => planConversationBinding({...request, observation: proof}), /independently verified/);
  }
  assert.throws(() => planConversationBinding({...request, available_projects: []}), /workspace/);
  assert.throws(() => planConversationBinding({...request, expected_revision: 1}), /revision/);
});

test("one App has one binding owner, and a context change cannot move an existing Session", () => {
  const next = planConversationBinding(request).state as typeof current;
  const second = {...row, transport_ref: "other-app", binding_id: "e".repeat(24)};
  assert.throws(() => planConversationBinding({...request, current: next, expected_revision: 1,
    binding: second, observation: {...observation, transport_ref: "other-app"}}), /ownership/);
  const other = {...project, project_ref: "f".repeat(24), workspace_path: "/authorized/other"};
  assert.throws(() => planConversationBinding({...request, current: next, expected_revision: 1,
    binding: {...row, project_ref: other.project_ref}, available_projects: [other]}), /new binding identity/);
});

test("external project audience has its own Session identity without portfolio or peer scope", () => {
  const next = planConversationBinding(request).state;
  const use = {current: next, binding_id: row.binding_id, source_ref: "e".repeat(24),
    sender_ref: row.operator_ref, private_human_message: true, observation, available_projects: [project]};
  const selected = resolveBoundConversation(use);
  assert.equal(selected.channel_id, `project.external.${row.binding_id}.${use.source_ref}`);
  assert.deepEqual(resolveConversationScope({channel_id: selected.channel_id, project_context: selected.context,
    goal_id: null, origin: "lark"}), {kind: "project_workspace", goal_ids: [], private_conversation: false});
  for (const bad of [{...use, sender_ref: "f".repeat(24)}, {...use, private_human_message: false},
    {...use, available_projects: []}, {...use, observation: {...observation, provider_ref: "f".repeat(24)}}]) {
    assert.throws(() => resolveBoundConversation(bad));
  }
  assert.throws(() => resolveBoundConversation({...use, source_ref: "f".repeat(24), session_context: selected.context}), /context changed/);
  const revoked = planConversationBinding({current: next, expected_revision: 1,
    operation: "disconnect", binding_id: row.binding_id}).state;
  assert.throws(() => resolveBoundConversation({...use, current: revoked}), /no longer authorized/);
});


test("native commands retain their recorded target across a new Session and redelivery", () => {
  const request = {request_ref: "e".repeat(24), command: "stop", target_recorded: true,
    session_id: "original", turn_id: "original-turn"};
  const current = {session_id: "replacement", active_turn_id: "different-turn"};
  assert.deepEqual(planBoundConversationRequest({request, current_session: current}), {
    operation: "stop", session_id: "original", turn_id: "original-turn", response_code: "stop_requested"});
  assert.deepEqual(planBoundConversationRequest({request: {...request, command: null}, current_session: current}), {
    operation: "admit_turn", client_turn_id: `external-${request.request_ref}`, session_id: "original", turn_id: null});
  assert.equal(planBoundConversationRequest({request: {...request, command: "unsupported"},
    current_session: null}).response_code, "unsupported_attachment");
  assert.throws(() => planBoundConversationRequest({request: {...request, command: "grant"}, current_session: current}),
    /unsupported/);
});
