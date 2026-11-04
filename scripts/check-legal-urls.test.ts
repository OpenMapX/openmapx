import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface CheckOptions {
  /** Simulate a provider that blocks the old link-check user agent. */
  blockedUa?: boolean;
  url?: string;
  /** Simulate a server that answers 404 to every request that doesn't ask for HTML. */
  htmlOnly?: boolean;
  dataSource?: Record<string, unknown>;
  /** Error code the direct DNS queries fail with; they succeed when unset. */
  dnsCode?: string;
  /** Ask the CLI for its Markdown report and return it. */
  report?: boolean;
}

// Exercise the CLI and its exit status, replacing only the external HTTP and DNS boundaries.
function runCheck(head: number | string, gets: (number | string)[], options: CheckOptions = {}) {
  const url = options.url ?? "https://provider.example/privacy";
  const dataSource = options.dataSource ?? { sourceId: "source", url };
  const root = mkdtempSync(join(tmpdir(), "openmapx-legal-urls-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "node_modules"));
  // The copied CLI still uses the real direct dependency; only HTTP and DNS are replaced.
  symlinkSync(
    dirname(fileURLToPath(import.meta.resolve("p-map"))),
    join(root, "node_modules/p-map"),
    "dir",
  );
  mkdirSync(join(root, "integrations/provider"), { recursive: true });
  copyFileSync(
    join(import.meta.dirname, "check-legal-urls.ts"),
    join(root, "scripts/check-legal-urls.ts"),
  );
  writeFileSync(
    join(root, "integrations/provider/manifest.json"),
    JSON.stringify({ id: "provider", dataSources: [dataSource] }),
  );
  const preload = join(root, "http.cjs");
  writeFileSync(
    preload,
    `
    const gets = ${JSON.stringify(gets)};
    let next = 0;
    global.fetch = async (_url, options) => {
      let result = options.method === 'HEAD' ? ${JSON.stringify(head)} : gets[Math.min(next++, gets.length - 1)];
      if (${options.blockedUa === true} && options.headers['user-agent'].includes('OpenMapX-LinkCheck')) result = 502;
      if (${options.htmlOnly === true} && !options.headers.accept.startsWith('text/html')) result = 404;
      if (typeof result === 'string') throw new TypeError('fetch failed', { cause: Object.assign(new Error(result), { code: result }) });
      return new Response(null, { status: result });
    };
    const dnsCode = ${JSON.stringify(options.dnsCode ?? null)};
    const answer = async () => {
      if (dnsCode) throw Object.assign(new Error(dnsCode), { code: dnsCode });
      return ['192.0.2.1'];
    };
    require('node:dns').promises.Resolver = class { resolve4() { return answer(); } resolve6() { return answer(); } };
  `,
  );
  const reportPath = join(root, "report.md");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        "--require",
        preload,
        join(root, "scripts/check-legal-urls.ts"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, LEGAL_URLS_REPORT: options.report ? reportPath : "" },
      },
    );
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined;
    return { ...result, report };
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
    const result = runCheck(200, [200], { blockedUa: true });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not be verified");
  });
  it.each([404, 410])("still blocks a GET-confirmed HTTP %s", (status) => {
    const result = runCheck(status, [status]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`HTTP ${status}`);
  });
  it("asks for HTML so servers that 404 wildcard requests are not reported dead", () => {
    const result = runCheck(200, [200], { htmlOnly: true });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
  it.each(["ENOTFOUND", "EAI_AGAIN"])(
    "blocks a %s failure when DNS confirms the domain does not exist",
    (failure) => {
      const result = runCheck(failure, [failure], { dnsCode: "ENOTFOUND" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("domain does not exist (NXDOMAIN)");
    },
  );
  it("keeps a domain whose name servers do not answer unverified, and says so", () => {
    const result = runCheck("EAI_AGAIN", ["EAI_AGAIN"], { dnsCode: "ESERVFAIL" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("DNS SERVFAIL");
  });
  it("does not consult DNS for failures unrelated to name resolution", () => {
    const result = runCheck("ECONNRESET", ["ECONNRESET"], { dnsCode: "ENOTFOUND" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not be verified");
  });
  it.each([
    "http://localhost:8090/",
    "http://127.0.0.1/",
    "http://192.168.1.10/api",
    "http://[::1]:8080/",
    "http://printer.local/",
  ])("skips the placeholder address %s instead of checking it", (url) => {
    const result = runCheck("ECONNREFUSED", ["ECONNREFUSED"], { url });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`skipped placeholder ${url}`);
    expect(result.stderr).toBe("");
  });
  it("checks licence URLs nested in the licensing block and names their path", () => {
    const result = runCheck(404, [404], {
      dataSource: {
        sourceId: "source",
        licensing: {
          version: 1,
          bindings: [
            { scope: "data", license: { kind: "unknown", url: "https://provider.example/terms" } },
          ],
        },
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'licensing.bindings[0].license.url · source "source" → https://provider.example/terms',
    );
  });
  it("writes a Markdown report listing dead links in a table", () => {
    const result = runCheck(404, [404], { report: true });
    expect(result.status).toBe(1);
    expect(result.report).toContain("**1 dead link(s)** of 1 checked");
    expect(result.report).toContain(
      "| `integrations/provider` | `source` | `url` | https://provider.example/privacy | HTTP 404 |",
    );
  });
  it("reports a clean run, with unverified links folded away", () => {
    const result = runCheck(503, [503], { report: true });
    expect(result.status).toBe(0);
    expect(result.report).toContain("No dead links among 1 checked.");
    expect(result.report).toContain("<summary>1 URL(s) could not be verified (not blocking)");
  });
  it("writes no report unless one is requested", () => {
    const result = runCheck(404, [404]);
    expect(result.report).toBeUndefined();
  });
  it("accepts a working GET even when HEAD reports 404", () => {
    const result = runCheck(404, [200]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
