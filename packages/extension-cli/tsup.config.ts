import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  clean: true,
  // One file: a dynamic import inside a core module the CLI never reaches
  // would otherwise still be emitted as an unreferenced chunk.
  splitting: false,
  // The bundle is ESM but inlines CommonJS dependencies such as the spdx
  // packages. esbuild's `__require` shim throws "Dynamic require of ... is not
  // supported" when an ESM output has no `require`. None of today's bundled
  // dependencies requires a Node built-in, so this real `createRequire` is
  // insurance for one that does.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __openmapxCreateRequire } from "node:module";',
      "const require = __openmapxCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Bundle the Apache-2.0 engine and its workspace dependencies.
  noExternal: [/^@openmapx\//],
});
