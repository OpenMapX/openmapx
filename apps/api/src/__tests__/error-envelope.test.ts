import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every API error reply uses the one envelope `{ error, code? }`. This scan
 * refuses an error reply whose literal body has no `error` field, or carries an
 * `ok` flag that the status already answers: a
 * `.status(n).send({...})` or `.code(n).send({...})` chain, and a handler that
 * sets the status and then returns or sends the body. A status literal below
 * 400 is a success; any other status expression counts as an error. A body
 * wrapped in `satisfies`, `as` or parentheses is judged by the literal inside.
 * Bodies built elsewhere or spread from another object are not judged.
 */

const REPO = resolve(import.meta.dirname, "../../../..");
const SCANNED = [
  "apps/api/src",
  "integrations",
  "packages/integration-framework/src",
  "services/data-manager/src",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "__tests__", "__fixtures__", "testing"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The status argument of a `.status(x)`/`.code(x)` call, or undefined for other calls. */
function statusArgument(call: ts.CallExpression): ts.Expression | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text !== "status" && callee.name.text !== "code") return undefined;
  return call.arguments.length === 1 ? call.arguments[0] : undefined;
}

function isErrorStatus(status: ts.Expression): boolean {
  return !(ts.isNumericLiteral(status) && Number(status.text) < 400);
}

/** The status set earlier in a `.status(x).send(...)` chain, if any. */
function chainedStatus(send: ts.CallExpression): ts.Expression | undefined {
  let current: ts.Expression = send.expression;
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
    if (ts.isCallExpression(current)) {
      const status = statusArgument(current);
      if (status) return status;
    }
    current = current.expression;
  }
  return undefined;
}

function isSend(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "send" &&
    node.arguments.length === 1
  );
}

/** The expression inside any `satisfies`, `as` and parentheses around it. */
function unwrapped(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  return property.name !== undefined &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ? property.name.text
    : undefined;
}

/**
 * A literal body with an `ok` flag, or without `error` and without a spread that
 * could supply it.
 */
function lacksEnvelope(expression: ts.Expression | undefined): boolean {
  const body = expression && unwrapped(expression);
  if (!body || !ts.isObjectLiteralExpression(body)) return false;
  if (body.properties.some((property) => propertyName(property) === "ok")) return true;
  return !body.properties.some(
    (property) => ts.isSpreadAssignment(property) || propertyName(property) === "error",
  );
}

/** Line numbers of error replies without the envelope in one source text. */
function findNonEnvelopeErrors(fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const report = (node: ts.Node) =>
    lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);

  const visit = (node: ts.Node): void => {
    if (isSend(node)) {
      const status = chainedStatus(node);
      if (status && isErrorStatus(status) && lacksEnvelope(node.arguments[0])) report(node);
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      // A status set as its own statement applies to what the block returns or sends after it.
      let errorStatus = false;
      for (const statement of node.statements) {
        if (
          ts.isExpressionStatement(statement) &&
          ts.isCallExpression(statement.expression) &&
          !isSend(statement.expression)
        ) {
          const status = statusArgument(statement.expression);
          if (status) errorStatus = isErrorStatus(status);
        }
        if (errorStatus && ts.isReturnStatement(statement) && statement.expression) {
          const returned = unwrapped(statement.expression);
          const body = isSend(returned) ? returned.arguments[0] : returned;
          if (lacksEnvelope(body)) report(statement);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...lines];
}

describe("error envelope detection", () => {
  const offenders = (source: string) => findNonEnvelopeErrors("probe.ts", source);

  it("refuses error bodies without error", () => {
    expect(offenders(`reply.status(400).send({ message: "bad" });`)).toEqual([1]);
    expect(offenders(`reply.code(409).send({ code: "TAKEN" });`)).toEqual([1]);
    expect(offenders(`reply.status(status).send({ errors });`)).toEqual([1]);
    expect(
      offenders(`function h() {\n  reply.status(503);\n  return { code: "DOWN" };\n}`),
    ).toEqual([3]);
    expect(
      offenders(`function h() {\n  reply.code(400);\n  return reply.send({ x: 1 });\n}`),
    ).toEqual([3]);
  });

  it("refuses an ok flag in an error body", () => {
    expect(offenders(`reply.code(404).send({ ok: false, error: "missing" });`)).toEqual([1]);
    expect(
      offenders(`function h() {\n  reply.code(503);\n  return { ok: false, error: "down" };\n}`),
    ).toEqual([3]);
    expect(offenders(`reply.code(200).send({ ok: false, status: "starting" });`)).toEqual([]);
  });

  it("sees a literal body through satisfies, as and parentheses", () => {
    expect(offenders(`reply.code(502).send({ available: false } satisfies Capability);`)).toEqual([
      1,
    ]);
    expect(offenders(`reply.status(400).send({ message: "bad" } as Body);`)).toEqual([1]);
    expect(offenders(`reply.status(400).send(({ message: "bad" }));`)).toEqual([1]);
    expect(
      offenders(
        `function h() {\n  reply.code(503);\n  return ({ code: "DOWN" }) satisfies Body;\n}`,
      ),
    ).toEqual([3]);
    expect(offenders(`reply.status(400).send({ error: "bad" } satisfies Body);`)).toEqual([]);
  });

  it("accepts the envelope, success bodies and bodies it cannot see", () => {
    expect(offenders(`reply.status(400).send({ error: "bad" });`)).toEqual([]);
    expect(offenders(`reply.status(409).send({ error: "taken", code: "TAKEN" });`)).toEqual([]);
    expect(offenders(`reply.status(201).send({ message: "created" });`)).toEqual([]);
    expect(offenders(`reply.send({ message: "ok" });`)).toEqual([]);
    expect(offenders(`reply.status(502).send({ ...failure });`)).toEqual([]);
    expect(offenders(`reply.status(502).send(body);`)).toEqual([]);
    expect(offenders(`function h() {\n  reply.status(200);\n  return { code: "x" };\n}`)).toEqual(
      [],
    );
  });
});

describe("API error replies use the { error, code? } envelope", () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(join(REPO, dir)));

  it("scans the API, the integrations, the integration framework and data-manager", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("has no error reply without the envelope", () => {
    const found = new Map<string, number[]>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!source.includes(".send(") && !source.includes(".status(") && !source.includes(".code("))
        continue;
      const lines = findNonEnvelopeErrors(file, source);
      if (lines.length) found.set(relative(REPO, file), lines);
    }
    const offending = [...found].flatMap(([file, lines]) => lines.map((line) => `${file}:${line}`));
    expect(
      offending,
      `Error replies must send { error, code? }; put the human-readable text in "error":\n${offending.join("\n")}`,
    ).toEqual([]);
  });
});
