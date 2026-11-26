import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCacheWrites } from "../policy/cache-writes.js";
import { AUTHOR_EXTENSIONS, serverModuleGraph } from "../policy/module-graph.js";
import { checkProviderHttp } from "../policy/provider-http.js";

const NONE = { "raw-fetch": {}, "credentialed-fetch-json": {}, "null-island": {} };

describe("policy library on arbitrary source", () => {
  it("reports raw fetch in a module outside the repository layout", () => {
    const failures = checkProviderHttp(
      new Map([["src/backend/client.ts", "export const load = (u: string) => fetch(u);"]]),
      NONE,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("src/backend/client.ts");
    expect(failures[0]).toContain("ctx.http");
  });
  it("accepts an exception with the exact count and rejects a stale one", () => {
    const modules = new Map([
      ["src/backend/a.ts", "export const p = () => fetch('http://engine/health');"],
    ]);
    const allowed = {
      ...NONE,
      "raw-fetch": { "src/backend/a.ts": { count: 1, reason: "engine readiness probe" } },
    };
    expect(checkProviderHttp(modules, allowed)).toEqual([]);
    expect(
      checkProviderHttp(new Map([["src/backend/a.ts", "export const p = 1;"]]), allowed)[0],
    ).toMatch(/remove its exception/);
  });
  it("reports fetchJson imported from the SDK when the call carries a credential", () => {
    const failures = checkProviderHttp(
      new Map([
        [
          "src/backend/a.ts",
          'import { fetchJson } from "@openmapx/integration-sdk/http";\nexport const load = (key: string) => fetchJson("https://example.org", { headers: { Authorization: key } });',
        ],
      ]),
      NONE,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("src/backend/a.ts");
  });
  it("reports fetchJson imported from its core module when the call carries a credential", () => {
    const failures = checkProviderHttp(
      new Map([
        [
          "src/backend/a.ts",
          'import { fetchJson } from "@openmapx/core/http/fetchJson";\nexport const load = (key: string) => fetchJson("https://example.org", { headers: { Authorization: key } });',
        ],
      ]),
      NONE,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("src/backend/a.ts");
  });
  it("reports a direct cache write", () => {
    const failures = checkCacheWrites(
      new Map([
        [
          "src/backend/index.ts",
          "export async function s(ctx: any) { await ctx.cache.set('k', 1, 60); }",
        ],
      ]),
      {},
    );
    expect(failures).toHaveLength(1);
  });
  it("follows relative imports from the entry and skips type-only imports and tests", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-graph-"));
    mkdirSync(join(root, "src/backend"), { recursive: true });
    writeFileSync(
      join(root, "src/backend/index.ts"),
      'import { a } from "./a.js"; import type { T } from "./types.js"; export const x = a;',
    );
    writeFileSync(join(root, "src/backend/a.ts"), "export const a = 1;");
    writeFileSync(join(root, "src/backend/types.ts"), "export type T = 1;");
    writeFileSync(join(root, "src/backend/a.test.ts"), "export {};");
    const graph = serverModuleGraph(
      [join(root, "src/backend/index.ts")],
      new Set(["node_modules", "dist"]),
    );
    expect(graph.map((p) => p.slice(root.length + 1)).sort()).toEqual([
      "src/backend/a.ts",
      "src/backend/index.ts",
    ]);
  });
  it("reads a JavaScript backend only when asked for author extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-graph-js-"));
    mkdirSync(join(root, "src/backend"), { recursive: true });
    writeFileSync(
      join(root, "src/backend/index.js"),
      'import { a } from "./a.js"; export const x = a;',
    );
    writeFileSync(join(root, "src/backend/a.js"), "export const a = 1;");
    const entry = [join(root, "src/backend/index.js")];
    const skipped = new Set(["node_modules", "dist"]);
    expect(serverModuleGraph(entry, skipped)).toEqual([]);
    expect(serverModuleGraph(entry, skipped, AUTHOR_EXTENSIONS)).toHaveLength(2);
  });
});
