import { createHash } from "node:crypto";
import { join } from "node:path";
import { initializeErasureJournal } from "@openmapx/core/erasure-journal";
import { services as coreServices } from "@openmapx/core/server";
import { type Command, Option } from "commander";
import { assertCliDeploymentSecrets } from "../lib/deployment-secret-policy";
import { dockerComposeStream } from "../lib/docker";
import { applyGeneratedHardlinks } from "../lib/hardlinks";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";
import {
  assertPlatformFileTarget,
  ensurePlatformExportsKeyRingFile,
  ensurePlatformOwnerOnlySecretFile,
  ensurePlatformPrivateDirectory,
  ensurePlatformSecretFile,
  PlatformFileTargetChangedError,
  type PlatformReplacementHooks,
  type PlatformTargetMetadataValidator,
  type PlatformTemporaryFileOps,
  type PreparedPlatformFileReplacement,
  preparePlatformFileReplacement,
  preparePlatformSecretReplacement,
  readPlatformFileContents,
  readPlatformSecretFile,
  writePlatformFileAtomically,
} from "../lib/platform-secret-files";
import { combineServiceSelection } from "../lib/preset-selection";
import {
  clearReleaseSelection,
  ensureReleaseOverlay,
  releaseStatusLines,
  selectRelease,
  unpinnedReleaseWarning,
} from "../lib/release";
import { applyServiceSelection } from "../lib/service-selection";

const {
  commitConfigurationGeneration,
  loadIntegrationSchemas,
  readAppliedConfiguration,
  resolveServiceConfigFromEnv,
  ServiceRegistry,
} = coreServices;

export interface RenderRepoOptions {
  rootDir?: string;
  domain: string;
  services?: string[];
  redisAuthHooks?: RedisAuthReconciliationHooks;
}

export interface RenderRepoResult {
  servicesRendered: number;
  /** The applied generation's compose file. */
  composePath: string;
  revisionId: string;
  requestedServiceIds: string[];
  enabledServiceIds: string[];
  selectionWarnings: string[];
  /**
   * Render-time advisories from the compose renderer — currently emitted for
   * optional bind-mounts whose host source is missing and was therefore
   * skipped (see `bindMounts[].optional` in the manifest schema).
   */
  renderWarnings: string[];
}

export interface RotateRedisPasswordOptions {
  rootDir?: string;
  confirmClientsStopped: boolean;
  randomBytes?: (size: number) => Uint8Array;
  aclTemporaryFileOps?: PlatformTemporaryFileOps;
  aclTargetMetadataValidator?: PlatformTargetMetadataValidator;
  redisAuthHooks?: RedisAuthReconciliationHooks;
  rotationHooks?: RedisPasswordRotationHooks;
  passwordReplacementHooks?: PlatformReplacementHooks;
}

export interface RedisAuthReconciliationHooks {
  afterPasswordObserved?: (attempt: number) => void;
}

export interface RedisPasswordRotationHooks {
  afterPasswordCommitted?: () => void;
}

export interface RotateRedisPasswordResult {
  passwordPath: string;
  aclPath: string;
}

function redisAclContents(password: string): string {
  const passwordHash = createHash("sha256").update(password).digest("hex");
  return `user default on #${passwordHash} ~* &* +@all\n`;
}

function reconcileRedisAuthFiles(
  passwordPath: string,
  aclPath: string,
  hooks: RedisAuthReconciliationHooks = {},
): void {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const observedPassword = readPlatformSecretFile(passwordPath);
    hooks.afterPasswordObserved?.(attempt);
    const expectedAcl = redisAclContents(observedPassword);
    try {
      writePlatformFileAtomically(aclPath, expectedAcl);
    } catch (error) {
      if (error instanceof PlatformFileTargetChangedError) continue;
      throw error;
    }
    const authoritativePassword = readPlatformSecretFile(passwordPath);
    const authoritativeAcl = readPlatformFileContents(aclPath);
    if (authoritativePassword === observedPassword && authoritativeAcl === expectedAcl) return;
  }
  throw new Error(
    "Redis authentication files could not be reconciled because of continuous password churn",
  );
}

export function rotateRedisPasswordForRepo(
  options: RotateRedisPasswordOptions,
): RotateRedisPasswordResult {
  if (!options.confirmClientsStopped) {
    throw new Error("Redis clients must be stopped before password rotation");
  }

  const paths = repoPaths(options.rootDir);
  const passwordPath = join(paths.infraDir, "secrets", "redis-password");
  const aclPath = join(paths.infraDir, "secrets", "redis-acl.conf");
  try {
    assertPlatformFileTarget(aclPath, {
      requireExisting: true,
      targetMetadataValidator: options.aclTargetMetadataValidator,
    });
  } catch (error) {
    throw new Error(`Redis ACL target preflight failed: ${(error as Error).message}`);
  }

  const passwordReplacement = preparePlatformSecretReplacement(passwordPath, {
    randomBytes: options.randomBytes,
    replacementHooks: options.passwordReplacementHooks,
  });
  let aclReplacement: PreparedPlatformFileReplacement;
  try {
    aclReplacement = preparePlatformFileReplacement(
      aclPath,
      redisAclContents(passwordReplacement.value),
      {
        temporaryFileOps: options.aclTemporaryFileOps,
        targetMetadataValidator: options.aclTargetMetadataValidator,
        requireExisting: true,
      },
    );
  } catch (error) {
    passwordReplacement.cleanup();
    throw new Error(`Redis ACL candidate preparation failed: ${(error as Error).message}`);
  }

  let passwordCommitted = false;
  try {
    passwordReplacement.assertTargetUnchanged();
    aclReplacement.assertTargetUnchanged();
    passwordReplacement.commit();
    passwordCommitted = true;
    options.rotationHooks?.afterPasswordCommitted?.();
    aclReplacement.commit();
  } catch (error) {
    passwordReplacement.cleanup();
    aclReplacement.cleanup();
    if (!passwordCommitted && passwordReplacement.hasCommitted()) {
      throw new Error(
        `Redis password commit crossed the rename boundary but post-commit verification failed; keep Redis clients stopped and run \`openmapx compose render\` to reconcile the authoritative password and ACL before recreating Redis: ${(error as Error).message}`,
      );
    }
    if (passwordCommitted) {
      throw new Error(
        `Redis password commit succeeded but the ACL commit failed; keep Redis clients stopped, repair the ACL target integrity issue, then run \`openmapx compose render\` before recreating Redis: ${(error as Error).message}`,
      );
    }
    throw new Error(
      `Redis rotation precommit failed without changing the password: ${(error as Error).message}`,
    );
  }
  reconcileRedisAuthFiles(passwordPath, aclPath, options.redisAuthHooks);
  return { passwordPath, aclPath };
}

export async function renderComposeForRepo(opts: RenderRepoOptions): Promise<RenderRepoResult> {
  const paths = repoPaths(opts.rootDir);
  assertCliDeploymentSecrets();
  ensurePlatformPrivateDirectory(join(paths.infraDir, "data", "ops-agent", "trusted-config"));
  const erasureDirectory = join(paths.infraDir, "data", "erasure");
  ensurePlatformPrivateDirectory(erasureDirectory);
  ensurePlatformPrivateDirectory(join(paths.infraDir, "data", "privacy-extraction"));
  ensurePlatformPrivateDirectory(join(paths.infraDir, "backups"));
  const redisPasswordPath = join(paths.infraDir, "secrets", "redis-password");
  const redisAclPath = join(paths.infraDir, "secrets", "redis-acl.conf");
  const opsAgentApiTokenPath = join(paths.infraDir, "secrets", "ops-agent-api-token");
  const opsAgentDataManagerTokenPath = join(
    paths.infraDir,
    "secrets",
    "ops-agent-data-manager-token",
  );
  const offlinePackagePrincipalKeyPath = join(
    paths.infraDir,
    "secrets",
    "offline-package-principal-key",
  );
  const erasureJournalKeyPath = join(paths.infraDir, "secrets", "erasure-journal-key");
  const subjectExportsMasterKeyPath = join(paths.infraDir, "secrets", "subject-exports-master-key");
  const privacyBackupCapabilityKeyPath = join(
    paths.infraDir,
    "secrets",
    "privacy-backup-capability-key",
  );
  // Shared only between data-manager and the private Transitous runner: it
  // signs the single-use capability tokens that authorize one upstream run.
  const transitousRunnerCapabilityPath = join(
    paths.infraDir,
    "secrets",
    "transitous-runner-capability",
  );
  ensurePlatformSecretFile(redisPasswordPath);
  ensurePlatformSecretFile(offlinePackagePrincipalKeyPath);
  const erasureJournalKey = Buffer.from(
    ensurePlatformSecretFile(erasureJournalKeyPath),
    "base64url",
  );
  initializeErasureJournal(join(erasureDirectory, "journal.jsonl"), erasureJournalKey);
  ensurePlatformExportsKeyRingFile(subjectExportsMasterKeyPath);
  // app-api and ops-agent refuse this key unless only their uid can read it.
  ensurePlatformOwnerOnlySecretFile(privacyBackupCapabilityKeyPath);
  ensurePlatformSecretFile(transitousRunnerCapabilityPath);
  const opsAgentApiToken = ensurePlatformSecretFile(opsAgentApiTokenPath);
  const opsAgentDataManagerToken = ensurePlatformSecretFile(opsAgentDataManagerTokenPath);
  if (opsAgentApiToken === opsAgentDataManagerToken) {
    throw new Error("Ops-agent API and data-manager tokens must be distinct");
  }
  reconcileRedisAuthFiles(redisPasswordPath, redisAclPath, opts.redisAuthHooks);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const applied = applyServiceSelection(registry, {
    rootDir: paths.root,
    explicitIds: opts.services,
  });
  const services = registry.list();
  const known = new Set(services.map((service) => service.manifest.id));
  const integrationSchemas = loadIntegrationSchemas(paths.root);
  // The database is the admin panel's: what it saved arrives through the
  // generation it last applied. The env layer is this host's.
  const saved = readAppliedConfiguration(paths.infraDir);
  const savedConfigs = new Map(saved.serviceConfigs.map((entry) => [entry.serviceId, entry]));
  const serviceConfigs = services.flatMap((service) => {
    const { id } = service.manifest;
    const proxyHostKey = service.manifest.exposure?.proxy?.host?.configKey;
    const fromEnv = Object.entries(
      resolveServiceConfigFromEnv(service.manifest, process.env),
    ).filter(([, entry]) => entry.source === "env");
    // An env value is a reference in the YAML, except the proxy host, which
    // the routes need as a value.
    const envKeys = fromEnv.map(([key]) => key).filter((key) => key !== proxyHostKey);
    const values: coreServices.ConfigurationInput["serviceConfigs"][number]["values"] =
      Object.fromEntries(
        Object.entries(savedConfigs.get(id)?.values ?? {}).filter(
          ([key]) => !envKeys.includes(key),
        ),
      );
    for (const [key, entry] of fromEnv) if (key === proxyHostKey) values[key] = String(entry.value);
    if (Object.keys(values).length === 0 && envKeys.length === 0) return [];
    return [{ serviceId: id, values, ...(envKeys.length > 0 ? { envKeys } : {}) }];
  });
  const committed = await commitConfigurationGeneration({
    infraDir: paths.infraDir,
    services,
    integrationSchemas,
    input: {
      domain: opts.domain,
      selectedRoots: applied.requestedIds,
      serviceConfigs,
      integrationConfigs: saved.integrationConfigs.filter((entry) =>
        integrationSchemas.has(entry.integrationId),
      ),
      serviceSecrets: saved.serviceSecrets.filter((entry) => known.has(entry.serviceId)),
    },
    allowMissingSelected: applied.source === "default",
  });
  return {
    servicesRendered: committed.enabledServiceIds.length,
    composePath: paths.composePath,
    revisionId: committed.revisionId,
    requestedServiceIds: applied.requestedIds,
    enabledServiceIds: committed.enabledServiceIds,
    selectionWarnings: applied.selection.warnings,
    renderWarnings: committed.warnings,
  };
}

export function registerComposeCommands(program: Command): void {
  const compose = program.command("compose").description("Manage docker-compose stack");

  compose
    .command("rotate-redis-password")
    .description("Atomically rotate Redis authentication files while Redis clients are stopped")
    .option("--confirm-clients-stopped", "Confirm app-api is stopped before rotating")
    .action((options: { confirmClientsStopped?: boolean }) => {
      try {
        const result = rotateRedisPasswordForRepo({
          confirmClientsStopped: options.confirmClientsStopped === true,
        });
        log.ok(`Rotated Redis authentication files → ${result.passwordPath}, ${result.aclPath}`);
        log.dim("Recreate Redis, then restart app-api.");
      } catch (err) {
        log.err(`Redis password rotation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  compose
    .command("render")
    .description("Apply the service selection and configuration as a new configuration generation")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .option("--services <ids>", "Comma/space-separated root service ids for this render")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (options: { domain: string; services?: string; preset?: string }) => {
      try {
        const services = combineServiceSelection(options.services, options.preset);
        const r = await renderComposeForRepo({ domain: options.domain, services });
        log.ok(`Rendered ${r.servicesRendered} services → ${r.revisionId}`);
        if (r.enabledServiceIds.length > 0) {
          log.dim(`Selected services → ${r.enabledServiceIds.join(", ")}`);
        }
        for (const warning of r.selectionWarnings) log.warn(warning);
        for (const warning of r.renderWarnings) log.warn(warning);
        log.dim(`Compose file → ${r.composePath}`);
      } catch (err) {
        log.err(`Render failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  compose
    .command("up")
    .description("Start the stack via generated compose")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .option("--services <ids>", "Comma/space-separated root service ids for this run")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (options: { domain: string; services?: string; preset?: string }) => {
      try {
        const services = combineServiceSelection(options.services, options.preset);
        const r = await renderComposeForRepo({ domain: options.domain, services });
        log.ok(`Rendered ${r.servicesRendered} services → ${r.revisionId}`);
        for (const warning of r.selectionWarnings) log.warn(warning);
        for (const warning of r.renderWarnings) log.warn(warning);
        const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
        log.ok(
          `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
        );
      } catch (err) {
        log.err(`Render failed: ${(err as Error).message}`);
        process.exit(1);
      }
      const overlay = await ensureReleaseOverlay();
      if (overlay.status === "resolved") {
        log.ok(`Atomic release selection ${overlay.release} → ${overlay.path}`);
      } else if (overlay.status === "present") {
        for (const line of releaseStatusLines(overlay.path)) log.dim(line);
      } else if (overlay.status === "unpinned") {
        log.err(unpinnedReleaseWarning(overlay.reason));
        process.exit(1);
      } else if (overlay.status === "disabled") {
        log.dim(
          "Release pinning disabled (OPENMAPX_RELEASE_MANIFEST_IMAGE is empty); using manifest image tags.",
        );
      }
      const code = await dockerComposeStream(["up", "-d"]);
      process.exit(code);
    });

  compose
    .command("release")
    .description(
      "Resolve the release lockfile for atomic release selection in docker-compose.release.yml",
    )
    .option("--status", "Show locally selected release and image pins without registry access")
    .addOption(
      new Option(
        "--clear",
        "Clear local release selection without changing running containers",
      ).conflicts("status"),
    )
    .action(async (options: { status?: boolean; clear?: boolean }) => {
      try {
        if (options.status) {
          for (const line of releaseStatusLines()) log.info(line);
          return;
        }
        if (options.clear) {
          const result = await clearReleaseSelection();
          log.ok(
            result.cleared
              ? `Cleared local release selection → ${result.path}`
              : "No local release selection to clear.",
          );
          log.dim(
            "Running containers, release evidence, and recorded running state are preserved.",
          );
          log.dim(
            process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE?.trim() === ""
              ? "Release resolution is disabled; the next start/update uses manifest image tags."
              : 'Automatic release resolution will select a release on the next start/update. To use local images, separately set OPENMAPX_RELEASE_MANIFEST_IMAGE="".',
          );
          return;
        }
        const selected = await selectRelease({ report: log.info });
        log.ok(`Atomic release selection ${selected.release} → ${selected.path}`);
        log.dim(
          "Apply it with `pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner`.",
        );
      } catch (err) {
        log.err(`Release lockfile operation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  compose
    .command("down")
    .description("Stop the stack")
    .option("--volumes", "Also remove named volumes (DESTRUCTIVE)")
    .action(async (options: { volumes?: boolean }) => {
      const args = ["down"];
      if (options.volumes) args.push("-v");
      const code = await dockerComposeStream(args);
      process.exit(code);
    });

  compose
    .command("pull [ids...]")
    .description("Pull the latest images (no args = all services)")
    .action(async (ids: string[]) => {
      const code = await dockerComposeStream(["pull", ...ids]);
      process.exit(code);
    });
}
