import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A test whose shared setup branches on its own name (`task.name`,
 * `currentTestName`) breaks silently when the test is renamed: the setup no
 * longer injects the fault and the test may still pass. Tests choose their
 * setup through `test.extend` fixtures or an explicit scenario instead.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = /\.[cm]?[jt]sx?$/;
/** Test files, test directories, fixtures, mocks, test helpers and runner setup files. */
const TEST_SUPPORT_PATH =
  /(^|[/._-])(tests?|spec|fixtures?|mocks?|vitest|jest)([/._-]|$)|(^|[/._-])setup/i;
const NAME_PROPERTIES = new Set(["name", "fullName"]);
const CURRENT_TEST_NAME = "currentTestName";

function isTestSupportFile(path: string): boolean {
  return SCRIPT.test(path) && TEST_SUPPORT_PATH.test(path);
}

function trackedTestSupportFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => isTestSupportFile(path) && existsSync(resolve(REPO_ROOT, path)));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  )
    current = current.expression;
  return current;
}

const literalKey = (node: ts.Node | undefined) =>
  node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;

/** `task`, `context.task`, `ctx?.task` or a member of one, such as `task.suite`. */
function isTaskChain(expression: ts.Expression): boolean {
  let current = unwrap(expression);
  for (;;) {
    if (ts.isIdentifier(current)) return current.text === "task";
    if (ts.isPropertyAccessExpression(current)) {
      if (current.name.text === "task") return true;
    } else if (ts.isElementAccessExpression(current)) {
      if (literalKey(current.argumentExpression) === "task") return true;
    } else return false;
    current = unwrap(current.expression);
  }
}

/** Whether a destructuring pattern takes its properties from a test task. */
function destructuresTask(pattern: ts.Node): boolean {
  const parent = pattern.parent;
  if (ts.isVariableDeclaration(parent))
    return parent.initializer !== undefined && isTaskChain(parent.initializer);
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === pattern
  )
    return isTaskChain(parent.right);
  if (ts.isBindingElement(parent))
    return (
      literalKey(parent.propertyName ?? parent.name) === "task" || destructuresTask(parent.parent)
    );
  if (ts.isPropertyAssignment(parent))
    return literalKey(parent.name) === "task" || destructuresTask(parent.parent);
  return false;
}

/** Whether `node` reads the running test's name or full name. */
function readsTestName(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === CURRENT_TEST_NAME) return true;
  if (ts.isPropertyAccessExpression(node))
    return NAME_PROPERTIES.has(node.name.text) && isTaskChain(node.expression);
  if (ts.isElementAccessExpression(node)) {
    const key = literalKey(node.argumentExpression);
    if (key === CURRENT_TEST_NAME) return true;
    return key !== undefined && NAME_PROPERTIES.has(key) && isTaskChain(node.expression);
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = literalKey(node.propertyName ?? node.name);
    return key !== undefined && NAME_PROPERTIES.has(key) && destructuresTask(node.parent);
  }
  if (
    (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) &&
    ts.isObjectLiteralExpression(node.parent)
  ) {
    const key = literalKey(node.name);
    return key !== undefined && NAME_PROPERTIES.has(key) && destructuresTask(node.parent);
  }
  return false;
}

/** Lines of `source` whose code reads the running test's name. */
function testNameReads(source: string, fileName: string): number[] {
  if (!/\btask\b|currentTestName/.test(source)) return [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const visit = (node: ts.Node) => {
    if (readsTestName(node))
      lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b);
}

describe("test setup selection", () => {
  it("finds a name read in setup and ignores one in prose", () => {
    expect(
      testNameReads(
        [
          "beforeEach(async (context) => {",
          '  // context.task.name used to pick the fault; "expect.getState().currentTestName" too',
          '  faults = context.task.name.startsWith("consumes");',
          "  const name = expect.getState().currentTestName;",
          "});",
        ].join("\n"),
        "fixture.test.ts",
      ),
    ).toEqual([3, 4]);
  });

  it.each([
    ["a member read", 'faults = context.task.name.startsWith("consumes");'],
    [
      "the destructured task",
      'beforeEach(({ task }) => { if (task.name.includes("x")) fault = true; });',
    ],
    ["optional chaining", "const name = ctx.task?.name;"],
    ["the full name", "const name = task.fullName;"],
    ["the suite name", "const name = context.task.suite?.name;"],
    ["a destructured name", "const { name } = context.task;"],
    ["a renamed destructured full name", "const { fullName: label } = task;"],
    ["a nested destructuring", "beforeEach(({ task: { name } }) => use(name));"],
    ["a destructuring assignment", "({ name } = context.task);"],
    ["an element access", 'const name = task["name"];'],
    ["the current test name", "const name = expect.getState().currentTestName;"],
    ["a destructured current test name", "const { currentTestName } = expect.getState();"],
  ])("finds %s", (_shape, line) => {
    expect(testNameReads(line, "fixture.ts")).toEqual([1]);
  });

  it("ignores other names, prose and strings", () => {
    expect(
      testNameReads(
        [
          "const label = job.name;",
          "const { name } = feature;",
          "const { task: job } = queue;",
          'const text = "context.task.name";',
          "// const { name } = context.task;",
        ].join("\n"),
        "fixture.ts",
      ),
    ).toEqual([]);
  });

  it.each([
    ["apps/api/src/routes/admin.test.ts", true],
    ["apps/api/src/routes/__tests__/admin-test-helpers.ts", true],
    ["apps/api/src/test/configuration-postgres-fixture.ts", true],
    ["apps/web/src/components/place/PlaceCard.test-support.tsx", true],
    ["apps/web/src/test/setup.ts", true],
    ["vitest.setup.node.ts", true],
    ["apps/mobile/jest.setup.ts", true],
    ["apps/mobile/jest.globals.js", true],
    ["packages/core/src/__fixtures__/routes.ts", true],
    ["apps/api/src/services/latest-release.ts", false],
    ["packages/core/src/attestation.ts", false],
    ["apps/web/src/components/admin/AdminTestEmail.tsx", false],
  ])("scans %s: %s", (path, scanned) => {
    expect(isTestSupportFile(path)).toBe(scanned);
  });

  it("no test chooses its setup by reading its own name", () => {
    const reads = trackedTestSupportFiles().flatMap((path) =>
      testNameReads(readFileSync(resolve(REPO_ROOT, path), "utf8"), path).map(
        (line) => `${path}:${line}`,
      ),
    );
    expect(reads, "use test.extend fixtures or an explicit scenario instead").toEqual([]);
  });
});
