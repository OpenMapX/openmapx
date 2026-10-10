import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Next can copy worker URLs as static assets. Emit self-contained JavaScript
// so either compiler serves executable code without unresolved workspace imports.
await build({
  entryPoints: [resolve(webRoot, "src/components/navigation/junction/photoAlignment.worker.ts")],
  bundle: true,
  outfile: resolve(webRoot, "src/generated/photoAlignment.worker.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
});
