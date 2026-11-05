import { dirname } from "node:path";
import { services } from "@openmapx/core/server";
import { registerConfigurationMaintenanceSource } from "../configuration-maintenance-store";
import { createOwnedServiceResolver } from "../owned-services";
import type { OpsRuntime } from "../runtime";
import {
  installTrustedConfigurationRuntime as install,
  type TrustedConfigurationRuntimeOptions,
} from "../trusted-config-runtime";

/** Direct adapter tests still run the literal production inventory qualification.
 * The Docker seam describes an empty host, so it cannot fabricate a coordinator
 * owner, a staged proof, or permission to publish over a live staged container. */
export function installConfigurationRuntimeFixture(
  runtime: OpsRuntime,
  options: TrustedConfigurationRuntimeOptions,
): void {
  install(runtime, options);
  const stack = {
    infraDir: options.infraDir,
    composePath: services.currentConfigurationFile(options.infraDir, services.GENERATED_COMPOSE_FILE),
    composeReleasePath: services.releaseStatePaths(options.infraDir).overlay,
  };
  const execFile = async (_file: string, args: readonly string[]) => {
    if (args[0] !== "container" || args[1] !== "ls")
      throw Error(`Unexpected configuration fixture Docker request: ${args.join(" ")}`);
    return { stdout: "", stderr: "" };
  };
  const loadAuthority = options.loadAuthority ?? (async () => ({
    revisionId: "registry-v1",
    services: options.services,
    integrationSchemas: options.integrationSchemas,
  }));
  const ownedServices = createOwnedServiceResolver({ stack, execFile, loadAuthority });
  registerConfigurationMaintenanceSource(runtime, {
    rootDir: options.rootDir ?? dirname(dirname(options.infraDir)),
    infraDir: options.infraDir,
    candidateSource: options.candidateSource,
    stack,
    execFile,
    loadAuthority,
    ownedServices,
  });
}
