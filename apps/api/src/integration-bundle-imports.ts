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
 * SHA-256 values of the bundles that passed the scan in this process. Each one
 * stands for a module Node already holds for the life of the process, so the
 * set grows no faster than those modules do and needs no bound of its own.
 * Failures are not remembered: a refused bundle is scanned again on its next
 * load and fails with the same message.
 */
const acceptedBundles = new Set<string>();

/**
 * Refuses an installed backend bundle that imports anything other than the
 * integration SDK's entries, zod or a Node built-in, before it is imported.
 *
 * The scan is a packaging aid, not a security boundary. Installed code is
 * trusted and runs with full access to the API process; it can reach any module
 * through an `import()` whose argument is computed, and a parser other than
 * Node's own can be made to read crafted source differently from Node. What the
 * scan catches is an honest mistake: a dependency left out of the bundle, or an
 * import of host internals, which the API's TypeScript runner would otherwise
 * resolve through the host's path aliases (`@integrations/...`) and run. Such a
 * bundle fails to load with a message naming the import instead of working by
 * accident or failing somewhere less clear.
 *
 * `sha256` is the digest of `bytes`; a bundle whose bytes already passed in this
 * process is not parsed again, so a reload of unchanged code costs no scan.
 */
export function assertBundleImports(bytes: Uint8Array, sha256: string): void {
  if (acceptedBundles.has(sha256)) return;
  scanBundleImports(bytes);
  acceptedBundles.add(sha256);
}

/**
 * Reads whitespace, line terminators, comments and string escapes by the
 * language's rules. A bundle that does not parse as a module is refused rather
 * than imported unchecked. An `import()` whose argument is not a string literal
 * cannot be judged without running the code and is left to resolution.
 */
function scanBundleImports(bytes: Uint8Array): void {
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
