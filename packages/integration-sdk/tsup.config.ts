import { readdirSync } from "node:fs";
import { defineConfig } from "tsup";

// Private workspace packages are inlined into the published build: they are not
// on npm, so an author's bundler could not resolve them. The declarations are
// bundled by rollup.config.mjs, because tsup's declaration build treats every
// dependency as external and does not follow `exports` subpaths.
const inlined = [
  /^@openmapx\/(integration-framework|core|mobility-core|mobility-formats|place-ids|air-quality|provider-kit|transitous-core|motis-feed-proxy-config)(\/|$)/,
  "@hey-api/client-fetch",
];

const entry = Object.fromEntries(
  readdirSync("src")
    .filter((file) => file.endsWith(".ts"))
    .map((file) => [file.slice(0, -".ts".length), `src/${file}`]),
);

export default defineConfig({
  entry,
  format: ["esm"],
  metafile: true,
  clean: true,
  noExternal: inlined,
  external: ["zod", /^zod\//, "@openmapx/extension-contracts", /^@openmapx\/extension-contracts\//],
  dts: false,
});
