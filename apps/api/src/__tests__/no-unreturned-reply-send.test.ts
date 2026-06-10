import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the ERR_HTTP_HEADERS_SENT double-send class.
 *
 * Fastify route handlers MUST `return reply` after sending (see
 * [[project-fastify-return-reply-contract]]). A bare `reply.send(...)` /
 * `reply.status(x).send(...)` at statement position — i.e. NOT returned — leaves
 * the handler resolving to `undefined`, which races a second send if any
 * preSerialization hook ever yields to the event loop. A unit test against one
 * route can't catch a new offender; this AST scan of the whole route surface
 * can. It's the durable counterpart to the throw-based auth guards + the
 * synchronous data-use-policy hook.
 */

const HERE = import.meta.dirname;
const ROUTES_DIR = resolve(HERE, "../routes");
const SERVER_FILE = resolve(HERE, "../server.ts");
// Handler reply parameter names used across the codebase.
const REPLY_IDENTIFIERS = new Set(["reply", "res"]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The leftmost identifier of a (possibly chained) member/call expression. */
function rootIdentifier(expr: ts.Expression): string | undefined {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    else break;
  }
  return ts.isIdentifier(e) ? e.text : undefined;
}

/** A call whose chain ends in `.send(...)` and roots at a reply-like identifier. */
function isReplySend(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "send") return false;
  const root = rootIdentifier(callee.expression);
  return root !== undefined && REPLY_IDENTIFIERS.has(root);
}

function findUnreturnedSends(file: string): { line: number; snippet: string }[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const hits: { line: number; snippet: string }[] = [];
  const visit = (node: ts.Node): void => {
    // A returned send is a ReturnStatement and an assigned one a
    // VariableStatement; only a send at *statement* position is unreturned.
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      isReplySend(node.expression)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ line: line + 1, snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 100) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("no unreturned reply.send() in the route surface", () => {
  const files = [...collectTsFiles(ROUTES_DIR), SERVER_FILE];

  it("scans the route files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("every reply.send()/.status().send() is returned", () => {
    const offenders = files.flatMap((f) =>
      findUnreturnedSends(f).map(
        (h) => `${f.replace(/.*\/apps\/api\//, "apps/api/")}:${h.line}  ${h.snippet}`,
      ),
    );
    expect(
      offenders,
      `Unreturned reply.send() — these race a second send (ERR_HTTP_HEADERS_SENT) if a ` +
        `preSerialization hook ever awaits. Use \`return reply.send(...)\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
