import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configurationReleaseServiceImagesSchema } from "../../ops/configuration-release-downloads";
import { releaseProvenance } from "../__fixtures__/release-provenance";
import {
  CONTROL_PLANE_SERVICE_IDS,
  CORE_RESTART_SERVICE_IDS,
  CORE_SERVICE_ID,
  PROTECTED_CONFIGURATION_SERVICE_IDS,
  RELEASE_PINNED_SERVICE_IDS,
} from "../core-service-ids";
import { RELEASE_BUILT_IN_SERVICE_IDS } from "../release-authority-inventory";
import { type ReleaseManifest, releaseServiceImages } from "../release-manifest";
import { selfUpdateServiceOrder } from "../self-update-order";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const sorted = (ids: Iterable<string>) => [...ids].sort();
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  release: "abc123",
  images: {
    api: `ghcr.io/openmapx/api@${digest("a")}`,
    web: `ghcr.io/openmapx/web@${digest("b")}`,
    "data-manager": `ghcr.io/openmapx/data-manager@${digest("c")}`,
    "ops-agent": `ghcr.io/openmapx/ops-agent@${digest("d")}`,
    "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
  },
  ...releaseProvenance(),
};

describe("core service IDs", () => {
  it("names only built-in services, each in its own services/<id> directory", () => {
    for (const id of Object.values(CORE_SERVICE_ID)) {
      expect(RELEASE_BUILT_IN_SERVICE_IDS).toContain(id);
      const raw = JSON.parse(
        readFileSync(join(REPOSITORY_ROOT, "services", id, "service.json"), "utf8"),
      ) as { id?: unknown };
      expect(raw.id).toBe(id);
    }
  });

  it("reaches the API internally through its project-unique alias, never the bare service ID", () => {
    const read = (id: string) =>
      JSON.parse(readFileSync(join(REPOSITORY_ROOT, "services", id, "service.json"), "utf8")) as {
        container: { networkAliases?: string[]; environment?: Record<string, string> };
      };
    const aliases = read(CORE_SERVICE_ID.api).container.networkAliases ?? [];
    expect(aliases).not.toContain(CORE_SERVICE_ID.api);
    const internalUrls = [
      read(CORE_SERVICE_ID.web).container.environment?.INTERNAL_API_URL,
      read(CORE_SERVICE_ID.dataManager).container.environment?.INTERNAL_API_URL,
    ];
    for (const value of internalUrls) {
      const url = /https?:\/\/[^/:}]+:\d+/.exec(value ?? "")?.[0];
      expect(url, value).toBeDefined();
      expect(aliases).toContain(new URL(url ?? "").hostname);
    }
  });

  it("restarts only control-plane services through the core-restart workflow", () => {
    for (const id of CORE_RESTART_SERVICE_IDS) expect(CONTROL_PLANE_SERVICE_IDS).toContain(id);
  });

  it("pins exactly the services the release names an image for", () => {
    expect(sorted(Object.keys(releaseServiceImages(manifest)))).toEqual(
      sorted(RELEASE_PINNED_SERVICE_IDS),
    );
    expect(sorted(Object.keys(configurationReleaseServiceImagesSchema.shape))).toEqual(
      sorted(RELEASE_PINNED_SERVICE_IDS),
    );
  });

  it("replaces the protected services last, in their fixed order", () => {
    expect(
      selfUpdateServiceOrder(["martin", ...[...PROTECTED_CONFIGURATION_SERVICE_IDS].reverse()]),
    ).toEqual(["martin", ...PROTECTED_CONFIGURATION_SERVICE_IDS]);
    expect(PROTECTED_CONFIGURATION_SERVICE_IDS.at(-1)).toBe(CORE_SERVICE_ID.opsAgent);
  });
});
