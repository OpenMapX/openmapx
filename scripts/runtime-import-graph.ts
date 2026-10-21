import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * The repository files a program loads at runtime, found by following its
 * imports from the entry points with the program's own tsconfig resolution
 * (paths and package exports, as tsx resolves them). Type-only imports are not
 * followed: they are erased before the code runs.
 *
 * A dynamic import of a computed specifier cannot be followed. Such a file must
 * declare the files it loads; an undeclared one is reported rather than
 * guessed. A declaration for a file without a computed import is reported too,
 * so the list cannot go stale silently.
 */
export interface RuntimeImportGraphOptions {
  root: string;
  tsconfig: string;
  /** Files or directories (all non-test sources below them). */
  entries: readonly string[];
  /** Repository-relative file → the repository-relative files it loads by computed specifier. */
  computedImports?: Readonly<Record<string, readonly string[]>>;
}

export interface RuntimeImportGraph {
  /** Repository-relative files outside node_modules, sorted. */
  files: string[];
  undeclaredComputedImports: string[];
  staleComputedImportDeclarations: string[];
  /** `file -> specifier` for relative or workspace specifiers that did not resolve. */
  unresolved: string[];
}

const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const TEST = /(?:\.test\.[cm]?tsx?$|\/__tests__\/)/;

function sourcesBelow(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return name === "node_modules" ? [] : sourcesBelow(child);
    return SOURCE.test(name) && !name.endsWith(".d.ts") && !TEST.test(child) ? [child] : [];
  });
}

function typeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/** Runtime module specifiers of one file, and whether it imports a computed one. */
function specifiersOf(file: string, text: string): { specifiers: string[]; computed: boolean } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  let computed = false;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!typeOnlyImport(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) {
        const [argument] = node.arguments;
        if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
        else if (isImport) computed = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, computed };
}

export function runtimeImportGraph(options: RuntimeImportGraphOptions): RuntimeImportGraph {
  const root = resolve(options.root);
  const config = ts.getParsedCommandLineOfConfigFile(join(root, options.tsconfig), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!config) throw new Error(`Cannot read ${options.tsconfig}`);
  const declared = options.computedImports ?? {};
  const seen = new Set<string>();
  const queue = options.entries.flatMap((entry) => sourcesBelow(join(root, entry)));
  const undeclared: string[] = [];
  const computedFiles = new Set<string>();
  const unresolved: string[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = relative(root, file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const { specifiers, computed } = specifiersOf(file, readFileSync(file, "utf8"));
    if (computed) {
      computedFiles.add(rel);
      if (declared[rel]) queue.push(...declared[rel].map((target) => join(root, target)));
      else undeclared.push(rel);
    }
    for (const specifier of specifiers) {
      const resolved = ts.resolveModuleName(specifier, file, config.options, ts.sys).resolvedModule;
      if (!resolved) {
        if (/^(?:\.|@openmapx\/|@integrations\/)/.test(specifier)) {
          unresolved.push(`${rel} -> ${specifier}`);
        }
        continue;
      }
      const target = resolved.resolvedFileName;
      if (target.includes("/node_modules/") || !target.startsWith(`${root}/`)) continue;
      if (target.endsWith(".d.ts")) continue;
      queue.push(target);
    }
  }
  return {
    files: [...seen].map((file) => relative(root, file)).sort(),
    undeclaredComputedImports: undeclared.sort(),
    staleComputedImportDeclarations: Object.keys(declared)
      .filter((file) => !computedFiles.has(file))
      .sort(),
    unresolved: unresolved.sort(),
  };
}
