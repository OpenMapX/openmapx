import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// Externalize every dependency, including `@openmapx/*` workspace packages.
// Bundling workspace packages would inline a private copy of any module-level
// state (e.g. `@openmapx/place-ids`'s resolver registry Map, `@openmapx/core`'s
// Overpass URL, `@openmapx/integration-framework`'s POI source store). At
// runtime tsx loads integrations as fresh module instances from
// /app/integrations/*/index.ts, and those imports follow node_modules symlinks
// to the canonical /app/packages/* — a different instance than the one
// bundled into dist/server.js. The two never see each other's writes, so an
// integration's `registerPlaceResolver(...)` call lands in a registry the
// route handler never reads, and the handler 404s with "no resolver". Same
// underlying reason as the `@integrations/*` alias note below.
const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  "@integrations/*",
];

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
