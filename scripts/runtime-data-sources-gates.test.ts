import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_KEYED_INTEGRATIONS,
  collectCredentialKeyViolations,
} from "./check-credential-keys.ts";
import { runtimeDataSourceIntegrations } from "./check-feed-ids.ts";

// Integrations whose manifests set `runtimeDataSources: true` have no static
// sources for the manifest gates to read. Every gate must say so explicitly
// rather than pass over them silently.

let root: string;

function writeManifest(id: string, manifest: Record<string, unknown>) {
  mkdirSync(join(root, "integrations", id), { recursive: true });
  writeFileSync(
    join(root, "integrations", id, "manifest.json"),
    JSON.stringify({ id, domains: ["road-conditions"], ...manifest }),
  );
}

function runScript(name: string) {
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    dirname(fileURLToPath(import.meta.resolve("p-map"))),
    join(root, "node_modules/p-map"),
    "dir",
  );
  copyFileSync(join(import.meta.dirname, name), join(root, "scripts", name));
  const preload = join(root, "no-network.cjs");
  writeFileSync(
    preload,
    "global.fetch = async () => { throw new Error('network disabled in test'); };",
  );
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "--require",
      preload,
      join(root, "scripts", name),
    ],
    { encoding: "utf8" },
  );
}

beforeEach(() => {
  // Real path: check-data-flows only runs its CLI when argv[1] equals its own
  // module URL, and the macOS temp dir is reached through a symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "omx-runtime-gates-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-feed-ids", () => {
  it("lists a runtime integration with the reason its sources are not checked", () => {
    writeManifest("runtime-probe", { runtimeDataSources: true });
    writeManifest("static-probe", {});
    expect(runtimeDataSourceIntegrations(root)).toEqual(["runtime-probe"]);
  });
});

describe("check-credential-keys", () => {
  it("rejects a credential-keyed integration that supplies its sources at runtime", () => {
    for (const id of CREDENTIAL_KEYED_INTEGRATIONS) writeManifest(id, {});
    writeManifest("bike-sharing", { runtimeDataSources: true });
    expect(collectCredentialKeyViolations(root)).toEqual([
      expect.stringMatching(/^bike-sharing: .*runtimeDataSources/),
    ]);
  });
});

describe("check-data-flows", () => {
  it("accepts declared URL siblings, explicit API hosts, public suffixes, allowlisted domains and internal services through the actual CLI", () => {
    const fixtures = [
      {
        id: "url-sibling",
        source: { url: "https://developer.actual-provider.org" },
        host: "api.actual-provider.org",
      },
      {
        id: "api-host",
        source: { url: "https://vendor-information.org", apiHosts: ["api.actual-service.net"] },
        host: "data.actual-service.net",
      },
      {
        id: "public-suffix",
        source: { url: "https://developer.provider.co.uk" },
        host: "api.provider.co.uk",
      },
      { id: "allowlisted", source: {}, host: "tiles.openstreetmap.org" },
      { id: "internal", source: {}, host: "app-api" },
    ];
    for (const fixture of fixtures) {
      writeManifest(fixture.id, { dataSources: [fixture.source] });
      writeFileSync(
        join(root, "integrations", fixture.id, "index.ts"),
        `export const upstream = "https://${fixture.host}/data";\n`,
      );
    }
    const result = runScript("check-data-flows.ts");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("every contacted host is declared or allowlisted");
  });
  it("names a runtime integration and still fails an undeclared host in its code", () => {
    writeManifest("runtime-probe", { runtimeDataSources: true });
    writeFileSync(
      join(root, "integrations", "runtime-probe", "index.ts"),
      'export const upstream = "https://api.undeclared.org/feed";\n',
    );
    const result = runScript("check-data-flows.ts");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/runtime-probe.*runtime/);
    expect(result.stderr).toContain("[undisclosed-host] undeclared.org");
  });

  it("checks media hosts of a runtime integration as server-only", () => {
    writeManifest("runtime-probe", { runtimeDataSources: true });
    writeFileSync(
      join(root, "integrations", "runtime-probe", "index.ts"),
      'export const photo = "https://cdn.photos.org/a.jpg";\n',
    );
    const result = runScript("check-data-flows.ts");
    expect(result.stderr).toContain("[media-exposure] cdn.photos.org");
  });
});

describe("check-legal-urls", () => {
  it("names a runtime integration whose URLs it cannot check", () => {
    writeManifest("runtime-probe", { runtimeDataSources: true });
    const result = runScript("check-legal-urls.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/runtime-probe.*runtime/);
  });
});
