import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { readCatalogPinSet } from "@openmapx/core/catalog-pins";
import { createControlRootOperationKey, executionFingerprint } from "@openmapx/core/ops";
import { fsyncDirectory } from "@openmapx/core/release-files";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  inspectPinnedFeedCredentialKeys,
  mergeFeedCredentialTemplate,
  parseFeedCredentialMapJson,
  TRANSITOUS_CATALOG_DIR,
} from "@openmapx/transitous-core";
import { execa } from "execa";
import { cliControlContext } from "./control-context";
import { cliProcessOptions } from "./execution-deadline";
import { repoPaths } from "./paths";
import {
  type PreparedPlatformFileReplacement,
  preparePlatformFileReplacement,
} from "./platform-secret-files";

export type { CommandRunner };
export { DEFAULT_TRANSITOUS_REPO_URL };
export interface GenerateTransitousApiKeysOptions {
  rootDir?: string;
  transitousRepoUrl?: string;
  outputPath?: string;
  runner?: CommandRunner;
}
export interface GenerateTransitousApiKeysResult {
  outputPath: string;
  catalogDir: string;
  requiredCount: number;
  preservedCount: number;
  droppedCount: number;
  orphanedKeys: string[];
  catalogRevisionId: string;
}
async function nativeGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execa("git", [...args], {
    ...cliProcessOptions(),
    cwd,
    stdin: "ignore",
    maxBuffer: args.includes("ls-tree") ? 5 * 1024 * 1024 : 16384,
  });
  return result.stdout;
}
function outputInsideRoot(root: string, output: string) {
  const rootStat = lstatSync(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== process.geteuid?.() ||
    (rootStat.mode & 0o022) !== 0
  )
    throw Error("Repository root ownership is unavailable");
  const value = relative(root, output);
  if (!value || value.startsWith("..") || isAbsolute(value))
    throw Error("--output must be inside the repository");
  let current = root;
  for (const part of value.split(/[\\/]/).slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.geteuid?.() ||
      (stat.mode & 0o022) !== 0
    )
      throw Error("Output parents must be existing owned directories");
  }
  const parent = realpathSync(dirname(output)),
    base = realpathSync(root);
  if (parent !== base && !parent.startsWith(`${base}/`))
    throw Error("Output parent leaves the repository");
  return value.split(/[\\/]/).join("/");
}
function existingSnapshot(path: string): { contents: string; identity: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.geteuid?.() ?? -1) ||
      before.size > 1048576n
    )
      throw Error("Credential file is unavailable or oversized");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    const identity = (stat: typeof before) =>
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
    if (
      BigInt(count) !== before.size ||
      identity(before) !== identity(after) ||
      identity(before) !== identity(current)
    )
      throw Error("Credential file changed during reading");
    return {
      contents: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)),
      identity: identity(before),
    };
  } catch (error) {
    if (fd === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw Error("Credential file is unavailable or changed");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export async function generateTransitousApiKeys(
  options: GenerateTransitousApiKeysOptions = {},
): Promise<GenerateTransitousApiKeysResult> {
  if (
    cliControlContext() ||
    process.env.OPENMAPX_CONTROL_EXECUTION ||
    process.env.OPENMAPX_CONTROL_DELEGATION ||
    process.env.OPENMAPX_PARENT_EXECUTION
  )
    throw Error("Credential templates require an explicit local host command");
  if (options.transitousRepoUrl && options.transitousRepoUrl !== DEFAULT_TRANSITOUS_REPO_URL)
    throw Error(
      "Credential discovery uses the active paired pin and cached catalog; repository overrides are unavailable",
    );
  const paths = repoPaths(options.rootDir),
    outputPath = options.outputPath
      ? resolve(paths.root, options.outputPath)
      : join(paths.root, "services/motis/tools/transitous/api-keys.json"),
    outputRelative = outputInsideRoot(paths.root, outputPath);
  let pins: ReturnType<typeof readCatalogPinSet>;
  try {
    pins = readCatalogPinSet(paths.root);
  } catch {
    throw Error(
      "Active paired catalog pins are unavailable; initialize or repair the instance first",
    );
  }
  if (!pins)
    throw Error(
      "Active paired catalog pins are required; initialize the instance before generating credentials",
    );
  const sha = pins.transitous.ref.split("@").at(-1),
    atlas = pins.transitous.submodules["transitland-atlas"];
  if (!sha || !atlas) throw Error("Exact Transitous and atlas pins are required");
  const before = existingSnapshot(outputPath);
  const existing = before ? parseFeedCredentialMapJson(before.contents) : {};
  const catalogDir = join(paths.infraDir, "data", TRANSITOUS_CATALOG_DIR);
  const required = await inspectPinnedFeedCredentialKeys({
    catalogDir,
    transitousCommit: sha,
    atlasCommit: atlas,
    git: async (args, cwd) => {
      if (options.runner && !args.includes("rev-parse") && !args.includes("ls-tree")) {
        await options.runner("git", [...args], { cwd, stdio: "pipe" });
        return "";
      }
      return nativeGit(args, cwd);
    },
  });
  const merged = mergeFeedCredentialTemplate(existing, required);
  // Serialize the map by code-unit key order using the shared canonical encoder.
  const { canonicalFeedCredentialMap } = await import("@openmapx/transitous-core");
  const contents = `${canonicalFeedCredentialMap(merged.values).canonicalJson}\n`;
  if (!existsSync(join(paths.infraDir, "secrets/control-verifiers.json")))
    await control.provisionControlInstallation(paths.infraDir);
  const installation = control.openControlInstallation({
    infraDir: paths.infraDir,
    role: "host-cli",
    serviceIds: ["motis"],
  });
  let lease: control.ArtifactTargetLease | undefined;
  let authority: control.VerifiedExecutionAuthority | undefined;
  let began = false;
  let replacement: PreparedPlatformFileReplacement | undefined;
  try {
    const operation = {
      kind: "transit.credentials.template",
      catalogRevisionId: pins.generationId,
      outputPath: outputRelative,
      fileMac: "0".repeat(64),
    };
    operation.fileMac = control.localFeedCredentialTemplateMac(installation, operation, contents);
    const admittedAt = Date.now(),
      deadlineAt = admittedAt + 300000,
      operationFingerprint = control.controlDigest(operation);
    const execution = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      deadlineAt,
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    };
    authority = control.retainAdmittedControlExecution(installation, {
      execution,
      kind: operation.kind,
      operation,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["motis"],
    });
    lease = await control.acquireArtifactTargetLease({
      dataRoot: join(paths.infraDir, "data"),
      serviceIds: ["motis"],
      owner: authority,
    });
    if (readCatalogPinSet(paths.root)?.generationId !== pins.generationId)
      throw Error("Catalog pins changed; inspect the new pin before retrying");
    if (existingSnapshot(outputPath)?.identity !== before?.identity)
      throw Error("Credential file changed; review before retrying");
    control.assertArtifactTargetLeaseForward(lease);
    control.beginControlEffect(authority);
    began = true;
    replacement = preparePlatformFileReplacement(outputPath, contents, {
      temporaryFileOps: { chmod: (fd) => fchmodSync(fd, 0o600) },
    });
    if (existingSnapshot(outputPath)?.identity !== before?.identity)
      throw Error("Credential file changed; refusing to overwrite it");
    replacement.assertTargetUnchanged();
    replacement.commit();
    fsyncDirectory(dirname(outputPath));
    control.retainControlEffectReceipt(authority, {
      outcome: "committed",
      publication: "committed",
      receipt: { kind: "feed-credential-template-written", fileMac: operation.fileMac },
    });
    await control.settleArtifactTargetLeaseChild(
      lease,
      control.verifyControlEffectSettlement(installation, execution),
    );
    await control.releaseArtifactTargetLease(lease);
    lease = undefined;
    return {
      outputPath,
      catalogDir,
      requiredCount: merged.requiredCount,
      preservedCount: merged.preservedCount,
      droppedCount: 0,
      orphanedKeys: merged.orphanedKeys,
      catalogRevisionId: pins.generationId,
    };
  } catch (error) {
    if (authority && !began) {
      control.retainControlEffectReceipt(authority, {
        outcome: "failed_without_effect",
        publication: "not_started",
        receipt: { kind: "not-started" },
      });
      if (lease) {
        await control.settleArtifactTargetLeaseChild(
          lease,
          control.verifyControlEffectSettlement(
            installation,
            control.executionAuthorityState(authority).execution,
          ),
        );
        await control.releaseArtifactTargetLease(lease);
        lease = undefined;
      }
    }
    throw error;
  } finally {
    replacement?.cleanup();
    if (lease) control.closeArtifactTargetLeaseHandle(lease);
    control.closeControlInstallation(installation);
  }
}
