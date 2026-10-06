import assert from "node:assert/strict";
import test from "node:test";
import {normalizeExploreResultAttachment} from "../../loopx/control_plane/capabilities/explore_result_writeback.ts";

const attachment = {
  schema_version: "explore_result_attachment_v0", node_id: "tail-bound",
  question: "Does a finite prefix establish a tail bound?",
  applicability: "Finite prefix only", input_revision: "fixture-v1",
  observation: "A divergent tail shares the prefix.",
  interpretation: "Require a uniform estimate.", status: "refuted",
  evidence_refs: ["validation:prefix", "validation:tail"],
};

test("two explicit sources normalize and coalesce equivalent scoped evidence", () => {
  const other = {...attachment, observation: ` ${attachment.observation} `,
    evidence_refs: ["validation:tail", "validation:prefix", "validation:tail"]};
  assert.deepEqual(normalizeExploreResultAttachment({attachment, other_attachment: other}), attachment);
});

test("neither a conflicting nor malformed secondary source can be silently preferred", () => {
  for (const other of [
    {...attachment, applicability: "Uniform tail bound"},
    {...attachment, interpretation: "Transfer the bound unconditionally."},
    {...attachment, evidence_refs: ["validation:other"]},
  ]) {
    assert.throws(() => normalizeExploreResultAttachment({attachment, other_attachment: other}), /sources conflict/);
  }
  for (const other of [null, [], {...attachment, evidence_refs: []}]) {
    assert.throws(() => normalizeExploreResultAttachment({attachment, other_attachment: other}));
  }
  assert.throws(() => normalizeExploreResultAttachment({attachment: null}));
});

const delta = {
  schema_version: "goal_path_delta_v0", outcome: "continue",
  prior_assumption: "A finite prefix might bound the tail.",
  observed_reality: attachment.observation,
  retained: ["Require a uniform estimate."], stopped: ["Transfer from a finite prefix."],
  evidence_refs: attachment.evidence_refs,
};
const scope = {
  schema_version: "explore_result_from_path_delta_v0", node_id: attachment.node_id,
  question: attachment.question, applicability: attachment.applicability,
  input_revision: attachment.input_revision, status: "tentative",
};
const resolved = {...attachment, status: "tentative",
  interpretation: 'Outcome: continue; retained: ["Require a uniform estimate."]; stopped: ["Transfer from a finite prefix."]'};

test("explicit scoped capture reuses the same typed path delta without inferring finding status", () => {
  const vision = {path_delta: delta};
  const before = structuredClone({scope, vision});
  assert.deepEqual(normalizeExploreResultAttachment({attachment: scope, vision_packet: vision}), resolved);
  assert.deepEqual({scope, vision}, before);
  // Stopping a route does not turn tentative evidence into a refutation.
  assert.equal(normalizeExploreResultAttachment({attachment: scope,
    vision_packet: {path_delta: {...delta, outcome: "stop"}}}).status, "tentative");
});

test("full and path-delta sources share canonical conflict and coalescing rules", () => {
  assert.deepEqual(normalizeExploreResultAttachment({attachment: scope, vision_packet: {path_delta: delta},
    other_attachment: resolved}), resolved);
  assert.throws(() => normalizeExploreResultAttachment({attachment: scope, vision_packet: {path_delta: delta},
    other_attachment: {...resolved, status: "refuted"}}), /sources conflict/);
});

test("scoped path capture cannot fall back to a missing, misplaced or invalid delta", () => {
  for (const vision of [null, {}, {vision_patch: {path_delta: delta}},
    {path_delta: {...delta, outcome: "invented"}},
    {path_delta: {...delta, retained: [], stopped: []}},
    {path_delta: {...delta, observed_reality: "/Users/private/results.log"}},
    {path_delta: {...delta, evidence_refs: []}},
  ]) assert.throws(() => normalizeExploreResultAttachment({attachment: scope, vision_packet: vision}));
  assert.throws(() => normalizeExploreResultAttachment({attachment: {...scope, observation: "Override"},
    vision_packet: {path_delta: delta}}), /unknown fields/);
});

test("reused text respects result limits without truncation or omission", () => {
  assert.throws(() => normalizeExploreResultAttachment({attachment: scope,
    vision_packet: {path_delta: {...delta, observed_reality: "x".repeat(301)}}}), /observation/);
  assert.throws(() => normalizeExploreResultAttachment({attachment: scope,
    vision_packet: {path_delta: {...delta, retained: ["x".repeat(110), "y".repeat(110), "z".repeat(110)]}}}), /interpretation/);
  assert.throws(() => normalizeExploreResultAttachment({attachment: {...scope, applicability: ""},
    vision_packet: {path_delta: delta}}), /applicability/);
});
