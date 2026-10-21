import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuntimeBundle,
  EXTERNALS_MANIFEST,
  PACKAGES_MANIFEST,
  RUNTIME_BUNDLES,
  writeRuntimeBundle,
} from "./build-runtime-bundles.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const config = {
  tsconfig: "tsconfig.json",
  outdir: "app/dist",
  entries: { main: "app/src/main.ts" },
};

function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-runtime-bundle-"));
  roots.push(root);
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        paths: { "@openmapx/lib/*": ["./lib/src/*.ts"] },
      },
    }),
    "node_modules/left-pad/package.json": JSON.stringify({ name: "left-pad", main: "index.js" }),
    "node_modules/left-pad/index.js": 'module.exports = (value) => " " + value;',
    "app/src/main.ts": [
      'import { readFileSync } from "node:fs";',
      'import pad from "left-pad";',
      'import { used } from "@openmapx/lib/tools";',
      "console.log(pad(used()), typeof readFileSync);",
    ].join("\n"),
    "lib/src/tools.ts": [
      'export const used = () => "used";',
      'export const unused = () => "unused";',
    ].join("\n"),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const text = (bundle: Awaited<ReturnType<typeof buildRuntimeBundle>>, name: string) =>
  bundle.files.get(name)?.toString("utf8") ?? "";

describe("runtime bundles", () => {
  it("bundles workspace code and pins npm imports to their installed files", async () => {
    const bundle = await buildRuntimeBundle(workspace(), "fixture", config);
    const main = text(bundle, "main.mjs");
    expect(main).toContain('"used"');
    expect(main).toContain('from "../../node_modules/left-pad/index.js"');
    expect(main).toContain('from "node:fs"');
    expect(JSON.parse(text(bundle, EXTERNALS_MANIFEST))).toEqual([
      "../../node_modules/left-pad/index.js",
    ]);
  });

  it("lists the installed package directories the pinned files load", async () => {
    const bundle = await buildRuntimeBundle(
      workspace({
        "node_modules/left-pad/index.js": [
          'const repeat = require("@pad/repeat");',
          'require("./build/native.node");',
          'module.exports = (value) => repeat(" ") + value;',
        ].join("\n"),
        "node_modules/left-pad/build/native.node": "binary",
        "node_modules/@pad/repeat/package.json": JSON.stringify({ name: "@pad/repeat" }),
        "node_modules/@pad/repeat/index.js": "module.exports = (value) => value;",
        "node_modules/unused/index.js": "module.exports = 1;",
      }),
      "fixture",
      config,
    );
    expect(JSON.parse(text(bundle, PACKAGES_MANIFEST))).toEqual([
      "node_modules/@pad/repeat",
      "node_modules/left-pad",
    ]);
  });

  it("rejects a computed require in an installed package the bundle loads", async () => {
    const root = workspace({
      "node_modules/left-pad/index.js":
        "const name = process.env.PAD;\nmodule.exports = require(name);",
    });
    await expect(buildRuntimeBundle(root, "fixture", config)).rejects.toThrow(
      "node_modules/left-pad/index.js: computed import() or require() in an installed package",
    );
  });

  it("pins the file Node loads, not esbuild's module condition", async () => {
    const bundle = await buildRuntimeBundle(
      workspace({
        "node_modules/dual/package.json": JSON.stringify({
          name: "dual",
          main: "main.cjs",
          module: "module.js",
          exports: { ".": { module: "./module.js", import: "./node.mjs", require: "./main.cjs" } },
        }),
        "node_modules/dual/module.js": "export default 1;",
        "node_modules/dual/node.mjs": "export default 2;",
        "node_modules/dual/main.cjs": "module.exports = 3;",
        "app/src/main.ts": 'import dual from "dual";\nconsole.log(dual);',
      }),
      "fixture",
      config,
    );
    expect(JSON.parse(text(bundle, EXTERNALS_MANIFEST))).toEqual([
      "../../node_modules/dual/node.mjs",
    ]);
  });

  it("resolves workspace packages from their exports without node_modules links", async () => {
    const files = {
      "packages/greet/package.json": JSON.stringify({
        name: "@openmapx/greet",
        exports: { "./hello": { types: "./src/hello.ts", default: "./src/hello.ts" } },
      }),
      "packages/greet/src/hello.ts": 'export const hello = () => "hello";',
      "app/src/main.ts": 'import { hello } from "@openmapx/greet/hello";\nconsole.log(hello());',
    };
    const bundle = await buildRuntimeBundle(workspace(files), "fixture", config);
    expect(text(bundle, "main.mjs")).toContain('"hello"');
    await expect(
      buildRuntimeBundle(
        workspace({ ...files, "app/src/main.ts": 'import "@openmapx/greet/missing";' }),
        "fixture",
        config,
      ),
    ).rejects.toThrow("is not exported by @openmapx/greet");
    // Node picks the first condition it matches, in the order the package lists them.
    const ordered = await buildRuntimeBundle(
      workspace({
        ...files,
        "packages/greet/package.json": JSON.stringify({
          name: "@openmapx/greet",
          exports: { "./hello": { node: "./src/node.ts", import: "./src/hello.ts" } },
        }),
        "packages/greet/src/node.ts": 'export const hello = () => "node";',
      }),
      "fixture",
      config,
    );
    expect(text(ordered, "main.mjs")).toContain('"node"');
    expect(ordered.sources).toContain("packages/greet/src/node.ts");
    expect(ordered.sources).not.toContain("packages/greet/src/hello.ts");
  });

  it("is byte-identical across builds and checkout locations", async () => {
    const first = await buildRuntimeBundle(workspace(), "fixture", config);
    const second = await buildRuntimeBundle(workspace(), "fixture", config);
    expect(second.digest).toBe(first.digest);
    expect([...second.files.keys()]).toEqual([...first.files.keys()]);
  });

  it("changes only when code the bundle keeps changes", async () => {
    const base = await buildRuntimeBundle(workspace(), "fixture", config);
    const unusedEdit = await buildRuntimeBundle(
      workspace({
        "lib/src/tools.ts":
          'export const used = () => "used";\nexport const unused = () => "changed";',
      }),
      "fixture",
      config,
    );
    expect(unusedEdit.digest).toBe(base.digest);
    const usedEdit = await buildRuntimeBundle(
      workspace({ "lib/src/tools.ts": 'export const used = () => "changed";' }),
      "fixture",
      config,
    );
    expect(usedEdit.digest).not.toBe(base.digest);
  });

  it("copies literal asset URLs next to the bundle and points the code at the copy", async () => {
    const files = {
      "lib/src/tools.ts":
        'import { readFileSync } from "node:fs";\nexport const used = () => readFileSync(new URL("../data/list.json", import.meta.url), "utf8");',
      "lib/data/list.json": '["a"]',
    };
    const root = workspace(files);
    const bundle = await buildRuntimeBundle(root, "fixture", config);
    const asset = [...bundle.files.keys()].find((name) => name.startsWith("assets/"));
    expect(asset).toMatch(/^assets\/[a-f0-9]{12}-list\.json$/);
    expect(text(bundle, "main.mjs")).toContain(`new URL("./${asset}", import.meta.url)`);
    writeRuntimeBundle(bundle);
    expect(readFileSync(join(root, "app/dist", asset as string), "utf8")).toBe('["a"]');

    const changed = await buildRuntimeBundle(
      workspace({ ...files, "lib/data/list.json": '["b"]' }),
      "fixture",
      config,
    );
    expect(changed.digest).not.toBe(bundle.digest);
  });

  it("points a URL naming another entry at that entry's bundle", async () => {
    const root = workspace({
      "app/src/main.ts": [
        'import { Worker } from "node:worker_threads";',
        'new Worker(new URL("./jobs/worker.ts", import.meta.url));',
      ].join("\n"),
      "app/src/jobs/worker.ts": 'console.log("worker");',
    });
    const bundle = await buildRuntimeBundle(root, "fixture", {
      ...config,
      entries: { main: "app/src/main.ts", worker: "app/src/jobs/worker.ts" },
    });
    expect(text(bundle, "main.mjs")).toContain('new URL("./worker.mjs", import.meta.url)');
    expect([...bundle.files.keys()].some((name) => name.startsWith("assets/"))).toBe(false);
    // Outside the bundle's entries, the same URL is an asset to copy.
    const asAsset = await buildRuntimeBundle(root, "fixture", config);
    expect(text(asAsset, "main.mjs")).toMatch(/new URL\("\.\/assets\/[a-f0-9]{12}-worker\.ts"/);
  });

  it("loads another entry imported by source as that entry's own module", async () => {
    const root = workspace({
      "app/src/main.ts": 'import "./setup";\nimport "./service";',
      "app/src/setup.ts": "globalThis.configured = true;",
      "app/src/service.ts": 'import pad from "left-pad";\nconsole.log(pad("x"));',
    });
    const bundle = await buildRuntimeBundle(root, "fixture", {
      ...config,
      entries: {
        main: "app/src/main.ts",
        setup: "app/src/setup.ts",
        service: "app/src/service.ts",
      },
    });
    // ESM evaluates setup.mjs completely before service.mjs and its npm imports.
    expect(text(bundle, "main.mjs")).toMatch(
      /import "\.\/setup\.mjs";\nimport "\.\/service\.mjs";/,
    );
    expect(text(bundle, "main.mjs")).not.toContain("left-pad");
    expect(text(bundle, "setup.mjs")).toContain("globalThis.configured = true");
  });

  it("pins packages loaded through a require created from the module's URL", async () => {
    const bundle = await buildRuntimeBundle(
      workspace({
        "app/src/main.ts": [
          'import { createRequire } from "node:module";',
          "const require = createRequire(import.meta.url);",
          'console.log(require("left-pad")("x"), require("node:fs").existsSync);',
        ].join("\n"),
      }),
      "fixture",
      config,
    );
    // esbuild renames the local binding, which the shared require shim shadows.
    expect(text(bundle, "main.mjs")).toMatch(
      /var (require\d*) = createRequire\(import\.meta\.url\);\nconsole\.log\(\1\("\.\.\/\.\.\/node_modules\/left-pad\/index\.js"\)/,
    );
    // Builtins are left as they are.
    expect(text(bundle, "main.mjs")).toMatch(/require\d*\("node:fs"\)/);
    expect(JSON.parse(text(bundle, EXTERNALS_MANIFEST))).toEqual([
      "../../node_modules/left-pad/index.js",
    ]);
  });

  it.each([
    [
      "a created require used for resolution",
      'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconsole.log(require.resolve("left-pad"));',
      "used other than with a literal specifier",
    ],
    [
      "a created require loading workspace code",
      'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconsole.log(require("../../lib/src/tools"));',
      "not an installed package",
    ],
    ["a computed import", 'const name = "x";\nvoid import(name);', "computed import()"],
    ["a computed require", 'const name = "x";\nrequire(name);', "computed import() or require()"],
    ["the module's directory", "console.log(import.meta.dirname);", "import.meta.dirname"],
    ["an entry-point check", "if (import.meta.main) console.log(1);", "import.meta.main"],
    ["module resolution", 'console.log(import.meta.resolve("left-pad"));', "import.meta.resolve"],
    ["a computed import.meta property", 'console.log(import.meta["url"]);', "import.meta (line 1)"],
    [
      "a destructured import.meta",
      "const { url } = import.meta;\nconsole.log(url);",
      "import.meta",
    ],
    [
      "an exported created require",
      'import { createRequire } from "node:module";\nexport const load = createRequire(import.meta.url);',
      "exported load from createRequire(import.meta.url)",
    ],
    [
      "the module's URL",
      'import { createRequire } from "node:module";\ncreateRequire(import.meta.url);',
      "import.meta.url",
    ],
    [
      "a missing asset",
      'console.log(new URL("./missing.txt", import.meta.url));',
      "does not exist",
    ],
  ])("rejects %s", async (_case, code, message) => {
    const root = workspace({ "app/src/main.ts": code });
    await expect(buildRuntimeBundle(root, "fixture", config)).rejects.toThrow(message);
  });

  it("leaves out workspace modules whose exports are unused, with their dependencies", async () => {
    const files = (other: string) => ({
      "node_modules/right-pad/package.json": JSON.stringify({
        name: "right-pad",
        main: "index.js",
      }),
      "node_modules/right-pad/index.js": 'module.exports = (value) => value + " ";',
      "lib/src/index.ts": 'export * from "./tools";\nexport * from "./other";',
      "lib/src/other.ts": `import pad from "right-pad";\nexport const other = () => pad("${other}");`,
      "app/src/main.ts": 'import { used } from "../../lib/src/index";\nconsole.log(used());',
    });
    const bundle = await buildRuntimeBundle(workspace(files("a")), "fixture", config);
    expect(text(bundle, "main.mjs")).not.toContain("right-pad");
    expect(JSON.parse(text(bundle, EXTERNALS_MANIFEST))).toEqual([]);
    const edited = await buildRuntimeBundle(workspace(files("b")), "fixture", config);
    expect(edited.digest).toBe(bundle.digest);
  });

  it("requires modules that run code when imported to be listed", async () => {
    const files = {
      "lib/src/tools.ts": 'export const used = () => "used";\nconsole.log("loaded");',
    };
    await expect(buildRuntimeBundle(workspace(files), "fixture", config)).rejects.toThrow(
      "lib/src/tools.ts: runs code when imported (line 2)",
    );
    const listed = await buildRuntimeBundle(workspace(files), "fixture", {
      ...config,
      sideEffectModules: ["lib/src/tools.ts"],
    });
    expect(text(listed, "main.mjs")).toContain('console.log("loaded")');
    // Directives and declarations are not code that runs on import.
    const declarations = await buildRuntimeBundle(
      workspace({ "lib/src/tools.ts": '"use client";\nexport const used = () => "used";' }),
      "fixture",
      config,
    );
    expect(text(declarations, "main.mjs")).toContain('"used"');
  });

  it.each([
    [
      "an assignment in an initializer",
      "export const used = () => 1;\nexport const x = (globalThis.y = 1);",
    ],
    [
      "an await in an initializer",
      "export const used = () => 1;\nexport const x = await Promise.resolve(1);",
    ],
    [
      "an update in an initializer",
      "let n = 0;\nexport const used = () => 1;\nexport const x = n++;",
    ],
    ["a computed default export", 'export const used = () => 1;\nexport default Symbol.for("x");'],
    [
      "a class static block",
      "export const used = () => 1;\nexport class A { static { console.log(1); } }",
    ],
    [
      "a namespace with a body",
      "export const used = () => 1;\nexport namespace N { export const v = 1; }",
    ],
  ])("rejects a module with %s that an unused import would drop", async (_case, tools) => {
    await expect(
      buildRuntimeBundle(workspace({ "lib/src/tools.ts": tools }), "fixture", config),
    ).rejects.toThrow("lib/src/tools.ts: runs code when imported");
  });

  it("allows declarations whose initializers only compute values", async () => {
    const bundle = await buildRuntimeBundle(
      workspace({
        "lib/src/tools.ts": [
          "const make = (value: string) => ({ value });",
          'export const schema = make("x");',
          "export const used = () => schema.value;",
          "export default function named() { return 1; }",
          "declare global { var configured: boolean; }",
          'export class A { static label = "a"; }',
        ].join("\n"),
      }),
      "fixture",
      config,
    );
    expect(text(bundle, "main.mjs")).toContain('make("x")');
  });

  it("leaves out the assets of modules the bundle does not include", async () => {
    const files = (data: string) => ({
      "lib/src/index.ts": 'export * from "./tools";\nexport * from "./data";',
      "lib/src/data.ts":
        'import { readFileSync } from "node:fs";\nexport const data = () => readFileSync(new URL("./list.json", import.meta.url), "utf8");',
      "lib/src/list.json": data,
      "app/src/main.ts": 'import { used } from "../../lib/src/index";\nconsole.log(used());',
    });
    const bundle = await buildRuntimeBundle(workspace(files('["a"]')), "fixture", config);
    expect([...bundle.files.keys()].some((name) => name.startsWith("assets/"))).toBe(false);
    const edited = await buildRuntimeBundle(workspace(files('["b"]')), "fixture", config);
    expect(edited.digest).toBe(bundle.digest);
  });

  it("keeps a listed module's bare import and rejects an unlisted or unused listing", async () => {
    const files = {
      "lib/src/setup.ts": "globalThis.configured = true;",
      "app/src/main.ts": 'import "../../lib/src/setup";\nconsole.log(globalThis.configured);',
    };
    const listed = await buildRuntimeBundle(workspace(files), "fixture", {
      ...config,
      sideEffectModules: ["lib/src/setup.ts"],
    });
    expect(text(listed, "main.mjs")).toContain("globalThis.configured = true");
    await expect(
      buildRuntimeBundle(
        workspace({ ...files, "lib/src/setup.ts": "export {};" }),
        "fixture",
        config,
      ),
    ).rejects.toThrow("marked as having no side effects");
    await expect(
      buildRuntimeBundle(workspace(), "fixture", {
        ...config,
        sideEffectModules: ["lib/src/tools.ts", "lib/src/missing.ts"],
      }),
    ).rejects.toThrow(
      "sideEffectModules lists lib/src/missing.ts, which the bundle does not include",
    );
  });

  it("builds every repository bundle deterministically", async () => {
    const root = resolve(import.meta.dirname, "..");
    for (const image of Object.keys(RUNTIME_BUNDLES)) {
      const first = await buildRuntimeBundle(root, image);
      const second = await buildRuntimeBundle(root, image);
      expect(second.digest, image).toBe(first.digest);
      expect(JSON.parse(first.files.get(EXTERNALS_MANIFEST)?.toString() ?? "[]")).not.toEqual([]);
      expect(JSON.parse(first.files.get(PACKAGES_MANIFEST)?.toString() ?? "[]")).not.toEqual([]);
    }
    // Six full bundle builds; the parallel CI suite can take longer than the
    // 15 s default.
  }, 60_000);
});
