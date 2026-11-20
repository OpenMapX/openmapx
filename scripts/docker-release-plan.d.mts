// Types for the Docker release planner. The planner itself stays plain
// JavaScript: every byte of it is an input of every image fingerprint, so
// annotating it in place would rebuild every image.

export { coversPath, dockerInputs } from "./docker-inputs.mjs";

export interface DockerTarget {
  app: string;
  context: string;
  dockerfile: string;
}

/** One `git ls-tree -r` entry. */
export interface TreeEntry {
  path: string;
  mode: string;
  oid: string;
}

export type ReadFile = (path: string) => string;

/** Returns `null` (or throws) when the ignore file does not exist. */
export type ReadIgnoreFile = (path: string) => string | null;

export interface ImageBuildMetadata {
  inputHash: string;
  sourceRevision: string;
  builtAt: string;
  coldRefreshedAt: string;
}

export interface BuildMetadata {
  version: number;
  images: Record<string, ImageBuildMetadata>;
}

/** The `release-manifest.json` a promoted release publishes. */
export interface ReleaseManifest {
  schemaVersion: number;
  release: string;
  images: Record<string, string>;
  buildMetadata: BuildMetadata;
}

export interface PlannedImage extends DockerTarget {
  rebuild: boolean;
  refresh: boolean;
  reason: "bootstrap" | "security-refresh" | "inputs-changed" | "unchanged";
  digest: string;
  bundleDigest?: string;
}

export interface ReleasePlan {
  version: number;
  release: string;
  sourceRevision: string;
  images: PlannedImage[];
  buildMetadata: BuildMetadata;
}

/** The parsed documents of `pnpm-lock.yaml`. */
export interface Lockfile {
  documents: unknown[];
}

export type LockfileFallback = (app: string, error: Error) => void;

/** The part of a `spawnSync` result the planner reads. */
export interface DockerCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export const targets: DockerTarget[];
export const pullRequestTargets: DockerTarget[];

export function targetInputs(
  target: DockerTarget,
  readDockerfile: ReadFile,
  sources?: string[],
): string[];

export function selectChangedTargets(options: {
  changedPaths: string[];
  readDockerfile: ReadFile;
  tree?: TreeEntry[];
  candidates?: DockerTarget[];
  readIgnoreFile?: ReadIgnoreFile;
}): string[];

export function trackedTree(root: string): TreeEntry[];

export function lockfileSubgraph(
  documents: unknown[],
  selectsImporter: (importer: string) => boolean,
): unknown;

export function imageFingerprint(options: {
  target: DockerTarget;
  tree: TreeEntry[];
  readDockerfile: ReadFile;
  lockfile?: Lockfile;
  onLockfileFallback?: LockfileFallback;
  bundleDigest?: string;
  readFile?: ReadFile;
}): string;

export function createReleasePlan(options: {
  revision: string;
  releaseId?: string;
  tree: TreeEntry[];
  readDockerfile: ReadFile;
  previous?: ReleaseManifest | null;
  now?: string;
  force?: boolean;
  imagePrefix?: string;
  lockfile?: Lockfile;
  onLockfileFallback?: LockfileFallback;
  bundleDigests?: Record<string, string>;
  readFile?: ReadFile;
}): ReleasePlan;

export function loadPreviousRelease(
  image: string,
  docker?: (args: string[]) => DockerCommandResult,
): ReleaseManifest | null;

export function sameProducerPlan(planned: unknown, current: unknown): boolean;
