import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { describe, expect, it, vi } from "vitest";
import { createProductionRegistryResourceClaimer, denyAllTrustedOpsData } from "./policy";
import {
  afterValidatedServiceAuthority,
  resolveBootstrapEnabledServiceIds,
} from "./startup-authority";

describe("ops-agent startup authority gate", () => {
  it("performs no registry, journal, queue, or runtime initialization after failed inventory validation", async () => {
    const initialize = vi.fn(async () => undefined);
    await expect(
      afterValidatedServiceAuthority("/trusted/root", initialize, async () => {
        throw new Error("invalid fixed inventory");
      }),
    ).rejects.toThrow("invalid fixed inventory");
    expect(initialize).not.toHaveBeenCalled();
  });

  it("passes the one immutable captured release generation into initialization", async () => {
    const captured: services.ReleaseServiceAuthorityCapture = Object.freeze({
      serviceIds: Object.freeze(["redis"]),
      services: Object.freeze([]),
      digest: `release1_${"a".repeat(43)}`,
    });
    const initialize = vi.fn(
      async (authority: services.ReleaseServiceAuthorityCapture) => authority.digest,
    );
    await expect(
      afterValidatedServiceAuthority("/trusted/root", initialize, async () => captured),
    ).resolves.toBe(captured.digest);
    expect(initialize).toHaveBeenCalledWith(captured);
  });

  it("authorizes exactly the dependency-expanded baked/default selection before trusted state exists", async () => {
    const rootDir = join(import.meta.dirname, "..", "..", "..");
    const releaseAuthority = await services.captureReleaseServiceAuthority(rootDir);
    const enabled = resolveBootstrapEnabledServiceIds(releaseAuthority.services, undefined);
    expect(enabled.has("app-api")).toBe(true);
    expect(enabled.has("redis")).toBe(true);
    expect(enabled.has("dawarich-app")).toBe(false);

    const authorityServices = releaseAuthority.services.map((service) => ({
      serviceId: service.manifest.id,
      enabled: enabled.has(service.manifest.id),
      isBuiltIn: true,
    }));
    let trusted: ReadonlySet<string> | null = null;
    const claimer = createProductionRegistryResourceClaimer({
      services: authorityServices,
      integrationIds: [],
      trustedData: denyAllTrustedOpsData,
      enabledServiceIds: () => trusted ?? enabled,
    });
    const signal = new AbortController().signal;
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "dawarich-app" }, "a".repeat(64), signal),
    ).resolves.toBeNull();

    trusted = new Set(["dawarich-app"]);
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "dawarich-app" }, "b".repeat(64), signal),
    ).resolves.not.toBeNull();
    await expect(
      claimer.claim({ kind: "service.start", serviceId: "redis" }, "c".repeat(64), signal),
    ).resolves.toBeNull();
  });

  it("expands the exact baked selection roots instead of manifest enabled defaults", () => {
    const loaded = [
      {
        manifest: {
          id: "selected",
          name: "Selected",
          version: "1.0.0",
          quality: "built-in" as const,
          container: {
            image: "example/selected",
            tag: "1",
            dependsOn: [{ service: "dependency", condition: "service_started" as const }],
          },
        },
        directory: "/trusted/selected",
        isBuiltIn: true,
        enabled: true,
      },
      {
        manifest: {
          id: "dependency",
          name: "Dependency",
          version: "1.0.0",
          quality: "built-in" as const,
          container: { image: "example/dependency", tag: "1" },
        },
        directory: "/trusted/dependency",
        isBuiltIn: true,
        enabled: true,
      },
      {
        manifest: {
          id: "unselected",
          name: "Unselected",
          version: "1.0.0",
          quality: "built-in" as const,
          container: { image: "example/unselected", tag: "1" },
        },
        directory: "/trusted/unselected",
        isBuiltIn: true,
        enabled: true,
      },
    ];
    expect(resolveBootstrapEnabledServiceIds(loaded, "selected")).toEqual(
      new Set(["selected", "dependency"]),
    );
  });
});
