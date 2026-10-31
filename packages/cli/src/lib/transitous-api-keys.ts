import { randomBytes, randomUUID } from "node:crypto";

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { readCatalogPinSet, readCatalogProposal } from "@openmapx/core/catalog-pins";
import { createControlRootOperationKey, executionFingerprint } from "@openmapx/core/ops";
import { fsyncDirectory } from "@openmapx/core/release-files";
import { services as coreServices } from "@openmapx/core/server";

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
  ensurePlatformPrivateDirectory,
  type PreparedPlatformFileReplacement,
  preparePlatformFileReplacement,
} from "./platform-secret-files";

export type { CommandRunner };
export { DEFAULT_TRANSITOUS_REPO_URL };

/**
 * The operator's Transitous API keys live alone in their own directory under
 * the secrets directory, which data-manager mounts read-only at
 * `/config/transitous`. A directory, not the file: data-manager reads the keys
 * at every run, and a file mount would keep showing the file a rename
 * replaced until the container is recreated.
 */
export const TRANSITOUS_API_KEYS_DIRECTORY = "transitous-api-keys";
export const TRANSITOUS_API_KEYS_FILENAME = "api-keys.json";
const TRANSITOUS_API_KEYS_MODE = 0o600;
/** A key name that is safe to print: letters, digits and plain punctuation, no controls. */
const SHOWN_KEY_NAME =
  /^[\p{L}\p{N}][\p{L}\p{N} ._()&'+-]{0,63}\/[\p{L}\p{N}][\p{L}\p{N} ._()&'+,-]{0,127}$/u;
const MAX_TRANSITOUS_API_KEYS_BYTES = 1024 * 1024;

export function transitousApiKeysPath(infraDir: string): string {
  return join(infraDir, "secrets", TRANSITOUS_API_KEYS_DIRECTORY, TRANSITOUS_API_KEYS_FILENAME);
}

/** Where releases before this one kept the keys, in the checkout. */
export function legacyTransitousApiKeysPath(rootDir: string): string {
  return join(rootDir, "services", "motis", "tools", "transitous", TRANSITOUS_API_KEYS_FILENAME);
}

export interface EnsureTransitousApiKeysResult {
  path: string;
  /** What this call created: the earlier file's copy, an empty file, or nothing. */
  created: "copied" | "empty" | null;
  /** Why an earlier file was left in place, when one was. */
  leftInPlace?: { path: string; reason: string };
}

function isApiKeysDocument(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((value) => typeof value === "string")
  );
}

/**
 * The file's text, read without following a link, or why it can't be used.
 * `writableByOthers` decides whether group or other write refuses it; when it
 * doesn't, the file is made owner-only instead.
 */
function readOwnedApiKeysFile(
  path: string,
  uid: number,
  writableByOthers: "refuse" | "restrict",
): { text: string } | { reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return { reason: "it is a symbolic link" };
    }
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { reason: "it is not a regular file" };
    if (stats.uid !== uid) return { reason: `it belongs to uid ${stats.uid}, not ${uid}` };
    if (stats.nlink !== 1) return { reason: `it has ${stats.nlink} links` };
    if ((stats.mode & 0o022) !== 0 && writableByOthers === "refuse") {
      return { reason: "group or others can write it" };
    }
    if (stats.size > MAX_TRANSITOUS_API_KEYS_BYTES) return { reason: "it is larger than 1 MiB" };
    const bytes = Buffer.alloc(stats.size);
    const read = stats.size === 0 ? 0 : readSync(fd, bytes, 0, stats.size, 0);
    const text = bytes.subarray(0, read).toString("utf8");
    if (!isApiKeysDocument(text)) return { reason: "it is not a JSON object of key strings" };
    if (writableByOthers === "restrict") fchmodSync(fd, TRANSITOUS_API_KEYS_MODE);
    return { text };
  } finally {
    closeSync(fd);
  }
}

/** Creates the file without replacing one that appeared meanwhile. */
function publishApiKeysFile(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    TRANSITOUS_API_KEYS_MODE,
  );
  try {
    writeFileSync(fd, contents, "utf8");
    fchmodSync(fd, TRANSITOUS_API_KEYS_MODE);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  fsyncDirectory(dirname(path));
}

/**
 * Makes sure the keys file exists in its directory before a generation mounts
 * it. The first time, the earlier release's file in the checkout is copied,
 * not moved, so that release still finds it after a rollback; only a regular
 * file of the deployment's user with one link that neither group nor others
 * can write, holding a JSON object of key strings, is copied. Anything else
 * stays where it is, the result says why, and the keys file starts empty.
 * An existing keys file must meet the same rules and is kept owner-only.
 */
export function ensureTransitousApiKeysFile(rootDir?: string): EnsureTransitousApiKeysResult {
  const paths = repoPaths(rootDir);
  const uid = process.geteuid?.();
  if (uid === undefined) throw new Error("Transitous API keys ownership is unavailable");
  const path = transitousApiKeysPath(paths.infraDir);
  // The secrets directory itself is protected by the platform secrets render
  // creates first; this one holds nothing but the keys.
  ensurePlatformPrivateDirectory(dirname(path));

  if (lstatExists(path)) {
    // Like the other secrets: kept owner-only, refused when it isn't its own.
    const current = readOwnedApiKeysFile(path, uid, "restrict");
    if ("reason" in current) {
      throw new Error(`Transitous API keys at ${path} can't be used: ${current.reason}`);
    }
    return { path, created: null };
  }
  // An operations agent without the checkout can't see the earlier keys, and
  // an empty file would stand in for them.
  if (!coreServices.checkoutMounted(paths.root)) {
    throw new coreServices.CheckoutRequiredError(
      `The Transitous API keys were never copied from the checkout into ${path}, and this operations agent runs without the checkout: run \`pnpm openmapx compose render\` on the host, as the checkout's owner, which copies them.`,
    );
  }

  const legacy = legacyTransitousApiKeysPath(paths.root);
  if (lstatExists(legacy)) {
    const earlier = readOwnedApiKeysFile(legacy, uid, "refuse");
    if ("reason" in earlier) {
      publishApiKeysFile(path, "{}\n");
      return { path, created: "empty", leftInPlace: { path: legacy, reason: earlier.reason } };
    }
    publishApiKeysFile(path, earlier.text);
    return { path, created: "copied" };
  }
  publishApiKeysFile(path, "{}\n");
  return { path, created: "empty" };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The names of the keys a file sets, read without following a link; values are
 * looked at only to tell a set key from an empty slot and never leave here.
 */
function setKeyNames(path: string): { names: Set<string> } | { reason: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { reason: "it is a symbolic link" };
    if (code === "EACCES") return { reason: "it can't be read" };
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { reason: "it is not a regular file" };
    if (stats.size > MAX_TRANSITOUS_API_KEYS_BYTES) return { reason: "it is larger than 1 MiB" };
    const bytes = Buffer.alloc(stats.size);
    const read = stats.size === 0 ? 0 : readSync(fd, bytes, 0, stats.size, 0);
    const text = bytes.subarray(0, read).toString("utf8");
    if (!isApiKeysDocument(text)) return { reason: "it is not a JSON object of key strings" };
    const entries = Object.entries(JSON.parse(text) as Record<string, string>);
    return {
      names: new Set(
        entries
          .filter(([name, value]) => !name.startsWith("_") && value.trim().length > 0)
          .map(([name]) => name),
      ),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * While the earlier release's keys file in the checkout still sets keys the
 * keys file doesn't, a line saying so, why it was not copied and how to carry
 * them over; `null` otherwise. Only key names appear, never values. `check`
 * reports it on every run, since the render's notice is printed once.
 */
export function transitousApiKeysLeftBehindWarning(rootDir?: string): string | null {
  const paths = repoPaths(rootDir);
  const legacy = legacyTransitousApiKeysPath(paths.root);
  const current = transitousApiKeysPath(paths.infraDir);
  // Before the first render there is nothing to compare; it copies the file.
  if (!lstatExists(legacy) || !lstatExists(current)) return null;
  const uid = process.geteuid?.();
  if (uid === undefined) return null;
  const shownLegacy = relative(paths.root, legacy);
  const shownCurrent = relative(paths.root, current);
  const fix = `Copy the keys you meant to keep into ${shownCurrent}, or run pnpm openmapx data generate-api-keys and enter them again.`;

  const earlier = setKeyNames(legacy);
  if ("reason" in earlier) {
    return `The earlier Transitous API keys file ${shownLegacy} was left in place and can't be compared with ${shownCurrent}: ${earlier.reason}. ${fix}`;
  }
  const now = setKeyNames(current);
  const set = "names" in now ? now.names : new Set<string>();
  const missing = [...earlier.names].filter((name) => !set.has(name)).sort();
  if (missing.length === 0) return null;
  const refusal = readOwnedApiKeysFile(legacy, uid, "refuse");
  const why =
    "reason" in refusal
      ? `it was not copied because ${refusal.reason}`
      : `${shownCurrent} already existed, so it is no longer copied`;
  // The earlier file may be one others could write: only names shaped like
  // the template's `<region>/<source>` reach a terminal or the panel's log.
  const printable = missing.filter((name) => SHOWN_KEY_NAME.test(name));
  const shown = printable.slice(0, 10).join(", ") || "none shown";
  const unshown = missing.length - Math.min(printable.length, 10);
  const more = unshown > 0 ? ` and ${unshown} more` : "";
  return `The earlier Transitous API keys file ${shownLegacy} sets ${missing.length} key${missing.length === 1 ? "" : "s"} that ${shownCurrent} doesn't (${shown}${more}): ${why}. ${fix}`;
}

/** One line for the render's output about what {@link ensureTransitousApiKeysFile} did. */
export function describeTransitousApiKeysMigration(
  result: EnsureTransitousApiKeysResult,
  rootDir: string,
): { level: "info" | "warn"; message: string } | null {
  const shown = (path: string) => relative(rootDir, path);
  if (result.created === "copied") {
    return {
      level: "info",
      message: `Copied the Transitous API keys from ${shown(legacyTransitousApiKeysPath(rootDir))} to ${shown(result.path)}; the earlier file stays for rolling back and is no longer read.`,
    };
  }
  if (result.leftInPlace) {
    return {
      level: "warn",
      message: `Left the earlier Transitous API keys file ${shown(result.leftInPlace.path)} in place and started an empty ${shown(result.path)}: ${result.leftInPlace.reason}. If it is yours, check it and copy its keys into the new file, or run pnpm openmapx data generate-api-keys and enter them again.`,
    };
  }
  return null;
}

export interface GenerateTransitousApiKeysOptions {
  rootDir?: string;
  transitousRepoUrl?: string;
  outputPath?: string;
  runner?: CommandRunner;
  proposalId?: string;
}
export interface GenerateTransitousApiKeysResult {
  outputPath: string;
  catalogDir: string;
  requiredCount: number;
  preservedCount: number;
  droppedCount: number;
  keysFile?: EnsureTransitousApiKeysResult;
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
  const paths = repoPaths(options.rootDir);
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
  const activeGenerationId = pins.generationId;
  if (options.proposalId) {
    const reader = control.openControlInstallation({
      infraDir: paths.infraDir,
      role: "host-cli",
      serviceIds: ["motis"],
    });
    try {
      const proposal = readCatalogProposal({
        rootDir: paths.root,
        installation: reader,
        proposalId: options.proposalId,
      });
      if (!proposal || proposal.baseGenerationId !== activeGenerationId)
        throw Error("Proposal is missing or based on different active pins");
      pins = proposal.pins;
    } finally {
      control.closeControlInstallation(reader);
    }
  }
  const sha = pins.transitous.ref.split("@").at(-1),
    atlas = pins.transitous.submodules["transitland-atlas"];
  if (!sha || !atlas) throw Error("Exact Transitous and atlas pins are required");
  const keysFile = options.outputPath ? undefined : ensureTransitousApiKeysFile(paths.root);
  const outputPath = options.outputPath ? resolve(paths.root, options.outputPath) : keysFile!.path;
  const outputRelative = outputInsideRoot(paths.root, outputPath);
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
    if (
      readCatalogPinSet(paths.root)?.generationId !== activeGenerationId ||
      (options.proposalId &&
        readCatalogProposal({ rootDir: paths.root, installation, proposalId: options.proposalId })
          ?.pins.generationId !== pins.generationId)
    )
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
      ...(keysFile ? { keysFile } : {}),
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
