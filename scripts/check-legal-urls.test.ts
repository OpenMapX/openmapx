import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Exercise the CLI and its exit status, replacing only the external HTTP boundary.
function runCheck(
  head: number | string,
  gets: (number | string)[],
  blockedUa = false,
  url = "https://provider.example/privacy",
  now = "2026-10-04T00:00:00Z",
) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-legal-urls-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "integrations/provider"), { recursive: true });
  copyFileSync(
    join(import.meta.dirname, "check-legal-urls.ts"),
    join(root, "scripts/check-legal-urls.ts"),
  );
  writeFileSync(
    join(root, "integrations/provider/manifest.json"),
    JSON.stringify({
      id: "provider",
      dataSources: [{ sourceId: "source", url }],
    }),
  );
  const preload = join(root, "http.cjs");
  writeFileSync(
    preload,
    `
    const gets = ${JSON.stringify(gets)};
    Date.now = () => Date.parse(${JSON.stringify(now)});
    let next = 0;
    global.fetch = async (_url, options) => {
      let result = options.method === 'HEAD' ? ${JSON.stringify(head)} : gets[Math.min(next++, gets.length - 1)];
      if (${blockedUa} && options.headers['user-agent'].includes('OpenMapX-LinkCheck')) result = 502;
      if (typeof result === 'string') throw new Error(result, { cause: { code: result } });
      return new Response(null, { status: result });
    };
  `,
  );
  try {
    return spawnSync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        "--require",
        preload,
        join(root, "scripts/check-legal-urls.ts"),
      ],
      { encoding: "utf8" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("legal URL liveness CLI", () => {
  it.each([500, 502, 503, "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"])(
    "reports %s as unverified rather than a dead link",
    (failure) => {
      const result = runCheck(failure, [failure]);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("could not be verified");
    },
  );
  it("does not trust a negative HEAD when GET fails", () => {
    const result = runCheck(404, ["ECONNRESET"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not be verified");
  });
  it("recovers when a temporary GET failure succeeds on retry", () => {
    const result = runCheck(503, [503, 200]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not be verified");
  });
  it("avoids the user agent that triggers provider blocking", () => {
    const result = runCheck(200, [200], true);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not be verified");
  });
  it.each([404, 410])("still blocks a GET-confirmed HTTP %s", (status) => {
    const result = runCheck(status, [status]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`HTTP ${status}`);
  });
  it("reports the browser-verified Uber false 404 as unverified, with evidence", () => {
    const result = runCheck(
      404,
      [404],
      false,
      "https://developer.uber.com/docs/businesses/terms-of-use",
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Browser verified on 2026-10-04");
    expect(result.stderr).toContain("2026-11-03");
  });
  it("stops exempting Uber after its manual verification expires", () => {
    const result = runCheck(
      404,
      [404],
      false,
      "https://developer.uber.com/docs/businesses/terms-of-use",
      "2026-11-03T00:00:00Z",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP 404");
  });
  it("does not exempt a newly gone Uber page returning 410", () => {
    const result = runCheck(
      410,
      [410],
      false,
      "https://developer.uber.com/docs/businesses/terms-of-use",
    );
    expect(result.status).toBe(1);
  });
  it("accepts a working GET even when HEAD reports 404", () => {
    const result = runCheck(404, [200]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
