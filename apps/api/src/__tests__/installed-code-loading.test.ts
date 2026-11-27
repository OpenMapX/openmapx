import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const HOST_SCRIPT = fileURLToPath(new URL("../../scripts/proof/host.mts", import.meta.url));
const API_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

describe("installed code loading", () => {
  it("shares host instances with a bundle imported from the cache", async () => {
    const tsx = createRequire(import.meta.url).resolve("tsx/esm");
    // The image starts the API from its own directory with NODE_ENV=production.
    const { stdout } = await execFileAsync(process.execPath, ["--import", tsx, HOST_SCRIPT], {
      timeout: 60_000,
      cwd: API_DIRECTORY,
      env: { ...process.env, NODE_ENV: "production" },
    });
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
    expect(result.timeoutIsHostClass).toBe(true);
    expect(result.zodErrorIsHostClass).toBe(true);
    expect(result.singleZod).toBe(true);
    expect(result.resolverVisibleToHost).toBe(true);
    expect(result.sameBytesTwoIdsAreDistinctModules).toBe(true);
    expect(result.largeBundleDigestMatches).toBe(true);
    expect(typeof result.largeBundleImportMs).toBe("number");
  }, 90_000);
});
