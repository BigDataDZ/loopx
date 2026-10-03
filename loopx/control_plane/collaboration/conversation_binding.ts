import type {JsonObject} from "../effect_program.ts";
import {EffectRuntimeRequestError} from "../effect_runtime_errors.ts";
import {requireJsonObject, requireNonEmptyString} from "../runtime_decode.ts";
import {normalizeProjectContext} from "./conversation_scope.ts";

/** Core owns the context and audience grant. A provider supplies verified,
 * opaque identity observations; neither a message nor a model selects them.
 * This contract intentionally carries no Goal and no provider credentials.
 */
const BINDING_SCHEMA = "loopx_chat_conversation_binding_v0";
const SET_SCHEMA = "loopx_chat_conversation_bindings_v0";

function ref(value: unknown, label: string): string {
  const result = requireNonEmptyString(value, label);
  if (!/^[a-f0-9]{24}$/.test(result)) throw new EffectRuntimeRequestError(`${label} is invalid`);
  return result;
}

function token(value: unknown, label: string): string {
  const result = requireNonEmptyString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(result)) throw new EffectRuntimeRequestError(`${label} is invalid`);
  return result;
}

function binding(value: unknown): JsonObject {
  const row = requireJsonObject(value, "conversation binding");
  if (row.schema_version !== BINDING_SCHEMA || row.context_kind !== "project"
      || row.grant !== "workspace_read" || row.enabled !== true) {
    throw new EffectRuntimeRequestError("unsupported conversation binding");
  }
  return {
    schema_version: BINDING_SCHEMA, binding_id: ref(row.binding_id, "binding identity"),
    transport_ref: token(row.transport_ref, "transport reference"),
    provider_ref: ref(row.provider_ref, "provider identity"),
    operator_ref: ref(row.operator_ref, "verified operator identity"),
    context_kind: "project", project_ref: ref(row.project_ref, "workspace reference"),
    executor_endpoint_id: token(row.executor_endpoint_id, "executor endpoint"),
    grant: "workspace_read", enabled: true,
  };
}

function state(value: unknown): {schema_version: string; revision: number; bindings: JsonObject[]} {
  const row = requireJsonObject(value, "conversation bindings");
  if (row.schema_version !== SET_SCHEMA || !Number.isSafeInteger(row.revision)
      || Number(row.revision) < 0 || !Array.isArray(row.bindings)) {
    throw new EffectRuntimeRequestError("invalid conversation bindings state");
  }
  const bindings = row.bindings.map(binding);
  for (const field of ["binding_id", "transport_ref", "provider_ref"]) {
    if (new Set(bindings.map(row => row[field])).size !== bindings.length) {
      throw new EffectRuntimeRequestError("conversation listener ownership is ambiguous");
    }
  }
  return {schema_version: SET_SCHEMA, revision: Number(row.revision), bindings};
}

function observed(row: JsonObject, value: unknown): void {
  const observation = requireJsonObject(value, "provider identity observation");
  if (observation.verified !== true || observation.transport_ref !== row.transport_ref
      || observation.provider_ref !== row.provider_ref || observation.operator_ref !== row.operator_ref) {
    throw new EffectRuntimeRequestError("provider or operator identity is not independently verified");
  }
}

export function planConversationBinding(params: JsonObject): JsonObject {
  const current = state(params.current);
  if (params.expected_revision !== current.revision) throw new EffectRuntimeRequestError("conversation binding revision changed");
  let rows: JsonObject[];
  if (params.operation === "configure") {
    const candidate = binding(params.binding);
    observed(candidate, params.observation);
    if (!Array.isArray(params.available_projects)
        || !params.available_projects.map(normalizeProjectContext).some(row => row.project_ref === candidate.project_ref)) {
      throw new EffectRuntimeRequestError("workspace grant is unavailable");
    }
    const previous = current.bindings.find(row => row.transport_ref === candidate.transport_ref);
    // An exact repeat is idempotent. A changed context receives a new binding
    // identity, so an existing Session can never silently move workspaces.
    if (previous && JSON.stringify({...previous, binding_id: null}) === JSON.stringify({...candidate, binding_id: null})) {
      return {changed: false, state: current};
    }
    if (previous?.binding_id === candidate.binding_id) throw new EffectRuntimeRequestError("changed context requires a new binding identity");
    rows = [...current.bindings.filter(row => row.transport_ref !== candidate.transport_ref), candidate];
  } else if (params.operation === "disconnect") {
    const id = ref(params.binding_id, "binding identity");
    rows = current.bindings.filter(row => row.binding_id !== id);
    if (rows.length === current.bindings.length) return {changed: false, state: current};
  } else throw new EffectRuntimeRequestError("unsupported conversation binding operation");
  const next = state({...current, revision: current.revision + 1, bindings: rows});
  return {changed: true, state: next};
}

export function resolveBoundConversation(params: JsonObject): JsonObject {
  const current = state(params.current);
  const id = ref(params.binding_id, "binding identity");
  const row = current.bindings.find(row => row.binding_id === id);
  if (!row) throw new EffectRuntimeRequestError("conversation binding is no longer authorized");
  observed(row, params.observation);
  const source = ref(params.source_ref, "source conversation identity");
  if (params.sender_ref !== row.operator_ref || params.private_human_message !== true) {
    throw new EffectRuntimeRequestError("message audience is outside the binding grant");
  }
  if (!Array.isArray(params.available_projects)) throw new EffectRuntimeRequestError("workspace grants unavailable");
  const projects = params.available_projects.map(normalizeProjectContext).filter(project => project.project_ref === row.project_ref);
  if (projects.length !== 1) throw new EffectRuntimeRequestError("workspace grant is unavailable or ambiguous");
  const context = {...projects[0], audience: "bound_owner", binding_id: id, source_ref: source,
    provider_ref: row.provider_ref, operator_ref: row.operator_ref};
  if (params.session_context !== undefined && JSON.stringify(params.session_context) !== JSON.stringify(context)) {
    throw new EffectRuntimeRequestError("bound Session context changed");
  }
  return {binding: row, context, channel_id: `project.external.${id}.${source}`};
}

/** Shared native command projection. Provider grammar carries the explicit
 * command; Core binds its exact target before IO. Replays retain that target.
 */
export function planBoundConversationRequest(params: JsonObject): JsonObject {
  const row = requireJsonObject(params.request, "external request");
  const request = ref(row.request_ref, "external request identity");
  const command = row.command;
  if (![null, "status", "new", "stop", "unsupported"].includes(command as null | string)) {
    throw new EffectRuntimeRequestError("unsupported external conversation command");
  }
  const current = params.current_session === null ? null : requireJsonObject(params.current_session, "current Session");
  const target = row.target_recorded === true ? row : current;
  const session = target?.session_id ?? null;
  const turn = row.target_recorded === true ? row.turn_id ?? null : current?.active_turn_id ?? null;
  if (command === "status" || command === "unsupported") {
    return {operation: "reply", session_id: session, turn_id: null,
      response_code: command === "unsupported" ? "unsupported_attachment" : !current ? "no_session"
        : current.active_turn_id ? "active_session" : "ready_session"};
  }
  if (command === "stop" || command === "new") {
    return {operation: command, session_id: session, turn_id: turn,
      response_code: command === "new" ? "new_session" : turn ? "stop_requested" : "no_active_turn"};
  }
  return {operation: "admit_turn", client_turn_id: `external-${request}`, session_id: session, turn_id: null};
}
