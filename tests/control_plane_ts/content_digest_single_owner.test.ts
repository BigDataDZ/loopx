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

// The same decision is written two ways: a regex literal, and a constructed RegExp over
// an equivalent string. Both are forbidden outside the owner, and the bypass cases below
// are what stop this scan from quietly decaying into a search for one spelling.
const WHOLE_VALUE = /\/\^(?:sha256:)?\[[0-9a-f-]{6}\]\{64\}\$\/(?<flags>[a-z]*)/g;
const CONSTRUCTED = /(?:new\s+)?RegExp\(\s*(?:["'`])(?<body>\^?(?:sha256:)?\[[0-9a-f-]{6}\]\{64\}\$?)(?:["'`])/g;

/** Sites that keep their own matcher, each with a reason a reviewer can check. */
const RECORDED_EXCEPTIONS: Record<string, string> = {
  "control_plane/agents/delivery_workspace.ts":
    "GIT_REVISION_DIGEST_PATTERN is case-insensitive (/i): a git revision may be written " +
    "in either case, so this surface is a different policy, not a stale copy.",
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

type Site = { file?: string; line: number; literal: string; flags: string };

function sitesInText(text: string): Site[] {
  const rows: Site[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(WHOLE_VALUE)) {
      rows.push({ line: index + 1, literal: match[0], flags: match.groups?.flags ?? "" });
    }
    for (const match of line.matchAll(CONSTRUCTED)) {
      rows.push({ line: index + 1, literal: `new RegExp(${match.groups?.body})`, flags: "" });
    }
  });
  return rows;
}

function wholeValueSites(): Site[] {
  const rows: Site[] = [];
  for (const file of tsFiles(PACKAGE_ROOT)) {
    if (file.endsWith(".generated.ts")) continue;
    for (const hit of sitesInText(readFileSync(join(PACKAGE_ROOT, file), "utf8"))) {
      rows.push({ ...hit, file });
    }
  }
  return rows;
}

test("the whole-value digest shape is stated once, outside recorded exceptions", () => {
  const offenders = wholeValueSites().filter(
    (row) => row.file !== OWNER_FILE && !(row.file! in RECORDED_EXCEPTIONS),
  );
  assert.deepEqual(
    offenders.map((row) => `${row.file}:${row.line} ${row.literal}`),
    [],
  );
});

test("a constructed private matcher is the same violation as a literal one", () => {
  // The bypass that made the first version of this guard unable to keep its promise:
  // a consumer re-derives the shape with `new RegExp`, behaviour is unchanged, and a
  // literal-only scan sees nothing.
  const constructed =
    'export function check(value: string): boolean {\n' +
    '  return new RegExp("^[0-9a-f]{64}$").test(value);\n' +
    '}\n';
  assert.equal(sitesInText(constructed).length, 1, "new RegExp bypass escaped the scan");

  const literal =
    "export function check(value: string): boolean {\n" +
    "  return /^[0-9a-f]{64}$/.test(value);\n" +
    "}\n";
  assert.equal(sitesInText(literal).length, 1, "literal restatement escaped the scan");

  const templated =
    "export const CHECK = (v: string) => new RegExp(`^sha256:[0-9a-f]{64}$`).test(v);\n";
  assert.equal(sitesInText(templated).length, 1, "template-literal bypass escaped the scan");

  // A case-insensitive git revision rule is a different policy and stays out of scope
  // for the ownership assertion; it is the one recorded exception.
  const caseInsensitive = 'const REVISION = /^[0-9a-f]{64}$/i;\n';
  assert.equal(sitesInText(caseInsensitive)[0]?.flags, "i");
});

test("the owner module states each envelope exactly once", () => {
  const sites = sitesInText(readFileSync(join(PACKAGE_ROOT, OWNER_FILE), "utf8"));
  assert.equal(sites.length, 2, JSON.stringify(sites));
  assert.equal(sites.filter((row) => row.literal.includes("sha256:")).length, 1);
  assert.deepEqual([...new Set(sites.map((row) => row.flags))], [""]);
});

test("a recorded exception is still the reason it was recorded", () => {
  for (const file of Object.keys(RECORDED_EXCEPTIONS)) {
    const sites = sitesInText(readFileSync(join(PACKAGE_ROOT, file), "utf8"));
    assert.ok(sites.length > 0, `${file} no longer restates the shape; drop the exception`);
    assert.ok(
      sites.every((row) => row.flags.length > 0),
      `${file} lost its per-surface flags; absorb it into the owner instead`,
    );
  }
});

test("class order cannot change a verdict", () => {
  const first = /^[a-f0-9]{64}$/;
  const second = /^[0-9a-f]{64}$/;
  for (const probe of ["b".repeat(64), "0123456789abcdef".repeat(4), "B".repeat(64), "b".repeat(63), "g".repeat(64)]) {
    assert.equal(first.test(probe), second.test(probe), probe);
    assert.equal(second.test(probe), BARE_SHA256_PATTERN.test(probe), probe);
  }
});

test("dropping the unicode flag cannot change a verdict for this pattern", () => {
  const flagged = /^[a-f0-9]{64}$/u;
  for (const probe of ["b".repeat(64), "sha256:" + "b".repeat(64), "\u{1D7CF}".repeat(64)]) {
    assert.equal(flagged.test(probe), BARE_SHA256_PATTERN.test(probe), probe);
  }
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
  assert.equal(delegationInventoryQuery({ limit: 5, cursor: hex }).cursor, hex);
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
  assert.equal(
    decodeOutboxCursor(cursor(`sha256:${hex}`), "todos").last_partition_digest,
    `sha256:${hex}`,
  );
  assert.equal(decodeOutboxCursor(cursor(null), "todos").last_partition_digest, null);
  assert.throws(() => decodeOutboxCursor(cursor(hex), "todos"), /drain cursor binding/);
});
