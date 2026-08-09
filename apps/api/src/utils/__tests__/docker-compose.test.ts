import { describe, expect, it, vi } from "vitest";
import { dockerComposeContainerEnv } from "../docker-compose.js";

describe("dockerComposeContainerEnv", () => {
  it("returns only the requested value from the running service container", async () => {
    const ps = vi.fn(async () => [
      { service: "dawarich-app", state: "running" as const, container: "stack-dawarich-app-1" },
    ]);
    const inspectEnvironment = vi.fn(async () => [
      "UNRELATED=sensitive-value",
      "OPENMAPX_PROVISIONING_GENERATION=0123456789abcdef0123456789abcdef",
      "WITH_EQUALS=a=b",
    ]);

    await expect(
      dockerComposeContainerEnv("dawarich-app", "OPENMAPX_PROVISIONING_GENERATION", {
        ps,
        inspectEnvironment,
      }),
    ).resolves.toBe("0123456789abcdef0123456789abcdef");
    expect(inspectEnvironment).toHaveBeenCalledWith("stack-dawarich-app-1");
  });

  it("does not inspect absent, stopped, or failed containers", async () => {
    const inspectEnvironment = vi.fn(async () => ["OPENMAPX_PROVISIONING_GENERATION=marker"]);
    await expect(
      dockerComposeContainerEnv("dawarich-app", "OPENMAPX_PROVISIONING_GENERATION", {
        ps: async () => [
          { service: "dawarich-app", state: "exited" as const, container: "old-app" },
        ],
        inspectEnvironment,
      }),
    ).resolves.toBeNull();
    expect(inspectEnvironment).not.toHaveBeenCalled();

    await expect(
      dockerComposeContainerEnv("dawarich-app", "OPENMAPX_PROVISIONING_GENERATION", {
        ps: async () => [
          { service: "dawarich-app", state: "running" as const, container: "current-app" },
        ],
        inspectEnvironment: async () => {
          throw new Error("inspect unavailable");
        },
      }),
    ).resolves.toBeNull();
  });
});
