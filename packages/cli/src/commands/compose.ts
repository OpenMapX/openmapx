import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { provisionControlInstallation } from "@openmapx/core/build-artifacts";
import { initializeErasureJournal } from "@openmapx/core/erasure-journal";
import { services as coreServices } from "@openmapx/core/server";
import { type Command, Option } from "commander";
import { runsInAgent } from "../lib/agent-integrations";
import { containerBindMounts } from "../lib/container-mounts";
import { assertCliDeploymentSecrets } from "../lib/deployment-secret-policy";
import { dockerComposeStream } from "../lib/docker";
import { assertCliExecutionAvailable } from "../lib/execution-deadline";
import { applyGeneratedHardlinksBeforeStart } from "../lib/hardlinks";

import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";
import {
  assertPlatformFileTarget,
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
  checkRelease,
  clearReleaseSelection,
  ensureReleaseOverlay,
  releaseStatusLines,
  selectRelease,
  touchesReleasePinnedServices,
  unpinnedReleaseWarning,
} from "../lib/release";
import { selectedReleaseServiceFiles } from "../lib/release-service-files";
import { applyServiceSelection } from "../lib/service-selection";
import { ensureTransitousApiKeysFile } from "../lib/transitous-api-keys";

const {
  agentStatePaths,
  prepareAgentStateDirectories,
  withConfigurationGenerationWriter,
  embeddedBuiltInIntegrationManifests,
  loadIntegrationSchemas,
  loadTrustedIntegrationSchemas,
  readAppliedConfiguration,
  resolveServiceConfigFromEnv,
  ServiceRegistry,
} = coreServices;

export interface RenderRepoOptions {
  rootDir?: string;
  domain?: string;
  services?: string[];
  expectedCurrentRevisionId?: string | null;
  revisionId?: string;
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
  assertCliExecutionAvailable();
  const paths = repoPaths(opts.rootDir);
  coreServices.assertDeploymentEnvironmentFile(join(paths.infraDir, ".env"));
  coreServices.readAppliedReleaseSelection(paths.infraDir);
  assertCliDeploymentSecrets();
  if (!existsSync("/run/secrets/openmapx-control-verifiers"))
    await provisionControlInstallation(paths.infraDir);
  return withConfigurationGenerationWriter(paths.infraDir, (writer) =>
    renderComposeWithWriter(opts, writer),
  );
}

/** Inner lifecycle adapter; the caller already owns the one generation writer. */
export async function renderComposeWithWriter(
  opts: RenderRepoOptions,
  writer: coreServices.ConfigurationGenerationWriter,
): Promise<RenderRepoResult> {
  coreServices.assertConfigurationGenerationWriter(writer);
  const paths = repoPaths(opts.rootDir);
  assertCliExecutionAvailable();
  // The deployment's user, which the generation's containers run as. A host
  // render takes it from .env or, where it has none, from the checkout's
  // owner, and writes it there. The operations agent's fixed CLI only reads
  // .env, and refuses one without it. Either must run as that user.
  if (runsInAgent()) {
    coreServices.assertRunningAsDeploymentUser(coreServices.readDeploymentUser(paths.infraDir));
  } else {
    const deploymentUser = coreServices.ensureDeploymentUser(paths.infraDir);
    coreServices.assertRunningAsDeploymentUser(deploymentUser);
    if (deploymentUser.derived.length > 0) {
      log.info(
        `Set the deployment's user in infra/docker/.env from the checkout's owner: UID=${deploymentUser.uid} GID=${deploymentUser.gid}`,
      );
    }
  }
  // The agent's state directories, owner-only, before a generation mounts one.
  prepareAgentStateDirectories(paths.infraDir);
  // The agent's stores, owner-only, before the generation mounts one into
  // app-api.
  coreServices.prepareAgentStores(paths.infraDir);
  const agentState = agentStatePaths(paths.infraDir);
  ensurePlatformPrivateDirectory(agentState.trustedConfig);
  ensurePlatformPrivateDirectory(join(paths.infraDir, "catalog-pins"));
  const erasureDirectory = join(paths.infraDir, "data", "erasure");
  ensurePlatformPrivateDirectory(erasureDirectory);
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
  ensurePlatformSecretFile(transitousRunnerCapabilityPath);
  const opsAgentApiToken = ensurePlatformSecretFile(opsAgentApiTokenPath);
  const opsAgentDataManagerToken = ensurePlatformSecretFile(opsAgentDataManagerTokenPath);
  if (opsAgentApiToken === opsAgentDataManagerToken) {
    throw new Error("Ops-agent API and data-manager tokens must be distinct");
  }
  // The API's and data-manager's own database logins. PostGIS creates the
  // roles from these files on every start; the superuser stays with PostGIS.
  const apiDatabasePassword = ensurePlatformSecretFile(
    join(paths.infraDir, "secrets", "postgres-api-password"),
  );
  const dataManagerDatabasePassword = ensurePlatformSecretFile(
    join(paths.infraDir, "secrets", "postgres-data-manager-password"),
  );
  if (apiDatabasePassword === dataManagerDatabasePassword) {
    throw new Error("API and data-manager database passwords must be distinct");
  }
  // Each data-manager caller's own bearer token: the API, the operations agent
  // (and the CLI it runs), and the CLI on the host.
  const dataManagerTokens = ["api", "ops-agent", "host-cli"].map((caller) =>
    ensurePlatformSecretFile(join(paths.infraDir, "secrets", `data-manager-${caller}-token`)),
  );
  if (new Set(dataManagerTokens).size !== dataManagerTokens.length) {
    throw new Error("Data-manager caller tokens must be distinct");
  }
  reconcileRedisAuthFiles(redisPasswordPath, redisAclPath, opts.redisAuthHooks);
  // Before a generation mounts their directory into data-manager.
  ensureTransitousApiKeysFile(paths.root);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const applied = applyServiceSelection(registry, {
    rootDir: paths.root,
    explicitIds: opts.services,
  });
  const services = registry.list();
  const known = new Set(services.map((service) => service.manifest.id));
  const integrationSchemas = embeddedBuiltInIntegrationManifests()
    ? loadTrustedIntegrationSchemas(paths.root)
    : loadIntegrationSchemas(paths.root);
  // The database is the admin panel's: what it saved arrives through the
  // generation it last applied. The env layer is this host's.
  const saved = readAppliedConfiguration(paths.infraDir);
  const savedConfigs = new Map(saved.serviceConfigs.map((entry) => [entry.serviceId, entry]));
  const serviceConfigs = services.flatMap((service) => {
    const { id } = service.manifest;
    const proxyHostKey = service.manifest.exposure?.proxy?.host?.configKey;
    const fromEnv = Object.entries(
      resolveServiceConfigFromEnv(service.manifest, process.env, { firstParty: service.isBuiltIn }),
    ).filter(([, entry]) => entry.source === "env");
    // An env value is a reference in the YAML, except the proxy host, which
    // the routes need as a value.
    const envKeys = fromEnv
      .map(([key]) => key)
      .filter(
        (key) =>
          key !== proxyHostKey &&
          !coreServices.materializeServiceConfigKey(id, key) &&
          !fromEnv.find(([name]) => name === key)?.[1].manifestExpression,
      );
    const values: coreServices.ConfigurationInput["serviceConfigs"][number]["values"] =
      Object.fromEntries(
        Object.entries(savedConfigs.get(id)?.values ?? {}).filter(
          ([key]) =>
            !envKeys.includes(key) &&
            !fromEnv.some(([name, entry]) => name === key && entry.manifestExpression),
        ),
      );
    for (const [key, entry] of fromEnv)
      if (
        (!entry.manifestExpression || key === proxyHostKey) &&
        (key === proxyHostKey || coreServices.materializeServiceConfigKey(id, key))
      )
        values[key] = entry.value as string | number | boolean;
    if (Object.keys(values).length === 0 && envKeys.length === 0) return [];
    return [{ serviceId: id, values, ...(envKeys.length > 0 ? { envKeys } : {}) }];
  });
  const mounts = await containerBindMounts();
  // Run from the checkout with a release selected, render uses that
  // release's service files, read from its image, and refuses while the
  // checkout's built-in services differ from them.
  const selected = await selectedReleaseServiceFiles(paths.infraDir);
  if (selected === "none") {
    log.dim(
      "No release is selected yet: the services' files come from this checkout. Bootstrap can select with `pnpm openmapx compose release`; existing installations use System → Updates or `system update`.",
    );
  } else if (selected) {
    const overrides = coreServices.readServiceOverrides(paths.infraDir, selected.files);
    const differences = coreServices.checkoutDifferencesFromRelease({
      rootDir: paths.root,
      services,
      release: selected.files,
      overrides: new Map(
        overrides.active.map((entry) => [`${entry.serviceId}/${entry.path}`, entry.bytes]),
      ),
    });
    if (differences.length > 0) {
      throw new Error(
        coreServices.describeCheckoutDifferences(differences, {
          name: selected.release,
          revision: selected.revision,
        }),
      );
    }
  }
  assertCliExecutionAvailable();
  const committed = await writer.commit({
    ...(mounts ? { containerBindMounts: mounts } : {}),
    ...(selected && selected !== "none" ? { releaseServiceFiles: selected.files } : {}),
    services,
    integrationSchemas,
    input: {
      domain: coreServices.resolvePlatformConfiguration({
        saved: saved.platform,
        env: process.env,
        overrides: opts.domain === undefined ? {} : { domain: opts.domain },
      }).values.domain,
      ...(saved.platform ? { platform: saved.platform } : {}),
      ...(saved.transitCredentialsRevision
        ? { transitCredentialsRevision: saved.transitCredentialsRevision }
        : {}),
      selectedRoots: applied.requestedIds,
      serviceConfigs,
      integrationConfigs: saved.integrationConfigs.filter((entry) =>
        integrationSchemas.has(entry.integrationId),
      ),
      serviceSecrets: saved.serviceSecrets.filter((entry) => known.has(entry.serviceId)),
    },
    allowMissingSelected: applied.source === "default",
    ...(Object.hasOwn(opts, "expectedCurrentRevisionId")
      ? { expectedCurrentRevisionId: opts.expectedCurrentRevisionId }
      : {}),
    ...(opts.revisionId ? { revisionId: opts.revisionId } : {}),
  });
  for (const problem of committed.stackFileProblems) log.warn(problem);
  for (const { level, message } of committed.serviceFileReport) log[level](message);
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

  // The host CLI runs this in the selected release's operations-agent image
  // to read the service files that release ships.
  compose
    .command("release-files", { hidden: true })
    .description("Print the service files this release's bundle embeds, as JSON")
    .action(() => {
      const files = coreServices.readEmbeddedReleaseServiceFiles();
      if (!files) {
        log.err(
          "Only a release's own CLI, in its operations-agent image, embeds its service files.",
        );
        process.exit(1);
      }
      process.stdout.write(coreServices.serializeReleaseServiceFiles(files));
    });

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
    .option("--domain <d>", "Public domain (default: applied ownership or host)")
    .option("--services <ids>", "Comma/space-separated root service ids for this render")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (options: { domain?: string; services?: string; preset?: string }) => {
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
    .option("--domain <d>", "Public domain (default: applied ownership or host)")
    .option("--services <ids>", "Comma/space-separated root service ids for this run")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (options: { domain?: string; services?: string; preset?: string }) => {
      let enabledServiceIds: string[] = [];
      try {
        const services = combineServiceSelection(options.services, options.preset);
        const r = await renderComposeForRepo({ domain: options.domain, services });
        enabledServiceIds = r.enabledServiceIds;
        log.ok(`Rendered ${r.servicesRendered} services → ${r.revisionId}`);
        for (const warning of r.selectionWarnings) log.warn(warning);
        for (const warning of r.renderWarnings) log.warn(warning);
        await applyGeneratedHardlinksBeforeStart();
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
      } else if (overlay.status === "held") {
        log.err(overlay.reason);
        process.exit(1);
      } else if (overlay.status === "disabled") {
        log.dim("Release pinning disabled (OPENMAPX_RELEASE=local); using manifest image tags.");
      }
      if (enabledServiceIds.length === 0) {
        log.dim("No enabled services to start");
        process.exit(0);
      }
      const code = await dockerComposeStream(["up", "-d", ...enabledServiceIds]);

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
        "--check",
        "Check and cache release metadata without changing selected pins",
      ).conflicts(["status", "clear"]),
    )
    .addOption(
      new Option(
        "--clear",
        "Clear an unused or mismatched release selection; refuses a matching Data Manager",
      ).conflicts(["status", "check"]),
    )
    .action(async (options: { status?: boolean; clear?: boolean; check?: boolean }) => {
      try {
        if (options.status) {
          for (const line of releaseStatusLines()) log.info(line);
          return;
        }
        if (options.check) {
          const checked = await checkRelease();
          log.ok(`Checked release: ${checked.manifest.release}`);
          log.info(`Manifest digest: ${checked.manifestDigest}`);
          log.info(`Metadata image digest: ${checked.ociDigest}`);
          for (const name of coreServices.RELEASE_IMAGE_NAMES)
            log.info(`${name}: ${checked.manifest.images[name]}`);
          log.dim("Selected pins and running services were not changed.");
          return;
        }
        if (options.clear) {
          const result = await clearReleaseSelection();
          log.ok(
            result.cleared
              ? `Cleared local release selection → ${result.path}`
              : "No local release selection to clear.",
          );
          log.dim("Running containers and recorded running state are preserved.");
          log.dim(
            process.env.OPENMAPX_RELEASE === "local"
              ? "Release resolution is disabled; the next start/update uses manifest image tags."
              : "Automatic release resolution will select a release on the next start/update. To use local images, separately set OPENMAPX_RELEASE=local.",
          );
          return;
        }
        const selected = await selectRelease({ report: log.info });
        log.ok(`Atomic release selection ${selected.release} → ${selected.path}`);
        log.dim(
          "Bootstrap: start the selected release with `pnpm openmapx compose up`. Existing installations: use System → Updates or authenticated `system update` after `compose release --check`.",
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
    .description("Pull selected images (no args = all services)")
    .action(async (ids: string[]) => {
      if (ids.length === 0 || touchesReleasePinnedServices(ids)) {
        const overlay = await ensureReleaseOverlay();
        if (overlay.status === "unpinned") throw new Error(unpinnedReleaseWarning(overlay.reason));
        if (overlay.status === "held") throw new Error(overlay.reason);
      }
      const code = await dockerComposeStream(["pull", ...ids]);
      process.exit(code);
    });
}
