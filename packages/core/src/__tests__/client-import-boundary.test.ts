import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const clientEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("client-facing core entry", () => {
  it("bundles a namespace import for the browser without Node-only transport code", async () => {
    await expect(
      build({
        bundle: true,
        format: "esm",
        platform: "browser",
        stdin: {
          contents: `import * as core from ${JSON.stringify(clientEntry)}; export { core };`,
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
          sourcefile: "client-core-namespace.ts",
        },
        write: false,
      }),
    ).resolves.toMatchObject({ errors: [] });
  });
});
