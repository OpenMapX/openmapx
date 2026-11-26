import { readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { ImportType, init, parse } from "es-module-lexer";

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

/**
 * Refuses an installed backend bundle that imports anything other than the
 * integration SDK's entries, zod or a Node built-in, before it is imported.
 *
 * Checked here rather than left to resolution from the code cache, because the
 * API's TypeScript runner applies the host's path aliases to every import,
 * so a specifier such as `@integrations/...` would otherwise reach host source.
 * A dynamic `import()` whose argument is not a string literal cannot be
 * checked without running the code and is left to resolution.
 */
export async function assertBundleImports(source: string): Promise<void> {
  await init;
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(source);
  } catch (error) {
    throw new Error(
      `backend bundle could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const entry of imports) {
    if (entry.t === ImportType.ImportMeta) continue;
    const specifier = entry.n;
    if (specifier === undefined) continue;
    if (!isAllowedSpecifier(specifier)) {
      throw new Error(
        `backend bundle imports ${JSON.stringify(specifier)}, which is not an entry of ${SDK_PACKAGE}, zod or a Node built-in`,
      );
    }
  }
}
