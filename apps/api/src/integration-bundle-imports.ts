import { readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { type Node, parse } from "acorn";

const SDK_PACKAGE = "@openmapx/integration-sdk";

let sdkSpecifiers: ReadonlySet<string> | undefined;

/** Every import specifier the host's integration SDK answers, read from its `exports`. */
function integrationSdkSpecifiers(): ReadonlySet<string> {
  if (sdkSpecifiers) return sdkSpecifiers;
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(
    readFileSync(require.resolve(`${SDK_PACKAGE}/package.json`), "utf8"),
  ) as { exports?: Record<string, unknown> };
  sdkSpecifiers = new Set(
    Object.keys(manifest.exports ?? {})
      .filter((entry) => entry === "." || (entry.startsWith("./") && entry !== "./package.json"))
      .map((entry) => (entry === "." ? SDK_PACKAGE : `${SDK_PACKAGE}/${entry.slice(2)}`)),
  );
  return sdkSpecifiers;
}

function isAllowedSpecifier(specifier: string): boolean {
  if (specifier === "zod" || specifier.startsWith("zod/")) return true;
  if (specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`)) {
    return integrationSdkSpecifiers().has(specifier);
  }
  return isBuiltin(specifier);
}

type SyntaxNode = Node & Record<string, unknown>;

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** The value of a string literal or of a template literal without substitutions. */
function literalValue(node: unknown): string | undefined {
  if (!isSyntaxNode(node)) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const { expressions, quasis } = node as unknown as {
      expressions: unknown[];
      quasis: Array<{ value: { cooked?: string | null } }>;
    };
    if (expressions.length === 0) return quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * The module specifier of every import declaration, export-from declaration and
 * `import()` with a literal argument, found anywhere in the syntax tree.
 */
function literalImportSpecifiers(program: Node): string[] {
  const specifiers: string[] = [];
  const pending: SyntaxNode[] = [program as SyntaxNode];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ImportExpression"
    ) {
      const specifier = literalValue(node.source);
      if (specifier !== undefined) specifiers.push(specifier);
    }
    // Every child is visited, not only the fields of known node types, so an
    // import() nested anywhere (an argument's options included) is still found.
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isSyntaxNode(item)) pending.push(item);
      } else if (isSyntaxNode(value)) {
        pending.push(value);
      }
    }
  }
  return specifiers;
}

/**
 * Decodes as Node decodes a `.mjs` file (UTF-8, a leading byte order mark
 * dropped), except that malformed bytes are refused instead of replaced.
 */
const utf8 = new TextDecoder("utf-8", { fatal: true });

function notAModule(reason: string): Error {
  return new Error(`backend bundle is not a valid ES module: ${reason}`);
}

/**
 * Refuses an installed backend bundle that imports anything other than the
 * integration SDK's entries, zod or a Node built-in, before it is imported.
 *
 * Checked here rather than left to resolution from the code cache, because the
 * API's TypeScript runner applies the host's path aliases to every import,
 * so a specifier such as `@integrations/...` would otherwise reach host source.
 * A full ECMAScript parser reads whitespace, line terminators, comments and
 * string escapes by the language's rules, as Node does. A bundle it cannot
 * parse as a module is refused rather than imported unchecked.
 * A dynamic `import()` whose argument is not a string literal cannot be
 * checked without running the code and is left to resolution.
 */
export function assertBundleImports(bytes: Uint8Array): void {
  let source: string;
  try {
    source = utf8.decode(bytes);
  } catch {
    throw notAModule("it is not valid UTF-8");
  }
  let program: Node;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  } catch (error) {
    throw notAModule(error instanceof Error ? error.message : String(error));
  }
  for (const specifier of literalImportSpecifiers(program)) {
    if (!isAllowedSpecifier(specifier)) {
      throw new Error(
        `backend bundle imports ${JSON.stringify(specifier)}, which is not an entry of ${SDK_PACKAGE}, zod or a Node built-in`,
      );
    }
  }
}
