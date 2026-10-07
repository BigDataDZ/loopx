import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../loopx/control_plane/effect_program.ts";
import { projectQuotaSelection, projectTodoQuotaPlanning } from "../../loopx/control_plane/todos/quota_selection.ts";
import { productionScaleCoordinationFixture } from "./production_scale_coordination_fixture.ts";
import {projectAdvancementFrontier} from "../../loopx/control_plane/todos/frontier_revision.ts";

function row(id: string, fields: JsonObject = {}): JsonObject {
  return {payload: {todo_id: id}, claim: null, bound: null, blocks: null, excluded: [],
    global: false, gate: false, removed: false, actionable: true, due: false,
    watch_only: false,
    task_class: "advancement_task", priority: 1, index: 1, profile_rank: 1,
    missing: [], raw_claimed: false, ...fields};
}
function request(items: JsonObject[], fields: JsonObject = {}): JsonObject {
  return {items, active_items: items, active_executable_items: [], agent_id: "agent-a",
    user_gate_scope: false, monitor_supported: true, diagnostic_limit: 3,
    backlog_limit: 8, visibility_limit: 16, profile: null, source_open_count: items.length, ...fields};
}
const ids = (value: unknown) => (value as JsonObject[]).map(item => item.todo_id);

test("gate applicability overrides execution claims, but not another lane's explicit scope", () => {
  const rows = [row("global", {gate: true, global: true, claim: "agent-b", excluded: ["agent-a"]}),
    row("targeted", {gate: true, blocks: "agent-a", claim: "agent-b"}),
    row("other", {gate: true, blocks: "agent-b", claim: "agent-a"}),
    row("legacy", {gate: true, claim: "agent-b"}),
    row("action", {bound: "agent-a", claim: "agent-b"}),
    row("other-action", {bound: "agent-b", claim: "agent-a"})];
  const input = request(rows, {user_gate_scope: true});
  const before = structuredClone(input);
  const lanes = projectQuotaSelection(input).lanes as JsonObject;
  assert.deepEqual(ids(lanes.open_items), ["global", "targeted"]);
  assert.deepEqual(ids(lanes.user_action_open_items), ["action"]);
  assert.deepEqual(ids(lanes.other_agent_scoped_items), ["other", "legacy"]);
  assert.deepEqual(ids(lanes.active_next_action_items), ["global", "targeted", "action"]);
  assert.equal(lanes.claim_scope, null);
  assert.deepEqual(input, before);
});

test("execution scope is shared with active-next-action, including removed-policy rejection", () => {
  const items = [row("excluded", {excluded: ["agent-a"]}), row("removed", {removed: true}),
    row("peer", {claim: "agent-b"}), row("unclaimed", {priority: 0, profile_rank: 0}),
    row("mine", {claim: "agent-a", priority: 4, profile_rank: 2})];
  const result = projectQuotaSelection(request(items));
  const lanes = result.lanes as JsonObject;
  assert.deepEqual(ids(lanes.open_items), ["mine", "unclaimed"]);
  assert.deepEqual(ids(lanes.active_next_action_items), ["unclaimed", "mine"]);
  assert.equal((lanes.claim_scope as JsonObject).executor_excluded_self_count, 1);
  assert.equal((lanes.claim_scope as JsonObject).removed_continuation_blocked_count, 1);
  assert.deepEqual(ids((result.claim_visibility as JsonObject).claimed_by_others_items), ["peer"]);
});

test("monitor eligibility preserves provider writeback and capability fences", () => {
  const items = [row("due", {task_class: "continuous_monitor", due: true}),
    row("watch", {task_class: "continuous_monitor", due: true, watch_only: true}),
    row("missing", {task_class: "continuous_monitor", due: true, missing: ["network"]}),
    row("future", {task_class: "continuous_monitor"})];
  const lanes = projectQuotaSelection(request(items)).lanes as JsonObject;
  assert.deepEqual(ids(lanes.monitor_due_items), ["due", "watch"]);
  assert.deepEqual(ids(lanes.watch_only_monitor_items), ["watch"]);
  assert.deepEqual(ids(lanes.watch_only_monitor_due_items), ["watch"]);
  assert.deepEqual(ids(lanes.non_watch_only_monitor_due_items), ["due"]);
  assert.deepEqual(ids(lanes.monitor_capability_blocked_due_items), ["missing"]);
  assert.deepEqual(ids(lanes.executable_items), []);
  const unsupported = projectQuotaSelection(request(items, {monitor_supported: false})).lanes as JsonObject;
  assert.deepEqual(unsupported.monitor_due_items, []);
  assert.deepEqual(unsupported.monitor_capability_blocked_due_items, []);
});

test("production-scale corpus counts remain complete while claimant display is bounded", () => {
  const fixture = productionScaleCoordinationFixture("goal-quota");
  const records = fixture.projection.todos as JsonObject[];
  const open = records.filter(item => item.role === "agent" && !item.done);
  const items = open.map((item, index) => row(String(item.todo_id), {
    payload: item, index, claim: item.claimed_by ?? null, raw_claimed: !!item.claimed_by,
    task_class: item.task_class, actionable: item.status === "open",
  }));
  const input = request(items, {visibility_limit: 2});
  const before = structuredClone(input);
  const result = projectQuotaSelection(input);
  const scope = (result.lanes as JsonObject).claim_scope as JsonObject;
  assert.equal(open.length, 80);
  assert.equal(scope.current_agent_claimed_open_count, 40);
  assert.equal(scope.other_agent_claimed_open_count, 40);
  const visible = (result.claim_visibility as JsonObject).claimed_open_items as JsonObject[];
  assert.equal(visible.length, 2);
  assert.deepEqual(new Set(visible.map(item => item.claimed_by)), new Set(["agent-a", "agent-b"]));
  assert.deepEqual(input, before);
});

test("stable ties and zero display never change selection or counts", () => {
  const result = projectQuotaSelection(request([row("zed"), row("alpha")], {
    visibility_limit: 0, backlog_limit: 0, diagnostic_limit: 0,
  }));
  assert.deepEqual(ids((result.lanes as JsonObject).open_items), ["zed", "alpha"]);
  assert.equal((result.lanes as JsonObject).open_count, 2);
  assert.deepEqual((result.claim_visibility as JsonObject).unclaimed_priority_open_items, []);
});

test("complete frontier counts survive hidden peer pressure without granting hidden work", () => {
  const mine = Array.from({length: 15}, (_, i) => ({id: `own-${i}`, claim: "agent-a",
    excluded: [], advancement: true, actionable: true, updated: "2026-09-01T00:00:00Z", serialized: "{}"}));
  const peers = Array.from({length: 20}, (_, i) => ({...mine[0], id: `peer-${i}`, claim: "agent-b"}));
  for (const full of [mine, [...mine, ...peers], [...mine, ...peers].reverse()]) {
    const index = projectAdvancementFrontier({schema_version: "todo_frontier_revision_request_v0",
      operation: "index", rows: full}).index;
    const observed = [row("visible-owned", {claim: "agent-a"}), row("visible-peer", {claim: "agent-b"})];
    const result = projectQuotaSelection(request(observed, {frontier_revision_index: index, source_open_count: full.length}));
    assert.equal((result.claim_visibility as JsonObject).current_agent_claimed_advancement_count, 15);
    // Counting hidden commitments does not synthesize a claim, lease or an
    // executable row. Selection still uses only the independently admitted rows.
    assert.deepEqual(ids((result.lanes as JsonObject).executable_items), ["visible-owned"]);
    assert.equal((result.work_counts as JsonObject).complete, false);
  }
});

test("missing historical census retains observed counts; malformed new totals reject", () => {
  const observed = [row("mine", {claim: "agent-a"})];
  const index = {schema_version: "todo_frontier_revision_index_v0"};
  assert.equal((projectQuotaSelection(request(observed, {frontier_revision_index: index}))
    .claim_visibility as JsonObject).current_agent_claimed_advancement_count, 1);
  for (const counts of [{"agent-a": -1}, {"agent-a": "15"}, {"agent-a": Number.MAX_SAFE_INTEGER + 1}, {" AGENT-A ": 15}]) {
    assert.throws(() => projectQuotaSelection(request(observed, {
      frontier_revision_index: {...index, claimed_advancement_counts: counts},
    })));
  }
});

test("malformed facts are rejected, not coerced into scope or execution authority", () => {
  for (const fields of [{gate: "false"}, {global: "true"}, {excluded: "agent-a"}, {priority: null}]) {
    assert.throws(() => projectQuotaSelection(request([row("bad", fields)])));
  }
  assert.throws(() => projectQuotaSelection(request([], {visibility_limit: -1})));
});

function clockRequest(items: JsonObject[], fields: JsonObject = {}): JsonObject {
  return {schema_version: "todo_quota_planning_request_v2", selection: request(items, {available: [], observed_at: 100, ...fields}),
    resume: {schema_version: "todo_resume_planning_request_v0", sources: Object.fromEntries([
      "items", "backlog_items", "first_open_items", "deferred_items", "deferred_resume_candidates",
      "resume_blocked_items", "monitor_open_items", "current_agent_claimed_monitor_items", "claimed_monitor_open_items",
    ].map(key => [key, []])), agent_id: null, available_capabilities: null,
    item_limit: 8, has_deferred_count: false, has_visible_deferred_count: false}};
}

test("quota v2 derives due and gap from the same clock, preserving priority presentation and fences", () => {
  const monitor = (id: string, fields: JsonObject = {}) => row(id, {task_class: "continuous_monitor",
    due_at: null, expires_at: null, required: [], targets: [], ...fields});
  const items = [monitor("gap-first", {index: 1}), monitor("gap-owned", {index: 2, claim: "agent-a"}),
    monitor("due", {due_at: 100, due: false}), monitor("future", {due_at: 101, due: true}),
    monitor("expired", {due_at: 90, expires_at: 100, due: true}),
    monitor("expired-gap", {expires_at: 100}), monitor("watch-gap", {watch_only: true}),
    monitor("watch-due", {watch_only: true, due_at: 90}),
    monitor("capability", {due_at: 90, required: ["compiler"]}),
    monitor("peer", {claim: "agent-b"}), monitor("excluded", {excluded: ["agent-a"]}),
    monitor("blocked", {actionable: false})];
  const input = clockRequest(items), before = structuredClone(input);
  const lanes = projectTodoQuotaPlanning(input).lanes as JsonObject;
  assert.deepEqual(ids(lanes.monitor_schedule_gap_items), ["gap-first", "gap-owned"]);
  assert.deepEqual(ids(lanes.monitor_due_items), ["due", "watch-due"]);
  assert.deepEqual(ids(lanes.monitor_capability_blocked_due_items), ["capability"]);
  assert.deepEqual(ids(lanes.watch_only_monitor_due_items), ["watch-due"]);
  assert.deepEqual(input, before);
  const unsupported = projectTodoQuotaPlanning(clockRequest(items, {monitor_supported: false})).lanes as JsonObject;
  assert.deepEqual(unsupported.monitor_schedule_gap_items, []);
  assert.deepEqual(unsupported.monitor_due_items, []);
});

test("quota v2 requires finite clock and explicit schedule facts while v0/v1 keep their old wire shape", () => {
  for (const observed_at of [undefined, null, "100", NaN, Infinity]) {
    assert.throws(() => projectTodoQuotaPlanning(clockRequest([], {observed_at})), /observed_at/);
  }
  for (const fields of [{due_at: undefined}, {due_at: "100"}, {due_at: Infinity}, {expires_at: false}]) {
    assert.throws(() => projectTodoQuotaPlanning(clockRequest([row("bad", {
      due_at: null, expires_at: null, required: [], targets: [], ...fields})])), /due_at|expires_at/);
  }
  const selection = request([row("old", {due: true, task_class: "continuous_monitor", required: [], targets: []})], {available: []});
  const direct = projectQuotaSelection(selection);
  for (const schema_version of ["todo_quota_planning_request_v0", "todo_quota_planning_request_v1"]) {
    const projected = projectTodoQuotaPlanning({...clockRequest([]), schema_version, selection});
    assert.deepEqual(projected.lanes, direct.lanes);
    assert.equal((projected.lanes as JsonObject).monitor_schedule_gap_items, undefined);
  }
});
