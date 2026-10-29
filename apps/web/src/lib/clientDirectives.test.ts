import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}
it("keeps Next client/server directives in the module directive prologue", () => {
  const invalid: string[] = [];
  for (const file of sources(path.resolve(import.meta.dirname, ".."))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (!ts.isExpressionStatement(statement)) continue;
      const expression = ts.isParenthesizedExpression(statement.expression)
        ? statement.expression.expression
        : statement.expression;
      if (
        !ts.isStringLiteral(expression) ||
        !["use client", "use server"].includes(expression.text)
      )
        continue;
      if (statement !== source.statements[0] || statement.expression !== expression)
        invalid.push(file);
    }
  }
  expect(invalid).toEqual([]);
});

it("keeps server-rendered legal pages away from the React-hook core barrel", () => {
  const invalid: string[] = [];
  for (const file of sources(path.resolve(import.meta.dirname, "../app/(legal)"))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const first = source.statements[0];
    if (
      first &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) &&
      first.expression.text === "use client"
    )
      continue;
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === "@openmapx/core" &&
        !statement.importClause?.isTypeOnly
      )
        invalid.push(file);
    }
  }
  expect(invalid).toEqual([]);
});
