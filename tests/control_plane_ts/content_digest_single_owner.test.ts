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

/**
 * One lexical scope. A name maps to the declarations seen for it *before the current point in
 * document order*; a `null` init is a blocker - a parameter, an import, `let`/`var`, a second
 * declaration of the same name - and a blocker stops the search instead of falling through to an
 * outer binding, so shadowing cannot silently substitute a different value.
 */
type Binding = { init: ts.Expression | null; at: Scope };
type Scope = { parent: Scope | null; vars: Map<string, Binding[]> };

const SCOPE_OPENERS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function declare(scope: Scope, name: string, init: ts.Expression | null): void {
  const seen = scope.vars.get(name);
  if (seen === undefined) scope.vars.set(name, [{ init, at: scope }]);
  else seen.push({ init, at: scope });
}

/** The innermost binding for a name, or null when it is absent, blocked or ambiguous. */
function binding(scope: Scope, name: string): Binding | null {
  for (let current: Scope | null = scope; current !== null; current = current.parent) {
    const seen = current.vars.get(name);
    if (seen === undefined) continue;
    return seen.length === 1 ? seen[0] as Binding : null;
  }
  return null;
}

/** Names a `const` may not hold: only block-scoped `const` without a later write is foldable. */
function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  return (
    ts.isVariableDeclarationList(list) &&
    (list.flags & ts.NodeFlags.BlockScoped) !== 0 &&
    (list.flags & ts.NodeFlags.Const) !== 0
  );
}

/**
 * Every identifier written to anywhere in the file. Increment targets are deliberately absent:
 * `++`/`--` needs a mutable binding, and those are already blockers.
 */
function assignedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, collect);
  };
  (function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      collect(node.left);
    }
    ts.forEachChild(node, visit);
  })(source);
  return names;
}

/** The names a binding pattern introduces, flattened. */
function boundNames(node: ts.Node | undefined): string[] {
  if (node === undefined) return [];
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isNamespaceImport(node)) return [node.name.text];
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    // An elided element (`const [, a] = …`) carries no name, so only real bindings are collected.
    return node.elements.flatMap((element) => (ts.isBindingElement(element) ? boundNames(element.name) : []));
  }
  return [];
}

/** Fold an expression to the string it denotes, through scope-resolved const names and `+`. */
function foldStringExpression(
  expr: ts.Expression,
  scope: Scope,
  source: ts.SourceFile,
  depth = 0,
): string | null {
  if (depth > 8) return null;
  if (ts.isParenthesizedExpression(expr)) {
    return foldStringExpression(expr.expression, scope, source, depth + 1);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getText(source).slice(1, -1);
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStringExpression(expr.left, scope, source, depth + 1);
    const right = foldStringExpression(expr.right, scope, source, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isIdentifier(expr)) {
    const found = binding(scope, expr.text);
    // Absent, blocked or ambiguous all fail closed: the site becomes unfoldable and has to be
    // declared, rather than folding to whatever a same-named binding elsewhere happens to hold.
    if (found === null || found.init === null) return null;
    return foldStringExpression(found.init, found.at, source, depth + 1);
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

/**
 * True when the callee *names* the `RegExp` constructor: the bare identifier, a property
 * path ending in `RegExp` (`globalThis.RegExp`, `window.RegExp`), a string-indexed member
 * (`globalThis["RegExp"]`), or any of those wrapped in parentheses. The path is not
 * evaluated - the guard has no opinion on what object it reads - so a member named
 * `RegExp` that is really some other constructor still gets scanned, and fails closed
 * into the declared inventory. Where the model stops is stated here rather than grown
 * silently: an aliased or computed reference to the constructor is out of scope, because
 * seeing through it would mean interpreting every JavaScript expression.
 */
function namesRegExpCallee(expression: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expression)) return namesRegExpCallee(expression.expression);
  if (ts.isIdentifier(expression)) return expression.text === "RegExp";
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === "RegExp";
  return (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression) &&
    expression.argumentExpression.text === "RegExp"
  );
}

/** Every RegExp created in this source: a literal, or any construction whose callee names `RegExp`. */
function matchersInText(text: string, file: string): Matcher[] {
  const source = parse(text, file);
  const written = assignedNames(source);
  const root: Scope = { parent: null, vars: new Map() };
  const found: Matcher[] = [];

  // Imports bind names whose value lives in another module, so they are blockers at file scope.
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    for (const name of boundNames(statement.importClause?.namedBindings)) declare(root, name, null);
    const defaultName = statement.importClause?.name;
    if (defaultName !== undefined) declare(root, defaultName.text, null);
  }

  (function walk(node: ts.Node, scope: Scope): void {
    const inner =
      node.kind === ts.SyntaxKind.SourceFile || !SCOPE_OPENERS.has(node.kind)
        ? scope
        : { parent: scope, vars: new Map<string, Binding[]>() };

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const foldable = isConstDeclaration(node) && node.initializer !== undefined && !written.has(node.name.text);
      declare(inner, node.name.text, foldable ? node.initializer : null);
    } else if (ts.isVariableDeclaration(node)) {
      for (const name of boundNames(node.name)) declare(inner, name, null);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        for (const name of boundNames(parameter.name)) declare(inner, name, null);
      }
    }

    const push = (pattern: string | null, flags: string | null): void => {
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

    if (ts.isRegularExpressionLiteral(node)) {
      const raw = node.getText(source);
      const close = raw.lastIndexOf("/");
      push(raw.slice(1, close), raw.slice(close + 1));
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      namesRegExpCallee(node.expression)
    ) {
      const args = node.arguments ?? [];
      const patternArg = args[0];
      if (patternArg !== undefined) {
        const flagsArg = args[1];
        push(
          foldStringExpression(patternArg, inner, source),
          flagsArg === undefined ? "" : foldStringExpression(flagsArg, inner, source),
        );
      }
    }

    ts.forEachChild(node, (child) => walk(child, inner));
  })(source, root);
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
    [
      // The third review round's bypass: a *later* function declares a local of the same name,
      // and a file-wide name-keyed binding table lets it overwrite the digest constant, so the
      // earlier `new RegExp` folds to the wrong value. Binding is resolved through scopes.
      "same-named local in a later function",
      "function first(value: string): boolean {\n" +
        '  const PRIVATE_PATTERN = "^[0-9a-f]{64}$";\n' +
        "  return new RegExp(PRIVATE_PATTERN).test(value);\n" +
        "}\n" +
        "function second(value: string): boolean {\n" +
        '  const PRIVATE_PATTERN = "^unrelated$";\n' +
        "  return new RegExp(PRIVATE_PATTERN).test(value);\n" +
        "}\n",
    ],
    [
      "same-named local in an earlier function",
      "function first(value: string): boolean {\n" +
        '  const PRIVATE_PATTERN = "^unrelated$";\n' +
        "  return new RegExp(PRIVATE_PATTERN).test(value);\n" +
        "}\n" +
        "function second(value: string): boolean {\n" +
        '  const PRIVATE_PATTERN = "^[0-9a-f]{64}$";\n' +
        "  return new RegExp(PRIVATE_PATTERN).test(value);\n" +
        "}\n",
    ],
    [
      "digest const in a nested block, unrelated const of the same name outside it",
      'const SHAPE = "^unrelated$";\nif (true) {\n  const SHAPE = "^[0-9a-f]{64}$";\n  new RegExp(SHAPE);\n}\nnew RegExp(SHAPE);\n',
    ],
    [
      "method body with a same-named parameter",
      "class Holder {\n" +
        "  check(pattern: string): boolean {\n" +
        '    const PRIVATE = "^[0-9a-f]{64}$";\n' +
        "    return new RegExp(PRIVATE).test(pattern);\n" +
        "  }\n" +
        "}\n",
    ],
    [
      "constructed through the global object",
      'const CHECK = new globalThis.RegExp("^[0-9a-f]{64}$");\n',
    ],
    [
      "constructed through a string-indexed global member",
      'const CHECK = new globalThis["RegExp"]("^[0-9a-f]{64}$");\n',
    ],
    [
      "constructed through a parenthesised RegExp-named path",
      'const CHECK = new (globalThis.RegExp)("^[0-9a-f]{64}$");\n',
    ],
    [
      "two constant halves through a foreign RegExp-named path",
      'const HEAD = "^[0-9";\nconst TAIL = "a-f]{64}$";\nconst CHECK = new window.RegExp(HEAD + TAIL);\n',
    ],
  ];
  for (const [name, source] of bypasses) {
    const caught = matchersInText(source, "synthetic.ts").filter((site) => site.envelope !== null);
    assert.equal(caught.length, 1, `${name} escaped the scan: ${JSON.stringify(source)}`);
  }
});

test("a binding that cannot be trusted fails closed instead of folding to a neighbour's value", () => {
  // These four are not digest findings: the value is genuinely not a compile-time constant here.
  // What matters is that the site is reported as unfoldable, because an unfoldable site has to be
  // declared in the inventory - so a name that shadows, mutates or repeats cannot hide a matcher by
  // resolving to some other binding with the same spelling.
  const ambiguous: [string, string][] = [
    [
      "parameter shadows the constant",
      'const DIGEST = "^[0-9a-f]{64}$";\nfunction check(DIGEST: string): boolean {\n  return new RegExp(DIGEST).test("");\n}\n',
    ],
    [
      "mutable binding written later",
      'let DIGEST = "^[a-f0-9]{64}$";\nDIGEST = "^unrelated$";\nconst CHECK = new RegExp(DIGEST);\n',
    ],
    [
      "two declarations of one name in the same scope",
      'const DIGEST = "^[0-9a-f]{64}$";\nconst DIGEST = "^unrelated$";\nconst CHECK = new RegExp(DIGEST);\n',
    ],
    ["name bound to another module", 'import { DIGEST } from "./elsewhere.ts";\nconst CHECK = new RegExp(DIGEST);\n'],
  ];
  for (const [name, source] of ambiguous) {
    const sites = matchersInText(source, "synthetic.ts").filter((site) => site.spelling.startsWith("new RegExp"));
    assert.equal(sites.length, 1, `${name} produced ${sites.length} sites: ${JSON.stringify(source)}`);
    assert.equal(sites[0]?.pattern, null, `${name} folded to a value it cannot vouch for`);
  }
});

test("a RegExp-named callee the scan cannot evaluate still reports its site", () => {
  // The fourth review's bypass: `new globalThis.RegExp(...)` names RegExp through a
  // property access, and a scan that accepted only a bare identifier never saw the site
  // at all - no fold, no declaration, no review event. Every callee that *names* RegExp
  // now produces a site; when the pattern argument cannot be folded the site is
  // unfoldable and has to be declared, exactly like any other construction.
  const unfoldable: [string, string][] = [
    [
      "foreign RegExp-named path with a runtime pattern",
      'const CHECK = new window.RegExp(runtimeShape());\n',
    ],
    [
      "global member with an unfoldable pattern argument",
      'const CHECK = new globalThis.RegExp(runtimeShape());\n',
    ],
  ];
  for (const [name, source] of unfoldable) {
    const sites = matchersInText(source, "synthetic.ts");
    assert.equal(sites.length, 1, `${name} produced ${sites.length} sites: ${JSON.stringify(source)}`);
    assert.equal(sites[0]?.pattern, null, `${name} folded to a value its callee cannot vouch for`);
  }
});

test("the scan's boundary: callees that do not name RegExp are outside its model", () => {
  // Stated as a contract so it can neither silently widen nor silently shrink. Seeing
  // through an aliased constructor, a computed member key or Reflect.construct would
  // mean interpreting every JavaScript expression, which the fourth review explicitly
  // set out of scope - so these spellings are the honest edge of the gate, recorded
  // here and in the body rather than left implied (the same class of recorded limit as
  // the no-RegExp verdict in the mutation battery).
  const outOfModel: [string, string][] = [
    ["constructor bound to an alias", 'const ALIAS = RegExp;\nconst CHECK = new ALIAS("^[0-9a-f]{64}$");\n'],
    ["member keyed by a computed name", 'const KEY = "RegExp";\nconst CHECK = new globalThis[KEY]("^[0-9a-f]{64}$");\n'],
    ["constructor invoked reflectively", 'const CHECK = Reflect.construct(RegExp, ["^[0-9a-f]{64}$"]);\n'],
  ];
  for (const [name, source] of outOfModel) {
    const sites = matchersInText(source, "synthetic.ts");
    assert.deepEqual(sites.map(describe), [], `${name} was unexpectedly scanned`);
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
