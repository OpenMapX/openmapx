/**
 * Integration cache-write analysis.
 *
 * A direct `ctx.cache.set` fences only its own invocation. Written after an
 * upstream request, it can refill a namespace that an admin cleared while the
 * request was in flight. Integration code stores upstream results through
 * `withCache` or through a writer from `captureCacheWriter`, both of which
 * capture the fence before the request (see "The integration context" in the
 * integration system documentation).
 *
 * The analysis reports every direct `set` on an integration cache, before or
 * after an await, because a helper that wraps the write hides the await from a
 * syntactic scan. A receiver is an integration cache when it is named `cache`
 * (`ctx.cache`, `this.cache`, `deps.cache`, a local `cache`), when it is
 * declared with a `CacheClient` type other than the captured writer's
 * `Pick<CacheClient, "set">`, or when it is a variable taken from a `.cache`
 * property. Each exception names the exact number of writes in one file and
 * the reason they are acceptable.
 *
 * The repository's gate runs this file directly under
 * `node --experimental-strip-types`, which maps no `.js` specifier to `.ts` and
 * accepts only erasable syntax. It therefore imports nothing but `node:*` and
 * `typescript`, and no sibling module.
 */
import ts from "typescript";

export interface CacheWriteException {
  /** How many direct writes the file holds; any other number fails the gate. */
  readonly count: number;
  readonly reason: string;
}

export interface DirectCacheWrite {
  readonly line: number;
  readonly text: string;
}

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

function receiverName(expression: ts.Expression): string | undefined {
  let inner = expression;
  while (ts.isNonNullExpression(inner) || ts.isParenthesizedExpression(inner)) {
    inner = inner.expression;
  }
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  return undefined;
}

/** Every `<cache>.set` access in one module. */
export function findDirectCacheWrites(sourceText: string, fileName: string): DirectCacheWrite[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const aliases = cacheAliases(source);
  const writes: DirectCacheWrite[] = [];
  const record = (node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    writes.push({ line: line + 1, text: node.getText(source).replace(/\n.*$/s, "") });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "set") {
      const name = receiverName(node.expression);
      if (name === "cache" || (name !== undefined && aliases.has(name))) record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

/**
 * One failure message per file whose writes no exception covers exactly, and
 * per exception that names a missing file or a file without direct writes.
 */
export function checkCacheWrites(
  modules: ReadonlyMap<string, string>,
  exceptions: Readonly<Record<string, CacheWriteException>>,
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
