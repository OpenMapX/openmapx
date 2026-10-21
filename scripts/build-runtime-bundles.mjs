// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Standalone build script, never cached by Turbo.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
 * dependency files as before, and the bundle bytes record which ones.
 *
 * The output is deterministic, so the release planner fingerprints an image by
 * its bundle instead of by every source file the bundle might include.
 */
export const RUNTIME_BUNDLES = {
  "transitous-runner": {
    tsconfig: "apps/transitous-runner/tsconfig.json",
    outdir: "apps/transitous-runner/dist",
    entries: { index: "apps/transitous-runner/src/index.ts" },
  },
};

export const EXTERNALS_MANIFEST = "runtime-externals.json";
const ASSET_DIR = "assets";
const WORKSPACE = /^(?:@openmapx\/|@integrations\/|\.|\/)/;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const SOURCE = /\.[cm]?[jt]sx?$/;

function posixRelative(from, to) {
  const path = relative(from, to).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function loaderFor(path) {
  const extension = extname(path).slice(1);
  return { mts: "ts", cts: "ts", mjs: "js", cjs: "js" }[extension] ?? extension;
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
  const externals = new Set();
  const assets = new Map();
  const problems = [];

  const runtimePlugin = {
    name: "openmapx-runtime",
    setup(context) {
      context.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point" || args.pluginData?.resolving) return undefined;
        if (BUILTINS.has(args.path)) return { path: args.path, external: true };
        if (WORKSPACE.test(args.path)) return undefined;
        const resolved = await context.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: { resolving: true },
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        // A bare specifier that resolves into the workspace is workspace code.
        if (!resolved.path.split(sep).includes("node_modules")) return undefined;
        const pinned = posixRelative(outdir, resolved.path);
        externals.add(pinned);
        return { path: pinned, external: true };
      });
      context.onLoad({ filter: SOURCE }, (args) => {
        if (args.path.split(sep).includes("node_modules")) return undefined;
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
        if (facts.assetUrls.length === 0) return undefined;
        // Copy each literal `new URL("…", import.meta.url)` asset next to the
        // bundle and point the URL at the copy.
        let contents = "";
        let cursor = 0;
        for (const asset of facts.assetUrls) {
          const sourcePath = resolve(dirname(args.path), asset.specifier);
          let bytes;
          try {
            bytes = readFileSync(sourcePath);
          } catch {
            problems.push(`${file}: asset ${asset.specifier} does not exist`);
            continue;
          }
          const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}-${basename(sourcePath)}`;
          assets.set(name, bytes);
          contents += `${text.slice(cursor, asset.start)}${JSON.stringify(`./${ASSET_DIR}/${name}`)}`;
          cursor = asset.end;
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
    logLevel: "silent",
    plugins: [runtimePlugin],
  });
  for (const warning of result.warnings) {
    problems.push(`${warning.location?.file ?? image}: ${warning.text}`);
  }
  if (problems.length > 0) {
    throw new Error(`Runtime bundle ${image} rejected:\n  ${problems.join("\n  ")}`);
  }

  const files = new Map();
  for (const output of result.outputFiles) {
    files.set(posixRelative(outdir, output.path).slice(2), Buffer.from(output.contents));
  }
  for (const [name, bytes] of assets) files.set(`${ASSET_DIR}/${name}`, bytes);
  files.set(EXTERNALS_MANIFEST, Buffer.from(`${JSON.stringify([...externals].sort(), null, 2)}\n`));

  // Bump the version when writeRuntimeBundle's output changes other than
  // through these files, so the planner does not reuse an image built by the
  // previous writer.
  const hash = createHash("sha256").update("openmapx/runtime-bundle/v1\0");
  for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${name}\0`).update(createHash("sha256").update(bytes).digest("hex"));
  }
  return { outdir, files, digest: hash.digest("hex") };
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
