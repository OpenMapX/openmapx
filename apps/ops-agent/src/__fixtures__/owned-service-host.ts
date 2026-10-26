import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  opsOperationFingerprint,
  sealTrustedConfigurationSnapshot,
  type OpsOperation,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { CommunityRepositoryStore } from "../community-repositories";
import type { DockerRuntimeOptions } from "../docker-runtime";
import { createProductionRegistryResourceClaimer } from "../policy";
import {
  createProductionOpsRuntime,
  productionOwnedServices,
  serviceActionAuthority,
} from "../production-runtime";
import { createTrustedConfigurationAuthorityLoader } from "../trusted-configuration-authority";
import { createFileTrustedOpsDataSource } from "../trusted-config-source";
import { dispatchOpsOperation } from "../runtime";
import { testExecution } from "./execution";

export async function ownedServiceHost() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-owned-"));
  chmodSync(root, 0o755);
  const infraDir = join(root, "infra/docker");
  mkdirSync(infraDir, { recursive: true });
  mkdirSync(join(root, "services"));
  mkdirSync(join(root, "custom_integrations"));
  const loaded: services.LoadedService[] = [
    "motis",
    "ops-agent",
    "app-api",
    "traefik",
    "postgis",
    "redis",
  ].map((id) => ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `example/${id}`, tag: "1" },
    },
    directory: join(root, "services", id),
    enabled: true,
    isBuiltIn: true,
  }));
  const loadAuthority = createTrustedConfigurationAuthorityLoader({
    rootDir: root,
    builtInServices: loaded,
  });
  const initial = await services.commitConfigurationGeneration({
    infraDir,
    services: loaded,
    input: {
      domain: "example.test",
      selectedRoots: ["motis"],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
    ownedServiceGenerations: [],
  });
  services.writeServiceSelectionFile(infraDir, ["motis"]);
  const composePath = services.currentConfigurationFile(infraDir, services.GENERATED_COMPOSE_FILE);
  const firstCompose = realpathSync(composePath);
  const stack = {
    infraDir,
    composePath,
    composeReleasePath: join(infraDir, "docker-compose.release.yml"),
  };
  const imageId = `sha256:${"b".repeat(64)}`;
  const row = {
    Id: "a".repeat(64),
    Image: imageId,
    State: "running",
    ConfigImage: "example/motis:1",
    Labels: {
      "com.docker.compose.project": services.STACK_PROJECT,
      "com.docker.compose.service": "motis",
      "com.docker.compose.project.working_dir": dirname(firstCompose),
      "com.docker.compose.project.config_files": firstCompose,
    },
  };
  let rows = [row];
  let rawListing: string | undefined;
  let malformedInspect = false;
  const calls: string[][] = [];
  const execFile: NonNullable<DockerRuntimeOptions["execFile"]> = async (_file, args) => {
    calls.push([...args]);
    let stdout = "";
    if (args[0] === "container" && args[1] === "ls")
      stdout = rawListing ?? rows.map((r) => r.Id).join("\n");
    else if (args[0] === "container" && args[1] === "inspect")
      stdout = malformedInspect ? "{" : rows.map((r) => JSON.stringify(r)).join("\n");
    else if (args[0] === "compose" && args.includes("config"))
      stdout = JSON.stringify({
        services: Object.fromEntries(
          loaded.map((s) => [
            s.manifest.id,
            { image: services.serviceContainerImageReference(s.manifest.container) },
          ]),
        ),
      });
    else if (args[0] === "image" && args[1] === "inspect") stdout = imageId;
    else if (args[0] === "stop") row.State = "exited";
    else if (args[0] === "logs") stdout = "retained log\n";
    return { stdout, stderr: "" };
  };
  const repositories = new CommunityRepositoryStore({
    rootDir: root,
    uid: process.geteuid?.() ?? 0,
    loadAuthority,
    clone: async ({ targetDir }) => {
      mkdirSync(targetDir, { recursive: true, mode: 0o755 });
      writeFileSync(
        join(targetDir, "service.json"),
        JSON.stringify({
          id: "community-live",
          name: "Community",
          version: "1.0.0",
          quality: "community",
          container: {
            image: "example/community-live",
            tag: "1",
            digest: `sha256:${"b".repeat(64)}`,
          },
        }),
      );
      return { directory: targetDir, commit: "1".repeat(40) };
    },
  });
  await repositories.recover();
  const runtime = await createProductionOpsRuntime({
    rootDir: root,
    stack,
    loadAuthority,
    communityRepositories: repositories,
    docker: {
      execFile,
      fileExists: existsSync,
      followLogs: async (_file, args, options) => {
        calls.push([...args]);
        options.onLine("stdout", "retained follow");
        return { lines: 1, truncated: false };
      },
    },
  });
  const authority = await loadAuthority();
  const queue = join(root, "trusted-queue");
  mkdirSync(queue, { mode: 0o700 });
  mkdirSync(join(queue, ".claimed"), { mode: 0o700 });
  const token = Buffer.alloc(32, 17).toString("base64url");
  const trustedData = createFileTrustedOpsDataSource({
    directory: queue,
    token,
    allowedUids: [statSync(queue).uid],
    expectedGid: statSync(queue).gid,
  });
  const claimer = createProductionRegistryResourceClaimer({
    services: authority.services.map((s) => ({
      serviceId: s.manifest.id,
      enabled: s.enabled,
      isBuiltIn: s.isBuiltIn,
    })),
    integrationIds: [],
    loadAuthority: async () => {
      const a = await loadAuthority();
      return {
        revisionId: a.revisionId,
        services: a.services.map((s) => ({
          serviceId: s.manifest.id,
          enabled: s.enabled,
          isBuiltIn: s.isBuiltIn,
        })),
        integrationIds: [...a.integrationSchemas.keys()],
      };
    },
    enabledServiceIds: () => services.readAppliedServiceIds(infraDir, loaded) ?? new Set(),
    trustedData,
    ownedServices: productionOwnedServices(runtime),
    serviceMetadata: (ss) => ss.map((s) => ({ ...s, buildable: false })),
  });
  const context = async (operation: OpsOperation) => {
    const signal = new AbortController().signal;
    const claim = await claimer.claim(operation, opsOperationFingerprint(operation), signal, {
      role: "api",
      operationKey: testExecution().operationKey,
    });
    if (!claim) throw new Error("Admission denied");
    return { execution: testExecution(), signal, emitLog() {}, claim };
  };
  let counter = 0;
  const select = async (selectedRoots: string[]) => {
    const sealed = sealTrustedConfigurationSnapshot({
      role: "api",
      token,
      nonce: `nonce_ownership_${String(++counter).padStart(12, "0")}`,
      operationKey: testExecution().operationKey,
      operationForRevision: (revisionId) => ({
        kind: "serviceSelection.apply",
        revisionId,
        expectedCurrentRevisionId: services.currentConfigurationGeneration(infraDir),
      }),
      payload: {
        domain: "example.test",
        selectedRoots,
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
    });
    writeFileSync(join(queue, `${sealed.revisionId}.json`), sealed.bytes, { mode: 0o600 });
    const ctx = await context(sealed.operation);
    await ctx.claim.admission?.commit();
    try {
      return await dispatchOpsOperation(runtime, sealed.operation, ctx);
    } finally {
      await ctx.claim.admission?.release();
    }
  };
  const deselect = () => select([]);
  return {
    root,
    token,
    infraDir,
    loaded,
    initial,
    firstCompose,
    stack,
    runtime,
    repositories,
    claimer,
    row,
    calls,
    execFile,
    loadAuthority,
    context,
    deselect,
    select,
    owned: productionOwnedServices(runtime),
    actionAuthority: async () => serviceActionAuthority(await loadAuthority(), infraDir),
    setRows(value: typeof rows) {
      rows = value;
    },
    setRawListing(value: string) {
      rawListing = value;
    },
    setMalformedInspect() {
      malformedInspect = true;
    },
  };
}
