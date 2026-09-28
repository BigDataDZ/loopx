import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  BARE_SHA256_PATTERN,
  ENVELOPED_SHA256_PATTERN,
} from "../../loopx/control_plane/content_digest.ts";
import { promotionPlanDigest } from "../../loopx/control_plane/coordination/reviewed_promotion_plan.ts";
import { delegationInventoryQuery } from "../../loopx/control_plane/collaboration/delegation.ts";
import { normalizeCollaborationBrief } from "../../loopx/control_plane/collaboration/semantic_request.ts";
import { decodeOutboxCursor } from "../../loopx/control_plane/coordination/local_authority_shadow_outbox.ts";

const PACKAGE_ROOT = new URL("../../loopx", import.meta.url).pathname;
const OWNER_FILE = "control_plane/content_digest.ts";
const WHOLE_VALUE = /\/\^(?:sha256:)?\[[0-9a-f-]{6}\]\{64\}\$\/([a-z]*)/g;
const HEX_CLASSES = new Set(["0-9a-f", "a-f0-9"]);

/** Sites that keep their own literal, each with the reason a reviewer can check. */
const RECORDED_EXCEPTIONS: Record<string, string> = {
  "control_plane/agents/delivery_workspace.ts":
    "GIT_REVISION_DIGEST_PATTERN is case-insensitive (/i): a git revision may be " +
    "written in either case, so this surface is a different policy, not a stale copy.",
};

function tsFiles(dir: string, base = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...tsFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) found.push(rel);
  }
  return found;
}

function wholeValueSites(): { file: string; line: number; literal: string; flags: string }[] {
  const rows: { file: string; line: number; literal: string; flags: string }[] = [];
  for (const file of tsFiles(PACKAGE_ROOT)) {
    if (file.endsWith(".generated.ts")) continue;
    const text = readFileSync(join(PACKAGE_ROOT, file), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(WHOLE_VALUE)) {
        const body = match[0].slice(1, match[0].length - 1 - (match[1] ?? "").length);
        const classMatch = /\[([0-9a-f-]{6})\]/.exec(body);
        if (!classMatch || !HEX_CLASSES.has(classMatch[1])) continue;
        rows.push({ file, line: index + 1, literal: match[0], flags: match[1] ?? "" });
      }
    });
  }
  return rows;
}

test("the whole-value digest shape is stated once, outside recorded exceptions", () => {
  const offenders = wholeValueSites().filter(
    (row) => row.file !== OWNER_FILE && !(row.file in RECORDED_EXCEPTIONS),
  );
  assert.deepEqual(
    offenders.map((row) => `${row.file}:${row.line} ${row.literal}`),
    [],
  );
});

test("the owner module states each envelope exactly once", () => {
  const owner = wholeValueSites().filter((row) => row.file === OWNER_FILE);
  assert.equal(owner.length, 2);
  assert.equal(
    owner.filter((row) => row.literal.includes("sha256:")).length,
    1,
  );
  assert.deepEqual([...new Set(owner.map((row) => row.flags))], [""]);
});

test("a recorded exception is still the reason it was recorded", () => {
  for (const file of Object.keys(RECORDED_EXCEPTIONS)) {
    const rows = wholeValueSites().filter((row) => row.file === file);
    assert.ok(rows.length > 0, `${file} no longer restates the shape; drop the exception`);
    assert.ok(
      rows.every((row) => row.flags.length > 0),
      `${file} lost its per-surface flags; absorb it into the owner instead`,
    );
  }
});

test("class order cannot change a verdict", () => {
  const first = /^[a-f0-9]{64}$/;
  const second = /^[0-9a-f]{64}$/;
  for (const probe of ["b".repeat(64), "0123456789abcdef".repeat(4), "B".repeat(64), "b".repeat(63), "z".repeat(64)]) {
    assert.equal(first.test(probe), second.test(probe), probe);
    assert.equal(second.test(probe), BARE_SHA256_PATTERN.test(probe), probe);
  }
});

test("dropping the unicode flag cannot change a verdict for this pattern", () => {
  const flagged = /^[a-f0-9]{64}$/u;
  const probes = ["b".repeat(64), "sha256:" + "b".repeat(64), "𝟏".repeat(64), "b".repeat(64) + "𝟏"];
  for (const probe of probes) assert.equal(flagged.test(probe), BARE_SHA256_PATTERN.test(probe), probe);
});

test("the bare envelope rejects the prefixed form and vice versa", () => {
  const hex = "a".repeat(64);
  assert.ok(BARE_SHA256_PATTERN.test(hex));
  assert.ok(!BARE_SHA256_PATTERN.test(`sha256:${hex}`));
  assert.ok(ENVELOPED_SHA256_PATTERN.test(`sha256:${hex}`));
  assert.ok(!ENVELOPED_SHA256_PATTERN.test(hex));
  for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", `pre-sha256:${hex}`]) {
    assert.ok(!ENVELOPED_SHA256_PATTERN.test(bad), bad);
    assert.ok(!BARE_SHA256_PATTERN.test(bad), bad);
  }
});

test("promotion plan digest is read through the owner as a bare digest", () => {
  const hex = "b".repeat(64);
  assert.equal(promotionPlanDigest(hex), hex);
  assert.throws(() => promotionPlanDigest(`sha256:${hex}`), /lowercase SHA-256/);
});

test("delegation inventory cursor is a bare digest, not an enveloped one", () => {
  const hex = "c".repeat(64);
  assert.deepEqual(
    delegationInventoryQuery({ limit: 5, cursor: hex }).cursor,
    hex,
  );
  assert.throws(
    () => delegationInventoryQuery({ limit: 5, cursor: `sha256:${hex}` }),
    /invalid delegation inventory cursor/,
  );
});

test("collaboration brief input digests must be bare", () => {
  const hex = "d".repeat(64);
  const brief = (sha: string) => ({
    schema_version: "collaboration_brief_v0",
    purpose: "p",
    context: "c",
    constraints: [],
    inputs: [{ ref: "notes/a.md", description: "d", sha256: sha }],
    acceptance: ["done when x"],
    return_requirement: "r",
  });
  assert.ok(normalizeCollaborationBrief(brief(hex)));
  assert.throws(
    () => normalizeCollaborationBrief(brief(`sha256:${hex}`)),
    /input\.sha256 must be a SHA256 digest/,
  );
});

test("drain cursor keeps its envelope and its unbound option", () => {
  const hex = "e".repeat(64);
  const cursor = (digest: string | null) => ({
    schema_version: "loopx_local_authority_shadow_drain_cursor_v0",
    partition: "todos",
    last_seq: 1,
    last_entry_id: `local-shadow-tx-${hex}`,
    last_partition_digest: digest,
    last_cursor: "c1",
    last_provider_revision: "r1",
    updated_at: "2026-09-28T00:00:00Z",
  });
  assert.equal(decodeOutboxCursor(cursor(`sha256:${hex}`), "todos").last_partition_digest, `sha256:${hex}`);
  assert.equal(decodeOutboxCursor(cursor(null), "todos").last_partition_digest, null);
  assert.throws(() => decodeOutboxCursor(cursor(hex), "todos"), /drain cursor binding is invalid/);
});
