import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

// Externalize all npm dependencies but bundle workspace packages (@openmapx/*)
const external = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
].filter((dep) => !dep.startsWith("@openmapx/"));

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external,
  outfile: "dist/server.js",
});
