import { existsSync } from "node:fs";
import { join } from "node:path";
import { readOpsTokenFile } from "@openmapx/core/ops";
import { repoPaths } from "@openmapx/core/server";
import {
  createAdministrativeRuntime,
  createDefaultFixedCli,
  createDefaultReleaseEffects,
  inspectBackupAuthority,
  inspectDataTypeAuthority,
  inspectReleaseAuthority,
  loadConfiguredResourceAuthority,
  pruneBackupRetention,
} from "./administrative-runtime";
import { loadOpsAgentConfig } from "./config";
import { createDockerRuntime } from "./docker-runtime";
import { openOpsJobJournal } from "./journal";
import { createProductionRegistryResourceClaimer } from "./policy";
import { buildOpsAgentServer } from "./server";
import {
  afterValidatedServiceAuthority,
  resolveBootstrapEnabledServiceIds,
} from "./startup-authority";
import { createTransitousLockRuntime } from "./transitous-lock-runtime";
import {
  initializeTrustedConfigurationRuntime,
  installTrustedConfigurationRuntime,
  readTrustedEnabledServiceIds,
} from "./trusted-config-runtime";
import {
  createFileTrustedOpsDataSource,
  initializeTrustedSnapshotDirectory,
} from "./trusted-config-source";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

async function main(): Promise<void> {
  const config = loadOpsAgentConfig();
  await afterValidatedServiceAuthority(config.rootDir, async (releaseAuthority) => {
    const [apiToken, dataManagerToken] = await Promise.all([
      readOpsTokenFile(config.apiTokenFile),
      readOpsTokenFile(config.dataManagerTokenFile),
    ]);
    const builtInServices = releaseAuthority.services.map((service) => structuredClone(service));
    const bootstrapEnabledServiceIds = resolveBootstrapEnabledServiceIds(
      builtInServices,
      process.env.OPENMAPX_ENABLED_SERVICES,
    );
    for (const service of builtInServices) {
      service.enabled = bootstrapEnabledServiceIds.has(service.manifest.id);
    }
    const journal = await openOpsJobJournal(config.journalFile);
    const paths = repoPaths(config.rootDir);
    const uid = process.geteuid?.() ?? 0;
    const gid = process.getegid?.() ?? 0;
    await initializeTrustedSnapshotDirectory(config.trustedConfigDirectory, {
      allowedUids: [uid],
      expectedGid: gid,
      token: apiToken,
      journalRecords: journal.records(),
    });
    await initializeTrustedConfigurationRuntime(paths.infraDir);
    const authorityLoader = createTrustedConfigurationAuthorityLoader({
      rootDir: config.rootDir,
      builtInServices,
      builtInAuthorityDigest: releaseAuthority.digest,
    });
    const initialAuthority = await authorityLoader();
    const runtime = createDockerRuntime({
      composeFile: join(paths.infraDir, ".trusted-config-current", "docker-compose.generated.yml"),
      releaseComposeFile: paths.composeReleasePath,
      releaseComposeExists: existsSync,
    });
    installTrustedConfigurationRuntime(runtime, {
      services: initialAuthority.services,
      integrationSchemas: initialAuthority.integrationSchemas,
      loadAuthority: authorityLoader,
      infraDir: paths.infraDir,
    });
    const administrativeCli = createDefaultFixedCli(config.rootDir);
    const releaseEffects = createDefaultReleaseEffects(config.rootDir, administrativeCli);
    await releaseEffects.initialize?.();
    createTransitousLockRuntime(runtime, { rootDir: config.rootDir });
    createAdministrativeRuntime(runtime, {
      rootDir: config.rootDir,
      runFixedCli: administrativeCli,
      releaseEffects,
      loadBuildAuthority: async () =>
        (await authorityLoader()).services.map((service) => ({
          serviceId: service.manifest.id,
          enabled: service.enabled,
          isBuiltIn: service.isBuiltIn,
          ...(service.manifest.buildCommand ? { buildCommand: service.manifest.buildCommand } : {}),
        })),
    });
    const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS?.trim() || "30");
    if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 36_500) {
      throw new Error("Invalid BACKUP_RETENTION_DAYS");
    }
    const runBackupRetention = () =>
      void pruneBackupRetention(config.rootDir, retentionDays, administrativeCli).catch(() => {
        process.stderr.write("Scheduled backup retention failed\n");
      });
    runBackupRetention();
    setInterval(runBackupRetention, 24 * 60 * 60 * 1_000);
    const policyAuthority = async () => {
      const authority = await authorityLoader();
      const resources = loadConfiguredResourceAuthority();
      return {
        revisionId: `${authority.revisionId.slice(0, 48)}-${resources.revisionId}`,
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
    const app = buildOpsAgentServer({
      tokens: { api: apiToken, "data-manager": dataManagerToken },
      resourceClaimer: createProductionRegistryResourceClaimer({
        services: initialPolicyAuthority.services,
        integrationIds: initialPolicyAuthority.integrationIds,
        loadAuthority: policyAuthority,
        enabledServiceIds: (authorityServices) => {
          const trusted = readTrustedEnabledServiceIds(
            paths.infraDir,
            authorityServices.map((service) => service.selectionAuthority),
          );
          return trusted ?? bootstrapEnabledServiceIds;
        },
        trustedData: createFileTrustedOpsDataSource({
          directory: config.trustedConfigDirectory,
          token: apiToken,
          allowedUids: [uid],
          expectedGid: gid,
        }),
        resourceAuthority: {
          allowBackup: (kind, backupId, serviceIds) =>
            inspectBackupAuthority(config.rootDir, kind, backupId, serviceIds),
          allowRegion: (_kind, regionId) => loadConfiguredResourceAuthority().regions.has(regionId),
          allowCountry: (_kind, countryCode) =>
            loadConfiguredResourceAuthority().countries.has(countryCode),
          allowDataType: async (dataTypeId) =>
            inspectDataTypeAuthority((await authorityLoader()).services, dataTypeId),
          allowCatalogRevision: (kind, revisionId) =>
            kind === "data.generateApiKeys" && revisionId === "transitous-fixed-v1",
          allowRelease: (_kind, releaseId) => inspectReleaseAuthority(config.rootDir, releaseId),
          allowUpdateJobId: (updateJobId) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(updateJobId),
        },
      }),
      journal,
      runtime,
      audit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    });
    await app.listen({ host: config.host, port: config.port });
  });
}

void main().catch(() => {
  process.stderr.write("ops-agent failed to start\n");
  process.exitCode = 1;
});
