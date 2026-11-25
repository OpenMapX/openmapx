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

/**
 * Calls `found` with each error reply's body in one source file, and the node
 * a finding is reported at: a send chained to an error status, and what a
 * block returns or sends after setting an error status.
 */
function visitErrorBodies(
  sf: ts.SourceFile,
  found: (body: ts.Expression | undefined, at: ts.Node) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (isSend(node)) {
      const status = chainedStatus(node);
      if (status && isErrorStatus(status)) found(node.arguments[0], node);
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
          found(isSend(returned) ? returned.arguments[0] : returned, statement);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Line numbers of error replies without the envelope in one source text. */
function findNonEnvelopeErrors(fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  visitErrorBodies(sf, (body, at) => {
    if (lacksEnvelope(body)) lines.add(sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1);
  });
  return [...lines];
}

/** A machine token rather than text: one word in one case, or words joined by `_`, `-`, `.` or `:`. */
const TOKEN_LIKE = /^(?:[a-z0-9]+(?:[_.:-][a-z0-9]+)*|[A-Z0-9]+(?:_[A-Z0-9]+)*)$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** The string literals an expression can be: a literal, a branch, or `z.literal`/`z.enum` arguments. */
function literalStrings(expression: ts.Expression): ts.StringLiteralLike[] {
  const node = unwrapped(expression);
  if (ts.isStringLiteralLike(node)) return [node];
  if (ts.isConditionalExpression(node))
    return [...literalStrings(node.whenTrue), ...literalStrings(node.whenFalse)];
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((element) =>
      ts.isSpreadElement(element) ? [] : literalStrings(element),
    );
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["literal", "enum"].includes(node.expression.name.text)
  )
    return node.arguments.flatMap(literalStrings);
  return [];
}

function property(body: ts.ObjectLiteralExpression, name: string) {
  return body.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) && propertyName(entry) === name,
  );
}

/**
 * Line numbers where an error envelope carries a token in `error` or a `code`
 * that is not UPPER_SNAKE: in an error reply's literal body, and in any object
 * literal with both `error` and `code` (a constant body or a contract schema).
 * An OAuth error response (`error_description`) keeps the RFC 6749 tokens.
 */
function findVocabularyOffenders(
  fileName: string,
  source: string,
  codeClasses: ReadonlyMap<string, number> = new Map(),
): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const report = (node: ts.Node) =>
    lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  const oauthRoute = fileName.replaceAll("\\", "/").endsWith(OAUTH_ROUTE);
  const judge = (body: ts.ObjectLiteralExpression) => {
    if (oauthRoute && property(body, "error_description")) return;
    const error = property(body, "error");
    for (const text of error ? literalStrings(error.initializer) : [])
      if (TOKEN_LIKE.test(text.text)) report(text);
    const code = property(body, "code");
    for (const value of code ? literalStrings(code.initializer) : [])
      if (!UPPER_SNAKE.test(value.text)) report(value);
  };
  visitErrorBodies(sf, (body) => {
    const literal = body && unwrapped(body);
    if (literal && ts.isObjectLiteralExpression(literal)) judge(literal);
  });
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && property(node, "error") && property(node, "code"))
      judge(node);
    // An error class that carries a code: the literal passed as its code.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const index = codeClasses.get(node.expression.text);
      const argument = index === undefined ? undefined : node.arguments?.[index];
      for (const value of argument ? literalStrings(argument) : [])
        if (!UPPER_SNAKE.test(value.text)) report(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...lines];
}

/**
 * Classes whose constructor takes a `code` parameter, by name, with that
 * parameter's position: their codes reach error replies, so a literal passed
 * there is judged like a reply's `code`.
 */
function codeParameterClasses(sources: readonly { file: string; source: string }[]) {
  const classes = new Map<string, number>();
  for (const { file, source } of sources) {
    if (!source.includes("code")) continue;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const declaration = node.members.find(ts.isConstructorDeclaration);
        const index =
          declaration?.parameters.findIndex(
            (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === "code",
          ) ?? -1;
        if (index >= 0) classes.set(node.name.text, index);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return classes;
}

/**
 * Error classes whose `code` a route sends as the reply's code. Classes whose
 * code only classifies a failure internally (provider and transport errors)
 * are not listed; a class a route starts sending a code of is added here.
 */
const REPLY_CODE_CLASSES = [
  "AccountProvisioningError",
  "AdminReauthenticationError",
  "CatalogBumpError",
  "CoverageHttpError",
  "IntegrationBindingConflict",
  "PrivacyRequestError",
  "TransitSourceError",
] as const;

/** The one route that answers OAuth 2.0 errors, whose RFC 6749 `error` tokens stay as they are. */
const OAUTH_ROUTE = "apps/api/src/routes/auth.ts";

/** Error envelope schemas the API, data-manager and air quality declare for their clients. */
const CONTRACTS = [
  "packages/core/src/api/contracts",
  "packages/core/src/services/data-manager/contracts",
  "packages/air-quality/src",
];

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

  it("has no machine token in error and no code outside UPPER_SNAKE", () => {
    const offending: string[] = [];
    const sources = [...files, ...CONTRACTS.flatMap((dir) => sourceFiles(join(REPO, dir)))].map(
      (file) => ({ file, source: readFileSync(file, "utf8") }),
    );
    const declared = codeParameterClasses(sources);
    // Every class whose code a route sends: each must still take a `code`.
    const codeClasses = new Map(
      REPLY_CODE_CLASSES.map((name) => {
        const index = declared.get(name);
        expect(index, `${name} takes no code parameter`).toBeTypeOf("number");
        return [name, index as number];
      }),
    );
    for (const { file, source } of sources) {
      if (!/\b(error|code)\b/.test(source)) continue;
      for (const line of findVocabularyOffenders(file, source, codeClasses))
        offending.push(`${relative(REPO, file)}:${line}`);
    }
    expect(
      offending,
      `Put the reason in "code" as UPPER_SNAKE and text in "error":\n${offending.join("\n")}`,
    ).toEqual([]);
  });
});

describe("error envelope vocabulary detection", () => {
  const offenders = (source: string) => findVocabularyOffenders("probe.ts", source);

  it("refuses a machine token in error", () => {
    expect(offenders(`reply.code(400).send({ error: "invalid_request" });`)).toEqual([1]);
    expect(offenders(`reply.code(409).send({ error: "REAUTHENTICATION_FAILED" });`)).toEqual([1]);
    expect(offenders(`reply.code(503).send({ error: "unavailable" });`)).toEqual([1]);
    expect(offenders(`const BUSY = { error: "busy-now", code: "BUSY" };`)).toEqual([1]);
    expect(offenders(`reply.code(403).send({ error: c ? "ok" : "Forbidden here" });`)).toEqual([1]);
  });

  it("refuses a code in another casing, also in a schema", () => {
    expect(offenders(`reply.code(409).send({ error: "Taken", code: "name-taken" });`)).toEqual([1]);
    expect(offenders(`reply.code(409).send({ error: "Taken", code: "name_taken" });`)).toEqual([1]);
    expect(offenders(`reply.code(409).send({ error: "Taken", code: "NameTaken" });`)).toEqual([1]);
    expect(
      offenders(`const s = z.strictObject({ error: z.string(), code: z.enum(["A_B", "c-d"]) });`),
    ).toEqual([1]);
    expect(
      offenders(`const s = z.strictObject({ error: z.string(), code: z.literal("in-flight") });`),
    ).toEqual([1]);
  });

  it("accepts text in error, UPPER_SNAKE codes and OAuth error responses", () => {
    expect(offenders(`reply.code(409).send({ error: "Name taken", code: "NAME_TAKEN" });`)).toEqual(
      [],
    );
    expect(offenders(`reply.code(404).send({ error: "Conflict" });`)).toEqual([]);
    expect(offenders(`reply.code(400).send({ error: message, code });`)).toEqual([]);
    const oauth = `reply.code(400).send({ error: "invalid_request", error_description: "Use Basic" });`;
    expect(findVocabularyOffenders(join(REPO, OAUTH_ROUTE), oauth)).toEqual([]);
    // The exemption belongs to the OAuth route alone.
    expect(offenders(oauth)).toEqual([1]);
    expect(offenders(`ctx.addIssue({ code: "custom", message: "bad" });`)).toEqual([]);
    expect(offenders(`reply.code(200).send({ error: "none" });`)).toEqual([]);
  });

  it("refuses a code in another casing passed to an error class that carries one", () => {
    const classes = codeParameterClasses([
      {
        file: "classes.ts",
        source: `class CoverageHttpError extends Error {
          constructor(readonly status: number, readonly code: string, message: string) { super(message); }
        }`,
      },
    ]);
    expect(classes.get("CoverageHttpError")).toBe(1);
    const thrown = (code: string) =>
      findVocabularyOffenders(
        "probe.ts",
        `throw new CoverageHttpError(400, ${JSON.stringify(code)}, "Invalid");`,
        classes,
      );
    expect(thrown("invalid_pagination")).toEqual([1]);
    expect(thrown("INVALID_QUERY")).toEqual([]);
  });
});
