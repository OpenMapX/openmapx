import type { ServiceAction, ServiceActionDecision } from "@openmapx/core/ops";
import type { OwnedServiceSnapshot } from "./owned-services";

export interface ServiceAuthority {
  revisionId: string;
  enabledServiceIds: ReadonlySet<string>;
  services: readonly {
    serviceId: string;
    isBuiltIn: boolean;
    buildable: boolean;
    creationDependencies?: readonly string[];
  }[];
}

const controlPlane = new Set(["ops-agent", "app-api", "traefik"]);
const dependencies = new Set(["postgis", "redis"]);

/** With no container, callers scope services to the single target being decided. */
export function decideServiceAction(
  authority: ServiceAuthority,
  snapshot: OwnedServiceSnapshot | undefined,
  action: ServiceAction,
): ServiceActionDecision {
  const service = snapshot
    ? authority.services.find((entry) => entry.serviceId === snapshot.serviceId)
    : authority.services.length === 1
      ? authority.services[0]
      : undefined;
  const denied = (
    reason: NonNullable<ServiceActionDecision["reason"]>,
    execution: ServiceActionDecision["execution"] = "direct",
    workflow: ServiceActionDecision["workflow"] = null,
  ): ServiceActionDecision => ({ available: false, execution, reason, workflow });
  if (!service) return denied("not_owned");
  if (action === "logs")
    return snapshot
      ? { available: true, execution: "direct", reason: null, workflow: null }
      : denied("not_owned");
  if (controlPlane.has(service.serviceId)) {
    if (action === "restart" && service.serviceId !== "ops-agent")
      return denied("unavailable", "workflow", "core-restart");
    return denied("control_plane");
  }
  if (dependencies.has(service.serviceId)) return denied("host_only", "host");
  if (action !== "stop" && !authority.enabledServiceIds.has(service.serviceId))
    return denied("disabled");
  // Pull-only DM staging needs Plan09 M3's purpose-bound producer. The installed
  // coordinator Update's private checked submission is a separate fixed path.
  if (service.serviceId === "data-manager" && action === "pull") return denied("unavailable");
  if (service.serviceId === "data-manager" && (action === "apply" || action === "update"))
    return {
      available: true,
      execution: "workflow",
      reason: null,
      workflow: action === "apply" ? "coordinator-apply" : "coordinator-update",
    };
  if (
    ["start", "apply", "update"].includes(action) &&
    service.serviceId !== "data-manager" &&
    service.creationDependencies?.includes("data-manager")
  )
    return denied("unavailable");
  if (action === "build" && (!service.isBuiltIn || !service.buildable))
    return denied("not_buildable");
  if (action === "stop" || action === "restart") {
    if (!snapshot) return denied("not_owned");
    if (!["running", "restarting", "paused"].includes(snapshot.state)) return denied("not_running");
  }
  return { available: true, execution: "direct", reason: null, workflow: null };
}
