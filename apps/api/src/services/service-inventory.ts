import type { AdminServiceStatus, AdminServices } from "@openmapx/core/api-contracts";
import { type OpsResultFor, SERVICE_ACTIONS, serviceActionsSchema } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import { getServiceRegistry } from "./service-registry";

const unavailableActions = () =>
  serviceActionsSchema.parse(
    Object.fromEntries(
      SERVICE_ACTIONS.map((action) => [
        action,
        { available: false, execution: "direct", reason: "unavailable", workflow: null },
      ]),
    ),
  );

export async function readServiceInventory(): Promise<AdminServices> {
  const registered = getServiceRegistry().list();
  let inspection: OpsResultFor<"services.inspect"> | undefined;
  try {
    inspection = await executeAndWait(
      createApiOpsClient(),
      { kind: "services.inspect" },
      createDurableOpsKey("admin.services.inspect", "current"),
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    /* Preserve registry rows and unknown acquisition; never infer stopped. */
  }
  const services = registered.map((service) => {
    const observed = inspection?.services.find((row) => row.serviceId === service.manifest.id);
    const status: AdminServiceStatus = !inspection
      ? "unknown"
      : !observed || observed.state === "stopped"
        ? "not-running"
        : observed.state;
    return {
      id: service.manifest.id,
      name: service.manifest.name,
      version: service.manifest.version,
      description: service.manifest.description,
      quality: service.manifest.quality,
      provides: coreServices.getProvidedCapabilityNames(service.manifest.provides),
      consumes: service.manifest.consumes ?? [],
      exposure: service.manifest.exposure,
      enabled: service.enabled,
      isBuiltIn: service.isBuiltIn,
      status,
      actions:
        status === "unknown" ? unavailableActions() : (observed?.actions ?? unavailableActions()),
    };
  });
  return {
    acquisition: inspection
      ? { state: "available", reason: null }
      : { state: "unavailable", reason: "ops_unavailable" },
    services,
    capabilityInventory: {
      recognized: [...coreServices.WELL_KNOWN_CAPABILITIES].sort(),
      unrecognized: [...new Set(services.flatMap((service) => service.provides))]
        .filter((capability) => !coreServices.WELL_KNOWN_CAPABILITIES.has(capability))
        .sort()
        .map((capability) => ({
          capability,
          serviceIds: services
            .filter((service) => service.provides.includes(capability))
            .map((service) => service.id)
            .sort(),
        })),
    },
    summary: {
      running: services.filter((s) => s.status === "running").length,
      stopped: services.filter((s) => s.status !== "running" && s.status !== "unknown").length,
      unknown: services.filter((s) => s.status === "unknown").length,
      total: services.length,
    },
  };
}
