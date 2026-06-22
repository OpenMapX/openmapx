import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // Bundle the Apache-2.0 engine; keep esbuild external (it ships its own
  // platform binary and must be a real runtime dependency, not inlined).
  noExternal: [/^@openmapx\//],
  external: ["esbuild"],
});
