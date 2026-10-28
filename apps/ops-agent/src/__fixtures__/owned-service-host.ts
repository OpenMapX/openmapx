import {configurationPolicyRevision} from "../configured-resource-authority";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
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
import { provisionControlInstallation } from "@openmapx/core/build-artifacts";
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
import { createDefaultFixedCli } from "../administrative-runtime";
import { runContainedProcess } from "../docker-runtime";

export async function ownedServiceHost(options: { capabilities?:Record<string,string[]>; extraServiceIds?:string[]; coordinatorDependency?:boolean; oversizedMaintenancePlan?:boolean; nestedRootSegments?:number; imageReferences?:Record<string,{image:string;tag:string;digest?:string}>; schemas?: Record<string, Record<string, unknown>>; withHardlinks?: boolean; withCoordinator?: boolean; defaultCliEntry?: string; competeAfterDefaultCli?: boolean; actualComposeConfig?: boolean } = {}) {
  const withCoordinator = options.withHardlinks || options.withCoordinator;
  const cleanupRoot = mkdtempSync(join(tmpdir(), "openmapx-owned-"));
  const root=join(cleanupRoot,...Array.from({length:options.nestedRootSegments??0},(_,index)=>`${index}${"x".repeat(79)}`));
  mkdirSync(root,{recursive:true});
  chmodSync(root, 0o755);
  const infraDir = join(root, "infra/docker");
  mkdirSync(infraDir, { recursive: true });
  mkdirSync(join(root, "services"));
  mkdirSync(join(root, "custom_integrations"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const loaded: services.LoadedService[] = [
    "motis",
    "ops-agent",
    "app-api",
    "traefik",
    "postgis",
    "redis",
    ...(withCoordinator ? ["data-manager"] : []),
    ...(options.extraServiceIds ?? []),
  ].map((id) => ({
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      ...(options.capabilities?.[id]?{provides:options.capabilities[id]}:{}),
      container: {...(options.capabilities?.[id]?{expose:[8080]}:{}),...(options.imageReferences?.[id] ?? { image: `example/${id}`, tag: "1" }),
        ...(options.coordinatorDependency && id==="motis"?{dependsOn:[{service:"data-manager"}]}:{})},
      ...(options.schemas?.[id] ? { configSchema: options.schemas[id] } : {}),
      ...(options.oversizedMaintenancePlan && id==="motis" ? {
        produces:Array.from({length:256},(_,index)=>({type:`capacity-${index}`,sourceDir:`data/${Array.from({length:10},(_,part)=>`${part}${"p".repeat(79)}`).join("/")}/${index}`})),
        consumes:Array.from({length:256},(_,index)=>({type:`capacity-${index}`,mountAt:`/input/${index}`,readOnly:true,required:true})),
      }:{}),
      ...(options.withHardlinks && id === "motis" ? {
        produces: [{ type: "osm-pbf", sourceDir: "data/source-osm" }],
        consumes: [{ type: "osm-pbf", mountAt: "/input", readOnly: true, required: true }],
      } : {}),
    },
    directory: join(root, "services", id),
    enabled: true,
    isBuiltIn: true,
  }));
  for (const service of loaded) {
    mkdirSync(service.directory, { recursive: true });
    writeFileSync(join(service.directory, "service.json"), JSON.stringify(service.manifest));
  }
  const loadAuthority = createTrustedConfigurationAuthorityLoader({
    rootDir: root,
    builtInServices: loaded,
  });
  const initial = await services.commitConfigurationGeneration({
    infraDir,
    services: loaded,
    input: {
      domain: "example.test",
      selectedRoots: [...(withCoordinator ? ["data-manager", "motis"] : ["motis"]),...(options.extraServiceIds??[])],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
    ownedServiceGenerations: [],
  });
  services.writeServiceSelectionFile(infraDir, [...(withCoordinator ? ["data-manager", "motis"] : ["motis"]),...(options.extraServiceIds??[])]);
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
    ConfigImage: services.serviceContainerImageReference(loaded.find(s=>s.manifest.id==="motis")!.manifest.container),
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
  let runtimeInspections: Record<string, unknown> = {};
  let runtimeSecretBytes: Record<string, string> = {};
  const calls: string[][] = [];
  const actualComposeConfig = options.actualComposeConfig;
  let creatingProcess:
    | ((args: readonly string[], signal: AbortSignal) => Promise<void>)
    | undefined;
  let inventoryProcess: (() => Promise<void>) | undefined;
  let imagePullProcess: ((reference:string,signal:AbortSignal)=>Promise<void>) | undefined;
  const imageIdentities = new Map<string,string>();
  const execFile: NonNullable<DockerRuntimeOptions["execFile"]> = async (_file, args, options) => {
    calls.push([...args]);
    let stdout = "";
    if (args[0] === "container" && args[1] === "ls") {
      stdout = rawListing ?? rows.map((r) => r.Id).join("\n");
      const pending = inventoryProcess;
      inventoryProcess = undefined;
      await pending?.();
    } else if (args[0] === "container" && args[1] === "inspect")
      stdout = malformedInspect ? "{" : args[3] === "{{json .}}"
        ? args.slice(4).map(id => JSON.stringify(runtimeInspections[id] ?? null)).join("\n") : rows.map((r) => JSON.stringify(r)).join("\n");
    else if (args[0] === "container" && args[1] === "exec" && args[3] === "base64") {
      const record = runtimeInspections[args[2]!] as { Mounts?: { Source?: string; Destination: string }[] } | undefined,
        source = record?.Mounts?.find(value => value.Destination === args[4])?.Source;
      if (!source) throw Error("Synthetic Docker secret mount unavailable");
      stdout = runtimeSecretBytes[`${args[2]}:${args[4]}`] ?? readFileSync(source).toString("base64");
    } else if (args[0] === "compose" && args.includes("ps"))
      stdout = JSON.stringify(rows.map(row => ({ Service: row.Labels["com.docker.compose.service"], State: row.State, Health: "" })));
    else if (args[0] === "compose" && args.includes("config"))
      stdout = actualComposeConfig ? (await runContainedProcess("docker", args, options)).stdout : JSON.stringify({
        services: Object.fromEntries(
          loaded.map((s) => [
            s.manifest.id,
            { image: services.serviceContainerImageReference(s.manifest.container) },
          ]),
        ),
      });
    else if (args[0] === "image" && args[1] === "inspect") stdout = imageIdentities.get(args.at(-1)!) ?? imageId;
    else if (args[0] === "image" && args[1] === "pull") await imagePullProcess?.(args[2]!,options.signal);
    else if (args[0] === "compose" && args.includes("up"))
      await creatingProcess?.(args, options.signal);
    else if (args[0] === "stop") {
      const stopped = rows.find((candidate) => candidate.Id === args[1]);
      if (stopped) stopped.State = "exited";
    } else if (args[0] === "logs") stdout = "retained log\n";
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
  const queue = join(root, "trusted-queue");
  mkdirSync(queue, { mode: 0o700 });
  mkdirSync(join(queue, ".claimed"), { mode: 0o700 });
  mkdirSync(join(infraDir, "data"), { mode: 0o700, recursive: true });
  await provisionControlInstallation(infraDir);
  const token = Buffer.alloc(32, 17).toString("base64url");
  let competingRevisionId: string | undefined;
  const defaultCli = options.defaultCliEntry ? createDefaultFixedCli(root, options.defaultCliEntry) : undefined;
  const runtime = await createProductionOpsRuntime({
    rootDir: root,
    stack,
    loadAuthority,
    communityRepositories: repositories,
    ...(defaultCli ? { runFixedCli: async (...args: Parameters<typeof defaultCli>) => {
      await defaultCli(...args);
      if (options.competeAfterDefaultCli) competingRevisionId = (await services.commitConfigurationGeneration({ infraDir, services: loaded,
        input: { ...services.readAppliedConfiguration(infraDir), domain: "example.test", selectedRoots: withCoordinator ? ["data-manager", "motis"] : ["motis"] } })).revisionId;
    } } : {}),
    candidateSource: { directory: queue, token, ownerUid: statSync(queue).uid, ownerGid: statSync(queue).gid },
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
      selectionAuthority: s,
    })),
    integrationIds: [],
    loadAuthority: async () => {
      const a = await loadAuthority();
      return {
        revisionId: configurationPolicyRevision(a.revisionId),
        configurationAuthorityRevision: a.revisionId,
        services: a.services.map((s) => ({
          serviceId: s.manifest.id,
          enabled: s.enabled,
          isBuiltIn: s.isBuiltIn,
          selectionAuthority: s,
        })),
        integrationIds: [...a.integrationSchemas.keys()],
      };
    },
    enabledServiceIds: (authorityServices) =>
      services.readAppliedServiceIds(
        infraDir,
        authorityServices.map((service) => service.selectionAuthority),
      ) ?? new Set(),
    trustedData,
    ownedServices: productionOwnedServices(runtime),
    serviceMetadata: (ss) => ss.map((s) => ({ ...s, buildable: false,
      creationDependencies:services.serviceCreationDependencyIds(ss.map(value=>value.selectionAuthority),[s.serviceId]) })),
  });
  const context = async (
    operation: OpsOperation,
    signal: AbortSignal = new AbortController().signal,
  ) => {
    const claim = await claimer.claim(operation, opsOperationFingerprint(operation), signal, {
      role: "api",
      operationKey: testExecution().operationKey,
    });
    if (!claim) throw new Error("Admission denied");
    return { execution: testExecution(), signal, emitLog() {}, claim };
  };
  let counter = 0;
  const select = async (selectedRoots: string[]) => {
    const inspection = { kind: "configuration.sources.inspect" } as const;
    const source = await dispatchOpsOperation(runtime, inspection, await context(inspection));
    const sealed = sealTrustedConfigurationSnapshot({
      role: "api",
      token,
      nonce: `nonce_ownership_${String(++counter).padStart(12, "0")}`,
      operationKey: testExecution().operationKey,
      operationForRevision: (revisionId) => ({
        kind: "serviceSelection.apply",
        expectedSourceRevision: source.sourceRevision,
        coordinatorMode: "ensure-running",
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
    cleanupRoot,
    queue,
    token,
    infraDir,
    loaded,
    initial,
    get competingRevisionId() { return competingRevisionId; },
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
    setCreatingProcess(value: typeof creatingProcess) {
      creatingProcess = value;
    },
    setInventoryProcess(value: typeof inventoryProcess) {
      inventoryProcess = value;
    },
    setImagePullProcess(value:typeof imagePullProcess) {imagePullProcess=value;},
    setImageIdentity(reference:string,value:string) {imageIdentities.set(reference,value);},
    setRows(value: typeof rows) {
      rows = value;
    },
    setServiceState(serviceId:string,state:string) {
      const service=rows.find(value=>value.Labels["com.docker.compose.service"]===serviceId);
      if(!service)throw Error("Named Docker fixture service unavailable");
      service.State=state;
    },
    setRuntimeInspections(value: typeof runtimeInspections) { runtimeInspections = value; },
    setRuntimeSecretBytes(value: typeof runtimeSecretBytes) { runtimeSecretBytes = value; },
    setRawListing(value: string) {
      rawListing = value;
    },
    setMalformedInspect() {
      malformedInspect = true;
    },
  };
}
