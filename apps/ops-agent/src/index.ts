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
import { isTerminalHandoff, readAgentHandoff } from "./agent-handoff";
import { loadArtifactTransferPolicy } from "./artifact-transfer/policy";
import { installArtifactTransferRuntime } from "./artifact-transfer/runtime";
import { ArtifactTransferStore, artifactTransferPrivateRoot } from "./artifact-transfer/store";
import { startOpsAgentServer } from "./bootstrap";
import { CommunityRepositoryStore } from "./community-repositories";
import { loadOpsAgentConfig } from "./config";
import { createDataTransitTrustedOpsDataSource } from "./data-transit-resource-source";
import {
  createDockerDawarichCollector,
  createDockerDawarichRuntimeInspector,
} from "./dawarich-subject-export";
import { openOpsJobJournal } from "./journal";
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
  janitorPrivacyBackupScratch(config.rootDir, process.env.OPS_PRIVACY_BACKUP_SCRATCH_ROOT);
  await afterValidatedServiceAuthority(config.rootDir, async (releaseAuthority) => {
    const [apiToken, dataManagerToken] = await Promise.all([
      readOpsTokenFile(config.apiTokenFile),
      readOpsTokenFile(config.dataManagerTokenFile),
    ]);
    let privacyBackupExtraction: Omit<PrivacyBackupExtractionRouteOptions, "apiToken"> | undefined;
    const privacyBackupRuntimeOptions = {
      rootDir: config.rootDir,
      collectorImage: process.env.OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE?.trim(),
      scratchRoot: process.env.OPS_PRIVACY_BACKUP_SCRATCH_ROOT?.trim() || undefined,
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
    // The agent is the only writer of services/.community. An interrupted
    // repository transaction is undone before any authority load, which
    // refuses a checkout it cannot validate.
    const communityRepositories = new CommunityRepositoryStore({
      rootDir: config.rootDir,
      uid,
      loadAuthority: () => authorityLoader(),
    });
    await communityRepositories.recover();
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
      runFixedCli: administrativeCli,
      candidateSource: {
        directory: config.trustedConfigDirectory,
        token: apiToken,
        ownerUid: uid,
        ownerGid: gid,
      },
    });
    const replacementInProgress = () => {
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
    if (artifactTransfers) installArtifactTransferRuntime(runtime, artifactTransfers);
    else if ("reason" in transferPolicy) console.error(transferPolicy.reason);
    if (controlStartup.installation)
      installStandaloneIntegrationRuntime(runtime, {
        rootDir: config.rootDir,
        store: artifactTransfers,
      });
    const releaseEffects = productionReleaseEffects(runtime);
    const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS?.trim() || "30");
    if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 36_500) {
      throw new Error("Invalid BACKUP_RETENTION_DAYS");
    }
    const runBackupRetention = () =>
      void pruneBackupRetention(config.rootDir, retentionDays, administrativeCli).catch(() => {
        process.stderr.write("Scheduled backup retention failed\n");
      });
    const policyAuthority = async () => {
      const authority = await authorityLoader();
      const resources = loadConfiguredResourceAuthority();
      return {
        revisionId: `${authority.revisionId.slice(0, 48)}-${resources.revisionId}`,
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
