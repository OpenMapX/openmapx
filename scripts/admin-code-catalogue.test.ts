import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_GROUPS,
  DESTRUCTIVE_AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES as WEB_AUDIT_TARGET_TYPES,
} from "../apps/web/src/components/admin/activity/auditCatalog";
import {
  JOB_ACTOR_LABELS,
  jobActorKey,
} from "../apps/web/src/components/admin/activity/jobActorCatalog";
import { ADMIN_REAUTH_PURPOSES } from "../packages/core/src/api/contracts/account-admin/reauth";
import {
  AUDIT_ACTION_NAMES,
  AUDIT_ACTION_PATTERN,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
} from "../packages/core/src/api/contracts/service-admin/audit-actions";
import { ADMIN_JOB_TYPES } from "../packages/core/src/jobs/vocabulary";
import { dataExecutionInputSchema } from "../packages/core/src/services/data-manager/contracts/executions";
import de from "../packages/i18n/locales/de.json";
import en from "../packages/i18n/locales/en.json";

/**
 * The admin area words server codes (job types, transit stages, actor labels,
 * audit actions, audit target types) through catalogues keyed by the code.
 * These tests collect the codes
 * from the code that writes them and fail when the catalogue misses one or
 * keeps one nothing writes, so a new job type or audit action cannot reach
 * the screen as a raw English code.
 */

const root = resolve(import.meta.dirname, "..");
const apiRoot = join(root, "apps/api/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

const apiSources = sourceFiles(apiRoot).map((path) => ({
  path: relative(root, path),
  text: readFileSync(path, "utf8"),
}));

function apiSource(path: string): string {
  const source = apiSources.find((file) => file.path === path);
  if (!source) throw new Error(`${path} is gone; update the code collector in this test`);
  return source.text;
}

/** The first capture group of every match of a global `pattern`. */
function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map(([whole, group]) => {
    if (group === undefined) throw new Error(`${pattern} matched ${whole} without a capture`);
    return group;
  });
}

const literals = (text: string) => captures(text, /"([^"\n]+)"/g);

/** The first capture group of `pattern` in `text`; throws when it does not match. */
function required(text: string, pattern: RegExp, what: string): string {
  const group = text.match(pattern)?.[1];
  if (group === undefined)
    throw new Error(`${what} not found; update the code collector in this test`);
  return group;
}

/** Literal values of a zod schema's discriminator, through unions and objects. */
function zodLiterals(schema: unknown, property: string): string[] {
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) return [];
  if (def.type === "union")
    return (def.options as unknown[]).flatMap((option) => zodLiterals(option, property));
  if (def.type === "object") {
    const value = (def.shape as Record<string, unknown>)[property];
    const valueDef = (value as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (valueDef?.type === "literal") return (valueDef.values as string[]).map(String);
    if (valueDef?.type === "enum") return Object.values(valueDef.entries as Record<string, string>);
    return [];
  }
  if (def.type === "pipe") return zodLiterals(def.in, property);
  return [];
}

/** The job runner's `register` and `enqueue` take only these types. */
const applicationJobTypes = (): string[] => [...ADMIN_JOB_TYPES].sort();

const dataManagerKinds = () => [...new Set(zodLiterals(dataExecutionInputSchema, "kind"))].sort();

interface SourceFile {
  path: string;
  text: string;
}

/**
 * Collects the codes the API writes into one audit property (`action` or
 * `targetType`) by reading every audit writer in the sources:
 * `writeAuditLog({…})` (bare or namespace-qualified),
 * `.insert(adminAuditLog).values({…})` (the table bare or qualified) and a
 * private property the file assigns `writeAuditLog` to.
 *
 * A value is read when it is a string literal, a conditional between readable
 * values, a `const` with a readable initializer, or a parameter of a function
 * or private method in the same file, read at every call of it. Anything else
 * must be explained in `derived`, keyed by file and expression. A writer the
 * collector cannot read (an entry that is not an object literal, a spread
 * that may set the property, the writer or table imported under another name
 * or passed as a value, a wrapper other files can call, the table in any call
 * but an insert or a read, raw SQL that inserts audit rows or sets their
 * action or target type, an unexplained expression) is reported in
 * `unreadable` rather than skipped.
 */
function collectAuditCodes(
  files: readonly SourceFile[],
  property: "action" | "targetType",
  derived: Record<string, (file: string) => string[]>,
): { codes: string[]; unreadable: string[]; unusedDerivations: string[] } {
  const codes = new Set<string>();
  const unreadable: string[] = [];
  const usedDerivations = new Set<string>();
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const where = (node: ts.Node) =>
      `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const flat = (node: ts.Node) => node.getText().replace(/\s+/g, " ");
    const writerMethods = new Set<string>();
    const entries: ts.Expression[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === WRITER) readWriterReference(node);
      if (isTableReference(node)) readTableReference(node);
      const text = literalText(node);
      if (text !== undefined && writesAuditCodesInSql(text))
        unreadable.push(`${where(node)} raw SQL writing ${property}s: ${flat(node)}`);
      ts.forEachChild(node, visit);
    };

    function readWriterReference(node: ts.Identifier) {
      const parent = node.parent;
      if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
        if (parent.propertyName === node && parent.name.text !== WRITER)
          unreadable.push(`${where(node)} ${WRITER} under another name: ${flat(parent)}`);
        return;
      }
      if (
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        ts.isTypeQueryNode(parent) ||
        ts.isQualifiedName(parent)
      )
        return;
      const callee = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
      if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee) {
        entries.push(callee.parent.arguments[0] ?? callee.parent);
        return;
      }
      const assigned = assignedThisProperty(node);
      if (assigned && privateClassMember(node, assigned)) writerMethods.add(assigned);
      else if (assigned)
        unreadable.push(`${where(node)} ${WRITER} held by the non-private this.${assigned}`);
      else unreadable.push(`${where(node)} ${WRITER} used as a value: ${flat(parent)}`);
    }

    function readTableReference(table: ts.Expression) {
      const parent = table.parent;
      if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) {
        if (parent.propertyName === table && parent.name.text !== TABLE)
          unreadable.push(`${where(table)} ${TABLE} under another name: ${flat(parent)}`);
        return;
      }
      if (
        (ts.isVariableDeclaration(parent) && parent.name === table) ||
        ts.isQualifiedName(parent) ||
        ts.isTypeQueryNode(parent) ||
        (ts.isPropertyAccessExpression(parent) && parent.expression === table)
      )
        return;
      const method =
        ts.isCallExpression(parent) &&
        parent.arguments.includes(table) &&
        ts.isPropertyAccessExpression(parent.expression)
          ? parent.expression.name.text
          : undefined;
      if (method && TABLE_READS.has(method)) return;
      if (method !== "insert" || !ts.isCallExpression(parent)) {
        unreadable.push(`${where(table)} ${TABLE} used where no writer is read: ${flat(parent)}`);
        return;
      }
      const values = parent.parent;
      const call = values.parent;
      if (
        ts.isPropertyAccessExpression(values) &&
        values.name.text === "values" &&
        ts.isCallExpression(call) &&
        call.expression === values
      )
        entries.push(call.arguments[0] ?? call);
      else unreadable.push(`${where(parent)} audit insert without .values(…): ${flat(parent)}`);
    }
    visit(source);
    const methodCalls = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        writerMethods.has(node.expression.name.text)
      )
        entries.push(node.arguments[0] ?? node);
      ts.forEachChild(node, methodCalls);
    };
    methodCalls(source);

    const read = (expression: ts.Expression, seen: ReadonlySet<ts.Node>): void => {
      const key = `${path} ${flat(expression)}`;
      const expand = derived[key];
      if (expand) {
        usedDerivations.add(key);
        for (const code of expand(text)) codes.add(code);
        return;
      }
      const inner = unwrap(expression);
      if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
        codes.add(inner.text);
        return;
      }
      if (ts.isConditionalExpression(inner)) {
        read(inner.whenTrue, seen);
        read(inner.whenFalse, seen);
        return;
      }
      if (ts.isIdentifier(inner) && !seen.has(inner)) {
        const next = new Set([...seen, inner]);
        const binding = resolveBinding(inner);
        if (binding?.kind === "const") {
          read(binding.initializer, next);
          return;
        }
        if (binding?.kind === "parameter") {
          const calls = callsOf(source, binding.fn);
          if (calls) {
            for (const call of calls) {
              const argument = call.arguments[binding.index];
              if (argument) read(argument, next);
              else unreadable.push(`${where(call)} call without the ${property} argument`);
            }
            return;
          }
        }
      }
      unreadable.push(`${where(expression)} ${path} ${flat(expression)}`);
    };

    for (const entry of entries) {
      const object = unwrap(entry);
      if (ts.isArrayLiteralExpression(object)) {
        for (const element of object.elements) readEntry(element);
      } else readEntry(object);
    }

    function readEntry(entry: ts.Expression) {
      const object = unwrap(entry);
      if (!ts.isObjectLiteralExpression(object)) {
        unreadable.push(`${where(entry)} audit entry is not an object literal: ${flat(entry)}`);
        return;
      }
      let value: ts.Expression | undefined;
      let spreadAfter = false;
      for (const member of object.properties) {
        const entryCall =
          ts.isSpreadAssignment(member) &&
          ts.isCallExpression(member.expression) &&
          ts.isIdentifier(member.expression.expression) &&
          member.expression.expression.text === ENTRY_HELPER
            ? member.expression
            : undefined;
        if (entryCall) {
          // `...auditEntry(action)` sets the action and the target type the
          // registry gives it.
          spreadAfter = false;
          value = entryCall.arguments[0];
        } else if (ts.isSpreadAssignment(member)) spreadAfter = true;
        else if (member.name && ts.isIdentifier(member.name) && member.name.text === property) {
          spreadAfter = false;
          if (ts.isPropertyAssignment(member)) value = member.initializer;
          else if (ts.isShorthandPropertyAssignment(member)) value = member.name;
          else value = undefined;
        }
      }
      if (spreadAfter) {
        unreadable.push(`${where(object)} a spread may set ${property}: ${flat(object)}`);
        return;
      }
      if (value) read(value, new Set());
      else if (property === "action")
        unreadable.push(`${where(object)} audit entry without an action: ${flat(object)}`);
    }
  }
  return {
    codes: [...codes].sort(),
    unreadable,
    unusedDerivations: Object.keys(derived).filter((key) => !usedDerivations.has(key)),
  };
}

const WRITER = "writeAuditLog";
const TABLE = "adminAuditLog";
const ENTRY_HELPER = "auditEntry";
/** Query-builder calls that take the audit table without writing a row. */
const TABLE_READS = new Set(["from", "delete", "leftJoin", "innerJoin", "rightJoin", "fullJoin"]);

/** `adminAuditLog`, `schema.adminAuditLog` or `schema["adminAuditLog"]`. */
function isTableReference(node: ts.Node): node is ts.Expression {
  if (ts.isIdentifier(node))
    return (
      node.text === TABLE &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    );
  if (ts.isPropertyAccessExpression(node)) return node.name.text === TABLE;
  return (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === TABLE
  );
}

/** The fixed text of a string or template literal, its substitutions left out. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ");
  return undefined;
}

/** The audit table in SQL, optionally schema-qualified and quoted. */
const AUDIT_TABLE_SQL = String.raw`(?:"?\w+"?\s*\.\s*)?"?admin_audit_log\b"?`;
const AUDIT_INSERT_SQL = new RegExp(String.raw`\binsert\s+into\s+${AUDIT_TABLE_SQL}`, "i");
// The table may carry an alias, with or without AS; the SET clause ends at the
// first FROM, WHERE or RETURNING.
const AUDIT_UPDATE_SQL = new RegExp(
  String.raw`\bupdate\s+(?:only\s+)?${AUDIT_TABLE_SQL}(?:\s+(?:as\s+)?(?!set\b)"?\w+"?)?\s+set\b([\s\S]*?)(?:\b(?:from|where|returning)\b|$)`,
  "i",
);
const AUDIT_CODE_COLUMN = /^\s*"?(?:action|target_type)"?\s*$/i;

/** Raw SQL that inserts audit rows or sets their action or target type. */
function writesAuditCodesInSql(text: string): boolean {
  if (AUDIT_INSERT_SQL.test(text)) return true;
  const assignments = AUDIT_UPDATE_SQL.exec(text)?.[1];
  if (assignments === undefined) return false;
  if (/\b(?:action|target_type)"?\s*=/i.test(assignments)) return true;
  // `SET (column, …) = (…)` assigns a whole column list at once.
  return [...assignments.matchAll(/\(([^()]*)\)\s*=/g)].some(([, columns = ""]) =>
    columns.split(",").some((column) => AUDIT_CODE_COLUMN.test(column)),
  );
}

const isPrivate = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) ===
    true;

/** Whether the class around `node` declares `name` private, so only its own code can call it. */
function privateClassMember(node: ts.Node, name: string): boolean {
  if (name.startsWith("#")) return true;
  let owner = node.parent;
  while (owner && !ts.isClassLike(owner)) owner = owner.parent;
  return (
    owner?.members.some((member) => member.name?.getText() === name && isPrivate(member)) ?? false
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

/** `this.<name> = … writeAuditLog …`: the method name the file calls the writer by. */
function assignedThisProperty(node: ts.Node): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isFunctionLike(current) || ts.isSourceFile(current))
      return undefined;
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(current.left) &&
      current.left.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      return current.left.name.text;
  }
  return undefined;
}

type Binding =
  | { kind: "const"; initializer: ts.Expression }
  | { kind: "parameter"; fn: ts.FunctionLikeDeclaration; index: number };

/**
 * The `const` or parameter an identifier refers to, by lexical scope. Any
 * other nearest declaration (`let`, a loop variable, a destructured name)
 * resolves to nothing, so the value counts as unreadable.
 */
function resolveBinding(identifier: ts.Identifier): Binding | undefined {
  const declares = (list: ts.VariableDeclarationList) =>
    list.declarations.find((declaration) =>
      declarationNames(declaration.name).has(identifier.text),
    );
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && "body" in scope) {
      const index = scope.parameters.findIndex((parameter) =>
        declarationNames(parameter.name).has(identifier.text),
      );
      const parameter = scope.parameters[index];
      if (parameter)
        return ts.isIdentifier(parameter.name)
          ? { kind: "parameter", fn: scope, index }
          : undefined;
    }
    if (
      (ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      declares(scope.initializer)
    )
      return undefined;
    if (ts.isBlock(scope) || ts.isSourceFile(scope))
      for (const statement of scope.statements) {
        if (statement.pos > identifier.pos || !ts.isVariableStatement(statement)) continue;
        const declaration = declares(statement.declarationList);
        if (!declaration) continue;
        return statement.declarationList.flags & ts.NodeFlags.Const &&
          ts.isIdentifier(declaration.name) &&
          declaration.initializer
          ? { kind: "const", initializer: declaration.initializer }
          : undefined;
      }
  }
  return undefined;
}

function declarationNames(name: ts.BindingName): Set<string> {
  if (ts.isIdentifier(name)) return new Set([name.text]);
  const names = new Set<string>();
  for (const element of name.elements)
    if (!ts.isOmittedExpression(element))
      for (const inner of declarationNames(element.name)) names.add(inner);
  return names;
}

/**
 * Every call of a function or private method declared in this file, or
 * `undefined` when it is exported, a method other code can reach, or
 * referenced other than by a direct call, so its callers cannot all be seen
 * here.
 */
function callsOf(
  source: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
): ts.CallExpression[] | undefined {
  let name: string | undefined;
  if (ts.isMethodDeclaration(fn)) {
    if (!ts.isPrivateIdentifier(fn.name) && !isPrivate(fn)) return undefined;
    name = fn.name.getText();
  } else if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name.text;
  else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
    name = fn.parent.name.text;
  if (!name) return undefined;
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (exported(fn) || (ts.isVariableDeclaration(fn.parent) && exported(fn.parent.parent.parent)))
    return undefined;
  const calls: ts.CallExpression[] = [];
  let escaped = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) &&
      node.text === name &&
      node !== fn.name
    ) {
      const callee =
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        node.parent.expression.kind === ts.SyntaxKind.ThisKeyword
          ? node.parent
          : node;
      const call = callee.parent;
      if (ts.isCallExpression(call) && call.expression === callee) calls.push(call);
      else if (!(ts.isVariableDeclaration(node.parent) && node.parent.name === node))
        escaped = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return escaped ? undefined : calls;
}

/**
 * Audit actions built from a template or a variable the collector cannot
 * follow, expanded from the code that bounds their values. A new writer of
 * that kind fails the test until it is described here.
 */
/** The values of an `as const` object literal assigned to `name` in `file`. */
function lookupValues(file: string, name: string): string[] {
  return literals(required(file, new RegExp(`const ${name} = \\{([^}]+)\\}`), name));
}

const DERIVED_ACTIONS: Record<string, (file: string) => string[]> = {
  "apps/api/src/routes/admin-services.ts SERVICE_ACTION_AUDIT[action]": (file) =>
    lookupValues(file, "SERVICE_ACTION_AUDIT"),
  "apps/api/src/routes/ambient-places.ts audited[action]": (file) => lookupValues(file, "audited"),
  "apps/api/src/account/account-provisioning.ts ASSISTED_ACTION_AUDIT[input.action]": (file) =>
    lookupValues(file, "ASSISTED_ACTION_AUDIT"),
  "apps/api/src/utils/auth-audit-hook.ts route.action": (file) =>
    captures(file, /\baction: "([^"]+)"/g),
  // The writer itself stores whatever its callers pass.
  "apps/api/src/utils/audit-log.ts action": () => [],
};

/**
 * Audit actions registered, grouped and worded before the API writes them,
 * because registering one changes the database baseline. An entry must go
 * once its writer exists.
 */
const AUDIT_ACTIONS_AHEAD_OF_THEIR_WRITER = ["attention.acknowledge"];

function auditActions(): string[] {
  const { codes, unreadable, unusedDerivations } = collectAuditCodes(
    apiSources,
    "action",
    DERIVED_ACTIONS,
  );
  expect(unreadable, "audit writers this test cannot read").toEqual([]);
  expect(unusedDerivations, "derivations no audit writer uses").toEqual([]);
  expect(
    AUDIT_ACTIONS_AHEAD_OF_THEIR_WRITER.filter((action) => codes.includes(action)),
    "audit actions listed as ahead of their writer that the API now writes",
  ).toEqual([]);
  return sorted([...codes, ...AUDIT_ACTIONS_AHEAD_OF_THEIR_WRITER]);
}

/** Catalogue keys cannot hold `.` or `-`; the label helpers read `_` instead. */
const catalogueKey = (code: string) => code.replace(/[.:-]/g, "_");
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

function selectBranches(message: string): string[] {
  const body = required(message, /^\{\w+, select,(.*)\}$/s, "select message");
  let depth = 0;
  const keys: string[] = [];
  let token = "";
  for (const char of body) {
    if (char === "{") {
      if (depth === 0) keys.push(token.trim());
      depth++;
      token = "";
    } else if (char === "}") depth--;
    else if (depth === 0) token += char;
  }
  return keys.filter((key) => key !== "other");
}

describe("admin job type catalogue", () => {
  it("collects the job types from the API and data-manager", () => {
    expect(applicationJobTypes()).toEqual(
      expect.arrayContaining(["data.operation.run", "integration.reload", "configuration.apply"]),
    );
    expect(dataManagerKinds()).toEqual(
      expect.arrayContaining(["transit-sync", "download-osm", "catalog.validate"]),
    );
  });

  it("words every job type the API and data-manager create, and nothing else", () => {
    const expected = sorted([...applicationJobTypes(), ...dataManagerKinds()].map(catalogueKey));
    expect(sorted(Object.keys(en.adminShared.jobTypes))).toEqual(expected);
    expect(sorted(Object.keys(de.adminShared.jobTypes))).toEqual(expected);
  });

  it("words every transit pipeline stage, and nothing else", () => {
    const schema = readFileSync(join(root, "packages/db-schema/src/data-manager.ts"), "utf8");
    const stages = literals(
      required(schema, /export const JOB_STAGE_NAMES = \[([^\]]+)\]/, "stage names"),
    );
    expect(stages).toEqual(expect.arrayContaining(["motis-import", "promote"]));
    const expected = sorted(stages.map(catalogueKey));
    expect(sorted(Object.keys(en.adminShared.jobStages))).toEqual(expected);
    expect(sorted(Object.keys(de.adminShared.jobStages))).toEqual(expected);
  });

  it("words every data-manager actor label the activity API sends", () => {
    const source = apiSource("apps/api/src/services/activity-jobs.ts");
    const labels = captures(source, /\blabel: "([^"]+)"/g);
    expect(labels.length).toBeGreaterThan(0);
    expect(sorted(labels)).toEqual(sorted(JOB_ACTOR_LABELS));
    const keys = sorted(JOB_ACTOR_LABELS.map(jobActorKey));
    for (const messages of [en, de])
      expect(sorted(selectBranches(messages.adminActivity.actorLabel))).toEqual(keys);
  });
});

describe("audit code collector", () => {
  const collect = (text: string, derived: Record<string, (file: string) => string[]> = {}) =>
    collectAuditCodes([{ path: "writer.ts", text }], "action", derived);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text handed to the collector.
  const dataTemplate = "`data.${id}`";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text handed to the collector.
  const stepTemplate = "`dawarich.${step}`";
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text handed to the collector.
  const actionUpdate = '`UPDATE "admin_audit_log" SET action = ${next} WHERE id = ${id}`';

  it("reads literals, conditionals, consts and same-file wrapper parameters", () => {
    expect(
      collect(`
        async function fail(request: unknown, action: string) {
          await writeAuditLog({ action, request });
        }
        export async function route(previous: boolean) {
          const action = previous ? "timeline.switch" : "timeline.connect";
          await writeAuditLog({ action: "settings.update" });
          await db.insert(adminAuditLog).values([{ action: "user.ban" }]);
          await fail(null, action);
          await fail(null, "dawarich.provision");
        }
      `),
    ).toEqual({
      codes: [
        "dawarich.provision",
        "settings.update",
        "timeline.connect",
        "timeline.switch",
        "user.ban",
      ],
      unreadable: [],
      unusedDerivations: [],
    });
  });

  it("reads qualified tables and writers, private wrappers and table reads", () => {
    const { codes, unreadable } = collect(`
      import { adminAuditLog } from "./schema";
      import * as schema from "./schema";
      import * as audit from "./audit-log";
      export { adminAuditLog } from "./audit-schema";
      export const adminAuditLog = pgTable("admin_audit_log", {});
      type Row = typeof adminAuditLog.$inferSelect;
      await tx.insert(schema.adminAuditLog).values({ action: "a.qualified" });
      await tx.insert(schema["adminAuditLog"]).values({ action: "a.element" });
      await audit.writeAuditLog({ action: "a.namespace" });
      await db.select({ id: adminAuditLog.id }).from(adminAuditLog).leftJoin(schema.adminAuditLog, on);
      await db.delete(adminAuditLog).where(lte(adminAuditLog.createdAt, cutoff));
      await tx.execute(sql\`UPDATE admin_audit_log SET target_id = NULL WHERE target_id = \${id}\`);
      class Service {
        private fail(action: string) {
          return writeAuditLog({ action });
        }
        #record(action: string) {
          return writeAuditLog({ action });
        }
        run() {
          this.fail("a.private");
          this.#record("a.hash");
        }
      }
    `);
    expect(unreadable).toEqual([]);
    expect(codes).toEqual(["a.element", "a.hash", "a.namespace", "a.private", "a.qualified"]);
  });

  it("reads a method the file assigns the writer to", () => {
    const { codes, unreadable } = collect(`
      class Service {
        private readonly audit: typeof writeAuditLog;
        constructor(options: { audit?: typeof writeAuditLog }) {
          this.audit = options.audit ?? writeAuditLog;
        }
        run() {
          return this.audit({ action: "timeline.test" });
        }
      }
    `);
    expect(unreadable).toEqual([]);
    expect(codes).toEqual(["timeline.test"]);
  });

  it("expands a derived expression and reports a derivation nothing uses", () => {
    const expand = () => ["data.a", "data.b"];
    expect(
      collect(`writeAuditLog({ action: ${dataTemplate} });`, {
        [`writer.ts ${dataTemplate}`]: expand,
        "writer.ts gone": expand,
      }),
    ).toEqual({
      codes: ["data.a", "data.b"],
      unreadable: [],
      unusedDerivations: ["writer.ts gone"],
    });
  });

  it.each([
    ["a variable argument", "const entry = { action: 'a.b' };\nwriteAuditLog(entry);"],
    ["an array element that is not an object", "tx.insert(adminAuditLog).values([row]);"],
    ["a variable insert", "tx.insert(adminAuditLog).values(rows);"],
    ["an insert without values", "const pending = tx.insert(adminAuditLog);"],
    ["a spread without an action", "writeAuditLog({ ...base, details });"],
    ["a spread after the action", "writeAuditLog({ action: 'a.b', ...base });"],
    ["an entry without an action", "writeAuditLog({ details });"],
    ["a template", `writeAuditLog({ action: ${dataTemplate} });`],
    ["a conditional with a variable branch", "writeAuditLog({ action: ok ? 'a.b' : other });"],
    ["a nullish fallback", "writeAuditLog({ action: other ?? 'a.b' });"],
    ["a let", "let action = 'a.b';\nwriteAuditLog({ action });"],
    ["a loop variable", "for (const action of list) writeAuditLog({ action });"],
    [
      "a wrapper called with a template",
      `function fail(action: string) { return writeAuditLog({ action }); }\nfail(${stepTemplate});`,
    ],
    [
      "an exported wrapper",
      "export function fail(action: string) { return writeAuditLog({ action }); }\nfail('a.b');",
    ],
    [
      "a wrapper passed as a value",
      "function fail(action: string) { return writeAuditLog({ action }); }\nhandlers.push(fail);",
    ],
    ["the writer passed as a value", "handlers.push(writeAuditLog);"],
    ["a qualified-table variable insert", "tx.insert(schema.adminAuditLog).values(rows);"],
    [
      "an aliased table import",
      "import { adminAuditLog as auditTable } from './schema';\ntx.insert(auditTable).values({ action: 'a.b' });",
    ],
    ["the table held in a variable", "const table = schema.adminAuditLog;\ntx.insert(table);"],
    ["an update of the table", "tx.update(adminAuditLog).set({ action: 'a.b' });"],
    [
      "an aliased writer import",
      "import { writeAuditLog as audit } from './audit-log';\naudit({ action: other });",
    ],
    ["an aliased writer re-export", "export { writeAuditLog as audit } from './audit-log';"],
    [
      "a public method wrapper",
      "export class S {\n  fail(action: string) { return writeAuditLog({ action }); }\n  run() { return this.fail('a.b'); }\n}",
    ],
    [
      "an object method wrapper",
      "const service = { fail(action: string) { return writeAuditLog({ action }); } };\nservice.fail('a.b');",
    ],
    [
      "a public property holding the writer",
      "export class S {\n  audit = noop;\n  constructor() { this.audit = writeAuditLog; }\n}",
    ],
    ["a raw SQL insert", "tx.execute(sql`INSERT INTO admin_audit_log (action) VALUES ('a.b')`);"],
    ["a raw SQL action update", `tx.execute(sql${actionUpdate});`],
    [
      "a schema-qualified raw SQL insert",
      "tx.execute(sql`INSERT INTO public.admin_audit_log (action) VALUES ('a.b')`);",
    ],
    [
      "a quoted schema-qualified raw SQL insert",
      `tx.execute(sql\`INSERT INTO "public"."admin_audit_log" (action) VALUES ('a.b')\`);`,
    ],
    [
      "a schema-qualified raw SQL update",
      "tx.execute(sql`UPDATE public.admin_audit_log SET action = 'a.b'`);",
    ],
    [
      "an aliased raw SQL update",
      "tx.execute(sql`UPDATE admin_audit_log AS a SET action = 'a.b' WHERE a.id = 1`);",
    ],
    [
      "a raw SQL update aliased without AS",
      "tx.execute(sql`UPDATE admin_audit_log a SET target_type = 'user'`);",
    ],
    [
      "a raw SQL update of a column list",
      "tx.execute(sql`UPDATE admin_audit_log SET (target_id, action) = (NULL, 'a.b')`);",
    ],
  ])("fails on %s", (_shape, text) => {
    expect(collect(text).unreadable).toHaveLength(1);
  });
});

describe("admin audit catalogue", () => {
  it("collects literal and derived audit actions", () => {
    expect(auditActions()).toEqual(
      expect.arrayContaining([
        "setting.test_email.send",
        "data.operation.run",
        "service.build",
        "ambient_places.rollback",
        "timeline.switch",
        "user.ban",
      ]),
    );
  });

  it("records exactly the registered audit actions, each following the action grammar", () => {
    expect(auditActions()).toEqual(sorted(AUDIT_ACTION_NAMES));
    expect(AUDIT_ACTION_NAMES.filter((action) => !AUDIT_ACTION_PATTERN.test(action))).toEqual([]);
    expect(ADMIN_REAUTH_PURPOSES.filter((purpose) => !AUDIT_ACTION_PATTERN.test(purpose))).toEqual(
      [],
    );
    expect(AUDIT_TARGET_TYPES.filter((type) => !/^[a-z][a-z0-9_]*$/.test(type))).toEqual([]);
  });

  it("words and offers every audit action the API records, and nothing else", () => {
    const actions = auditActions();
    const expected = sorted(actions.map(catalogueKey));
    expect(sorted(Object.keys(en.adminShared.auditActions))).toEqual(expected);
    expect(sorted(Object.keys(de.adminShared.auditActions))).toEqual(expected);
    expect(sorted(AUDIT_ACTION_GROUPS.flatMap((group) => group.actions))).toEqual(actions);
    expect([...DESTRUCTIVE_AUDIT_ACTIONS].filter((action) => !actions.includes(action))).toEqual(
      [],
    );
    const groups = sorted(AUDIT_ACTION_GROUPS.map((group) => group.group));
    for (const messages of [en, de])
      expect(sorted(selectBranches(messages.adminActivity.audit.actionGroup))).toEqual(groups);
  });

  it("names and offers every registered audit target type, and nothing else", () => {
    const types = sorted(
      Object.values(AUDIT_ACTIONS).flatMap(({ targetType }) => (targetType ? [targetType] : [])),
    );
    expect(sorted(AUDIT_TARGET_TYPES)).toEqual(types);
    expect(sorted(WEB_AUDIT_TARGET_TYPES)).toEqual(types);
    const keys = sorted(types.map(catalogueKey));
    for (const messages of [en, de])
      expect(sorted(selectBranches(messages.adminActivity.audit.targetTypeOption))).toEqual(keys);
  });
});
