import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { opsOperationFingerprint, type OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { composePathHost } from "../../../../packages/core/src/services/__fixtures__/compose-path-host";
import { CommunityRepositoryStore } from "../community-repositories";
import type { DockerRuntimeOptions } from "../docker-runtime";
import { createProductionRegistryResourceClaimer, denyAllTrustedOpsData } from "../policy";
import { createProductionOpsRuntime, productionOwnedServices } from "../production-runtime";
import { createTrustedConfigurationAuthorityLoader } from "../trusted-configuration-authority";
import { testExecution } from "./execution";

export async function ownedComposePathRuntime() {
  const host = await composePathHost();
  const loadAuthority = createTrustedConfigurationAuthorityLoader({
    rootDir: host.root,
    builtInServices: host.loaded,
  });
  const source = host.config(host.currentArgs());
  if (!source.model?.services.alpha) throw Error("Real Compose fixture acquisition failed");
  const row = {
    Id: "d".repeat(64),
    Image: `sha256:${"e".repeat(64)}`,
    State: "running",
    ConfigImage: source.model.services.alpha.image,
    Labels: {
      "com.docker.compose.project": services.STACK_PROJECT,
      "com.docker.compose.service": "alpha",
      "com.docker.compose.project.working_dir": dirname(host.firstCompose),
      "com.docker.compose.project.config_files": [
        host.firstCompose,
        realpathSync(host.stack.composeReleasePath),
      ].join(","),
    },
  };
  const calls: string[][] = [];
  const pathChecks: Record<string, boolean>[] = [];
  const execFile: NonNullable<DockerRuntimeOptions["execFile"]> = async (_file, args) => {
    calls.push([...args]);
    let stdout = "";
    if (args[0] === "container" && args[1] === "ls") stdout = row.Id;
    else if (args[0] === "container" && args[1] === "inspect") stdout = JSON.stringify(row);
    else if (args[0] === "image" && args[1] === "inspect") stdout = row.Image;
    else if (args[0] === "compose" && args.includes("config")) {
      const result = host.runConfigArgv(args);
      if (!result.model) throw Error("Real ownership Compose acquisition failed");
      pathChecks.push(host.pathChecks(result.model, host.firstCompose));
      stdout = JSON.stringify(result.model);
    } else if (args[0] === "stop") row.State = "exited";
    else if (args[0] === "logs") stdout = "public fixture log\n";
    return { stdout, stderr: "" };
  };
  const repositories = new CommunityRepositoryStore({
    rootDir: host.root,
    uid: process.geteuid?.() ?? 0,
    loadAuthority,
  });
  await repositories.recover();
  const runtime = await createProductionOpsRuntime({
    rootDir: host.root,
    stack: host.stack,
    loadAuthority,
    communityRepositories: repositories,
    docker: { execFile, fileExists: existsSync },
  });
  const snapshot = () =>
    loadAuthority().then((authority) => ({
      revisionId: authority.revisionId,
      services: authority.services.map((service) => ({
        serviceId: service.manifest.id,
        enabled: service.enabled,
        isBuiltIn: service.isBuiltIn,
        selectionAuthority: service,
      })),
      integrationIds: [...authority.integrationSchemas.keys()],
    }));
  const initial = await snapshot();
  const claimer = createProductionRegistryResourceClaimer({
    ...initial,
    loadAuthority: snapshot,
    trustedData: denyAllTrustedOpsData,
    enabledServiceIds: (current) =>
      services.readAppliedServiceIds(
        host.infraDir,
        current.map((service) => service.selectionAuthority),
      ) ?? new Set(),
    serviceMetadata: (current) =>
      current.map((service) => ({
        serviceId: service.serviceId,
        isBuiltIn: service.isBuiltIn,
        buildable: !!service.selectionAuthority.manifest.buildCommand,
      })),
    ownedServices: productionOwnedServices(runtime),
  });
  const context = async (operation: OpsOperation) => {
    const signal = new AbortController().signal,
      claim = await claimer.claim(operation, opsOperationFingerprint(operation), signal, {
        role: "api",
        operationKey: testExecution().operationKey,
      });
    if (!claim) throw Error("Admission denied");
    return { signal, claim, execution: testExecution(), emitLog() {} };
  };
  return {
    host,
    runtime,
    owned: productionOwnedServices(runtime),
    row,
    calls,
    pathChecks,
    context,
  };
}
