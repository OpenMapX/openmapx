import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import { atomicWrite, fsyncDirectory } from "../release-files";
import { legacyConfigurationWriterActive } from "./configuration-ownership";
import {
  canonicalReleaseManifest,
  carryLegacyReleaseOverlay,
  parseReleaseComposeSelection,
  parseReleaseManifest,
  RELEASE_IMAGE_NAMES,
  type ReleaseManifest,
  writeReleaseComposeArtifacts,
} from "./release-manifest";
import {
  assertReleaseStateDirectory,
  ensureReleaseStateDirectories,
  legacyReleaseStatePaths,
  parseReleasePointer,
  parseReleaseSelectionReceipts,
  RELEASE_MANIFEST_FILE_PATTERN,
  RELEASE_STORE_LIMITS,
  type ReleaseStateOptions,
  readReleaseStateFile,
  releaseStateFileProblem,
  releaseStatePaths,
} from "./release-state";
import {
  acquireReleaseStoreLock,
  RELEASE_STORE_LOCK_NAME,
  type ReleaseStoreLock,
  type ReleaseStoreLockHooks,
} from "./release-store-lock";

/**
 * The migration's own record in `releases/`: `started` while it runs, so the
 * next run completes one that stopped midway, then `finished`.
 */
const MIGRATION_RECORD = "legacy-migration.json";

export interface LegacyReleaseStateMigration {
  /** `refused`: nothing was copied, for the reason in `problems`. */
  outcome: "migrated" | "refused";
  /** The release IDs whose manifests are in the new store. */
  releases: string[];
  /** The pointer files copied: `current.json`, `latest.json`, `selections.json`. */
  pointers: string[];
  /**
   * `regenerated` from the manifest the old overlay selected; `carried` from
   * the old overlay itself, verified, when the store had no manifest for its
   * release; `kept` an overlay already there.
   */
  overlay: "regenerated" | "carried" | "kept" | "absent" | "skipped";
  /** Every entry left behind, and why. */
  problems: string[];
}

export interface LegacyReleaseStateMigrationOptions extends ReleaseStateOptions {
  lockHooks?: ReleaseStoreLockHooks;
}

function digestOf(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function migrationState(
  path: string,
  options: ReleaseStateOptions,
): "started" | "finished" | undefined {
  let raw: string;
  try {
    // A finished record lists the problems, so it is allowed a transaction's size.
    raw = readReleaseStateFile(path, RELEASE_STORE_LIMITS.transactionBytes, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const state = (JSON.parse(raw) as { state?: unknown }).state;
  if (state !== "started" && state !== "finished") {
    throw new Error(`${path} is not a release state migration record`);
  }
  return state;
}

function storeHasManifests(store: string): boolean {
  try {
    return readdirSync(store).some((name) => RELEASE_MANIFEST_FILE_PATTERN.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Publishes `contents` at `path` without replacing anything: a temporary is
 * linked into place. An existing file is kept, and reported when it differs.
 */
function copyInto(path: string, contents: string, options: ReleaseStateOptions): string | null {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readReleaseStateFile(path, RELEASE_STORE_LIMITS.transactionBytes, options) === contents
      ? null
      : "differs from the entry already in the new store, which is kept";
  } finally {
    unlinkSync(temporary);
  }
}

/** The release and digest an overlay's `x-openmapx-release` metadata names. */
function overlayIdentity(raw: string): { release: string; digest: string } | null {
  const document = load(raw, { schema: JSON_SCHEMA }) as Record<string, unknown> | null;
  const metadata = document?.["x-openmapx-release"] as Record<string, unknown> | undefined;
  const selected = parseReleaseComposeSelection(raw);
  if (
    !metadata ||
    typeof metadata.release !== "string" ||
    typeof metadata.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.digest) ||
    selected.release !== metadata.release
  ) {
    return null;
  }
  return { release: metadata.release, digest: metadata.digest };
}

/**
 * Brings the release state of releases before this one, `.ops-agent-releases`
 * and the overlay in `infra/docker`, into the agent's state directory. Run by
 * the agent before anything reads its releases and by the CLI's render.
 *
 * It runs when the new store has no manifest yet and the old store exists, or
 * to finish one that stopped midway; once its record says finished, never
 * again, and later calls return null. Nothing is moved: `infra/docker/data` can
 * be a filesystem of its own, and an agent of an earlier release, restored by
 * a rollback, still reads the old location. So the old files are copied, then
 * left as they are and never read again.
 *
 * - An entry is copied only if it is a release-store name, a regular file of
 *   this user with one link and no group or other write, and passes the
 *   store's own checks: a manifest in canonical form under its release ID, a
 *   pointer naming a copied manifest at its digest. Anything else stays
 *   behind and is reported; one bad entry does not stop the rest.
 * - The overlay is never copied. When the new one is absent and the old one
 *   passes the same file checks and names a copied release at its digest, it
 *   is rendered again from that manifest, with its evidence, in the new place.
 *   When the store holds no manifest of its release, because the host CLI
 *   selected it, it is rendered again from its own metadata and evidence, if
 *   that gives exactly its bytes.
 * - An old `transaction.json` is an update the previous agent has not
 *   finished. Its rollback overlay is bytes from the old location, which this
 *   agent never restores, and its state is the old agent's to recover. While
 *   it exists nothing is migrated; the refusal is reported and the next run
 *   tries again.
 *
 * The new store's lock is held throughout, and while an agent of an earlier
 * release can run, the old store's lock as well, first, in the order writers
 * take the configuration writer locks.
 */
export async function migrateLegacyReleaseState(
  infraDir: string,
  options: LegacyReleaseStateMigrationOptions = {},
): Promise<LegacyReleaseStateMigration | null> {
  const legacy = legacyReleaseStatePaths(infraDir);
  const paths = releaseStatePaths(infraDir);
  const record = join(paths.directory, MIGRATION_RECORD);
  const due = () => {
    // The host CLI's `compose release` leaves an overlay without any store.
    if (!exists(legacy.store) && !exists(legacy.overlay)) return false;
    const state = migrationState(record, options);
    return state === "started" || (state === undefined && !storeHasManifests(paths.store));
  };
  if (!due()) return null;
  const refused = (problem: string): LegacyReleaseStateMigration => ({
    outcome: "refused",
    releases: [],
    pointers: [],
    overlay: "skipped",
    problems: [problem],
  });
  ensureReleaseStateDirectories(infraDir, options);
  const legacyStore = exists(legacy.store);
  try {
    if (legacyStore) assertReleaseStateDirectory(legacy.store, options);
  } catch {
    return refused(
      `${legacy.store} is not a directory of uid ${options.uid ?? process.geteuid?.()} that its group and others cannot reach; nothing was migrated`,
    );
  }
  const locks: ReleaseStoreLock[] = [];
  try {
    if (legacyStore && legacyConfigurationWriterActive(infraDir)) {
      locks.push(await acquireReleaseStoreLock(legacy.store, options.lockHooks));
    }
    locks.push(await acquireReleaseStoreLock(paths.store, options.lockHooks));
    if (!due()) return null;
    return migrateLocked(infraDir, options, record, refused);
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}

function migrateLocked(
  infraDir: string,
  options: ReleaseStateOptions,
  record: string,
  refused: (problem: string) => LegacyReleaseStateMigration,
): LegacyReleaseStateMigration {
  const legacy = legacyReleaseStatePaths(infraDir);
  const paths = releaseStatePaths(infraDir);
  if (exists(join(legacy.store, "transaction.json"))) {
    return refused(
      `${join(legacy.store, "transaction.json")}: a release update of the previous agent is unfinished; nothing was migrated. Let that agent recover it, or remove the file once the running services are checked, and start again`,
    );
  }
  const names = exists(legacy.store) ? readdirSync(legacy.store) : [];
  if (names.length > RELEASE_STORE_LIMITS.entries + 5) {
    return refused(
      `${legacy.store} holds more entries than a release store can; nothing was migrated`,
    );
  }
  const startedAt = new Date().toISOString();
  atomicWrite(record, `${JSON.stringify({ version: 1, state: "started", startedAt })}\n`);
  const problems: string[] = [];
  const read = (name: string, maximum: number): string | null => {
    const path = join(legacy.store, name);
    try {
      const problem = releaseStateFileProblem(lstatSync(path), maximum, options);
      if (problem) {
        problems.push(`${path} ${problem}`);
        return null;
      }
      const raw = readReleaseStateFile(path, maximum, options);
      if (raw.length === 0) {
        problems.push(`${path} is empty`);
        return null;
      }
      return raw;
    } catch (error) {
      problems.push(`${path} could not be read: ${(error as Error).message}`);
      return null;
    }
  };
  const copy = (name: string, contents: string): boolean => {
    const problem = copyInto(join(paths.store, name), contents, options);
    if (problem) problems.push(`${join(legacy.store, name)} ${problem}`);
    return problem === null;
  };

  // Manifests first: every pointer is checked against a copied one.
  const manifests = new Map<string, { manifest: ReleaseManifest; digest: string }>();
  const pointerNames: string[] = [];
  for (const name of names.sort()) {
    if (name === RELEASE_STORE_LOCK_NAME) continue;
    if (name === "current.json" || name === "latest.json" || name === "selections.json") {
      pointerNames.push(name);
      continue;
    }
    const match = RELEASE_MANIFEST_FILE_PATTERN.exec(name);
    if (!match) {
      problems.push(`${join(legacy.store, name)} is not a release store entry`);
      continue;
    }
    if (manifests.size >= RELEASE_STORE_LIMITS.entries) {
      problems.push(`${join(legacy.store, name)} exceeds the release store's entry limit`);
      continue;
    }
    const raw = read(name, RELEASE_STORE_LIMITS.manifestBytes);
    if (raw === null) continue;
    let manifest: ReleaseManifest;
    try {
      manifest = parseReleaseManifest(raw);
    } catch (error) {
      problems.push(
        `${join(legacy.store, name)} is not a release manifest: ${(error as Error).message}`,
      );
      continue;
    }
    if (manifest.release !== match[1] || raw !== canonicalReleaseManifest(manifest)) {
      problems.push(
        `${join(legacy.store, name)} is not the canonical manifest of release ${match[1]}`,
      );
      continue;
    }
    if (copy(name, raw)) manifests.set(manifest.release, { manifest, digest: digestOf(raw) });
  }

  const pointers: string[] = [];
  for (const name of pointerNames) {
    const isSelections = name === "selections.json";
    const raw = read(
      name,
      isSelections ? RELEASE_STORE_LIMITS.selectionsBytes : RELEASE_STORE_LIMITS.stateBytes,
    );
    if (raw === null) continue;
    let unmatched: string | undefined;
    try {
      if (isSelections) {
        for (const [releaseId, receipt] of Object.entries(parseReleaseSelectionReceipts(raw))) {
          if (manifests.get(releaseId)?.digest !== receipt.digest) unmatched = releaseId;
        }
      } else {
        const pointer = parseReleasePointer(raw, name === "latest.json");
        const stored = manifests.get(pointer.releaseId);
        if (!stored || (pointer.digest !== undefined && pointer.digest !== stored.digest)) {
          unmatched = pointer.releaseId;
        }
      }
    } catch (error) {
      problems.push(`${join(legacy.store, name)} is malformed: ${(error as Error).message}`);
      continue;
    }
    if (unmatched !== undefined) {
      problems.push(
        `${join(legacy.store, name)} names release ${unmatched}, whose manifest was not migrated at that digest`,
      );
      continue;
    }
    if (copy(name, raw)) pointers.push(name);
  }
  fsyncDirectory(paths.store);

  let overlay: LegacyReleaseStateMigration["overlay"] = "absent";
  if (exists(paths.overlay)) overlay = "kept";
  else if (exists(legacy.overlay)) {
    overlay = "skipped";
    try {
      const problem = releaseStateFileProblem(
        lstatSync(legacy.overlay),
        RELEASE_STORE_LIMITS.manifestBytes,
        options,
      );
      if (problem) throw new Error(problem);
      const raw = readReleaseStateFile(legacy.overlay, RELEASE_STORE_LIMITS.manifestBytes, options);
      const identity = overlayIdentity(raw);
      if (!identity) throw new Error("it names no release");
      const stored = manifests.get(identity.release);
      if (!stored) {
        if (exists(join(legacy.store, `${identity.release}.json`))) {
          throw new Error("its release's manifest did not come over");
        }
        // The host CLI selects a release without storing its manifest.
        carryLegacyReleaseOverlay(raw, legacy.evidence, infraDir, options);
        overlay = "carried";
      } else {
        if (stored.digest !== identity.digest) {
          throw new Error("it does not name its migrated release at that release's digest");
        }
        const selected = parseReleaseComposeSelection(raw);
        if (
          RELEASE_IMAGE_NAMES.some(
            (image) => selected.images[image] !== stored.manifest.images[image],
          )
        ) {
          throw new Error("it pins images other than its release's");
        }
        writeReleaseComposeArtifacts(stored.manifest, infraDir, options);
        overlay = "regenerated";
      }
    } catch (error) {
      problems.push(`${legacy.overlay} was not carried over: ${(error as Error).message}`);
    }
  }
  const result: LegacyReleaseStateMigration = {
    outcome: "migrated",
    releases: [...manifests.keys()],
    pointers,
    overlay,
    problems,
  };
  atomicWrite(
    record,
    `${JSON.stringify({ version: 1, state: "finished", startedAt, finishedAt: new Date().toISOString(), ...result })}\n`,
  );
  return result;
}

/**
 * Written by `compose release --clear`: once the operator has cleared the
 * selection, the earlier overlay holds nothing back. (A selection holds
 * nothing back either way: it is an overlay in the new place.)
 */
const LEGACY_OVERLAY_SUPERSEDED = "legacy-overlay-superseded.json";

/** The release an earlier overlay names, for a message; null if it names none plainly. */
function legacyOverlayRelease(path: string): string | null {
  try {
    const raw = readReleaseStateFile(path, RELEASE_STORE_LIMITS.manifestBytes, {});
    const release = overlayIdentity(raw)?.release;
    return release && RELEASE_MANIFEST_FILE_PATTERN.test(`${release}.json`) ? release : null;
  } catch {
    return null;
  }
}

/**
 * Why no release may be selected automatically, or null. An earlier release
 * selected one in `infra/docker`, and the migration did not bring that
 * selection into the agent's release state: resolving a release now would
 * replace the running one with whatever is newest, an upgrade nobody chose.
 * Commands that would select or apply a release refuse until the operator
 * selects one with `pnpm openmapx compose release`, or until the migration,
 * once the previous agent has finished its update, carries the overlay over.
 */
export function releaseSelectionHold(
  infraDir: string,
  options: ReleaseStateOptions = {},
): string | null {
  const legacy = legacyReleaseStatePaths(infraDir);
  const paths = releaseStatePaths(infraDir);
  if (!exists(legacy.overlay) || exists(paths.overlay)) return null;
  if (exists(join(paths.directory, LEGACY_OVERLAY_SUPERSEDED))) return null;
  const named = legacyOverlayRelease(legacy.overlay);
  const selection = named
    ? `The release the earlier release selected, ${named},`
    : "The release the earlier release selected";
  const choose =
    "select one explicitly with `pnpm openmapx compose release` on the host (or clear the selection with `pnpm openmapx compose release --clear`)";
  const transaction = join(legacy.store, "transaction.json");
  if (exists(transaction)) {
    return `${selection} was not carried into the agent's release state: the previous agent's release update is unfinished (${transaction}). No release is selected automatically until then. Let the previous agent finish its update, then render again, or ${choose}.`;
  }
  const record = join(paths.directory, MIGRATION_RECORD);
  let reason = "the migration has not run yet; run `pnpm openmapx compose render`";
  if (migrationState(record, options) === "finished") {
    const recorded = JSON.parse(
      readReleaseStateFile(record, RELEASE_STORE_LIMITS.transactionBytes, options),
    ) as { problems?: unknown };
    const problem = Array.isArray(recorded.problems)
      ? recorded.problems.find(
          (entry): entry is string => typeof entry === "string" && entry.startsWith(legacy.overlay),
        )
      : undefined;
    reason = problem ?? `${legacy.overlay} was not carried over`;
  }
  return `${selection} was not carried into the agent's release state (${reason}). No release is selected automatically until one is: ${choose}.`;
}

/** Clearing the selection explicitly supersedes the earlier overlay, whatever it held. */
export function supersedeLegacyReleaseOverlay(
  infraDir: string,
  options: ReleaseStateOptions = {},
): void {
  const legacy = legacyReleaseStatePaths(infraDir);
  const marker = join(releaseStatePaths(infraDir).directory, LEGACY_OVERLAY_SUPERSEDED);
  if (!exists(legacy.overlay) || exists(marker)) return;
  ensureReleaseStateDirectories(infraDir, options);
  atomicWrite(
    marker,
    `${JSON.stringify({ version: 1, supersededAt: new Date().toISOString() })}\n`,
    0o600,
  );
}
