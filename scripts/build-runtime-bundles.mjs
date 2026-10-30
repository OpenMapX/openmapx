// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone build script, never cached by Turbo.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { analyzeModule } from "./module-specifiers.mjs";

/**
 * Runtime bundles for images that used to run workspace TypeScript under tsx.
 *
 * Workspace code is bundled; npm packages stay installed in the image but are
 * pinned: every bare import is resolved here, from the importing package's own
 * location exactly as Node resolves it in the pnpm layout, and rewritten to a
 * path relative to the output directory. Bundled code therefore loads the same
 * dependency files as before, and the bundle bytes record which ones. The image
 * installs only the package directories those files load, statically, listed
 * in `runtime-packages.json` (see scripts/copy-runtime-packages.mjs).
 *
 * Bundled workspace modules are treated as side-effect free: a module none of
 * whose exports a bundle uses is left out of it, so a change to unused code
 * does not change the bundle. A module whose top-level code must run when it
 * is imported is an entry or is listed in its bundle's `sideEffectModules`
 * (variable initializers are not checked: plain calls there, such as
 * `z.object(…)`, are dropped with an unused module); the build rejects
 * any other module that runs top-level statements, and a bare `import "…"` of
 * an unlisted module (esbuild warns that it does nothing).
 *
 * The output is deterministic, so the release planner fingerprints an image by
 * its bundle instead of by every source file the bundle might include.
 */
export const RUNTIME_BUNDLES = {
  "ops-agent": {
    tsconfig: "apps/ops-agent/tsconfig.json",
    outdir: "apps/ops-agent/dist",
    entries: {
      agent: "apps/ops-agent/src/index.ts",
      "agent-handoff-main": "apps/ops-agent/src/agent-handoff-main.ts",
      "configuration-handoff-main": "apps/ops-agent/src/configuration-handoff-main.ts",
      cli: "packages/cli/src/index.ts",
    },
  },
  "data-manager": {
    tsconfig: "services/data-manager/tsconfig.json",
    outdir: "services/data-manager/dist",
    entries: {
      supervisor: "services/data-manager/src/supervisor.ts",
      // index imports undici-fetch and then service, each its own module, so
      // the fetch globals are replaced before the service's npm imports are
      // evaluated, as under tsx (see workspaceModule).
      index: "services/data-manager/src/index.ts",
      service: "services/data-manager/src/service.ts",
      "live-writer-worker": "services/data-manager/src/jobs/traffic/live-writer-worker.ts",
      "extractor-worker": "services/data-manager/src/offline-packages/extractor-worker.ts",
      "undici-fetch": "packages/core/src/undici-fetch.ts",
    },
    sideEffectModules: [
      // Refuses a production database URL without a secret before any query.
      "services/data-manager/src/db/index.ts",
    ],
  },
  "transitous-runner": {
    tsconfig: "apps/transitous-runner/tsconfig.json",
    outdir: "apps/transitous-runner/dist",
    entries: { index: "apps/transitous-runner/src/index.ts" },
  },
};

export const EXTERNALS_MANIFEST = "runtime-externals.json";
export const PACKAGES_MANIFEST = "runtime-packages.json";
const ASSET_DIR = "assets";
const WORKSPACE = /^(?:@openmapx\/|@integrations\/|\.|\/)/;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const SOURCE = /\.[cm]?[jt]sx?$/;

/**
 * Workspace packages by name. Bundled code resolves them from the packages'
 * own `exports` (or `main`), as Node does, instead of through node_modules
 * links, so a bundle resolves the same in a full checkout and in an image
 * that installs only part of the workspace.
 */
function workspacePackages(root) {
  const packages = new Map();
  const directory = join(root, "packages");
  if (!existsSync(directory)) return packages;
  for (const name of readdirSync(directory)) {
    const manifest = join(directory, name, "package.json");
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof json.name === "string")
      packages.set(json.name, { dir: join(directory, name), json });
  }
  return packages;
}

const EXPORT_CONDITIONS = new Set(["node", "import", "module-sync", "node-addons", "default"]);

/** The target Node picks: the first key, in object order, that it matches. */
function exportTarget(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  for (const [condition, value] of Object.entries(entry)) {
    if (!EXPORT_CONDITIONS.has(condition)) continue;
    const target = exportTarget(value);
    if (target) return target;
  }
  return undefined;
}

function posixRelative(from, to) {
  const path = relative(from, to).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function loaderFor(path) {
  const extension = extname(path).slice(1);
  return { mts: "ts", cts: "ts", mjs: "js", cjs: "js" }[extension] ?? extension;
}

const PACKAGE_FILE = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const SCRIPT = /\.[cm]?js$/;
// Any `require` other than a call with one plain string literal, or an
// `import(` of anything else. Only a file containing one can make a computed
// call, so only those are parsed.
const UNCERTAIN_LOAD =
  /\brequire\b(?!\s*\(\s*["'][^"'`\\]*["']\s*\))|\bimport\s*\((?!\s*["'][^"'`\\]*["']\s*\))/;

/**
 * The installed package directories, relative to the root, that the pinned
 * files load: their own and those of every file they import or require with a
 * literal specifier, transitively. Whole directories are kept, so a package
 * still finds the files it reads or starts by path, and its license. A computed
 * `import()` or `require()` in any of these files fails the build, because its
 * target cannot be listed.
 */
async function runtimePackages(root, outdir, externals, problems) {
  const pinned = [...externals]
    .map((path) => resolve(outdir, path))
    .filter((path) => path.split(sep).includes("node_modules"));
  if (pinned.length === 0) return [];
  let result;
  try {
    result = await build({
      absWorkingDir: root,
      entryPoints: pinned,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      conditions: ["module-sync", "node-addons"],
      mainFields: ["main"],
      outdir: join(root, ".runtime-packages"),
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "openmapx-runtime-packages",
          setup(context) {
            // Native addons and other data files count as loaded; their
            // contents do not matter here.
            context.onLoad({ filter: /.*/ }, (args) =>
              SCRIPT.test(args.path) || args.path.endsWith(".json")
                ? undefined
                : { contents: "", loader: "empty" },
            );
          },
        },
      ],
    });
  } catch (error) {
    const messages = error?.errors?.map(
      (message) => `${message.location?.file ?? "dependency"}: ${message.text}`,
    );
    problems.push(...(messages ?? [String(error)]));
    return [];
  }
  const directories = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const directory = PACKAGE_FILE.exec(input)?.[1];
    if (!directory) {
      problems.push(`${input}: loaded by an installed package but not part of one`);
      continue;
    }
    directories.add(directory);
    if (!SCRIPT.test(input)) continue;
    const text = readFileSync(join(root, input), "utf8");
    if (UNCERTAIN_LOAD.test(text) && analyzeModule(join(root, input), text).computedImport) {
      problems.push(
        `${input}: computed import() or require() in an installed package; the packages it loads cannot be listed`,
      );
    }
  }
  return [...directories].sort();
}

/**
 * Builds one image's bundle in memory. Returns the output files (relative to
 * the output directory) and their digest. Throws on anything the bundle would
 * change the meaning of: a computed `import()`, a module reading its own
 * location, an asset that does not exist, or any esbuild warning.
 */
export async function buildRuntimeBundle(root, image, config = RUNTIME_BUNDLES[image]) {
  if (!config) throw new Error(`No runtime bundle is defined for ${image}`);
  // esbuild resolves real paths; a symlinked checkout must not leak into pins.
  const absoluteRoot = realpathSync(resolve(root));
  const outdir = join(absoluteRoot, config.outdir);
  const packages = workspacePackages(absoluteRoot);
  const entryNames = new Map(
    Object.entries(config.entries).map(([name, entry]) => [join(absoluteRoot, entry), name]),
  );
  const pinnedRequires = new Map();
  const assets = new Map();
  const sources = new Set();
  const problems = [];
  const sideEffectModules = new Set(
    (config.sideEffectModules ?? []).map((path) => join(absoluteRoot, path)),
  );
  // Bundled code is evaluated after every npm import of its bundle. An import
  // of another entry's source therefore loads that entry's output as its own
  // module, which keeps its place in the evaluation order.
  const workspaceModule = (path) => {
    const entry = entryNames.get(path);
    if (entry) return { path: `./${entry}.mjs`, external: true };
    return sideEffectModules.has(path) ? { path } : { path, sideEffects: false };
  };

  const runtimePlugin = {
    name: "openmapx-runtime",
    setup(context) {
      context.onResolve({ filter: /^@openmapx\// }, async (args) => {
        if (args.pluginData?.resolving) return undefined;
        const [, name, subpath] = /^(@openmapx\/[^/]+)(?:\/(.+))?$/.exec(args.path) ?? [];
        const workspacePackage = packages.get(name);
        if (!workspacePackage) return undefined;
        const { dir, json } = workspacePackage;
        if (json.exports) {
          const target = exportTarget(json.exports[subpath ? `./${subpath}` : "."]);
          if (!target) {
            return { errors: [{ text: `${args.path} is not exported by ${name}` }] };
          }
          return workspaceModule(join(dir, target));
        }
        const resolved = await context.resolve(`./${subpath ?? json.main ?? "index.ts"}`, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: dir,
          pluginData: { resolving: true },
        });
        return resolved.errors.length > 0
          ? { errors: resolved.errors }
          : workspaceModule(resolved.path);
      });
      context.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData?.resolving) return undefined;
        if (BUILTINS.has(args.path)) return { path: args.path, external: true };
        const resolved = await context.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: { resolving: true },
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        // A bare specifier that resolves into the workspace is workspace code.
        if (WORKSPACE.test(args.path) || !resolved.path.split(sep).includes("node_modules")) {
          return workspaceModule(resolved.path);
        }
        return { path: posixRelative(outdir, resolved.path), external: true };
      });
      context.onLoad({ filter: SOURCE }, async (args) => {
        if (args.path.split(sep).includes("node_modules")) return undefined;
        sources.add(args.path);
        const text = readFileSync(args.path, "utf8");
        const file = relative(absoluteRoot, args.path);
        const facts = analyzeModule(args.path, text);
        if (facts.computedImport) {
          problems.push(
            `${file}: computed import() or require() cannot be bundled; load a literal specifier`,
          );
        }
        for (const use of facts.locationSensitive) {
          problems.push(`${file}: ${use} refers to the source location, not the bundle`);
        }
        if (
          facts.topLevelStatements.length > 0 &&
          !entryNames.has(args.path) &&
          !sideEffectModules.has(args.path)
        ) {
          problems.push(
            `${file}: runs code when imported (${facts.topLevelStatements.join(", ")}); move it into a function, or list the module in the bundle's sideEffectModules`,
          );
        }
        const replacements = [];
        // Copy each literal `new URL("…", import.meta.url)` asset next to the
        // bundle and point the URL at the copy. A URL naming another entry of
        // this bundle (a worker or child process) points at that entry's
        // output instead; entries are written flat into the output directory.
        for (const asset of facts.assetUrls) {
          const sourcePath = resolve(dirname(args.path), asset.specifier);
          const entry = entryNames.get(sourcePath);
          if (entry) {
            replacements.push({ ...asset, text: `./${entry}.mjs` });
            continue;
          }
          let bytes;
          try {
            bytes = readFileSync(sourcePath);
          } catch {
            problems.push(`${file}: asset ${asset.specifier} does not exist`);
            continue;
          }
          const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}-${basename(sourcePath)}`;
          assets.set(name, bytes);
          sources.add(sourcePath);
          replacements.push({ ...asset, text: `./${ASSET_DIR}/${name}` });
        }
        // A `require` created from the module's URL resolves from the bundle
        // instead; pin each literal it loads, as for imports.
        for (const call of facts.localRequires) {
          if (BUILTINS.has(call.specifier)) continue;
          const resolved = await context.resolve(call.specifier, {
            importer: args.path,
            kind: "require-call",
            resolveDir: dirname(args.path),
            pluginData: { resolving: true },
          });
          if (resolved.errors.length > 0 || !resolved.path.split(sep).includes("node_modules")) {
            problems.push(
              `${file}: createRequire(import.meta.url) loads ${call.specifier}, which is not an installed package`,
            );
            continue;
          }
          const pinned = posixRelative(outdir, resolved.path);
          pinnedRequires.set(args.path, [...(pinnedRequires.get(args.path) ?? []), pinned]);
          replacements.push({ ...call, text: pinned });
        }
        if (replacements.length === 0) return undefined;
        let contents = "";
        let cursor = 0;
        for (const replacement of replacements.sort((a, b) => a.start - b.start)) {
          contents += `${text.slice(cursor, replacement.start)}${JSON.stringify(replacement.text)}`;
          cursor = replacement.end;
        }
        return { contents: contents + text.slice(cursor), loader: loaderFor(args.path) };
      });
    },
  };

  const result = await build({
    absWorkingDir: absoluteRoot,
    entryPoints: Object.fromEntries(
      Object.entries(config.entries).map(([name, entry]) => [name, join(absoluteRoot, entry)]),
    ),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    splitting: false,
    outdir,
    entryNames: "[name]",
    outExtension: { ".js": ".mjs" },
    tsconfig: join(absoluteRoot, config.tsconfig),
    // Resolve npm packages with Node 24's conditions (esbuild adds `node`,
    // `import`/`require` and `default`), without esbuild's `module` condition
    // and `module` main field, which Node never reads.
    conditions: ["module-sync", "node-addons"],
    mainFields: ["main"],
    legalComments: "none",
    // Bundled CommonJS code calls `require`; give ESM output a real one.
    banner: {
      js: 'import { createRequire as __openmapxCreateRequire } from "node:module";\nconst require = __openmapxCreateRequire(import.meta.url);',
    },
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [runtimePlugin],
  });
  for (const warning of result.warnings) {
    problems.push(`${warning.location?.file ?? image}: ${warning.text}`);
  }
  // Only the dependency files the output loads: those of modules left out of
  // every bundle need not be installed and do not change the digest.
  const externals = new Set();
  const included = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external && !BUILTINS.has(imported.path)) externals.add(imported.path);
    }
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (bytesInOutput === 0) continue;
      included.add(join(absoluteRoot, input));
      for (const pinned of pinnedRequires.get(join(absoluteRoot, input)) ?? []) {
        externals.add(pinned);
      }
    }
  }

  for (const path of config.sideEffectModules ?? []) {
    if (!included.has(join(absoluteRoot, path))) {
      problems.push(`sideEffectModules lists ${path}, which the bundle does not include`);
    }
  }
  const installed = await runtimePackages(absoluteRoot, outdir, externals, problems);
  if (problems.length > 0) {
    throw new Error(`Runtime bundle ${image} rejected:\n  ${problems.join("\n  ")}`);
  }

  const files = new Map();
  for (const output of result.outputFiles) {
    files.set(posixRelative(outdir, output.path).slice(2), Buffer.from(output.contents));
  }
  // Only assets the output refers to: those of left-out modules or dead code
  // would change the digest without changing what runs.
  const emitted = result.outputFiles.map((output) => output.text).join("\n");
  for (const [name, bytes] of assets) {
    if (emitted.includes(JSON.stringify(`./${ASSET_DIR}/${name}`))) {
      files.set(`${ASSET_DIR}/${name}`, bytes);
    }
  }
  files.set(EXTERNALS_MANIFEST, Buffer.from(`${JSON.stringify([...externals].sort(), null, 2)}\n`));
  files.set(PACKAGES_MANIFEST, Buffer.from(`${JSON.stringify(installed, null, 2)}\n`));

  // Bump the version when writeRuntimeBundle's output changes other than
  // through these files, so the planner does not reuse an image built by the
  // previous writer.
  const hash = createHash("sha256").update("openmapx/runtime-bundle/v1\0");
  for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${name}\0`).update(createHash("sha256").update(bytes).digest("hex"));
  }
  // Every repository file the build read, for checking the image's bundle stage.
  const configs = [];
  for (let tsconfig = join(absoluteRoot, config.tsconfig); tsconfig; ) {
    configs.push(tsconfig);
    const parent = JSON.parse(readFileSync(tsconfig, "utf8")).extends;
    tsconfig =
      typeof parent === "string" && parent.startsWith(".")
        ? resolve(dirname(tsconfig), parent)
        : "";
  }
  const read = [...sources, ...configs].map((path) => posixRelative(absoluteRoot, path).slice(2));
  return { outdir, files, digest: hash.digest("hex"), sources: [...new Set(read)].sort() };
}

export function writeRuntimeBundle(bundle) {
  rmSync(bundle.outdir, { recursive: true, force: true });
  for (const [name, bytes] of bundle.files) {
    const path = join(bundle.outdir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

async function main() {
  const [image, ...flags] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundle = await buildRuntimeBundle(root, image);
  if (flags[0] === "--digest") {
    console.log(bundle.digest);
    return;
  }
  // Release builds pass the digest the planner fingerprinted; a different
  // bundle would mean the image is not the one the release plan describes.
  const expectIndex = flags.indexOf("--expect");
  const expected = expectIndex === -1 ? "" : (flags[expectIndex + 1] ?? "");
  if (expected && expected !== bundle.digest) {
    throw new Error(
      `Runtime bundle ${image} digest ${bundle.digest} does not match the release plan's ${expected}`,
    );
  }
  writeRuntimeBundle(bundle);
  console.log(`${image}: ${bundle.files.size} files, digest ${bundle.digest}`);
}

// No top-level await: CommonJS-compiled scripts import this module.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
