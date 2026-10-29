import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import z from "zod/v4";
import { fsyncDirectory } from "../release-files";
import { agentStatePaths, writeAgentStateFile } from "./agent-state";
import { checkoutMounted } from "./checkout-layout";
import {
  ownedDirectoryProblem,
  parseServiceFileHistory,
  type ReleaseServiceFiles,
  readOwnedRegularFile,
  ServiceFileError,
  serviceFileReferences,
  sha256,
} from "./release-service-files";
import {
  addOverrideRecords,
  overridableWithoutRelease,
  overridesDirectory,
} from "./service-overrides";
import type { LoadedService } from "./types";

/**
 * The one-time import of an operator's edits in the checkout's service files
 * into overrides, when render first uses the release's files.
 *
 * A checkout file is an edit when its bytes match no version that file had
 * in a release: a checkout the panel updated still holds an earlier
 * release's files, which are not edits. That holds only for a checkout at or
 * behind the release: one ahead of it holds upstream versions the release
 * has never seen, which match none either. Where the checkout is not known
 * to be at or behind the release, the import waits, importing and recording
 * nothing, and render says so each time.
 *
 * A file a container writes (a `writableCopy`, valhalla.json) is never
 * imported. Traefik's dynamic YAML and TOML files the release doesn't ship
 * (an operator's `auth.yml`) are, and its `traefik.yml` when it differs (the
 * `basic-auth@file` reference); the routes earlier releases wrote there never
 * are.
 *
 * Nothing in the checkout is moved or changed. A differing file render may
 * not read fails the render, with nothing recorded, rather than lose the
 * edit. Afterwards the import is recorded and never runs again; render goes
 * on reporting checkout edits that are not overrides.
 */

const MARKER = "overrides-import.json";
const markerSchema = z.strictObject({
  version: z.literal(1),
  importedAt: z.string(),
  imported: z.array(z.string()),
});
/** Why the import waits in an operations agent that runs without the checkout. */
const NO_CHECKOUT_TO_IMPORT_FROM =
  "this operations agent runs without the checkout, so it has no edits to read";

/** Each commit's list of every version of its service files; CI fails one that lacks a file's current bytes. */
export const CHECKOUT_SERVICE_FILE_HISTORY = "services/service-file-history.json";

function markerPath(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, MARKER);
}

/** Whether the import has run (the checkout's edits are overrides now, or there were none). */
export function serviceFilesImported(infraDir: string): boolean {
  try {
    markerSchema.parse(JSON.parse(readFileSync(markerPath(infraDir), "utf8")));
    return true;
  } catch {
    return false;
  }
}

/** Whether the checkout is at or behind the release, so that its files hold no upstream version newer than the release's. */
export type CheckoutPosition =
  | { readonly atOrBehindRelease: true }
  | { readonly atOrBehindRelease: false; readonly reason: string };

/**
 * Where the checkout stands, without git (the agent): at or behind the
 * release when every version of a release file that its own
 * `services/service-file-history.json` lists is one the release's lists too.
 * A commit that changes a service file adds its bytes to that list, so a
 * checkout ahead of the release with a changed file lists a version the
 * release doesn't. A file the release no longer names is left out (it is not
 * imported), unless it is one of Traefik's dynamic files, which would be. A
 * checkout without the list predates the release that introduced it, which
 * is this one or earlier, so it is behind. An agent without the checkout
 * mounted has nothing to compare, which is not "at or behind": the import
 * waits for a render on the host.
 */
export function checkoutPositionFromHistory(
  rootDir: string,
  release: ReleaseServiceFiles,
  uid: number = process.geteuid?.() ?? 0,
): CheckoutPosition {
  if (!checkoutMounted(rootDir)) {
    return { atOrBehindRelease: false, reason: NO_CHECKOUT_TO_IMPORT_FROM };
  }
  const read = readOwnedRegularFile(join(rootDir, CHECKOUT_SERVICE_FILE_HISTORY), uid);
  if ("reason" in read) {
    return read.reason === "it is missing"
      ? { atOrBehindRelease: true }
      : {
          atOrBehindRelease: false,
          reason: `the checkout's ${CHECKOUT_SERVICE_FILE_HISTORY}, which says whether it is ahead of the release, can't be used: ${read.reason}`,
        };
  }
  let listed: Map<string, Set<string>>;
  try {
    listed = parseServiceFileHistory(read.bytes.toString("utf8"));
  } catch {
    return {
      atOrBehindRelease: false,
      reason: `the checkout's ${CHECKOUT_SERVICE_FILE_HISTORY}, which says whether it is ahead of the release, is not a service file history`,
    };
  }
  const newer: string[] = [];
  for (const [key, hashes] of [...listed].sort(([a], [b]) => a.localeCompare(b))) {
    const known = release.history.get(key);
    const [serviceId = "", ...rest] = key.split("/");
    if (!known && !overridableWithoutRelease(serviceId, rest.join("/"))) continue;
    if ([...hashes].some((hash) => !known?.has(hash))) newer.push(`services/${key}`);
  }
  if (newer.length === 0) return { atOrBehindRelease: true };
  return {
    atOrBehindRelease: false,
    reason: `the checkout's ${CHECKOUT_SERVICE_FILE_HISTORY} lists versions of ${newer.join(", ")} that the release doesn't, so the checkout may be ahead of it`,
  };
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Each release file a container doesn't write, and Traefik's dynamic files the checkout adds. */
function importCandidates(
  rootDir: string,
  services: readonly LoadedService[],
  release: ReleaseServiceFiles,
  uid: number,
): string[] {
  const written = new Set(
    serviceFileReferences(services.filter((service) => service.isBuiltIn).map((s) => s.manifest))
      .filter((reference) => reference.writableCopy)
      .map((reference) => `${reference.serviceId}/${reference.path}`),
  );
  const keys = [...release.files.keys()].filter((key) => !written.has(key));
  const dynamic = join(rootDir, "services", "traefik", "config", "dynamic");
  const stats = lstatOrUndefined(dynamic);
  if (stats) {
    const problem = ownedDirectoryProblem(stats, uid);
    if (problem) {
      throw new ServiceFileError(
        `services/traefik/config/dynamic can't be read for the one-time import of your service file edits: ${problem}. Make it your own directory, or remove it, and render again.`,
      );
    }
    for (const name of readdirSync(dynamic).sort()) {
      const key = `traefik/config/dynamic/${name}`;
      if (
        overridableWithoutRelease("traefik", `config/dynamic/${name}`) &&
        !release.files.has(key)
      ) {
        keys.push(key);
      }
    }
  }
  return keys.sort();
}

interface CheckoutEdit {
  readonly key: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

/**
 * The checkout's files that match no version the release shipped and that
 * no override carries yet. With `strict`, one that can't be read fails;
 * otherwise it is left out.
 */
function differingCheckoutFiles(
  infraDir: string,
  services: readonly LoadedService[],
  release: ReleaseServiceFiles,
  uid: number,
  strict: boolean,
): CheckoutEdit[] {
  const rootDir = resolve(infraDir, "..", "..");
  const overrides = overridesDirectory(infraDir);
  const edits: CheckoutEdit[] = [];
  let candidates: string[];
  try {
    candidates = importCandidates(rootDir, services, release, uid);
  } catch (error) {
    if (strict) throw error;
    return [];
  }
  for (const key of candidates) {
    if (existsSync(join(overrides, key)) || lstatOrUndefined(join(overrides, key))) continue;
    const path = join(rootDir, "services", key);
    if (!lstatOrUndefined(path)) continue;
    const read = readOwnedRegularFile(path, uid);
    if ("reason" in read) {
      if (!strict) continue;
      throw new ServiceFileError(
        `services/${key} can't be read for the one-time import of your service file edits: ${read.reason}. Render now uses the release's files, so an edit there would be lost: replace it with a regular file of yours holding your version, or delete it if the release's version will do (git restore services/${key}), and render again.`,
      );
    }
    const hash = sha256(read.bytes);
    const known = release.history.get(key) ?? new Set<string>();
    if (hash === release.files.get(key)?.sha256 || known.has(hash)) continue;
    // Never more open than the checkout's file, and never writable by others;
    // an operator's Traefik files may hold password hashes, so owner-only.
    const mode = read.mode & (key.startsWith("traefik/") ? 0o600 : 0o644);
    edits.push({ key, bytes: read.bytes, mode: mode | 0o400 });
  }
  return edits;
}

/** What the import will do: take these edits along, or wait, and why. */
export type ServiceFileImportPlan =
  | { readonly kind: "import"; readonly edits: readonly CheckoutEdit[] }
  | {
      readonly kind: "defer";
      readonly reason: string;
      /** Checkout files matching no version the release shipped, which render does not use meanwhile. */
      readonly pending: readonly string[];
    };

/**
 * What the import would do now, changing nothing; null when it already ran
 * or does not apply (running the checkout's files). Without `position`, the
 * checkout's own history says where it stands (the agent, which has no git).
 * Throws, when it would import, for a differing file it may not read.
 */
export function planServiceFileImport(options: {
  infraDir: string;
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  position?: CheckoutPosition;
  uid?: number;
}): ServiceFileImportPlan | null {
  const { infraDir, services, release } = options;
  if (release.origin !== "release" || serviceFilesImported(infraDir)) return null;
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const position =
    options.position ?? checkoutPositionFromHistory(resolve(infraDir, "..", ".."), release, uid);
  if (!position.atOrBehindRelease) {
    return {
      kind: "defer",
      reason: position.reason,
      pending: differingCheckoutFiles(infraDir, services, release, uid, false).map(
        (edit) => edit.key,
      ),
    };
  }
  return { kind: "import", edits: differingCheckoutFiles(infraDir, services, release, uid, true) };
}

function writeOverride(path: string, bytes: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.import.tmp`);
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

/**
 * The Traefik files a waiting import would carry over, which render refuses
 * to go without: a dynamic YAML or TOML file the release doesn't ship (an
 * operator's `auth.yml`) or a differing `traefik.yml` (its `basic-auth@file`
 * reference). Using the release's files in their place could drop a
 * basic-auth gate. Other differing files, Traefik's shipped dynamic files
 * included, keep the release's bytes and are reported.
 */
export function waitingTraefikEdits(
  plan: ServiceFileImportPlan | null,
  release: ReleaseServiceFiles,
): string[] {
  if (plan?.kind !== "defer") return [];
  return plan.pending.filter(
    (key) =>
      key === "traefik/config/traefik.yml" ||
      (key.startsWith("traefik/") &&
        overridableWithoutRelease("traefik", key.slice("traefik/".length)) &&
        !release.files.has(key)),
  );
}

/** Why render refuses while the import waits on Traefik files, and how to go on. */
export function describeWaitingTraefikEdits(reason: string, keys: readonly string[]): string {
  return `Render refuses while the one-time import of your service file edits waits (${reason}): the checkout holds Traefik files the import would carry over, and the release's files in their place could drop a basic-auth gate: ${keys.map((key) => `services/${key}`).join(", ")}. Put each, as a whole file at the same path, in infra/docker/overrides/services/traefik/, created under umask 022 (an auth.yml holding password hashes with mode 0600), or delete it if you don't need it. An override ends the wait for that file, and render goes on.`;
}

/** What the import did: the files it made overrides of (`<id>/<path>`), or why it waits. */
export type ServiceFileImport =
  | { readonly imported: readonly string[] }
  | { readonly deferred: string; readonly pending: readonly string[] };

/**
 * Imports the checkout's edits once, when `release` is the release's own
 * files and the checkout is at or behind it. Null when the import already
 * ran or does not apply (running the checkout's files).
 */
export function importCheckoutServiceFiles(options: {
  infraDir: string;
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  position?: CheckoutPosition;
  uid?: number;
}): ServiceFileImport | null {
  const { infraDir, release } = options;
  const plan = planServiceFileImport(options);
  if (!plan) return null;
  if (plan.kind === "defer") {
    const traefik = waitingTraefikEdits(plan, release);
    if (traefik.length > 0) {
      throw new ServiceFileError(describeWaitingTraefikEdits(plan.reason, traefik));
    }
    return { deferred: plan.reason, pending: plan.pending };
  }
  const overrides = overridesDirectory(infraDir);
  const records: Record<string, { override: string; base: string | null }> = {};
  for (const { key, bytes, mode } of plan.edits) {
    writeOverride(join(overrides, key), bytes, mode);
    records[key] = { override: sha256(bytes), base: release.files.get(key)?.sha256 ?? null };
  }
  if (plan.edits.length > 0) addOverrideRecords(infraDir, records);
  const imported = plan.edits.map((edit) => edit.key);
  writeAgentStateFile(
    infraDir,
    MARKER,
    `${JSON.stringify({ version: 1, importedAt: new Date().toISOString(), imported })}\n`,
  );
  return { imported };
}

/** Why the import waits, and what render does meanwhile. */
export function describeDeferredServiceFileImport(
  reason: string,
  pending: readonly string[],
): string {
  if (reason === NO_CHECKOUT_TO_IMPORT_FROM) {
    return `The one-time import of your edits in the checkout's service files has not run, and ${reason}: run \`pnpm openmapx compose render\` on the host, as the checkout's owner, which imports them and records that it did. Nothing is recorded until then. Meanwhile render uses the release's files and your overrides in infra/docker/overrides/services.`;
  }
  const meanwhile =
    pending.length > 0
      ? ` Meanwhile render uses the release's files, not these checkout files, which match no version it shipped: ${pending.map((key) => `services/${key}`).join(", ")}. To keep an edit among them now, put the whole file in infra/docker/overrides/services/<id>/<path>.`
      : "";
  return `The one-time import of your edits in the checkout's service files waits: ${reason}. A checkout file ahead of the release could be a newer upstream version rather than your edit, so nothing is imported or recorded until the checkout is at or behind the release's source revision; render tries again each time.${meanwhile}`;
}

/** Said once, when the import made overrides of the checkout's edits, and each time it waits. */
export function describeServiceFileImport(result: ServiceFileImport | null): string[] {
  if (!result) return [];
  if ("deferred" in result)
    return [describeDeferredServiceFileImport(result.deferred, result.pending)];
  const { imported } = result;
  if (imported.length === 0) return [];
  return [
    `Imported ${imported.length} checkout service file${imported.length === 1 ? " that differs" : "s that differ"} from every version a release shipped as overrides, used from now on in place of the release's: ${imported.map((key) => `infra/docker/overrides/services/${key}`).join(", ")}. Edit them there; the checkout's copies are no longer read.`,
  ];
}

/**
 * Checkout service files that differ from every version a release shipped
 * and that no override carries: an edit render does not use. Unreadable
 * files are left out; the import reported them.
 */
export function unusedCheckoutEdits(options: {
  infraDir: string;
  services: readonly LoadedService[];
  release: ReleaseServiceFiles;
  overrides: ReadonlyMap<string, Buffer>;
  uid?: number;
}): string[] {
  const { infraDir, services, release, overrides } = options;
  if (release.origin !== "release") return [];
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const rootDir = resolve(infraDir, "..", "..");
  let candidates: string[];
  try {
    candidates = importCandidates(rootDir, services, release, uid);
  } catch {
    return [];
  }
  const unused: string[] = [];
  for (const key of candidates) {
    const read = readOwnedRegularFile(join(rootDir, "services", key), uid);
    if ("reason" in read) continue;
    const hash = sha256(read.bytes);
    if (hash === release.files.get(key)?.sha256 || release.history.get(key)?.has(hash)) continue;
    if (overrides.get(key)?.equals(read.bytes)) continue;
    unused.push(key);
  }
  return unused;
}

export function describeUnusedCheckoutEdits(keys: readonly string[]): string[] {
  return keys.map(
    (key) =>
      `services/${key} differs from every version a release shipped, and render does not use it: services read the release's files, or your overrides. To keep this change, put the whole file in infra/docker/overrides/services/${key}.`,
  );
}
