/** Native production assembly. Only Docker's external process IO crosses the
 * owning fixture's loopback bridge; authority, journal and HTTP handlers are real. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { inspectReleaseAuthority } from "../administrative-runtime.ts";
import { CommunityRepositoryStore } from "../community-repositories.ts";
import { configurationCandidateSource } from "../configuration-candidate-source.ts";
import { configurationPolicyRevision } from "../configured-resource-authority.ts";
import {
  configurationPayloadSource,
  createDataTransitTrustedOpsDataSource,
} from "../data-transit-resource-source.ts";
import { openOpsJobJournal } from "../journal.ts";
import { createProductionRegistryResourceClaimer } from "../policy.ts";
import { safeProcessDiagnostic } from "../process-output.ts";
import { createProductionOpsRuntime, productionOwnedServices } from "../production-runtime.ts";
import { buildOpsAgentServer } from "../server.ts";
import { createTrustedConfigurationAuthorityLoader } from "../trusted-configuration-authority.ts";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
syncBuiltinESMExports();
if (
  !Array.isArray(input.serviceIds) ||
  input.serviceIds.length > 256 ||
  input.serviceIds.some((id) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
)
  throw Error("Invalid fixed fixture registry");
const builtInServices = input.serviceIds.map((id) => ({
  manifest: JSON.parse(fs.readFileSync(join(input.root, "services", id, "service.json"), "utf8")),
  directory: join(input.root, "services", id),
  enabled: true,
  isBuiltIn: true,
}));
const loadAuthority = createTrustedConfigurationAuthorityLoader({
  rootDir: input.root,
  builtInServices,
  // The protected helper uses the production release-inventory authority.
  // Read the actual bounded checkout inventory; never accept a supplied digest.
  ...(input.captureReleaseAuthority
    ? { builtInAuthorityDigest: (await services.captureReleaseServiceAuthority(input.root)).digest }
    : {}),
});
const repositories = new CommunityRepositoryStore({ rootDir: input.root });
await repositories.recover();
const runtime = await createProductionOpsRuntime({
  rootDir: input.root,
  stack: input.stack,
  loadAuthority,
  communityRepositories: repositories,
  candidateSource: configurationCandidateSource(input.infraDir),
  apiToken: input.token,
  docker: {
    fileExists: fs.existsSync,
    execFile: async (file, args, options) => {
      if (file !== "docker") throw Error("Only named Docker IO crosses fixture bridge");
      const response = await fetch(input.dockerBridge, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args }),
        signal: options.signal,
      });
      if (!response.ok) throw Error("Named Docker IO failed");
      return response.json();
    },
  },
});
// Observe the original handler; all authority checks and results remain native.
if (input.catalogFault) {
  const approve = runtime["transitousLock.approve"];
  runtime["transitousLock.approve"] = async (...args) => {
    try {
      return await approve(...args);
    } catch (error) {
      console.error(
        safeProcessDiagnostic(
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        ),
      );
      throw error;
    }
  };
}
const policyAuthority = async () => {
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
};
const authority = await policyAuthority();
const installation = openControlInstallation({
  infraDir: input.infraDir,
  role: "ops-agent",
  serviceIds: input.serviceIds,
});
const journal = await openOpsJobJournal(services.agentStatePaths(input.infraDir).journal);
if (["pointer", "cancel-pointer", "before-pointer"].includes(input.catalogFault)) {
  const rename = fs.renameSync;
  let stopped = false;
  fs.renameSync = (from, to) => {
    let matching = false;
    if (String(to).endsWith("/current.json")) {
      const actual = fs.statSync(dirname(String(to)));
      const expected = fs.statSync(join(input.infraDir, "catalog-pins"));
      matching = actual.dev === expected.dev && actual.ino === expected.ino;
    }
    if (matching && !stopped && input.catalogFault === "before-pointer") {
      stopped = true;
      fs.writeSync(1, JSON.stringify({ event: "catalog-pointer-before-commit" }) + "\n");
      process.kill(process.pid, "SIGSTOP");
    }
    const result = rename(from, to);
    if (matching && !stopped) {
      stopped = true;
      fs.writeSync(1, JSON.stringify({ event: "catalog-pointer-committed" }) + "\n");
      process.kill(process.pid, "SIGSTOP");
    }
    return result;
  };
  syncBuiltinESMExports();
}

const app = buildOpsAgentServer({
  runtime,
  journal,
  controlInstallation: installation,
  operationTimeoutMs: input.operationTimeoutMs ?? 180000,
  tokens: { api: input.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
  resourceClaimer: createProductionRegistryResourceClaimer({
    services: authority.services,
    integrationIds: authority.integrationIds,
    loadAuthority: policyAuthority,
    trustedData: createDataTransitTrustedOpsDataSource(installation, configurationPayloadSource),
    resourceAuthority: {
      allowRelease: (kind, releaseId) =>
        kind === "release.images.pull" && inspectReleaseAuthority(input.root, releaseId),
    },
    ownedServices: productionOwnedServices(runtime),
    enabledServiceIds: (ss) =>
      services.readAppliedServiceIds(
        input.infraDir,
        ss.map((s) => s.selectionAuthority),
      ) ?? new Set(),
    serviceMetadata: (ss) =>
      ss.map((s) => ({
        ...s,
        buildable: !!s.selectionAuthority.manifest.buildCommand,
        creationDependencies: services.serviceCreationDependencyIds(
          ss.map((v) => v.selectionAuthority),
          [s.serviceId],
        ),
      })),
  }),
});
app.addHook("onSend", async (request, reply, payload) => {
  const kind = request.body?.operation?.kind;
  if (request.method === "POST" && request.url === "/v1/operations" && kind)
    process.stdout.write(
      JSON.stringify({
        event: "operation",
        kind,
        status: reply.statusCode,
        ...(reply.statusCode >= 400 ? { errorClass: JSON.parse(payload).error?.class } : {}),
      }) + "\n",
    );
  if (
    ["pointer", "cancel-pointer", "before-pointer"].includes(input.catalogFault) &&
    kind === "transitousLock.approve" &&
    reply.statusCode === 202
  )
    request.raw.socket.destroy();
  return payload;
});
const url = await app.listen({ host: "127.0.0.1", port: input.listenPort ?? 0 });
const owned = await productionOwnedServices(runtime).inspectOwnedServices(
  new AbortController().signal,
);
process.stdout.write(
  JSON.stringify({
    event: "ready",
    url,
    ownedDM: owned.some((s) => s.serviceId === "data-manager"),
  }) + "\n",
);
process.once("SIGTERM", () => {
  void app
    .close()
    .then(() => {
      closeControlInstallation(installation);
      process.exit(0);
    })
    .catch(() => process.exit(2));
});
