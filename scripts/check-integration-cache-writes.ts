/**
 * Integration cache-write gate.
 *
 * A direct `ctx.cache.set` fences only its own invocation. Written after an
 * upstream request, it can refill a namespace that an admin cleared while the
 * request was in flight. Integration code stores upstream results through
 * `withCache` or through a writer from `captureCacheWriter`, both of which
 * capture the fence before the request (see "The integration context" in
 * docs/docs/developer/integration-system.md).
 *
 * The gate refuses every direct `set` on an integration cache, before or after
 * an await, because a helper that wraps the write hides the await from a
 * syntactic scan. A receiver is an integration cache when it is named `cache`
 * (`ctx.cache`, `this.cache`, `deps.cache`, a local `cache`), when it is
 * declared with a `CacheClient` type other than the captured writer's
 * `Pick<CacheClient, "set">`, or when it is a variable taken from a `.cache`
 * property. Shared helpers that write the cache without the fence count as
 * direct writes too. In-memory maps that happen to be named `cache` and
 * writes that store no upstream result are listed below with the reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["integrations", "packages/integration-framework/src"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "__tests__", "__fixtures__"]);

/** Helpers outside the scanned roots that call `cache.set` on the cache they are given. */
const UNFENCED_HELPERS: ReadonlyArray<{ module: string; name: string }> = [
  { module: "@openmapx/mobility-core/cache", name: "cacheSet" },
  { module: "@openmapx/core", name: "withCache" },
];

export interface CacheWriteException {
  /** How many direct writes the file holds; any other number fails the gate. */
  readonly count: number;
  readonly reason: string;
}

export const EXCEPTIONS: Readonly<Record<string, CacheWriteException>> = {
  "integrations/transit/index.ts": {
    count: 6,
    reason:
      "Converted with the transit correctness changes on their own branch; lower this count as its writes move to captureCacheWriter.",
  },
  "integrations/transit-motis/rentals-capability.ts": {
    count: 1,
    reason: "`cache` is a module-level in-memory Map, not the integration cache.",
  },
  "integrations/bike-sharing/providers/db-bike-client.ts": {
    count: 1,
    reason: "`cache` is an in-memory Map owned by the provider, not the integration cache.",
  },
  "integrations/geocoding/mem-cache.ts": {
    count: 1,
    reason: "`this.cache` is the process-local LRU behind the autocomplete L1.",
  },
  "integrations/knowledge-sun-time/index.ts": {
    count: 1,
    reason:
      "The /timezone entry comes from the bundled geo-tz lookup; no upstream request precedes the write.",
  },
  "integrations/search-nlp/index.ts": {
    count: 2,
    reason:
      "A development-only parse quota counter and a provider breaker flag; neither stores an upstream result.",
  },
};

/** A writer captured before acquisition has this type; its `set` is the fenced one. */
const CAPTURED_WRITER_TYPE = /^(?:CacheWriter|Pick<CacheClient,\s*"set">)$/;

function isCacheTypeAnnotation(type: ts.TypeNode | undefined, source: ts.SourceFile): boolean {
  if (!type) return false;
  const text = type.getText(source).replace(/\s+/g, " ").trim();
  return /\bCacheClient\b/.test(text) && !CAPTURED_WRITER_TYPE.test(text);
}

function isCacheProperty(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const inner = ts.isNonNullExpression(expression) ? expression.expression : expression;
  return ts.isPropertyAccessExpression(inner) && inner.name.text === "cache";
}

/** Local names in this file that hold an integration cache under another name. */
function cacheAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      ts.isIdentifier(node.name) &&
      isCacheTypeAnnotation(node.type, source)
    ) {
      aliases.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isCacheProperty(node.initializer)) aliases.add(node.name.text);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const property = node.propertyName ?? node.name;
      if (ts.isIdentifier(property) && property.text === "cache") aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return aliases;
}

/** Local names bound to an unfenced cache-writing helper by an import. */
function unfencedHelperNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (UNFENCED_HELPERS.some((helper) => helper.module === module && helper.name === imported)) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function receiverName(expression: ts.Expression): string | undefined {
  let inner = expression;
  while (ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  return undefined;
}

export interface DirectCacheWrite {
  readonly line: number;
  readonly text: string;
}

/** Every `<cache>.set` access and unfenced helper call in one module. */
export function findDirectCacheWrites(sourceText: string, fileName: string): DirectCacheWrite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const aliases = cacheAliases(source);
  const helpers = unfencedHelperNames(source);
  const writes: DirectCacheWrite[] = [];
  const record = (node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    writes.push({ line: line + 1, text: node.getText(source).split("\n")[0] as string });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "set") {
      const name = receiverName(node.expression);
      if (name === "cache" || (name !== undefined && aliases.has(name))) record(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helpers.has(node.expression.text)
    ) {
      record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

function isProductionModule(name: string): boolean {
  return (
    /\.(?:ts|tsx|mts)$/.test(name) &&
    !name.endsWith(".d.ts") &&
    !/\.(?:test|spec)\.(?:ts|tsx|mts)$/.test(name)
  );
}

function listModules(directory: string): string[] {
  const modules: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) modules.push(...listModules(path));
    } else if (entry.isFile() && isProductionModule(entry.name)) {
      modules.push(path);
    }
  }
  return modules;
}

export function checkCacheWrites(
  modules: ReadonlyMap<string, string>,
  exceptions: Readonly<Record<string, CacheWriteException>> = EXCEPTIONS,
): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const [path, text] of modules) {
    const writes = findDirectCacheWrites(text, path);
    if (writes.length === 0) continue;
    seen.add(path);
    const exception = exceptions[path];
    if (exception?.count === writes.length) continue;
    const where = writes.map((write) => `  ${path}:${write.line}  ${write.text}`).join("\n");
    failures.push(
      exception
        ? `${path} holds ${writes.length} direct cache writes; its exception allows ${exception.count}. Update the exception only if every write still matches its reason.\n${where}`
        : `${path} writes the integration cache directly. Capture a writer with captureCacheWriter before the upstream request, or use withCache.\n${where}`,
    );
  }
  for (const path of Object.keys(exceptions)) {
    if (!seen.has(path) && modules.has(path)) {
      failures.push(`${path} no longer writes the cache directly; remove its exception.`);
    }
    if (!modules.has(path)) failures.push(`${path} is listed as an exception but does not exist.`);
  }
  return failures;
}

function main(): void {
  const modules = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const path of listModules(join(ROOT, root))) {
      modules.set(relative(ROOT, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  }
  const failures = checkCacheWrites(modules);
  if (failures.length > 0) {
    console.error("Integration cache-write check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Integration cache-write check passed: ${modules.size} modules, ${Object.keys(EXCEPTIONS).length} listed exceptions.`,
  );
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) main();
