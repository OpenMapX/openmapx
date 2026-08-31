import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const clientEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

describe("client-facing core entry", () => {
  it("bundles a namespace import for the browser without Node-only transport code", async () => {
    const result = await build({
      bundle: true,
      format: "esm",
      metafile: true,
      platform: "browser",
      stdin: {
        contents: `import * as core from ${JSON.stringify(clientEntry)}; export { core };`,
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        sourcefile: "client-core-namespace.ts",
      },
      write: false,
    });

    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((path) => path.includes("packages/mobility-core/src/"))).toBe(true);
    expect(
      inputs.filter((path) =>
        /(?:safe-download|undici-fetch|gbfs-|motis-|ris-client|\/server(?:\.ts|\/))/.test(path),
      ),
    ).toEqual([]);
  });
});
