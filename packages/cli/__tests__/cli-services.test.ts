import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatServicesTable, listServices } from "../src/commands/services";

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
});
