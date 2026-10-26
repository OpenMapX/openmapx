import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import z from "zod/v4";
import { agentStatePaths, writeAgentStateFile } from "./agent-state";
import {
  ownedDirectoryProblem,
  type ReleaseServiceFiles,
  readOwnedRegularFile,
  ServiceFileError,
  sha256,
} from "./release-service-files";
import type { ServiceFileOverlay } from "./service-file-store";

/**
 * An operator's deliberate changes to release service files: whole files in
 * `infra/docker/overrides/services/<id>/<same relative path>`, read at render
 * and used in place of the release's file.
 *
 * Only a regular file of the deployment's user, with one link and that no
 * group or other may write, in directories that are the same, is used; never
 * through a link. An override of a path the release ships that is anything
 * else fails the render: using the release's file instead could drop what it
 * changes (a basic-auth gate). One for a path the release doesn't ship is
 * reported and ignored, so a release that drops a file never blocks an
 * upgrade. Traefik's dynamic directory is the exception: an operator's YAML
 * or TOML file there (`auth.yml`) is an override of that directory.
 *
 * The agent's state records each override's bytes and the release's file it
 * replaced; render flags one whose release file changed since. Editing the
 * override is how the operator acknowledges that.
 */

export const OVERRIDES_DIRECTORY = "overrides";
const TRAEFIK_DYNAMIC = /^config\/dynamic\/([^/]+\.(?:ya?ml|toml))$/;
const TRAEFIK_ROUTES = "config/dynamic/generated-routes.yml";

export interface ActiveOverride {
  readonly serviceId: string;
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  /** The release's file it replaces, or null for a Traefik dynamic file the release doesn't ship. */
  readonly releaseSha256: string | null;
}

export interface IgnoredOverride {
  /** Below `infra/docker/overrides/services`. */
  readonly path: string;
  readonly reason: string;
}

export interface ServiceOverrides {
  readonly active: readonly ActiveOverride[];
  readonly ignored: readonly IgnoredOverride[];
}

export function overridesDirectory(infraDir: string): string {
  return join(infraDir, OVERRIDES_DIRECTORY, "services");
}

/** Whether a release-relative `path` of `serviceId` may be overridden although the release doesn't ship it. */
export function overridableWithoutRelease(serviceId: string, path: string): boolean {
  return serviceId === "traefik" && TRAEFIK_DYNAMIC.test(path) && path !== TRAEFIK_ROUTES;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Why an overrides directory may not be read, or null when it may. */
function directoryProblem(stats: Stats | undefined, uid: number): string | null {
  return (
    ownedDirectoryProblem(stats, uid) ??
    ((stats?.mode ?? 0) & 0o022 ? "group or others may write it" : null)
  );
}

const unusable = (path: string, reason: string) =>
  new ServiceFileError(
    `infra/docker/overrides/services/${path} can't be used: ${reason}. Render refuses it rather than use the release's file in its place: make it a regular file of yours that only you may write, or delete it.`,
  );

/** The overrides render uses, and those it ignores; throws for one of a shipped path it may not use. */
export function readServiceOverrides(
  infraDir: string,
  release: ReleaseServiceFiles,
  uid: number = process.geteuid?.() ?? 0,
): ServiceOverrides {
  const root = join(infraDir, OVERRIDES_DIRECTORY);
  const active: ActiveOverride[] = [];
  const ignored: IgnoredOverride[] = [];
  const rootStats = lstatOrUndefined(root);
  if (!rootStats) return { active, ignored };
  const rootProblem = directoryProblem(rootStats, uid);
  if (rootProblem) {
    throw new ServiceFileError(
      `infra/docker/overrides can't be used: ${rootProblem}. Render refuses to go on without the overrides it may hold.`,
    );
  }
  const services = join(root, "services");
  const servicesStats = lstatOrUndefined(services);
  if (!servicesStats) return { active, ignored };
  const servicesProblem = directoryProblem(servicesStats, uid);
  if (servicesProblem) {
    throw new ServiceFileError(
      `infra/docker/overrides/services can't be used: ${servicesProblem}. Render refuses to go on without the overrides it may hold.`,
    );
  }
  const shippedPaths = new Map<string, string[]>();
  for (const file of release.files.values()) {
    const paths = shippedPaths.get(file.serviceId) ?? [];
    paths.push(file.path);
    shippedPaths.set(file.serviceId, paths);
  }
  const shipped = (serviceId: string, path: string) =>
    release.files.has(`${serviceId}/${path}`) || overridableWithoutRelease(serviceId, path);
  /** Whether anything render would use may lie below `path`. */
  const mayHold = (serviceId: string, path: string) =>
    (shippedPaths.get(serviceId) ?? []).some((file) => file.startsWith(`${path}/`)) ||
    (serviceId === "traefik" && "config/dynamic".startsWith(path));

  const visit = (serviceId: string, directory: string, prefix: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const shown = `${serviceId}/${path}`;
      const absolute = join(directory, name);
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        // In place of a file the release ships, as `mkdir -p` of its path makes one.
        if (shipped(serviceId, path)) throw unusable(shown, "it is a directory");
        const problem = directoryProblem(stats, uid);
        if (problem && mayHold(serviceId, path)) throw unusable(shown, problem);
        if (problem) ignored.push({ path: shown, reason: problem });
        else visit(serviceId, absolute, path);
        continue;
      }
      // A link in place of a directory that holds shipped files.
      if (stats.isSymbolicLink() && mayHold(serviceId, path)) {
        throw unusable(shown, "it is a symbolic link");
      }
      if (!shipped(serviceId, path)) {
        ignored.push({
          path: shown,
          reason:
            serviceId === "traefik" && path === TRAEFIK_ROUTES
              ? "render writes Traefik's routes itself"
              : `the release has no services/${shown} for it to replace`,
        });
        continue;
      }
      const read = readOwnedRegularFile(absolute, uid);
      if ("reason" in read) throw unusable(shown, read.reason);
      if (read.mode & 0o022) throw unusable(shown, "group or others may write it");
      active.push({
        serviceId,
        path,
        bytes: read.bytes,
        sha256: sha256(read.bytes),
        releaseSha256: release.files.get(shown)?.sha256 ?? null,
      });
    }
  };
  for (const serviceId of readdirSync(services).sort()) {
    const absolute = join(services, serviceId);
    const stats = lstatSync(absolute);
    if (!shippedPaths.has(serviceId) && serviceId !== "traefik") {
      ignored.push({
        path: serviceId,
        reason: `there is no built-in service "${serviceId}" with files to replace`,
      });
      continue;
    }
    const problem = directoryProblem(stats, uid);
    if (problem) throw unusable(serviceId, problem);
    visit(serviceId, absolute, "");
  }
  return { active, ignored };
}

/** The bytes render uses in place of the release's. */
export function overrideOverlay(overrides: ServiceOverrides): ServiceFileOverlay {
  return {
    files: new Map(
      overrides.active.map((entry) => [`${entry.serviceId}/${entry.path}`, entry.bytes]),
    ),
  };
}

const recordSchema = z.strictObject({
  version: z.literal(1),
  overrides: z.record(
    z.string(),
    z.strictObject({
      override: z.string().regex(/^[a-f0-9]{64}$/),
      base: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    }),
  ),
});
type OverrideRecords = z.infer<typeof recordSchema>["overrides"];

const RECORDS = "overrides.json";

function recordPath(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, RECORDS);
}

function readRecords(infraDir: string): OverrideRecords {
  try {
    return recordSchema.parse(JSON.parse(readFileSync(recordPath(infraDir), "utf8"))).overrides;
  } catch {
    return {};
  }
}

function writeRecords(infraDir: string, records: OverrideRecords): void {
  writeAgentStateFile(infraDir, RECORDS, `${JSON.stringify({ version: 1, overrides: records })}\n`);
}

/** Records overrides render made itself (the import), each with the release file it replaced. */
export function addOverrideRecords(infraDir: string, records: OverrideRecords): void {
  writeRecords(infraDir, { ...readRecords(infraDir), ...records });
}

/**
 * The overrides whose release file changed since they were made or last
 * edited. With `record`, the agent's state takes each new or edited
 * override's release file as its base, and forgets removed ones.
 */
export function staleOverrides(
  infraDir: string,
  overrides: ServiceOverrides,
  options: { record: boolean },
): ActiveOverride[] {
  const recorded = readRecords(infraDir);
  const next: OverrideRecords = {};
  const stale: ActiveOverride[] = [];
  for (const entry of overrides.active) {
    const key = `${entry.serviceId}/${entry.path}`;
    const record = recorded[key];
    if (!record || record.override !== entry.sha256) {
      next[key] = { override: entry.sha256, base: entry.releaseSha256 };
      continue;
    }
    next[key] = record;
    if (record.base !== entry.releaseSha256) stale.push(entry);
  }
  if (options.record && JSON.stringify(next) !== JSON.stringify(recorded)) {
    writeRecords(infraDir, next);
  }
  return stale;
}

/** What render, the agent's log, check and Run diagnostics say about the overrides; names only. */
export function describeServiceOverrides(
  overrides: ServiceOverrides,
  stale: readonly ActiveOverride[],
): string[] {
  const lines: string[] = [];
  if (overrides.active.length > 0) {
    const names = overrides.active.map(
      (entry) =>
        `${entry.serviceId}/${entry.path}${entry.releaseSha256 === null ? " (no release file; Traefik's dynamic directory)" : ""}`,
    );
    lines.push(
      `Service file overrides in use, in place of the release's files (infra/docker/overrides/services): ${names.join(", ")}.`,
    );
  }
  for (const entry of stale) {
    const key = `${entry.serviceId}/${entry.path}`;
    lines.push(
      entry.releaseSha256 === null
        ? `The release no longer ships services/${key}, which infra/docker/overrides/services/${key} was made for. Check that it still applies, then edit the override to acknowledge it.`
        : `The release's services/${key} changed since infra/docker/overrides/services/${key} was made, and the override still replaces it. Compare the two, then edit the override to acknowledge the release's change.`,
    );
  }
  for (const entry of overrides.ignored) {
    lines.push(`infra/docker/overrides/services/${entry.path} is ignored: ${entry.reason}.`);
  }
  return lines;
}
