import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("server HTTP import boundaries", () => {
  it.each([
    ["core server-api", "../api/server.ts"],
    ["admin deployment", "../../../../apps/web/src/lib/admin/serverDeployment.ts"],
  ])("bundles %s without React, query caches or host services", async (_name, relativeEntry) => {
    const entry = fileURLToPath(new URL(relativeEntry, import.meta.url));
    const result = await build({
      bundle: true,
      format: "esm",
      metafile: true,
      platform: "node",
      stdin: {
        contents: `import * as server from ${JSON.stringify(entry)}; export { server };`,
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        sourcefile: "server-http-namespace.ts",
      },
      treeShaking: false,
      write: false,
    });

    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile.inputs);
    // The two pure platform/release value schemas live beside host services.
    // Their precise exceptions below must never introduce a Node builtin.
    expect(
      Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((entry) => entry.external && isBuiltin(entry.path)),
    ).toEqual([]);
    expect(inputs.some((path) => path.endsWith("/api/client.ts"))).toBe(true);
    expect(
      inputs.filter((path) =>
        /(?:^|\/)(?:react|react-dom|@tanstack)(?:\/|@)|packages\/core\/src\/(?:index\.ts|hooks\/|stores\/|server(?:\.ts|\/)|services\/(?!data-manager\/contracts\/|platform-configuration\.ts$|release-selection\.ts$))|\/admin\/serviceAdmin\.ts/.test(
          path,
        ),
      ),
    ).toEqual([]);
  });
});
