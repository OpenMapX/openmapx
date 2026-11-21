import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const LITERALS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
]);

/**
 * The code of a TypeScript or JavaScript source with comments and the text of
 * string, template, regular-expression and JSX text literals replaced by
 * spaces. Line breaks and offsets are kept, so a text search matches only the
 * identifiers and punctuation the program runs, at their original lines. Code
 * inside `${…}` stays.
 */
export function codeOnly(source: string, fileName = "source.tsx"): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const out = source.replace(/[^\n]/g, " ").split("");
  const keep = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    if (LITERALS.has(node.kind)) return;
    const children = node.getChildren(file);
    if (children.length > 0) {
      for (const child of children) keep(child);
      return;
    }
    for (let index = node.getStart(file); index < node.end; index++) out[index] = source[index];
  };
  keep(file);
  return out.join("");
}

const SOURCE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

/** Production source files under `dir`: no tests, fixtures or build output. */
export function productionSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.includes("test")) continue;
      productionSources(path, found);
      continue;
    }
    if (entry.includes("test")) continue;
    if (!SOURCE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
    found.push(path);
  }
  return found;
}
