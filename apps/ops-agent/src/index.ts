import { constants, existsSync } from "node:fs";
import { open } from "node:fs/promises";
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
import { AGENT_HANDOFF_LABEL, isTerminalHandoff, readAgentHandoff } from "./agent-handoff";
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
import { runContainedProcess } from "./docker-runtime";
import { IntegrationStore } from "./integration-store";
import { openOpsJobJournal } from "./journal";
import { importLegacyAgentState, retireLegacyAgentState } from "./legacy-state";
import { createProductionRegistryResourceClaimer } from "./policy";
import type { PrivacyBackupExtractionRouteOptions } from "./privacy-backup-extraction";
import {
  createPrivacyBackupExtractionRuntime,
  janitorPrivacyBackupScratch,
  probePrivacyBackupRuntime,
} from "./privacy-backup-runtime";
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

/** How often the agent checks again whether the earlier releases' lock can be retired. */
const LEGACY_WRITER_RETRY_MS = 10_000;

async function main(): Promise<void> {
  const config = loadOpsAgentConfig();
  // Privacy scratch, like the trusted-configuration queue, is reached through
  // the checkout: the container's own mount may still be the old location,
  // which data-manager can read. OPS_PRIVACY_BACKUP_SCRATCH_ROOT stays set for
  // agents of earlier releases.
  janitorPrivacyBackupScratch(config.rootDir);
  // With the whole checkout, as this release's manifest mounts it, or only
  // infra/docker with its runtime directories: the agent works either way.
  process.stderr.write(`${services.describeMountLayout(config.rootDir)}\n`);
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
    let privacyBackupExtraction: Omit<PrivacyBackupExtractionRouteOptions, "apiToken"> | undefined;
    const privacyBackupRuntimeOptions = {
      rootDir: config.rootDir,
      collectorImage: process.env.OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE?.trim(),
    };
    if (config.privacyBackupCapabilityKeyFile) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          config.privacyBackupCapabilityKeyFile,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const stat = await handle.stat();
        const expectedUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== 43 ||
          (stat.mode & 0o077) !== 0 ||
          stat.uid !== expectedUid
        )
          throw new Error("invalid capability key");
        const buffer = Buffer.alloc(43);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        const encoded = buffer.subarray(0, read.bytesRead).toString("utf8");
        if (read.bytesRead !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
          throw new Error("invalid capability key");
        const key = Buffer.from(encoded, "base64url");
        if (key.byteLength !== 32 || key.toString("base64url") !== encoded)
          throw new Error("invalid capability key");
        const backupRuntime = createPrivacyBackupExtractionRuntime(privacyBackupRuntimeOptions);
        privacyBackupExtraction = {
          capabilityKey: key,
          enabled:
            process.env.OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED === "true" && backupRuntime.enabled,
          inspectBackup: backupRuntime.inspectBackup,
          runCollector: backupRuntime.runCollector,
        };
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
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
    // Releases before this one kept both stores in the checkout. The first
    // time, a change they left unfinished is undone where it began, then the
    // stores are copied into the agent's state, each entry verified against
    // its record, before anything is installed there. After a panel
    // self-update this runs before app-api is recreated with the new mount;
    // until then app-api keeps reading the earlier copies, which stay.
    // Without the checkout there is nothing to copy them from: said here, and
    // every render and commit refuses until a host render has copied them.
    const storesCopied = services.readAgentStoresMigration(paths.infraDir) !== null;
    if (!storesCopied && !services.checkoutMounted(config.rootDir)) {
      process.stderr.write(`${services.AGENT_STORES_NOT_COPIED}\n`);
    } else if (!storesCopied) {
      const legacy = services.legacyAgentStorePaths(paths.infraDir);
      await new CommunityRepositoryStore({
        rootDir: config.rootDir,
        directory: legacy.community,
        uid,
        loadAuthority: () => authorityLoader(),
      }).recover();
      await new IntegrationStore({
        rootDir: config.rootDir,
        directory: legacy.customIntegrations,
        uid,
        builtInIds: builtInIntegrationIds,
      }).recover();
      const migration = await services.withConfigurationGenerationWriter(paths.infraDir, async () =>
        services.prepareAgentStores(paths.infraDir, { uid }),
      );
      for (const { message } of services.describeAgentStoresMigration(migration, paths.infraDir)) {
        process.stderr.write(`${message}\n`);
      }
    }
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
    // Releases before this one kept the applied configuration, the selection
    // and the release state in infra/docker itself. After a panel self-update
    // this agent starts before anything has rendered with its code, so it
    // renders once now: the render carries them into the agent's state and
    // nothing reads the earlier files again. A failure stops the agent, so a
    // self-update rolls back to the agent that still uses them.
    if (services.configurationMigrationPending(paths.infraDir)) {
      process.stderr.write(
        "Applied configuration migration requires a host render before mutations\n",
      );
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
    // Releases before this one kept the journal and handoff record where
    // data-manager can write; import them once, before anything reads them.
    const handoffHelperRunning = async (handoffId?: string) =>
      (
        await runContainedProcess(
          "docker",
          [
            "ps",
            "--quiet",
            "--filter",
            `label=${AGENT_HANDOFF_LABEL}${handoffId === undefined ? "" : `=${handoffId}`}`,
          ],
          { signal: AbortSignal.timeout(30_000), timeout: 30_000, maxBuffer: 64 * 1024 },
        )
      ).stdout.trim() !== "";
    // Whether any container, running or stopped, bind-mounts an earlier
    // directory: one restarted without its source would get it back as root.
    const containerMounts = async (path: string) =>
      (
        await runContainedProcess(
          "docker",
          ["ps", "--all", "--quiet", "--filter", `volume=${path}`],
          {
            signal: AbortSignal.timeout(30_000),
            timeout: 30_000,
            maxBuffer: 64 * 1024,
          },
        )
      ).stdout.trim() !== "";
    const legacyState = {
      rootDir: config.rootDir,
      handoffHelperRunning,
      containerMounts,
      report: (message: string) => process.stderr.write(`${message}\n`),
    };
    const imported = await importLegacyAgentState(legacyState);
    if (imported) {
      process.stderr.write(
        `Imported the agent state from infra/docker/data/ops-agent: journal ${imported.journal}, handoff record ${imported.handoff}\n`,
      );
    }
    await retireLegacyAgentState(legacyState).catch(() => false);
    // Writers stop also taking the earlier releases' lock in infra/docker
    // once no agent of an earlier release can run: this one has started, and
    // no handoff helper runs that could roll back to one. After a panel
    // self-update the helper that started this agent is still running, so
    // the check repeats until it has exited.
    const retireLegacyWriter = async (): Promise<boolean> => {
      if (!services.legacyConfigurationWriterActive(paths.infraDir)) return true;
      if (await handoffHelperRunning()) return false;
      services.retireLegacyConfigurationWriter(paths.infraDir);
      process.stderr.write("Writers no longer take the earlier releases' lock in infra/docker\n");
      return true;
    };
    if (!(await retireLegacyWriter().catch(() => false))) {
      const retry = setInterval(() => {
        retireLegacyWriter()
          .then((retired) => {
            if (retired) clearInterval(retry);
          })
          .catch(() => undefined);
      }, LEGACY_WRITER_RETRY_MS);
      retry.unref();
    }
    const journal = await openOpsJobJournal(config.journalFile);
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
    const releaseMigration = await services.migrateLegacyReleaseState(paths.infraDir);
    if (releaseMigration)
      for (const problem of releaseMigration.problems) process.stderr.write(`${problem}\n`);
    const administrativeCli = createDefaultFixedCli(config.rootDir);
    const runtime = await createProductionOpsRuntime({
      rootDir: config.rootDir,
      stack: paths,
      loadAuthority: authorityLoader,
      communityRepositories,
      integrationStore,
      releaseRuntimeOptions: {
        afterHandoffSettled: async () => {
          await retireLegacyAgentState(legacyState);
          await retireLegacyWriter();
        },
        onLegacyReleaseMigration: (migration) => {
          for (const problem of migration.problems) process.stderr.write(`${problem}\n`);
        },
      },
      runFixedCli: administrativeCli,
      candidateSource: {
        directory: config.trustedConfigDirectory,
        token: apiToken,
        ownerUid: uid,
        ownerGid: gid,
      },
    });
    const replacementInProgress = () => {
      if (configurationHandoffPendingMaintenanceIds(runtime).size) return true;
      try {
        const handoff = readAgentHandoff(config.rootDir);
        return handoff !== null && !isTerminalHandoff(handoff.phase);
      } catch {
        return true;
      }
    };
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
            admissionsOpen: () => !replacementInProgress(),
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
            allowUpdateJobId: (updateJobId) =>
              /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(updateJobId),
          },
        }),
        journal,
        controlInstallation: controlStartup.installation,
        terminalClaimCleanup,
        runtime,
        artifactTransfers,
        replacementInProgress: () => {
          if (configurationHandoffPendingMaintenanceIds(runtime).size) return true;
          try {
            const handoff = readAgentHandoff(config.rootDir);
            return handoff !== null && !isTerminalHandoff(handoff.phase);
          } catch {
            // Unknown legacy replacement retains the existing mutation/drain
            // boundary; inspection and health remain reachable.
            return true;
          }
        },
        audit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
        ...(privacyBackupExtraction ? { privacyBackupExtraction } : {}),
        privacyBackupHealth: () =>
          probePrivacyBackupRuntime({
            ...privacyBackupRuntimeOptions,
            enabled: privacyBackupExtraction?.enabled === true,
          }),
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
