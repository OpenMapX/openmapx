import { SERVICE_ACTIONS, serviceActionDecisionSchema } from "@openmapx/core/ops";
import { describe, expect, it } from "vitest";
import type { OwnedServiceSnapshot } from "./owned-services";
import { decideServiceAction, type ServiceAuthority } from "./service-action-policy";

const authority: ServiceAuthority = {
  revisionId: "test",
  enabledServiceIds: new Set(["motis"]),
  services: [{ serviceId: "motis", isBuiltIn: true, buildable: true }],
};
const snapshot: OwnedServiceSnapshot = {
  serviceId: "motis",
  containerId: "a".repeat(64),
  state: "running",
  provenance: {
    project: "docker",
    composeWorkingDirectory: "/trusted",
    composeConfigFiles: ["/trusted/docker-compose.generated.yml"],
    imageId: `sha256:${"b".repeat(64)}`,
  },
};
describe("shared service action decisions", () => {
  it.each(["app-api", "traefik"])(
    "offers only the dedicated restart workflow for owned enabled %s",
    (serviceId) => {
      const current = { ...snapshot, serviceId };
      const selected = {
        ...authority,
        services: [{ serviceId, isBuiltIn: true, buildable: false }],
        enabledServiceIds: new Set([serviceId]),
      };
      expect(decideServiceAction(selected, current, "restart")).toEqual({
        available: true,
        execution: "workflow",
        reason: null,
        workflow: "core-restart",
      });
      expect(
        decideServiceAction({ ...selected, enabledServiceIds: new Set() }, current, "restart")
          .available,
      ).toBe(false);
      expect(decideServiceAction(selected, undefined, "restart").available).toBe(false);
      expect(
        decideServiceAction(selected, { ...current, state: "stopped" }, "restart").available,
      ).toBe(false);
      for (const action of ["start", "stop", "apply", "update"] as const)
        expect(decideServiceAction(selected, current, action).available).toBe(false);
    },
  );
  it("keeps every available direct decision consistent with its portable schema", () => {
    for (const action of SERVICE_ACTIONS)
      expect(
        serviceActionDecisionSchema.safeParse(decideServiceAction(authority, snapshot, action))
          .success,
      ).toBe(true);
    expect(decideServiceAction(authority, snapshot, "update")).toMatchObject({
      available: true,
      execution: "direct",
      reason: null,
    });
  });
  it("retains logs after stop, requires proven ownership for cleanup and refuses unknown registry IDs", () => {
    expect(
      decideServiceAction(authority, { ...snapshot, state: "stopped" }, "logs").available,
    ).toBe(true);
    expect(decideServiceAction(authority, { ...snapshot, state: "stopped" }, "stop").reason).toBe(
      "not_running",
    );
    expect(decideServiceAction(authority, undefined, "stop").reason).toBe("not_owned");
    expect(
      decideServiceAction(authority, { ...snapshot, serviceId: "unknown" }, "logs").reason,
    ).toBe("not_owned");
    expect(
      decideServiceAction(
        { ...authority, services: [{ serviceId: "motis", isBuiltIn: true, buildable: false }] },
        snapshot,
        "build",
      ).reason,
    ).toBe("not_buildable");
  });
});
