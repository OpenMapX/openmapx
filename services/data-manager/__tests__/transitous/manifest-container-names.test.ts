import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { services } from "@openmapx/core/server";
import { describe, expect, it } from "vitest";
import {
  PRIMARY_CONTAINER,
  STAGING_CONTAINER,
} from "../../src/jobs/transitous/motis-containers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__/transitous -> __tests__ -> data-manager -> services -> repo root
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

describe("MOTIS container names follow the service manifests", () => {
  // The renderer names every container `serviceContainerName(<service id>)`;
  // a constant for a service that has no manifest would name no container.
  it.each([
    ["motis", PRIMARY_CONTAINER],
    ["motis-staging", STAGING_CONTAINER],
  ])("%s has a manifest and its container name", (serviceId, constant) => {
    expect(existsSync(join(REPO_ROOT, "services", serviceId, "service.json"))).toBe(true);
    expect(constant).toBe(services.serviceContainerName(serviceId));
  });
});
