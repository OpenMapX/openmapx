import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SERVICES_WITHOUT_PRIVILEGE_LOCK,
  renderCompose,
} from "../services/compose-renderer";
import { findServiceManifestDirs } from "../services/manifest-discovery";
import { serviceManifestSchema } from "../services/manifest-schema";
import type { LoadedService, ServiceManifest } from "../services/types";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

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

/** The whole built-in stack, rendered once with every service enabled. */
function renderedSecurityOptions(): Map<string, string[] | undefined> {
  const compose = renderCompose(loadBuiltIns(), {
    domain: "maps.example.test",
    existsSync: () => true,
  });
  const services = (
    parseYaml(compose.composeYaml) as {
      services: Record<string, { security_opt?: string[] }>;
    }
  ).services;
  return new Map(Object.entries(services).map(([id, service]) => [id, service.security_opt]));
}

describe("privilege lock on built-in services", () => {
  const rendered = renderedSecurityOptions();
  const builtInIds = loadBuiltIns().map((service) => service.manifest.id);

  it("renders every built-in service", () => {
    expect([...rendered.keys()].sort()).toEqual([...builtInIds].sort());
  });

  it("locks every built-in service that is not listed as running without the lock", () => {
    const neitherLockedNorListed = builtInIds.filter(
      (id) =>
        !BUILT_IN_SERVICES_WITHOUT_PRIVILEGE_LOCK.has(id) &&
        !rendered.get(id)?.includes("no-new-privileges:true"),
    );
    expect(neitherLockedNorListed).toEqual([]);
  });

  it("leaves exactly the listed services without the lock", () => {
    const listedButLocked = [...BUILT_IN_SERVICES_WITHOUT_PRIVILEGE_LOCK].filter(
      (id) => rendered.get(id) !== undefined,
    );
    expect(listedButLocked).toEqual([]);
  });

  it("lists only services that still exist", () => {
    const unknown = [...BUILT_IN_SERVICES_WITHOUT_PRIVILEGE_LOCK].filter(
      (id) => !builtInIds.includes(id),
    );
    expect(unknown).toEqual([]);
  });
});
