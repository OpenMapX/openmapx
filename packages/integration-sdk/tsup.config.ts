import { readdirSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { INLINED_WORKSPACE_PACKAGES } from "./inlined-packages.mjs";

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
};

// Private workspace packages are inlined into the published build: they are not
// on npm, so an author's bundler could not resolve them. The declarations are
// bundled by rollup.config.mjs, because tsup's declaration build treats every
// dependency as external and does not follow `exports` subpaths.
const inlined = [INLINED_WORKSPACE_PACKAGES, "@hey-api/client-fetch"];

const entry = Object.fromEntries(
  readdirSync("src")
    .filter((file) => file.endsWith(".ts"))
    .map((file) => [file.slice(0, -".ts".length), `src/${file}`]),
);

// Every other dependency is published on npm and installed with the SDK, so it
// stays an import: zod, the contracts package and the third-party libraries
// that shared helpers call at run time.
const external = Object.keys(manifest.dependencies)
  .filter((name) => !name.startsWith("@types/") && !INLINED_WORKSPACE_PACKAGES.test(name))
  .flatMap((name) => [name, new RegExp(`^${name.replaceAll("/", "\\/")}\\/`)]);

export default defineConfig({
  entry,
  format: ["esm"],
  metafile: true,
  clean: true,
  noExternal: inlined,
  external,
  dts: false,
});
