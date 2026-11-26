/**
 * Module listing and the relative-import closure the policy gates scan.
 *
 * The repository's gates run this file directly under
 * `node --experimental-strip-types`, which maps no `.js` specifier to `.ts` and
 * accepts only erasable syntax. It therefore imports nothing but `node:*` and
 * `typescript`, and no sibling module.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";

/** Extensions of the repository's own server modules. */
export const REPOSITORY_EXTENSIONS: readonly string[] = [".ts", ".mts"];
/** Extensions an extension author may write a backend in. */
export const AUTHOR_EXTENSIONS: readonly string[] = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"];

/** A source module with one of the extensions that is neither a declaration file nor a test. */
export function isProductionModule(
  name: string,
  extensions: readonly string[] = REPOSITORY_EXTENSIONS,
): boolean {
  return (
    extensions.some((extension) => name.endsWith(extension)) &&
    !name.endsWith(".d.ts") &&
    !extensions.some(
      (extension) => name.endsWith(`.test${extension}`) || name.endsWith(`.spec${extension}`),
    )
  );
}

/** Every production module below `directory`, without descending into skipped directory names. */
export function listModules(
  directory: string,
  skipped: ReadonlySet<string>,
  extensions: readonly string[] = REPOSITORY_EXTENSIONS,
): string[] {
  const modules: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) modules.push(...listModules(path, skipped, extensions));
    } else if (entry.isFile() && isProductionModule(entry.name, extensions)) {
      modules.push(path);
    }
  }
  return modules;
}

function resolveRelative(
  fromFile: string,
  specifier: string,
  extensions: readonly string[],
): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const withoutJs = base.replace(/\.(?:js|mjs)$/, "");
  const candidates = [
    base,
    ...extensions.map((extension) => `${withoutJs}${extension}`),
    ...extensions.map((extension) => join(withoutJs, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (
      existsSync(candidate) &&
      statSync(candidate).isFile() &&
      isProductionModule(candidate, extensions)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function relativeImports(path: string, text: string, extensions: readonly string[]): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) &&
      !(ts.isExportDeclaration(node) && node.isTypeOnly)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolveRelative(path, specifier, extensions))
    .filter((resolved): resolved is string => resolved !== undefined);
}

/**
 * Absolute paths of the entries and of every module they reach through relative,
 * non-type-only static imports and literal dynamic imports. A module inside a
 * skipped directory name is not followed.
 */
export function serverModuleGraph(
  entries: readonly string[],
  skipped: ReadonlySet<string>,
  extensions: readonly string[] = REPOSITORY_EXTENSIONS,
): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const entry of entries) {
    if (existsSync(entry) && isProductionModule(entry, extensions)) queue.push(resolve(entry));
  }
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    for (const next of relativeImports(path, readFileSync(path, "utf8"), extensions)) {
      if (!next.split(sep).some((part) => skipped.has(part))) queue.push(next);
    }
  }
  return [...seen];
}
