import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatServicesTable, listServices } from "../src/commands/services";
import {
  disableSelectedServices,
  enableSelectedServices,
  getServiceSelectionSummary,
  readServiceSelection,
} from "../src/lib/service-selection";

let tmp: string;

function writeManifest(slug: string, body: Record<string, unknown>) {
  const dir = join(tmp, "services", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify(body), "utf-8");
}

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  quality: "built-in",
  container: { image: "t/x", tag: "latest", expose: [80] },
};

beforeEach(() => {
  delete process.env.OPENMAPX_ENABLED_SERVICES;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("listServices", () => {
  it("lists installed services", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha", provides: ["routing-engine"] });
    writeManifest("beta", { ...baseManifest, id: "beta", provides: ["geocoder"] });

    const list = await listServices({ rootDir: tmp });
    expect(list.map((s) => s.manifest.id).sort()).toEqual(["alpha", "beta"]);
  });

  it("filters by capability", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha", provides: ["routing-engine"] });
    writeManifest("beta", { ...baseManifest, id: "beta", provides: ["geocoder"] });

    const list = await listServices({ rootDir: tmp, capability: "geocoder" });
    expect(list.map((s) => s.manifest.id)).toEqual(["beta"]);
  });

  it("formats services as table", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha", provides: ["routing-engine"] });
    const list = await listServices({ rootDir: tmp });
    const out = formatServicesTable(list);
    expect(out).toContain("alpha");
    expect(out).toContain("routing-engine");
  });

  it("marks only the effective service selection as enabled", async () => {
    writeManifest("app-api", {
      ...baseManifest,
      id: "app-api",
      container: {
        ...baseManifest.container,
        dependsOn: [{ service: "postgis", condition: "service_healthy" }],
      },
    });
    writeManifest("postgis", { ...baseManifest, id: "postgis" });
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });

    const enabled = await listServices({ rootDir: tmp, enabledOnly: true });

    expect(enabled.map((s) => s.manifest.id).sort()).toEqual(["app-api", "postgis"]);
  });
});

describe("service selection persistence", () => {
  it("enables and disables root selections in infra/docker/service-selection.json", async () => {
    writeManifest("traefik", { ...baseManifest, id: "traefik" });
    writeManifest("well-known", { ...baseManifest, id: "well-known" });
    writeManifest("app-api", { ...baseManifest, id: "app-api" });
    writeManifest("app-web", { ...baseManifest, id: "app-web" });
    writeManifest("postgis", { ...baseManifest, id: "postgis" });
    writeManifest("redis", { ...baseManifest, id: "redis" });
    writeManifest("data-manager", { ...baseManifest, id: "data-manager" });
    writeManifest("valhalla", { ...baseManifest, id: "valhalla" });

    enableSelectedServices(["valhalla"], tmp);
    expect(readServiceSelection(tmp)?.selected).toContain("valhalla");
    expect((await getServiceSelectionSummary(tmp)).selection.enabledIdsOrdered).toContain(
      "valhalla",
    );

    disableSelectedServices(["app-api"], tmp);
    expect(readServiceSelection(tmp)?.selected).not.toContain("app-api");
    expect((await getServiceSelectionSummary(tmp)).selection.enabledIdsOrdered).not.toContain(
      "app-api",
    );
  });
});
