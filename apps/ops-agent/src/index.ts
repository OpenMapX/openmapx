import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadControlStartup } from "@openmapx/core/build-artifacts";
import { initializeManagedCatalogPins } from "@openmapx/core/catalog-pins";
import { readOpsTokenFile } from "@openmapx/core/ops";
import { repoPaths, services } from "@openmapx/core/server";
import {
  createDefaultFixedCli,
  inspectBackupAuthority,
  inspectDataTypeAuthority,
  inspectReleaseAuthority,
  loadConfiguredResourceAuthority,
  pruneBackupRetention,
} from "./administrative-runtime";
import { installPreparedImportRuntime } from "./artifact-transfer/import-runtime";
import { loadArtifactTransferPolicy } from "./artifact-transfer/policy";
import { installArtifactTransferRuntime } from "./artifact-transfer/runtime";
import { ArtifactTransferStore, artifactTransferPrivateRoot } from "./artifact-transfer/store";
import { startOpsAgentServer } from "./bootstrap";
import { CommunityRepositoryStore } from "./community-repositories";
import { loadOpsAgentConfig } from "./config";
import { configurationHandoffPendingMaintenanceIds } from "./configuration-maintenance-store";
import { createDataTransitTrustedOpsDataSource } from "./data-transit-resource-source";
import {
  createDockerDawarichCollector,
  createDockerDawarichRuntimeInspector,
} from "./dawarich-subject-export";
import { describeDeploymentUserAtStart } from "./deployment-user-at-start";
import { recoverInterruptedTrafficMaintenance } from "./docker-runtime";
import { IntegrationStore } from "./integration-store";
import { openOpsJobJournal } from "./journal";
import { createProductionRegistryResourceClaimer } from "./policy";
import {
  createProductionOpsRuntime,
  productionOwnedServices,
  productionReleaseEffects,
} from "./production-runtime";
import { agentLogLine, describeServiceFilesAtStart } from "./service-files-at-start";
import { installStandaloneIntegrationRuntime } from "./standalone-integration-runtime";
import {
  afterValidatedServiceAuthority,
  resolveBootstrapEnabledServiceIds,
} from "./startup-authority";
import {
  initializeTrustedConfigurationRuntime,
  readTrustedEnabledServiceIds,
} from "./trusted-config-runtime";
import {
  createFileTrustedOpsDataSource,
  initializeTerminalClaimCleanup,
} from "./trusted-config-source";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

async function main(): Promise<void> {
  const config = loadOpsAgentConfig();
  // The release's manifests and service files apply, with the operator's
  // overrides; the checkout's no longer do. Reported, never fatal at start.
  for (const line of describeServiceFilesAtStart(join(config.rootDir, "infra", "docker"))) {
    process.stderr.write(`${agentLogLine(line)}\n`);
  }
  await afterValidatedServiceAuthority(config.rootDir, async (releaseAuthority) => {
    const [apiToken, dataManagerToken] = await Promise.all([
      readOpsTokenFile(config.apiTokenFile),
      readOpsTokenFile(config.dataManagerTokenFile),
    ]);
    const builtInServices = releaseAuthority.services.map((service) => structuredClone(service));
    const paths = repoPaths(config.rootDir);
    const uid = process.geteuid?.() ?? 0;
    const gid = process.getegid?.() ?? 0;
    const authorityOptions = {
      rootDir: config.rootDir,
      builtInAuthorityDigest: releaseAuthority.digest,
    };
    const builtInIntegrationIds = () =>
      new Set(
        (
          services.embeddedBuiltInIntegrationManifests() ??
          services.checkoutBuiltInIntegrationManifests(config.rootDir)
        ).ids,
      );
    // The agent is the only writer of its community store. An interrupted
    // repository transaction is undone before any authority load, which
    // refuses a checkout it cannot validate.
    const communityRepositories = new CommunityRepositoryStore({
      rootDir: config.rootDir,
      uid,
      loadAuthority: () => authorityLoader(),
    });
    await communityRepositories.recover();
    // And of its integration store; an interrupted install is undone before
    // any authority load reads the integrations.
    const integrationStore = new IntegrationStore({
      rootDir: config.rootDir,
      uid,
      builtInIds: builtInIntegrationIds,
    });
    await integrationStore.recover();
    // The generations the agent writes require UID and GID in .env, which
    // only a render on the host writes. Problems are reported, not fatal.
    for (const line of describeDeploymentUserAtStart(paths.infraDir)) {
      process.stderr.write(`${line}\n`);
    }
    // Compose interpolates infra/docker/.env into every service; one that is
    // not the operator's alone is refused by every stack command.
    const environmentProblem = services.deploymentEnvironmentFileProblem(
      join(paths.infraDir, ".env"),
    );
    if (environmentProblem) process.stderr.write(`${environmentProblem}\n`);
    // The operator's selection can name installed community services as well
    // as built-in ones.
    const communityServices = (
      await createTrustedConfigurationAuthorityLoader({ ...authorityOptions, builtInServices })()
    ).services.filter((service) => !service.isBuiltIn);
    const bootstrapEnabledServiceIds = resolveBootstrapEnabledServiceIds(
      [...builtInServices, ...communityServices],
      services.readDesiredSelection(paths.infraDir),
    );
    for (const service of builtInServices) {
      service.enabled = bootstrapEnabledServiceIds.has(service.manifest.id);
    }
    const journal = await openOpsJobJournal(config.journalFile);
    // A maintenance job this agent was stopped in left its fence behind, and
    // with it a quiesced data-manager worker that would never ask again.
    try {
      const recovery = await recoverInterruptedTrafficMaintenance({
        trafficDataRoot: join(paths.infraDir, "data"),
        journalRecords: journal.records(),
      });
      if (recovery.state === "released") {
        process.stderr.write(
          `Released the Valhalla traffic maintenance fence of interrupted job ${recovery.operationId.slice(0, 16)} (${recovery.plan}); data-manager requests a fresh maintenance\n`,
        );
      } else if (recovery.state === "kept") {
        process.stderr.write(
          `Kept the Valhalla traffic maintenance fence: ${recovery.reason}. Valhalla stays stopped and data-manager's traffic worker paused; recover as described under "Graph maintenance pauses" in the monitoring guide\n`,
        );
      }
    } catch {
      process.stderr.write("Could not check the Valhalla traffic maintenance fence\n");
    }
    // After the configuration helper replaces it, this agent starts before
    // anything has rendered with its code, so the state directories it opens
    // may not exist yet.
    await services.withConfigurationGenerationWriter(paths.infraDir, async () =>
      services.prepareAgentStateDirectories(paths.infraDir),
    );
    const controlStartup = loadControlStartup({
      infraDir: paths.infraDir,
      role: "ops-agent",
      serviceIds: [...builtInServices, ...communityServices].map((s) => s.manifest.id),
      container: existsSync("/run/secrets/openmapx-control-verifiers"),
    });
    if (controlStartup.reason) console.error(controlStartup.reason);
    if (controlStartup.installation) {
      try {
        await initializeManagedCatalogPins({
          rootDir: config.rootDir,
          installation: controlStartup.installation,
        });
      } catch {
        console.error(
          "Paired catalog initialization unavailable; preserve original ownership and reconcile before transit operations",
        );
      }
    }
    const terminalClaimCleanup = await initializeTerminalClaimCleanup(
      config.trustedConfigDirectory,
      {
        allowedUids: [uid],
        expectedGid: gid,
        token: apiToken,
        journalRecords: journal.records(),
      },
    );
    await initializeTrustedConfigurationRuntime(paths.infraDir);
    const authorityLoader = createTrustedConfigurationAuthorityLoader({
      ...authorityOptions,
      builtInServices,
    });
    const initialAuthority = await authorityLoader();
    for (const { integrationId, problem } of initialAuthority.integrationProblems ?? []) {
      process.stderr.write(`Integration "${integrationId}" is not loaded: ${problem}\n`);
    }
    // The managed timeline endpoint is registered only when the trusted
    // service selection explicitly enables `dawarich-app`.  Its request path,
    // container name and collector script remain fixed; every call re-checks
    // the running image digest/revision before sending a subject locator.
    const managedDawarichEnabled = initialAuthority.services.some(
      (service) =>
        service.manifest.id === "dawarich-app" &&
        service.enabled &&
        service.manifest.subjectData?.strategy === "collector" &&
        service.manifest.subjectData.registrationIds?.includes("managed-dawarich"),
    );
    const dawarichInspector = managedDawarichEnabled
      ? createDockerDawarichRuntimeInspector()
      : undefined;
    const dawarichCollector = dawarichInspector
      ? createDockerDawarichCollector({ inspect: dawarichInspector })
      : undefined;
    const administrativeCli = createDefaultFixedCli(config.rootDir);
    const runtime = await createProductionOpsRuntime({
      rootDir: config.rootDir,
      stack: paths,
      loadAuthority: authorityLoader,
      communityRepositories,
      integrationStore,
      runFixedCli: administrativeCli,
      candidateSource: {
        directory: config.trustedConfigDirectory,
        token: apiToken,
        ownerUid: uid,
        ownerGid: gid,
      },
    });
    const transferPolicy = loadArtifactTransferPolicy();
    const artifactTransfers =
      "policy" in transferPolicy && controlStartup.installation
        ? new ArtifactTransferStore({
            dataRoot: join(paths.infraDir, "data", ".openmapx-transfers"),
            privateRoot: artifactTransferPrivateRoot(
              paths.infraDir,
              existsSync("/run/secrets/openmapx-control-verifiers"),
            ),
            token: apiToken,
            policy: transferPolicy.policy,
            admissionsOpen: () => configurationHandoffPendingMaintenanceIds(runtime).size === 0,
          })
        : undefined;
    if (artifactTransfers) {
      installArtifactTransferRuntime(runtime, artifactTransfers);
      installPreparedImportRuntime(runtime, artifactTransfers, {
        rootDir: config.rootDir,
        infraDir: paths.infraDir,
        stack: paths,
        ownedServices: productionOwnedServices(runtime),
        loadAuthority: authorityLoader,
      });
    } else if ("reason" in transferPolicy) console.error(transferPolicy.reason);
    if (controlStartup.installation)
      installStandaloneIntegrationRuntime(runtime, {
        rootDir: config.rootDir,
        store: artifactTransfers,
      });
    const releaseEffects = productionReleaseEffects(runtime);
    const runBackupRetention = () => {
      void Promise.resolve()
        .then(() => {
          const retentionDays = services.readAppliedPlatformValues(
            paths.infraDir,
          ).backupRetentionDays;
          return pruneBackupRetention(config.rootDir, retentionDays, administrativeCli);
        })
        .catch(() => {
          process.stderr.write("Scheduled backup retention failed\n");
        });
    };
    const policyAuthority = async () => {
      const authority = await authorityLoader();
      return {
        revisionId: `${authority.revisionId.slice(0, 48)}-${loadConfiguredResourceAuthority().revisionId}`,
        configurationAuthorityRevision: authority.revisionId,
        services: authority.services.map((service) => ({
          serviceId: service.manifest.id,
          enabled: service.enabled,
          isBuiltIn: service.isBuiltIn,
          selectionAuthority: service,
        })),
        integrationIds: [...authority.integrationSchemas.keys()],
      };
    };
    const initialPolicyAuthority = await policyAuthority();
    await startOpsAgentServer(
      {
        tokens: { api: apiToken, "data-manager": dataManagerToken },
        resourceClaimer: createProductionRegistryResourceClaimer({
          services: initialPolicyAuthority.services,
          integrationIds: initialPolicyAuthority.integrationIds,
          loadAuthority: policyAuthority,
          ownedServices: productionOwnedServices(runtime),
          serviceMetadata: (authorityServices) =>
            authorityServices.map((service) => ({
              serviceId: service.serviceId,
              isBuiltIn: service.isBuiltIn,
              buildable: !!service.selectionAuthority.manifest.buildCommand,
              creationDependencies: services.serviceCreationDependencyIds(
                authorityServices.map((value) => value.selectionAuthority),
                [service.serviceId],
              ),
            })),
          enabledServiceIds: (authorityServices) => {
            const trusted = readTrustedEnabledServiceIds(
              paths.infraDir,
              authorityServices.map((service) => service.selectionAuthority),
            );
            return trusted ?? bootstrapEnabledServiceIds;
          },
          trustedData: createDataTransitTrustedOpsDataSource(
            controlStartup.installation,
            createFileTrustedOpsDataSource({
              directory: config.trustedConfigDirectory,
              token: apiToken,
              allowedUids: [uid],
              expectedGid: gid,
            }),
          ),
          resourceAuthority: {
            allowBackup: (kind, backupId, serviceIds) =>
              inspectBackupAuthority(config.rootDir, kind, backupId, serviceIds),
            allowRegion: (_kind, regionId) =>
              loadConfiguredResourceAuthority().regions.has(regionId),
            allowCountry: (_kind, countryCode) =>
              loadConfiguredResourceAuthority().countries.has(countryCode),
            allowDataType: async (dataTypeId) =>
              inspectDataTypeAuthority((await authorityLoader()).services, dataTypeId),
            allowCatalogRevision: () => false,
            allowRelease: (_kind, releaseId) => inspectReleaseAuthority(config.rootDir, releaseId),
          },
        }),
        journal,
        controlInstallation: controlStartup.installation,
        terminalClaimCleanup,
        runtime,
        artifactTransfers,
        audit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
        ...(dawarichCollector && dawarichInspector
          ? {
              dawarichExport: {
                enabled: true,
                inspectRuntime: dawarichInspector,
                runCollector: dawarichCollector,
              },
            }
          : {}),
      },
      releaseEffects,
      { host: config.host, port: config.port },
      () => {
        runBackupRetention();
        const retentionTimer = setInterval(runBackupRetention, 24 * 60 * 60 * 1_000);
        retentionTimer.unref();
      },
    );
  });
}

void main().catch((error: unknown) => {
  // Only the message: startup errors carry fixed reasons, never key material.
  const reason = error instanceof Error ? `: ${error.message}` : "";
  process.stderr.write(`ops-agent failed to start${reason}\n`);
  process.exitCode = 1;
});
