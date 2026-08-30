import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("browser package entry", () => {
  it("bundles without Node hashing or the jurisdiction geometry", async () => {
    const result = await build({
      entryPoints: [new URL("../index.ts", import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.some((path) => path.includes("supported.geojson"))).toBe(false);
    expect(inputs.some((path) => path.includes("jurisdiction/resolve"))).toBe(false);
    expect(inputs.some((path) => path.endsWith("/ids.ts"))).toBe(false);
    expect(new TextDecoder().decode(result.outputFiles[0]?.contents)).not.toContain("node:crypto");
  });
});
