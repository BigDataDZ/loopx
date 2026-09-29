import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

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
const CANONICAL_EXPORTS = ["BARE_SHA256_PATTERN", "ENVELOPED_SHA256_PATTERN"];
const HEX_CHARS = [..."0123456789abcdef"];

/**
 * A construction whose pattern cannot be folded to a value still shows its character
 * class in source, so it is caught by sight rather than by value.
 */
const VISIBLE_HEX64_CLASS = /\[[0-9a-f-]{6}\]\{64\}/;

type Envelope = "bare" | "enveloped" | "union";

/** One RegExp created in source, however it was spelled or assembled. */
type Matcher = {
  file: string;
  line: number;
  spelling: string;
  /** Null when the flags expression could not be folded to a value. */
  flags: string | null;
  /** Null when the pattern expression could not be folded to a value. */
  pattern: string | null;
  envelope: Envelope | "unresolved-visible" | null;
};

/** Sites that keep their own matcher, each with a reason a reviewer can check. */
const RECORDED_EXCEPTIONS: Record<string, string> = {
  "control_plane/agents/delivery_workspace.ts":
    "GIT_REVISION_DIGEST_PATTERN is case-insensitive (/i): a git revision may be written " +
    "in either case, so this surface is a different policy, not a stale copy.",
};

/**
 * Constructions whose pattern is assembled from runtime values. None of them can be
 * folded here, so each is named with the shape it answers; a new one has to be declared,
 * and a digest restatement cannot hide in this bucket (the last assertion below proves it).
 */
const DECLARED_UNFOLDABLE: Record<string, { count: number; reason: string }> = {
  "control_plane/coordination/authority_format_inspection.ts": {
    count: 1,
    reason: "store identity binds a provider name at runtime; 32 hex, not a 64 digest",
  },
  "control_plane/coordination/local_authority_migration.ts": {
    count: 2,
    reason: "store identity per provider arm; 32 hex, not a 64 digest",
  },
  "control_plane/coordination/local_authority_provider.ts": {
    count: 2,
    reason: "store identity selector; 32 hex, not a 64 digest",
  },
  "control_plane/coordination/todo_agents.ts": {
    count: 2,
    reason: "whitespace class assembled from a shared character-class constant",
  },
  "control_plane/quota/monitor_poll_commit.ts": {
    count: 1,
    reason: "artifact file name grammar keyed by a runtime effect token",
  },
  "control_plane/todos/priority.ts": {
    count: 2,
    reason: "legacy patterns are carried by the contract record, not by this module",
  },
};

/** Every module that reads the owner, pinned so that dropping an import is loud. */
const CANONICAL_CONSUMERS = [
  "control_plane/agents/supervisor_event_append.ts",
  "control_plane/capabilities/external_evidence.ts",
  "control_plane/collaboration/delegation.ts",
  "control_plane/collaboration/return_delivery.ts",
  "control_plane/collaboration/semantic_request.ts",
  "control_plane/coordination/authority_archive_read.ts",
  "control_plane/coordination/authority_source.ts",
  "control_plane/coordination/local_authority_migration.ts",
  "control_plane/coordination/local_authority_shadow.ts",
  "control_plane/coordination/local_authority_shadow_outbox.ts",
  "control_plane/coordination/reviewed_promotion_plan.ts",
  "control_plane/coordination/runtime_shadow.ts",
  "control_plane/coordination/shadow_drain_files.ts",
  "control_plane/coordination/shadow_entry_delivery.ts",
  "control_plane/coordination/shadow_management.ts",
  "control_plane/coordination/shadow_registry_source.ts",
  "control_plane/coordination/source_transfer.ts",
  "control_plane/coordination/sqlite_authority_store.ts",
  "control_plane/coordination/todo_terminal_lifecycle.ts",
  "control_plane/coordination/todo_update_intent.ts",
  "control_plane/effect_runtime_snapshot.ts",
  "control_plane/goals/acceptance_authority.ts",
  "control_plane/goals/acceptance_contract.ts",
  "control_plane/goals/goal_amendment_proposal.ts",
  "control_plane/goals/operator_actions.ts",
  "control_plane/goals/shared_goal_alignment.ts",
  "control_plane/goals/source_session_lifetime.ts",
  "control_plane/governed_capability.ts",
  "control_plane/quota/refresh_external_delivery.ts",
  "control_plane/runtime/usage_statistics_cycles.ts",
  "control_plane/runtime/usage_statistics_goal_contract.ts",
  "control_plane/runtime/usage_statistics_goals.ts",
  "control_plane/todos/completion_transaction.ts",
  "control_plane/todos/completion_validation_revision.ts",
  "control_plane/turn_driver/chat_turn_acceptance.ts",
  "control_plane/work_items/pending_capability_intent.ts",
  "control_plane/work_items/replan_history_snapshot.ts",
  "control_plane/work_items/task_lease_acquire.ts",
  "control_plane/work_items/task_lease_lifecycle.ts",
  "control_plane/work_items/task_lease_lifecycle_request.ts",
];

function packageFiles(dir: string, base = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...packageFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".generated.ts")) found.push(rel);
  }
  return found.sort();
}

/** The set a character class admits, so `[0-9a-f]` and `[a-f0-9]` compare equal. */
function charClassMembers(body: string): string[] {
  const chars = new Set<string>();
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char === "\\") {
      index += 1;
      continue;
    }
    const limit = body[index + 2];
    if (body[index + 1] === "-" && limit !== undefined) {
      for (let code = char.charCodeAt(0); code <= limit.charCodeAt(0); code += 1) {
        chars.add(String.fromCharCode(code));
      }
      index += 2;
      continue;
    }
    chars.add(char);
  }
  return [...chars].sort();
}

/** Which whole-value digest verdict this pattern source states, if any. */
function digestEnvelope(pattern: string): Envelope | null {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return null;
  let body = pattern.slice(1, -1);
  let envelope: Envelope = "bare";
  const prefixes: [string, Envelope][] = [
    ["(?:sha256:)?", "union"],
    ["(sha256:)?", "union"],
    ["(?:sha256:)", "enveloped"],
    ["(sha256:)", "enveloped"],
    ["sha256:", "enveloped"],
  ];
  for (const [spelling, kind] of prefixes) {
    if (body.startsWith(spelling)) {
      envelope = kind;
      body = body.slice(spelling.length);
      break;
    }
  }
  const classOnly = /^\[([^\]]*)\]\{64\}$/.exec(body);
  if (classOnly === null) return null;
  if (charClassMembers(classOnly[1] as string).join("") !== HEX_CHARS.join("")) return null;
  return envelope;
}

/** Fold an expression to the string it denotes, across `+`, const names and quoting. */
function foldStringExpression(
  expr: ts.Expression,
  bindings: Map<string, ts.Expression>,
  source: ts.SourceFile,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  if (ts.isParenthesizedExpression(expr)) {
    return foldStringExpression(expr.expression, bindings, source, depth + 1);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getText(source).slice(1, -1);
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStringExpression(expr.left, bindings, source, depth + 1);
    const right = foldStringExpression(expr.right, bindings, source, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(expr)) {
    const bound = bindings.get(expr.text);
    return bound === undefined ? null : foldStringExpression(bound, bindings, source, depth + 1);
  }
  return null;
}

function parse(text: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function nameUsage(source: ts.SourceFile, localName: string): number {
  let uses = 0;
  (function visit(node: ts.Node): void {
    // A reference inside the import clause is the declaration itself, not a use.
    if (ts.isIdentifier(node) && node.text === localName && !isImportSpecifier(node)) uses += 1;
    ts.forEachChild(node, visit);
  })(source);
  return uses;
}

function isImportSpecifier(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.kind !== ts.SyntaxKind.SourceFile) {
    if (ts.isImportSpecifier(current) || ts.isImportClause(current)) return true;
    current = current.parent;
  }
  return false;
}

/** Every RegExp created in this source: literal, `new RegExp(...)` or `RegExp(...)`. */
function matchersInText(text: string, file: string): Matcher[] {
  const source = parse(text, file);
  const bindings = new Map<string, ts.Expression>();
  (function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  })(source);

  const found: Matcher[] = [];
  const push = (node: ts.Node, pattern: string | null, flags: string | null): void => {
    const spelling = node.getText(source).replace(/\s+/g, " ");
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      spelling,
      flags,
      pattern,
      envelope: pattern !== null ? digestEnvelope(pattern) : VISIBLE_HEX64_CLASS.test(spelling) ? "unresolved-visible" : null,
    });
  };

  (function visit(node: ts.Node): void {
    if (ts.isRegularExpressionLiteral(node)) {
      const raw = node.getText(source);
      const close = raw.lastIndexOf("/");
      push(node, raw.slice(1, close), raw.slice(close + 1));
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      const args = node.arguments ?? [];
      const patternArg = args[0];
      if (patternArg !== undefined) {
        const flagsArg = args[1];
        push(
          node,
          foldStringExpression(patternArg, bindings, source),
          flagsArg === undefined ? "" : foldStringExpression(flagsArg, bindings, source),
        );
      }
    }
    ts.forEachChild(node, visit);
  })(source);
  return found;
}

function importersInText(text: string, file: string): string[] {
  const names: string[] = [];
  for (const statement of parse(text, file).statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier) continue;
    const specifier = statement.moduleSpecifier.getText().slice(1, -1);
    if (!specifier.endsWith("content_digest.ts")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.push(element.name.text);
  }
  return names;
}

let packageCache: { file: string; text: string }[] | null = null;

function packageSources(): { file: string; text: string }[] {
  if (packageCache === null) {
    packageCache = packageFiles(PACKAGE_ROOT).map((file) => ({
      file,
      text: readFileSync(join(PACKAGE_ROOT, file), "utf8"),
    }));
  }
  return packageCache;
}

function packageMatchers(): Matcher[] {
  return packageSources().flatMap(({ file, text }) => matchersInText(text, file));
}

function describe(site: Matcher): string {
  return `${site.file}:${site.line} ${site.spelling.slice(0, 60)}`;
}

test("the whole-value digest shape is stated once, outside recorded exceptions", () => {
  const offenders = packageMatchers().filter(
    (site) =>
      site.envelope !== null &&
      site.file !== OWNER_FILE &&
      !(site.file in RECORDED_EXCEPTIONS),
  );
  assert.deepEqual(offenders.map(describe), []);
});

test("restating the shape is the same violation in every spelling", () => {
  // The bypass that made the first two versions of this guard unable to keep their
  // promise: a consumer re-derives the shape without writing it as one literal, so
  // behaviour is unchanged and a source-text scan sees nothing. The model here is the
  // folded pattern value, so the spelling no longer decides the verdict.
  const bypasses: [string, string][] = [
    ["regex literal", "const CHECK = /^[0-9a-f]{64}$/;\n"],
    [
      "constructed from a string",
      'export function check(value: string): boolean {\n  return new RegExp("^[0-9a-f]{64}$").test(value);\n}\n',
    ],
    ["single-quoted construction", "const CHECK = new RegExp('^[a-f0-9]{64}$');\n"],
    ["template construction", "const CHECK = new RegExp(`^sha256:[0-9a-f]{64}$`);\n"],
    [
      "two constant halves",
      'const HEAD = "^[0-9";\nconst TAIL = "a-f]{64}$";\nconst CHECK = new RegExp(HEAD + TAIL);\n',
    ],
    [
      "identifier holding the whole pattern",
      'const BODY = "^[0-9a-f]{64}$";\nconst CHECK = new RegExp(BODY);\n',
    ],
    [
      "parenthesised halves in a call",
      'const CHECK = new RegExp(("^" + "[0-9a-f]" + "{64}$"));\n',
    ],
    [
      "local const inside a function",
      "function check(value: string): boolean {\n  const local = /^[a-f0-9]{64}$/u;\n  return local.test(value);\n}\n",
    ],
    ["flags assembled from a constant", 'const FLAGS = "u";\nconst CHECK = new RegExp("^[0-9a-f]{64}$", FLAGS);\n'],
    ["union envelope restated", "const CHECK = /^(?:sha256:)?[0-9a-f]{64}$/;\n"],
    [
      "pattern a call cannot fold, but its class is visible",
      'const CHECK = new RegExp(compile("^[0-9a-f]{64}$"));\n',
    ],
  ];
  for (const [name, source] of bypasses) {
    const caught = matchersInText(source, "synthetic.ts").filter((site) => site.envelope !== null);
    assert.equal(caught.length, 1, `${name} escaped the scan: ${JSON.stringify(source)}`);
  }
});

test("a matcher that answers a different question is not a restatement", () => {
  // Widening this net would turn the guard into a rule against hex64 anywhere. These
  // are the grammars the PR deliberately leaves with their own owners.
  const outOfScope: [string, string][] = [
    ["entry id inside a larger grammar", "const ENTRY = /^local-shadow-tx-[0-9a-f]{64}$/;\n"],
    ["compound drain cursor", "const CURSOR = /^1:[0-9a-f]{64}:[0-9a-f]{64}$/;\n"],
    ["file name suffix", 'const FILE = new RegExp("^prq_[0-9a-f]{64}\\\\.json$");\n'],
    ["git oid alternation", "const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;\n"],
    ["unanchored search", "const SEARCH = /[0-9a-f]{64}/;\n"],
    ["accepts uppercase, so a different policy", "const UPPER = /^[0-9a-fA-F]{64}$/;\n"],
    ["shorter digest", "const ID = /^[0-9a-f]{32}$/;\n"],
  ];
  for (const [name, source] of outOfScope) {
    const caught = matchersInText(source, "synthetic.ts").filter((site) => site.envelope !== null);
    assert.deepEqual(caught.map(describe), [], `${name} was wrongly counted as a restatement`);
  }
});

test("the owner module states each envelope exactly once", () => {
  const sites = matchersInText(readFileSync(join(PACKAGE_ROOT, OWNER_FILE), "utf8"), OWNER_FILE);
  assert.deepEqual(
    sites.map((site) => site.envelope),
    ["enveloped", "bare"],
    JSON.stringify(sites.map(describe)),
  );
  assert.deepEqual([...new Set(sites.map((site) => site.flags))], [""], "the owner carries a stray flag");
});

test("a recorded exception is still the reason it was recorded", () => {
  for (const file of Object.keys(RECORDED_EXCEPTIONS)) {
    const sites = packageMatchers().filter((site) => site.file === file && site.envelope !== null);
    assert.ok(sites.length > 0, `${file} no longer restates the shape; drop the exception`);
    assert.ok(
      sites.every((site) => site.flags !== null && site.flags.length > 0),
      `${file} lost its per-surface flags; absorb it into the owner instead`,
    );
  }
});

test("the owner's consumers are the pinned set, each reading a canonical export", () => {
  const read = packageSources()
    .filter(({ file }) => file !== OWNER_FILE)
    .filter(({ file, text }) => importersInText(text, file).length > 0)
    .map(({ file, text }) => ({ file, names: importersInText(text, file) }));

  assert.deepEqual(
    read.map((row) => row.file),
    [...CANONICAL_CONSUMERS].sort(),
    "the set of modules reading the owner changed; a new consumer is a review event",
  );

  const source = new Map(packageSources().map(({ file, text }) => [file, text]));
  for (const row of read) {
    const parsed = parse(source.get(row.file) as string, row.file);
    for (const localName of row.names) {
      assert.ok(
        nameUsage(parsed, localName) > 0,
        `${row.file} imports ${localName} but never uses it, so it validates with something else`,
      );
    }
  }
});

test("an import of the owner can only name a canonical export", () => {
  for (const { file, text } of packageSources()) {
    for (const statement of parse(text, file).statements) {
      if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier) continue;
      if (!statement.moduleSpecifier.getText().slice(1, -1).endsWith("content_digest.ts")) continue;
      const bindings = statement.importClause?.namedBindings;
      assert.ok(bindings !== undefined && ts.isNamedImports(bindings), `${file} uses a default or namespace import`);
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).getText();
        assert.ok(
          CANONICAL_EXPORTS.includes(imported),
          `${file} imports ${imported} from the owner, which does not export it`,
        );
      }
    }
  }
});

test("every unfoldable construction is declared, and none of them hides a digest", () => {
  const derived = new Map<string, number>();
  for (const site of packageMatchers()) {
    if (site.pattern !== null) continue;
    derived.set(site.file, (derived.get(site.file) ?? 0) + 1);
    if (site.envelope === "unresolved-visible") {
      assert.fail(`${describe(site)} states a 64-hex class the scan can see; it is a restatement`);
    }
  }
  assert.deepEqual(
    [...derived.entries()].sort(),
    Object.entries(DECLARED_UNFOLDABLE)
      .map(([file, record]) => [file, record.count])
      .sort(),
    "a RegExp whose pattern cannot be folded must be declared with the shape it answers",
  );
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
