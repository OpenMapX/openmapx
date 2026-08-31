import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Structural guard against the Compose blank-env-injection class.
 *
 * Compose renders optional container vars as `${VAR:-}`, which injects EMPTY
 * STRINGS for unset vars, and `"" ?? fallback` keeps the empty string. Env
 * VALUE reads must go through `envString`/`envInt` from the shared server-env module so a
 * blank var falls back. `?? null` / `?? undefined` passthroughs are exempt:
 * they normalize absence rather than pick a usable value.
 */

const HERE = import.meta.dirname;
const SRC_DIR = resolve(HERE, "..");

// "path-relative-to-src:VAR_NAME" for intentional bare `??` env fallbacks.
const ALLOWLIST = new Set<string>([]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** `process.env.FOO` / `process.env["FOO"]`, unwrapping parens and `!`. */
function envVarName(expr: ts.Expression, sf: ts.SourceFile): string | undefined {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return undefined;
  const base = e.expression;
  if (
    !ts.isPropertyAccessExpression(base) ||
    !ts.isIdentifier(base.expression) ||
    base.expression.text !== "process" ||
    base.name.text !== "env"
  ) {
    return undefined;
  }
  return ts.isPropertyAccessExpression(e) ? e.name.text : e.argumentExpression.getText(sf);
}

function isNullOrUndefined(expr: ts.Expression): boolean {
  return (
    expr.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expr) && expr.text === "undefined")
  );
}

function findBareEnvFallbacks(file: string): { line: number; varName: string }[] {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const hits: { line: number; varName: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      !isNullOrUndefined(node.right)
    ) {
      const varName = envVarName(node.left, sf);
      if (varName !== undefined) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push({ line: line + 1, varName });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("no bare ?? fallback on a process.env read", () => {
  const files = collectTsFiles(SRC_DIR);

  it("scans the src tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("every process.env value read goes through envString/envInt", () => {
    const offenders = files.flatMap((f) =>
      findBareEnvFallbacks(f)
        .map((h) => ({ ...h, rel: f.slice(SRC_DIR.length + 1) }))
        .filter((h) => !ALLOWLIST.has(`${h.rel}:${h.varName}`))
        .map((h) => `apps/api/src/${h.rel}:${h.line}  process.env.${h.varName} ?? …`),
    );
    expect(
      offenders,
      `Bare \`??\` fallback on a process.env read — Compose \`\${VAR:-}\` injects ` +
        `empty strings, which \`??\` keeps. Use envString/envInt from @openmapx/core/server-env ` +
        `(or add to ALLOWLIST with justification):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
