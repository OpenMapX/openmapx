import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// Externalize all npm dependencies but bundle workspace packages (@openmapx/*).
// `@integrations/*` is the runtime alias used by integrations/-aware code
// (see apps/api/tsconfig.json paths). Keep it external so the dynamically
// loaded integration module instance is the only one — see plugin below.
const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  "@integrations/*",
].filter((dep) => !dep.startsWith("@openmapx/"));

// Integrations are loaded at runtime via tsx as separate module instances
// (see apps/api/src/integration-host.ts — `await import(entryPoint)`).
// A relative import from apps/api/src/ into integrations/ inlines a copy
// of the target into dist/server.js, so module-level state (e.g. the
// orchestrators' `_ctx`) lives in two instances: the runtime copy that
// the integration's setup() initialised, and the bundled copy that the
// route handler reads. The bundled copy stays uninitialised forever.
//
// Use the `@integrations/*` alias instead. esbuild doesn't resolve it
// (no aliasing configured here), so it survives bundling and tsx
// resolves it at runtime to the same module the integration loaded.
const apiSrcPrefix = `${path.sep}apps${path.sep}api${path.sep}src${path.sep}`;
const noRelativeIntegrationsImports = {
  name: "no-relative-integrations-imports",
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.importer.includes(apiSrcPrefix)) return null;
      const resolved = path.resolve(args.resolveDir, args.path);
      const integrationsDir = `${path.sep}integrations${path.sep}`;
      if (!resolved.includes(integrationsDir)) return null;
      return {
        errors: [
          {
            text:
              `Relative import from apps/api/src into integrations/ is forbidden — ` +
              `it would be inlined into the bundle and shadow the runtime-loaded ` +
              `integration module. Use the \`@integrations/*\` alias instead.`,
            location: { file: args.importer },
          },
        ],
      };
    });
  },
};

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external,
  outfile: "dist/server.js",
  plugins: [noRelativeIntegrationsImports],
});
