import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../services/compose-renderer";
import { serviceContainerName, serviceNetworkAlias } from "../services/core-service-ids";
import { findServiceManifestDirs } from "../services/manifest-discovery";
import { serviceManifestSchema } from "../services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../services/types";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * Services whose containers the operations agent, data-manager or CLI address
 * by name (`docker exec`, `inspect`, `stop`, `logs`), always through
 * `serviceContainerName`.
 */
const ADDRESSED_SERVICE_IDS = [
  "postgis",
  "redis",
  "valhalla",
  "motis",
  "motis-staging",
  "motis-feed-proxy",
  "dawarich-app",
];

function loadBuiltIns(): LoadedService[] {
  return findServiceManifestDirs(join(REPO_ROOT, "services")).map((directory) => ({
    manifest: serviceManifestSchema.parse(
      JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
    ) as unknown as ServiceManifest,
    directory,
    isBuiltIn: true,
    enabled: true,
  }));
}

describe("built-in container names", () => {
  const builtIns = loadBuiltIns();
  const rendered = (
    parseYaml(
      renderCompose(builtIns, { domain: "maps.example.test", existsSync: () => true }).composeYaml,
    ) as { services: Record<string, { container_name?: string }> }
  ).services;

  it("renders every service's container under its network alias", () => {
    expect(Object.keys(rendered).length).toBe(builtIns.length);
    for (const [serviceId, service] of Object.entries(rendered)) {
      expect(service.container_name, serviceId).toBe(serviceContainerName(serviceId));
      expect(service.container_name, serviceId).toBe(serviceNetworkAlias(serviceId));
    }
  });

  it.each(ADDRESSED_SERVICE_IDS)("renders the addressed service %s", (serviceId) => {
    expect(rendered[serviceId]?.container_name).toBe(serviceContainerName(serviceId));
  });
});
