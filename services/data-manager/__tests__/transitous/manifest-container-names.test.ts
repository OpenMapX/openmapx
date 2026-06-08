import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FEED_PROXY_CONTAINER,
  PRIMARY_CONTAINER,
  STAGING_CONTAINER,
} from "../../src/jobs/transitous/motis-containers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__/transitous -> __tests__ -> data-manager -> services -> repo root
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

function manifestContainerName(serviceId: string): unknown {
  const path = join(REPO_ROOT, "services", serviceId, "service.json");
  const manifest = JSON.parse(readFileSync(path, "utf-8"));
  return manifest?.container?.containerName;
}

describe("MOTIS container-name constants stay in sync with the service manifests", () => {
  // The data-manager addresses these containers by bare name over the docker
  // CLI (`docker exec`, `docker restart`, `docker stop`); the compose renderer
  // emits `container_name` from the manifest's `container.containerName`. If the
  // two drift, the docker calls fail at runtime with "No such container" — this
  // test converts that silent runtime drift into a build-time failure.
  it.each([
    ["motis", PRIMARY_CONTAINER],
    ["motis-staging", STAGING_CONTAINER],
    ["motis-feed-proxy", FEED_PROXY_CONTAINER],
  ])("%s manifest containerName equals the data-manager constant", (serviceId, constant) => {
    expect(manifestContainerName(serviceId)).toBe(constant);
    // The renderer + stages assume the pinned name equals the service id.
    expect(constant).toBe(serviceId);
  });
});
