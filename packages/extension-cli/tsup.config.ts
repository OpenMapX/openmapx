import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  clean: true,
  // The bundle is ESM but inlines CommonJS dependencies (undici, reached
  // through @openmapx/core) that call `require("assert")` at load time.
  // esbuild's `__require` shim forwards to `require` when one exists and throws
  // "Dynamic require of ... is not supported" when it does not — which is
  // exactly what an ESM output lacks. Providing a real `createRequire` gives
  // those modules a working `require` instead.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __openmapxCreateRequire } from "node:module";',
      "const require = __openmapxCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Bundle the Apache-2.0 engine; keep esbuild external (it ships its own
  // platform binary and must be a real runtime dependency, not inlined).
  noExternal: [/^@openmapx\//],
  external: ["esbuild"],
});
