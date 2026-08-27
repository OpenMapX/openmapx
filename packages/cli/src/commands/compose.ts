import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import type { Command } from "commander";
import { assertCliDeploymentSecret } from "../lib/deployment-secret-policy";
import { dockerComposeStream } from "../lib/docker";
import { applyGeneratedHardlinks } from "../lib/hardlinks";
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
import { ensureReleaseOverlay, unpinnedReleaseWarning } from "../lib/release";
import { applyServiceSelection } from "../lib/service-selection";

const {
  buildAppApiServiceEnv,
  flattenResolvedConfig,
  GENERATED_SECRETS_DIRNAME,
  mergeServiceSecretKeys,
  readServiceSecretKeysFromCompose,
  readServiceSecretKeysFromDisk,
  renderCompose,
  renderTraefikDynamicConfiguration,
  renderTraefikDynamicYaml,
  resolveProxyHost,
  resolveServiceConfigFromEnv,
  ServiceRegistry,
} = coreServices;

export interface RenderRepoOptions {
  rootDir?: string;
  domain: string;
  services?: string[];
  /**
   * Render even when vault-managed service credentials exist on disk
   * (`.generated-secrets/` present) but their key names cannot be recovered
   * from the existing compose — which strips every `/run/secrets` mount from
   * the output. Off by default so a CLI render can never silently
   * un-credential services; surfaced as `--drop-secrets` on `compose render`
   * and `compose up`.
   */
  dropSecrets?: boolean;
  redisAuthHooks?: RedisAuthReconciliationHooks;
}

export interface RenderRepoResult {
  servicesRendered: number;
  composePath: string;
  hardlinkPath: string;
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
  assertCliDeploymentSecret();
  ensurePlatformPrivateDirectory(join(paths.infraDir, "data", "ops-agent", "trusted-config"));
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
  // Shared only between data-manager and the private Transitous runner: it
  // signs the single-use capability tokens that authorize one upstream run.
  const transitousRunnerCapabilityPath = join(
    paths.infraDir,
    "secrets",
    "transitous-runner-capability",
  );
  ensurePlatformSecretFile(redisPasswordPath);
  ensurePlatformSecretFile(offlinePackagePrincipalKeyPath);
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
  const enabled = registry.enabled();
  const composeOutDir = dirname(paths.composeOutPath);
  // CLI renders without DB access — the full DB cascade runs in the API path.
  // We still resolve env-var overrides so `SERVICE_<ID>_<KEY>=...` on the host
  // lands in the rendered container env, keeping CLI- and API-produced YAML
  // observationally equivalent when no per-service DB config is set.
  const resolvedServiceConfigs = new Map<string, Record<string, unknown>>();
  for (const s of enabled) {
    // Pass the full manifest so `resolveServiceConfigFromEnv` can suppress
    // schema defaults whose key already exists in `container.environment` —
    // otherwise a boolean `true` default clobbers a manifest "True"/"False"
    // string (see valhalla-scripted).
    const withSources = resolveServiceConfigFromEnv(s.manifest, process.env);
    if (Object.keys(withSources).length > 0) {
      resolvedServiceConfigs.set(s.manifest.id, flattenResolvedConfig(withSources));
    }
  }

  if (enabled.some((s) => s.manifest.id === "app-api")) {
    resolvedServiceConfigs.set(
      "app-api",
      buildAppApiServiceEnv(enabled, resolvedServiceConfigs.get("app-api") ?? {}, process.env),
    );
  }

  // Preserve vault secret mounts without DB access: reconstruct the key names
  // from the existing generated compose's `secrets:` block (world-readable —
  // the admin render last wrote it) plus, when this process can list it, the
  // 0700 `.generated-secrets/` dir itself (a non-root CLI gets EACCES there,
  // swallowed inside the reader). Union of both so a CLI re-render keeps every
  // known vault mount instead of silently dropping it.
  const serviceSecretKeys = mergeServiceSecretKeys(
    readServiceSecretKeysFromCompose(paths.composeOutPath),
    readServiceSecretKeysFromDisk(composeOutDir),
  );
  // Fail-loud guard: the app-api render only keeps `.generated-secrets/`
  // around while at least one vault credential exists (it removes the whole
  // tree when the vault is empty). So if that dir is present but neither
  // source above yielded a single key (compose deleted/rewritten without a
  // secrets block + dir unreadable), this render would strip every
  // `/run/secrets` mount and silently un-credential the affected services.
  // Refuse instead — the operator can re-render from the admin panel (which
  // reads the vault) or explicitly opt into dropping the secrets.
  const generatedSecretsDir = join(composeOutDir, GENERATED_SECRETS_DIRNAME);
  if (serviceSecretKeys.size === 0 && existsSync(generatedSecretsDir) && !opts.dropSecrets) {
    throw new Error(
      `vault-managed service credentials exist on disk (${generatedSecretsDir}) but their key names could not be recovered from the existing generated compose, so this render would strip every /run/secrets mount and silently un-credential the affected services. Re-render from the admin panel (Admin → Services → Apply changes reads the credential vault directly), or — if the credentials are intentionally decommissioned — remove the .generated-secrets directory (root-owned; sudo rm -rf) or re-run with --drop-secrets to render without them.`,
    );
  }

  const result = renderCompose(enabled, {
    domain: opts.domain,
    composeOutDir,
    allServices: registry.list(),
    resolvedServiceConfigs,
    serviceSecretKeys: opts.dropSecrets ? undefined : serviceSecretKeys,
  });

  writeFileSync(paths.composeOutPath, result.composeYaml, "utf-8");

  // Traefik reads routing from a generated file rather than the Docker socket.
  // Only enabled first-party manifests are rendered: a community service never
  // receives a platform route.
  const traefikDynamic = renderTraefikDynamicConfiguration(
    enabled.filter((service) => service.isBuiltIn).map((service) => service.manifest),
    {
      domain: opts.domain,
      resolveProxyHost: (manifest) => resolveProxyHost(manifest, { domain: opts.domain }),
    },
  );
  const traefikDynamicDir = join(paths.root, "services", "traefik", "config", "dynamic");
  mkdirSync(traefikDynamicDir, { recursive: true });
  const traefikRoutesPath = join(traefikDynamicDir, "generated-routes.yml");
  writeFileSync(traefikRoutesPath, renderTraefikDynamicYaml(traefikDynamic), "utf-8");

  const hardlinkPath = join(paths.infraDir, "docker-compose.generated.hardlinks.json");
  writeFileSync(hardlinkPath, JSON.stringify(result.hardlinkPlan, null, 2), "utf-8");
  // Pre-create writable data bind-dirs as the invoking (data-owning) user so a
  // later `docker compose up` doesn't auto-create them as root. Runs on every
  // render path that precedes a compose up (start/update/up/build/link).
  for (const dir of result.writableBindDirs ?? []) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    servicesRendered: enabled.length,
    composePath: paths.composeOutPath,
    hardlinkPath,
    requestedServiceIds: applied.requestedIds,
    enabledServiceIds: applied.selection.enabledIdsOrdered,
    selectionWarnings: applied.selection.warnings,
    renderWarnings: result.warnings ?? [],
  };
}

export function registerComposeCommands(program: Command): void {
  const compose = program.command("compose").description("Manage docker-compose stack");

  compose
    .command("rotate-redis-password")
    .description("Atomically rotate Redis authentication files while Redis clients are stopped")
    .option(
      "--confirm-clients-stopped",
      "Confirm app-api and data-manager are stopped before rotating",
    )
    .action((options: { confirmClientsStopped?: boolean }) => {
      try {
        const result = rotateRedisPasswordForRepo({
          confirmClientsStopped: options.confirmClientsStopped === true,
        });
        log.ok(`Rotated Redis authentication files → ${result.passwordPath}, ${result.aclPath}`);
        log.dim("Recreate Redis, then restart app-api and data-manager.");
      } catch (err) {
        log.err(`Redis password rotation failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  compose
    .command("render")
    .description("Render docker-compose.generated.yml from manifests")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .option("--services <ids>", "Comma/space-separated root service ids for this render")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .option(
      "--drop-secrets",
      "Render without the vault-managed service secret mounts (DANGEROUS — affected services run uncredentialed)",
    )
    .action(
      async (options: {
        domain: string;
        services?: string;
        preset?: string;
        dropSecrets?: boolean;
      }) => {
        try {
          const services = combineServiceSelection(options.services, options.preset);
          const r = await renderComposeForRepo({
            domain: options.domain,
            services,
            dropSecrets: options.dropSecrets,
          });
          log.ok(`Rendered ${r.servicesRendered} services → ${r.composePath}`);
          if (r.enabledServiceIds.length > 0) {
            log.dim(`Selected services → ${r.enabledServiceIds.join(", ")}`);
          }
          for (const warning of r.selectionWarnings) log.warn(warning);
          for (const warning of r.renderWarnings) log.warn(warning);
          log.dim(`Hardlink plan → ${r.hardlinkPath}`);
        } catch (err) {
          log.err(`Render failed: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  compose
    .command("up")
    .description("Start the stack via generated compose")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .option("--services <ids>", "Comma/space-separated root service ids for this run")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .option(
      "--drop-secrets",
      "Render without the vault-managed service secret mounts (DANGEROUS — affected services run uncredentialed)",
    )
    .action(
      async (options: {
        domain: string;
        services?: string;
        preset?: string;
        dropSecrets?: boolean;
      }) => {
        try {
          const services = combineServiceSelection(options.services, options.preset);
          const r = await renderComposeForRepo({
            domain: options.domain,
            services,
            dropSecrets: options.dropSecrets,
          });
          log.ok(`Rendered ${r.servicesRendered} services → ${r.composePath}`);
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
          log.ok(`Pinned release ${overlay.release} → ${overlay.path}`);
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
      },
    );

  compose
    .command("release")
    .description(
      "Resolve ghcr.io/openmapx/release-manifest:latest and (re)write docker-compose.release.yml pinning the release runtime images",
    )
    .action(async () => {
      try {
        const { resolveReleaseManifest, writeReleaseOverlay } = await import("../lib/release");
        const manifest = await resolveReleaseManifest();
        const path = writeReleaseOverlay(manifest);
        log.ok(`Pinned release ${manifest.release} → ${path}`);
        log.dim(
          "Apply it with `pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner`.",
        );
      } catch (err) {
        log.err(`Release resolution failed: ${(err as Error).message}`);
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
