import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { dts } from "rollup-plugin-dts";
import ts from "typescript";
import { INLINED_WORKSPACE_PACKAGES } from "./inlined-packages.mjs";

// Bundles the SDK's declarations so the published `.d.ts` files name only its
// public dependencies. TypeScript first emits declarations for every module the
// entries reach; rollup then inlines the modules of the workspace packages that
// the JavaScript build inlines too, and leaves everything else as imports.
const sdkDirectory = import.meta.dirname;
const packagesDirectory = resolve(sdkDirectory, "..");

const entries = readdirSync(join(sdkDirectory, "src"))
  .filter((file) => file.endsWith(".ts"))
  .map((file) => join(sdkDirectory, "src", file));

// Each export key of an inlined workspace package mapped to its source file.
// Resolving them through `paths` instead of `node_modules` makes TypeScript
// treat them as the program's own files, which it emits declarations for.
function workspaceSources() {
  const sources = {};
  for (const name of readdirSync(packagesDirectory)) {
    const directory = join(packagesDirectory, name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || !INLINED_WORKSPACE_PACKAGES.test(manifest.name)) {
      continue;
    }
    const exports = manifest.exports ?? { ".": manifest.types ?? manifest.main };
    for (const [key, target] of Object.entries(exports)) {
      const file = typeof target === "string" ? target : (target?.types ?? target?.default);
      if (typeof file !== "string" || !/\.tsx?$/.test(file)) continue;
      sources[`${manifest.name}${key.slice(1)}`] = join(directory, file);
    }
  }
  return sources;
}

function emitDeclarations(sources, outDir) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(sdkDirectory, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  );
  if (parsed === undefined || parsed.errors.length > 0) {
    throw new Error("packages/integration-sdk/tsconfig.json could not be read");
  }
  const options = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    outDir,
    paths: Object.fromEntries(Object.entries(sources).map(([key, file]) => [key, [file]])),
  };
  const program = ts.createProgram(entries, options);
  const diagnosed = new Map();
  // The last argument forces a declaration file even for a module whose
  // declaration has an error. Such modules (browser hooks behind the core root)
  // are parsed but tree-shaken; `checkDiagnosedModules` fails the build if one
  // reaches the output.
  const result = program.emit(undefined, undefined, undefined, true, undefined, true);
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || diagnostic.file === undefined) {
      continue;
    }
    const declaration = declarationPath(options.rootDir, outDir, diagnostic.file.fileName);
    const messages = diagnosed.get(declaration) ?? [];
    messages.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    diagnosed.set(declaration, messages);
  }
  checkTypes(program);
  return { rootDir: options.rootDir, diagnosed };
}

// Emitting does not check types, and a type error can silently widen an
// inferred type in the output to `any`. Every module the program reaches is
// held to this, tree-shaken or not, because an inferred type can come from a
// module that does not itself reach the output. It runs after the emit because
// checking first changes the order in which the emitted types list members.
function checkTypes(program) {
  const errors = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return;
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => sdkDirectory,
    getNewLine: () => "\n",
  };
  throw new Error(
    `the SDK's declarations would be built from code with type errors:\n${ts.formatDiagnostics(errors, host)}`,
  );
}

function declarationPath(rootDir, outDir, sourceFile) {
  return join(outDir, relative(rootDir, sourceFile)).replace(/\.tsx?$/, ".d.ts");
}

function checkDiagnosedModules(diagnosed) {
  return {
    name: "check-diagnosed-modules",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, module] of Object.entries(chunk.modules)) {
          const messages = diagnosed.get(id);
          if (messages !== undefined && module.renderedLength > 0) {
            this.error(`${id} has no valid declaration:\n${messages.join("\n")}`);
          }
        }
      }
    },
  };
}

function removeDirectory(directory) {
  return {
    name: "remove-emitted-declarations",
    closeBundle() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const outDir = mkdtempSync(join(tmpdir(), "openmapx-integration-sdk-dts-"));
const sources = workspaceSources();
let emitted;
try {
  emitted = emitDeclarations(sources, outDir);
} catch (error) {
  rmSync(outDir, { recursive: true, force: true });
  throw error;
}
const { rootDir, diagnosed } = emitted;

export default {
  input: Object.fromEntries(
    entries.map((file) => [
      file.slice(join(sdkDirectory, "src/").length, -".ts".length),
      declarationPath(rootDir, outDir, file),
    ]),
  ),
  output: {
    dir: "dist",
    format: "es",
    entryFileNames: "[name].d.ts",
    chunkFileNames: "shared-[hash].d.ts",
  },
  onwarn(warning, warn) {
    // An import that a kept module names but no kept declaration uses.
    if (warning.code !== "UNUSED_EXTERNAL_IMPORT") warn(warning);
  },
  // Everything but the private workspace modules stays an import. The emitted
  // declarations sit outside the repository's `node_modules` tree, so this is
  // decided here and not by resolution. JSON modules are only reached through
  // code that is tree-shaken away. `check-external-consumer.mjs` refuses any
  // import in the output other than zod, the contracts package and declared
  // type packages.
  external: (id) =>
    id.endsWith(".json") || (!id.startsWith(".") && !id.startsWith("/") && !(id in sources)),
  plugins: [
    dts({
      compilerOptions: {
        paths: Object.fromEntries(
          Object.entries(sources).map(([key, file]) => [
            key,
            [declarationPath(rootDir, outDir, file)],
          ]),
        ),
      },
    }),
    checkDiagnosedModules(diagnosed),
    removeDirectory(outDir),
  ],
};
