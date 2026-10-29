import { extractIntegrationArtifactStream } from "./artifact-stream";
// Pure functions for installing, removing, validating, and bundling community
// integrations under `custom_integrations/`. The CLI (`pnpm openmapx
// integrations …`) and the admin Store (`apps/api/src/services/store.ts`) both
// call into this module so they share one source of truth.
//
// Community install/package entry points enforce declarative-only artifacts;
// app-api never builds or executes community bundles at runtime.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  constants as C,
  chmodSync,
  closeSync,
  cpSync,
  createReadStream,
  type Dirent,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { AnchoredDirectory } from "@openmapx/core/build-artifacts";
import { scanLicenses } from "@openmapx/core/licenses";
import {
  assertAllowedGitUrl,
  gitShallowClone,
  gitShallowCloneSnapshot,
  safeDownload,
} from "@openmapx/core/server";
import {
  type ArtifactMetadata,
  validateArtifactMetadata as validatePortableArtifactMetadata,
} from "@openmapx/extension-contracts/artifact";
import z from "zod/v4";
import { createDeterministicTarGz } from "./deterministic-tar";
import { INTEGRATION_ID_REGEX, validateManifest } from "./manifest";
import { PLATFORM_VERSION, satisfiesPlatformVersion } from "./platform";

export interface IntegrationSummary {
  id: string;
  name: string;
  version: string;
  quality: string;
  directory: string;
}

function customDir(rootDir: string): string {
  return join(rootDir, "custom_integrations");
}

const STAGING_DIR_NAME = ".staging";
const DEFAULT_MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;
const MAX_LAYER_SELECTOR_PREVIEW_BYTES = 64 * 1024;

function stagingDir(rootDir: string): string {
  return join(customDir(rootDir), STAGING_DIR_NAME);
}

function createStagePath(rootDir: string, prefix: string): string {
  const parent = stagingDir(rootDir);
  mkdirSync(parent, { recursive: true });
  return join(parent, `${prefix}-${randomBytes(4).toString("hex")}`);
}

function builtInDir(rootDir: string): string {
  return join(rootDir, "integrations");
}

/**
 * Reject ids that aren't safe to use as a directory name or to embed in
 * generated source code. Defense-in-depth on top of the manifest schema; the
 * manifest validator already enforces this regex, but install/remove/build are
 * also reachable from the CLI with an arbitrary user-supplied id, so we
 * re-check before any path concatenation.
 */
function assertSafeId(id: string): void {
  if (typeof id !== "string" || !INTEGRATION_ID_REGEX.test(id)) {
    throw new Error(
      `Invalid integration id "${id}" — must match ${INTEGRATION_ID_REGEX} (lowercase, hyphen-separated, starts with a letter or digit)`,
    );
  }
}

/** Resolve the install target and verify it stays under `customDir`. */
function resolveInstallTarget(rootDir: string, id: string): string {
  assertSafeId(id);
  const base = resolve(customDir(rootDir));
  const target = resolve(join(base, id));
  if (!target.startsWith(`${base}/`) && target !== base) {
    // Unreachable given the slug regex, but keep as a defensive guard.
    throw new Error(`Resolved install target ${target} escapes ${base}`);
  }
  return target;
}

function readBoundedJson(path: string, limit: number): unknown {
  const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit))
      throw Error("Integration JSON metadata exceeds its size limit");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error("Integration JSON metadata changed");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw Error("Integration JSON metadata changed");
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
function readManifest(directory: string): Record<string, unknown> | null {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return readBoundedJson(manifestPath, 1024 * 1024) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function builtInIntegrationIds(rootDir: string): Set<string> {
  const ids = new Set<string>();
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(builtInDir(rootDir), { withFileTypes: true });
  } catch {
    return ids;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(join(builtInDir(rootDir), entry.name));
    if (typeof manifest?.id === "string" && INTEGRATION_ID_REGEX.test(manifest.id)) {
      ids.add(manifest.id);
    }
  }
  return ids;
}

function assertDoesNotShadowBuiltIn(rootDir: string, id: string): void {
  if (builtInIntegrationIds(rootDir).has(id)) {
    throw new Error(
      `Built-in integration id "${id}" is reserved and cannot be installed as a community integration`,
    );
  }
}

function summarise(directory: string): IntegrationSummary | null {
  const manifest = readManifest(directory);
  if (!manifest || typeof manifest.id !== "string") return null;
  return {
    id: manifest.id,
    name: typeof manifest.name === "string" ? manifest.name : manifest.id,
    version: typeof manifest.version === "string" ? manifest.version : "?",
    quality: typeof manifest.quality === "string" ? manifest.quality : "community",
    directory,
  };
}

export interface ListOptions {
  rootDir: string;
  includeBuiltIn?: boolean;
}

export function listIntegrations(opts: ListOptions): IntegrationSummary[] {
  const dirs: string[] = [];
  if (opts.includeBuiltIn && existsSync(builtInDir(opts.rootDir))) {
    dirs.push(builtInDir(opts.rootDir));
  }
  if (existsSync(customDir(opts.rootDir))) {
    dirs.push(customDir(opts.rootDir));
  }
  const out: IntegrationSummary[] = [];
  for (const baseDir of dirs) {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const summary = summarise(join(baseDir, entry.name));
      if (summary) out.push(summary);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface ValidateResult {
  id: string;
  valid: boolean;
  errors: string[];
}

/**
 * Resolve and validate the static layer-selector preview declared by a manifest.
 * The returned path is canonical and guaranteed to remain inside the integration root.
 */
export function resolveLayerSelectorPreview(
  directory: string,
  manifest: Record<string, unknown>,
): string | null {
  const frontend = manifest.frontend;
  if (!frontend || typeof frontend !== "object") return null;
  const layerSelector = (frontend as Record<string, unknown>).layerSelector;
  if (!layerSelector || typeof layerSelector !== "object") return null;
  const preview = (layerSelector as Record<string, unknown>).preview;
  if (preview === undefined || preview === null) return null;

  const prefix = "frontend.layerSelector.preview";
  if (typeof preview !== "string" || !preview.toLowerCase().endsWith(".svg")) {
    throw new Error(`${prefix} must reference an SVG file`);
  }

  const root = resolve(directory);
  const candidate = resolve(root, preview);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${prefix} escapes the integration directory`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`${prefix} file is missing`);
  }

  const canonicalRoot = realpathSync(root);
  const canonical = realpathSync(candidate);
  if (canonical === canonicalRoot || !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`${prefix} escapes the integration directory through a symlink`);
  }
  const stats = statSync(canonical);
  if (!stats.isFile()) {
    throw new Error(`${prefix} must be a regular file`);
  }
  if (stats.size > MAX_LAYER_SELECTOR_PREVIEW_BYTES) {
    throw new Error(`${prefix} exceeds the 64 KiB size limit`);
  }
  return canonical;
}

export function validateIntegrationDirectory(directory: string): ValidateResult {
  const manifest = readManifest(directory);
  if (!manifest) {
    return { id: directory, valid: false, errors: ["manifest.json missing or invalid JSON"] };
  }
  const result = validateManifest(manifest);
  const errors = [...result.errors];
  if (result.valid) {
    try {
      resolveLayerSelectorPreview(directory, manifest);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  return {
    id: typeof manifest.id === "string" ? manifest.id : directory,
    valid: result.valid && errors.length === 0,
    errors,
  };
}

export interface InstallOptions {
  rootDir: string;
  /**
   * For `sourceKind: "source"`: `github:user/repo`, an https Git URL, or an
   * absolute/relative local path. For `sourceKind: "artifact"`: an https URL
   * to a `.tar.gz` artifact, or a local `.tar.gz` path when local sources are
   * allowed.
   */
  source: string;
  /**
   * `source` clones/copies a working directory. `artifact` extracts an
   * OpenMapX community-integration release tarball used by the admin Store.
   * Both paths enforce the declarative-only community code policy.
   */
  sourceKind?: "source" | "artifact";
  ref?: string;
  artifactSha256?: string;
  maxArtifactBytes?: number;
  /**
   * Whether to allow installing from a local filesystem path or local
   * `.tar.gz`. Defaults to `true`. Set to `false` for admin-facing endpoints
   * (the admin Store), where arbitrary local paths are out-of-scope.
   */
  allowLocalSources?: boolean;
  /** Stream-style line callback for log output (stdout + stderr). */
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  /** Server-local bundle orchestration retains publication through reload/bookkeeping. */
  retainPublication?: boolean;
  expectedId?: string;
  beforePublish?: (receipt: IntegrationPublicationReceipt) => void;
}

export interface InstallResult {
  publication?: IntegrationPublication;
  id: string;
  directory: string;
  replaced: boolean;
}

// Matches anything that *looks like* a URL scheme (e.g. `https://`, `http://`,
// `ssh://`, `git@github.com:`). If it matches, we treat the source as a Git
// URL attempt and route it through the allowlist — even non-https schemes —
// so the user gets a precise error rather than "this isn't a local directory".
const URL_SCHEME_REGEX = /^([a-z][a-z0-9+.-]*:\/\/|git@)/i;

function resolveGitUrl(source: string): string | null {
  if (source.startsWith("github:")) {
    return `https://github.com/${source.slice("github:".length)}.git`;
  }
  if (URL_SCHEME_REGEX.test(source)) {
    return source.endsWith("/") ? source.slice(0, -1) : source;
  }
  return null;
}

export async function installIntegration(opts: InstallOptions): Promise<InstallResult> {
  mkdirSync(customDir(opts.rootDir), { recursive: true });

  const allowLocal = opts.allowLocalSources ?? true;
  const sourceKind = opts.sourceKind ?? "source";
  const gitUrl = sourceKind === "source" ? resolveGitUrl(opts.source) : null;

  // Validate the source before doing any work. assertAllowedGitUrl throws on
  // non-https URLs and off-allowlist hosts; local paths are gated by the
  // caller-supplied flag.
  if (sourceKind === "artifact") {
    if (URL_SCHEME_REGEX.test(opts.source)) {
      const parsed = new URL(opts.source);
      if (parsed.protocol !== "https:") {
        throw new Error(`Only https:// artifact URLs are supported (got ${parsed.protocol})`);
      }
      if (!opts.artifactSha256) {
        throw new Error("Remote integration artifacts require an expected SHA-256 digest");
      }
    } else if (!allowLocal) {
      throw new Error("Local artifact paths are not allowed in this context.");
    } else if (!existsSync(opts.source) || !statSync(opts.source).isFile()) {
      throw new Error(`Artifact '${opts.source}' is not an existing .tar.gz file`);
    }
  } else if (gitUrl) {
    assertAllowedGitUrl(gitUrl);
  } else if (!allowLocal) {
    throw new Error(
      `Source '${opts.source}' is not a github:<user>/<repo> spec or an https Git URL. Local paths are not allowed in this context.`,
    );
  }

  // Stage inside custom_integrations so the final rename stays on the same
  // filesystem as the install target (renameSync is only atomic within a
  // single filesystem).
  let stage: string,
    archiveSha256: string | null = null;
  if (sourceKind === "artifact") {
    const artifact = await stageArtifactSource(opts);
    stage = artifact.directory;
    archiveSha256 = artifact.archiveSha256;
  } else if (gitUrl) {
    stage = await gitShallowClone({
      url: gitUrl,
      ref: opts.ref,
      targetDir: createStagePath(opts.rootDir, "git"),
      signal: opts.signal,
      onLog: opts.onLog,
    });
  } else {
    if (!existsSync(opts.source) || !statSync(opts.source).isDirectory()) {
      throw new Error(
        `Source '${opts.source}' is neither a github:<user>/<repo> spec, an https Git URL, nor an existing local directory`,
      );
    }
    stage = stageLocalSource(opts.rootDir, opts.source);
  }

  try {
    const manifest = readManifest(stage);
    if (!manifest || typeof manifest.id !== "string") {
      throw new Error("Source has no manifest.json with a string `id` at its root");
    }

    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Manifest validation failed:\n  - ${validation.errors.join("\n  - ")}`);
    }
    assertCompatibleManifestProtocol(manifest);
    const id = manifest.id;
    assertSafeId(id);
    assertDoesNotShadowBuiltIn(opts.rootDir, id);
    resolveLayerSelectorPreview(stage, manifest);
    assertNoExecutableCommunityCode(stage, manifest);

    // The schema regex already enforces the slug shape, but resolveInstallTarget
    // (via assertSafeId) gives a single point of defense if the schema ever
    // loosens AND verifies the resolved path stays under custom_integrations/.
    const target = resolveInstallTarget(opts.rootDir, id);
    validateDeclarativeArtifact(stage);
    if (sourceKind === "artifact") {
      validateArtifactMetadata(stage, manifest);
    }
    if (opts.expectedId !== undefined && opts.expectedId !== id)
      throw Error(`Integration artifact declares ${id}, expected ${opts.expectedId}`);
    const signal = opts.signal ?? new AbortController().signal;
    const context = createIntegrationArtifactPreparation({ rootDir: opts.rootDir });
    const state = preparationState(context),
      workspace = checkedWorkspace(state);
    try {
      renameSync(stage, workspace.name("content"));
      privatizeIntegrationDirectory(workspace.name("content"), signal);
      state.phase = "preparing";
      const prepared = finishIntegrationPreparation(context, archiveSha256, signal);
      const previous = inspectInstalledIntegrationFingerprint({
        rootDir: opts.rootDir,
        id,
        signal,
      });
      const publication = await publishPreparedIntegration(prepared, {
        transactionId: randomUUID(),
        expectedPreviousContentDigest: previous?.contentDigest ?? null,
        expectedPreviousIdentity: previous?.identity ?? null,
        signal,
        beforePublish: opts.beforePublish,
      });
      if (opts.retainPublication)
        return { id, directory: target, replaced: previous !== null, publication };
      // Publication is the CLI commit point; finish only its already-owned
      // cleanup even if cancellation arrives after the directory swap.
      await settleIntegrationPublication(publication, "commit", new AbortController().signal);
      return { id, directory: target, replaced: previous !== null };
    } catch (error) {
      if (state.phase !== "published") discardIntegrationPreparation(context);
      throw error;
    } finally {
      workspace.close();
    }
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}

function stageLocalSource(rootDir: string, source: string): string {
  const stage = createStagePath(rootDir, "source");
  cpSync(source, stage, { recursive: true });
  rmSync(join(stage, ".git"), { recursive: true, force: true });
  return stage;
}

async function stageArtifactSource(
  opts: InstallOptions,
): Promise<{ directory: string; archiveSha256: string }> {
  const token = randomBytes(4).toString("hex");
  const parent = stagingDir(opts.rootDir);
  const maxArtifactBytes = opts.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  mkdirSync(parent, { recursive: true });
  const extractRoot = join(parent, `artifact-${token}`);
  const archivePath = join(parent, `artifact-${token}.tar.gz`);
  mkdirSync(extractRoot, { recursive: true, mode: 0o700 });

  try {
    let sourcePath = opts.source;
    if (URL_SCHEME_REGEX.test(opts.source)) {
      await safeDownload({
        url: new URL(opts.source),
        destination: archivePath,
        maxBytes: maxArtifactBytes,
        timeoutMs: 5 * 60_000,
        allowedContentTypes: [],
        credentialPolicy: "none",
        headers: { "User-Agent": "Open-MapX-integration-installer" },
      });
      sourcePath = archivePath;
    }

    assertArtifactFileSize(sourcePath, maxArtifactBytes);
    const extracted = await extractIntegrationArtifactStream({
      source: createReadStream(sourcePath, { highWaterMark: 64 * 1024 }),
      destination: extractRoot,
      expectedSha256: opts.artifactSha256,
      maxArtifactBytes,
      maxExpandedBytes: maxArtifactBytes,
      signal: opts.signal ?? new AbortController().signal,
    });

    const stage = normalizeExtractedArtifactRoot(extractRoot, join(parent, `source-${token}`));
    if (sourcePath === archivePath) rmSync(archivePath, { force: true });
    return { directory: stage, archiveSha256: extracted.archiveSha256 };
  } catch (err) {
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
    throw err;
  }
}

function assertArtifactFileSize(path: string, maxBytes: number): void {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`Artifact size ${size} exceeds max ${maxBytes} bytes`);
  }
}

function normalizeExtractedArtifactRoot(extractRoot: string, promoted: string): string {
  if (existsSync(join(extractRoot, "manifest.json"))) return extractRoot;

  const entries = readdirSync(extractRoot, { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith("."),
  );
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (entries.length === 1 && dirs.length === 1) {
    const nested = join(extractRoot, dirs[0].name);
    if (existsSync(join(nested, "manifest.json"))) {
      renameSync(nested, promoted);
      rmSync(extractRoot, { recursive: true, force: true });
      return promoted;
    }
  }

  return extractRoot;
}

declare const preparationBrand: unique symbol;
declare const preparedBrand: unique symbol;
export type IntegrationArtifactPreparationContext = { readonly [preparationBrand]: true };
export type PreparedIntegrationArtifact = Readonly<{
  preparationId: string;
  id: string;
  version: string;
  contentDigest: string;
  archiveSha256: string | null;
  bytes: number;
  [preparedBrand]: true;
}>;
const inodeSchema = z.strictObject({
  dev: z.string().regex(/^[0-9]{1,32}$/),
  ino: z.string().regex(/^[0-9]{1,32}$/),
});
const preparationReceiptSchema = z.strictObject({
  version: z.literal(1),
  preparationId: z.uuid(),
  id: z.string().regex(INTEGRATION_ID_REGEX),
  integrationVersion: z.string().min(1).max(128),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  archiveSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  bytes: z.number().int().safe().nonnegative().max(DEFAULT_MAX_ARTIFACT_BYTES),
  workspace: inodeSchema,
  content: inodeSchema,
});
export type IntegrationPreparationReceipt = z.infer<typeof preparationReceiptSchema>;
interface PreparationState {
  rootDir: string;
  preparationId: string;
  workspace: { dev: string; ino: string };
  phase: "empty" | "preparing" | "prepared" | "published" | "discarded";
  receipt?: IntegrationPreparationReceipt;
  journal?: IntegrationPublicationJournal;
  manifest?: Record<string, unknown>;
}
const preparations = new WeakMap<IntegrationArtifactPreparationContext, PreparationState>();
const preparedHandles = new WeakMap<
  PreparedIntegrationArtifact,
  IntegrationArtifactPreparationContext
>();
function preparationState(context: IntegrationArtifactPreparationContext): PreparationState {
  const state = preparations.get(context);
  if (!state) throw Error("Unverified integration preparation context");
  return state;
}
/** Server-local descriptor ownership; this path never crosses an HTTP contract. */
export function describeIntegrationPreparationRoot(
  context: IntegrationArtifactPreparationContext,
): string {
  const state = preparationState(context);
  const workspace = checkedWorkspace(state);
  workspace.close();
  return state.rootDir;
}
function workspacePath(state: PreparationState): string {
  return join(stagingDir(state.rootDir), `preparation-${state.preparationId}`);
}
function checkedWorkspace(state: PreparationState): AnchoredDirectory {
  const directory = new AnchoredDirectory(workspacePath(state), undefined, true);
  if (
    String(directory.stat.dev) !== state.workspace.dev ||
    String(directory.stat.ino) !== state.workspace.ino
  ) {
    directory.close();
    throw Error("Integration preparation directory changed");
  }
  return directory;
}
export function createIntegrationArtifactPreparation(options: {
  rootDir: string;
}): IntegrationArtifactPreparationContext {
  const rootDir = resolve(options.rootDir);
  mkdirSync(customDir(rootDir), { recursive: true });
  const root = new AnchoredDirectory(customDir(rootDir));
  let staging: AnchoredDirectory | undefined, workspace: AnchoredDirectory | undefined;
  try {
    staging = root.directory(STAGING_DIR_NAME, true, false);
    const preparationId = randomUUID();
    workspace = staging.directory(`preparation-${preparationId}`, true, true);
    const context = Object.freeze({}) as IntegrationArtifactPreparationContext;
    preparations.set(context, {
      rootDir,
      preparationId,
      workspace: { dev: String(workspace.stat.dev), ino: String(workspace.stat.ino) },
      phase: "empty",
    });
    return context;
  } finally {
    workspace?.close();
    staging?.close();
    root.close();
  }
}
function validatePreparedIntegration(directory: string, rootDir: string): Record<string, unknown> {
  const manifest = readManifest(directory);
  if (!manifest || typeof manifest.id !== "string")
    throw Error("Source has no manifest.json with a string id");
  const validation = validateManifest(manifest);
  if (!validation.valid) throw Error(`Manifest validation failed: ${validation.errors.join("; ")}`);
  assertCompatibleManifestProtocol(manifest);
  assertSafeId(manifest.id);
  assertDoesNotShadowBuiltIn(rootDir, manifest.id);
  resolveLayerSelectorPreview(directory, manifest);
  assertNoExecutableCommunityCode(directory, manifest);
  validateDeclarativeArtifact(directory);
  validateArtifactMetadata(directory, manifest);
  return manifest;
}
function fingerprintPreparedDirectory(
  directory: string,
  signal: AbortSignal,
  strict = true,
): { contentDigest: string; bytes: number } {
  const root = new AnchoredDirectory(directory, undefined, strict);
  const hash = createHash("sha256");
  let bytes = 0,
    count = 0;
  const walk = (parent: AnchoredDirectory, prefix: string) => {
    for (const name of parent.listBounded(4096).sort()) {
      signal.throwIfAborted();
      if (++count > 4096) throw Error("Integration preparation entry limit exceeded");
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(parent.name(name), { bigint: true });
      if (stat.isDirectory()) {
        const child = parent.directory(name, false, strict);
        try {
          hash.update(JSON.stringify(["directory", path]));
          walk(child, path);
        } finally {
          child.close();
        }
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1n ||
          stat.uid !== BigInt(process.getuid?.() ?? -1) ||
          (stat.mode & BigInt(strict ? 0o077 : 0o022)) !== 0n
        )
          throw Error("Unsafe integration preparation member");
        bytes += Number(stat.size);
        if (!Number.isSafeInteger(bytes) || bytes > DEFAULT_MAX_ARTIFACT_BYTES)
          throw Error("Integration preparation exceeds 200 MiB");
        const fd = openSync(parent.name(name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
        try {
          const before = fstatSync(fd, { bigint: true });
          const fileHash = createHash("sha256"),
            buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            signal.throwIfAborted();
            const n = readSync(fd, buffer);
            if (!n) break;
            fileHash.update(buffer.subarray(0, n));
          }
          const after = fstatSync(fd, { bigint: true }),
            current = parent.fileIdentity(name, strict);
          if (
            before.dev !== stat.dev ||
            before.ino !== stat.ino ||
            before.size !== stat.size ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs ||
            String(after.dev) !== current.dev ||
            String(after.ino) !== current.ino
          )
            throw Error("Integration preparation changed during fingerprinting");
          hash.update(JSON.stringify(["file", path, Number(before.size), fileHash.digest("hex")]));
        } finally {
          closeSync(fd);
        }
      }
    }
    parent.check();
  };
  try {
    walk(root, "");
    return { contentDigest: hash.digest("hex"), bytes };
  } finally {
    root.close();
  }
}
function preparedHandle(
  context: IntegrationArtifactPreparationContext,
  receipt: IntegrationPreparationReceipt,
): PreparedIntegrationArtifact {
  const prepared = Object.freeze({
    preparationId: receipt.preparationId,
    id: receipt.id,
    version: receipt.integrationVersion,
    contentDigest: receipt.contentDigest,
    archiveSha256: receipt.archiveSha256,
    bytes: receipt.bytes,
  }) as PreparedIntegrationArtifact;
  preparedHandles.set(prepared, context);
  return prepared;
}
export async function prepareIntegrationArtifact(
  input: {
    source: AsyncIterable<Uint8Array>;
    expectedSha256: string;
    maxArtifactBytes: number;
    maxExpandedBytes: number;
    signal: AbortSignal;
  },
  context: IntegrationArtifactPreparationContext,
): Promise<PreparedIntegrationArtifact> {
  const state = preparationState(context);
  if (state.phase !== "empty") throw Error("Integration preparation already used");
  if (
    !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
    !Number.isSafeInteger(input.maxArtifactBytes) ||
    input.maxArtifactBytes <= 0 ||
    input.maxArtifactBytes > DEFAULT_MAX_ARTIFACT_BYTES ||
    !Number.isSafeInteger(input.maxExpandedBytes) ||
    input.maxExpandedBytes <= 0 ||
    input.maxExpandedBytes > DEFAULT_MAX_ARTIFACT_BYTES
  )
    throw Error("Invalid integration preparation limits");
  const workspace = checkedWorkspace(state);
  state.phase = "preparing";
  try {
    const payload = workspace.directory("payload", true, true);
    payload.close();
    const output = await extractIntegrationArtifactStream({
      source: input.source,
      destination: join(workspacePath(state), "payload"),
      expectedSha256: input.expectedSha256,
      maxArtifactBytes: input.maxArtifactBytes,
      maxExpandedBytes: input.maxExpandedBytes,
      signal: input.signal,
    });
    workspace.check();
    const content = join(workspacePath(state), "content");
    const normalized = normalizeExtractedArtifactRoot(
      join(workspacePath(state), "payload"),
      content,
    );
    if (normalized !== content) renameSync(normalized, content);
    return finishIntegrationPreparation(context, output.archiveSha256, input.signal);
  } catch (error) {
    discardIntegrationPreparation(context);
    throw error;
  } finally {
    workspace.close();
  }
}
/** HTTPS/redirect/public-network checks and byte cap are enforced by the shared downloader. */
export async function prepareRemoteIntegrationArtifact(
  input: { url: string; sha256: string; signal: AbortSignal },
  context: IntegrationArtifactPreparationContext,
): Promise<PreparedIntegrationArtifact> {
  const state = preparationState(context);
  if (state.phase !== "empty") throw Error("Integration preparation already used");
  const workspace = checkedWorkspace(state);
  try {
    const file = workspace.name("download.tar.gz");
    await safeDownload({
      url: new URL(input.url),
      destination: file,
      maxBytes: DEFAULT_MAX_ARTIFACT_BYTES,
      timeoutMs: 5 * 60000,
      allowedContentTypes: [],
      credentialPolicy: "none",
      signal: input.signal,
    });
    const source = createReadStream(file, { highWaterMark: 64 * 1024, signal: input.signal });
    try {
      return await prepareIntegrationArtifact(
        {
          source,
          expectedSha256: input.sha256,
          maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES,
          maxExpandedBytes: DEFAULT_MAX_ARTIFACT_BYTES,
          signal: input.signal,
        },
        context,
      );
    } finally {
      source.destroy();
    }
  } finally {
    workspace.close();
  }
}
function finishIntegrationPreparation(
  context: IntegrationArtifactPreparationContext,
  archiveSha256: string | null,
  signal: AbortSignal,
): PreparedIntegrationArtifact {
  const state = preparationState(context);
  const workspace = checkedWorkspace(state);
  try {
    const content = join(workspacePath(state), "content");
    const manifest = validatePreparedIntegration(content, state.rootDir);
    const proof = fingerprintPreparedDirectory(content, signal);
    const directory = workspace.directory("content", false, true);
    try {
      const receipt = preparationReceiptSchema.parse({
        version: 1,
        preparationId: state.preparationId,
        id: manifest.id,
        integrationVersion: manifest.version,
        contentDigest: proof.contentDigest,
        archiveSha256,
        bytes: proof.bytes,
        workspace: state.workspace,
        content: { dev: String(directory.stat.dev), ino: String(directory.stat.ino) },
      });
      state.receipt = receipt;
      state.manifest = structuredClone(manifest);
      state.phase = "prepared";
      return preparedHandle(context, receipt);
    } finally {
      directory.close();
    }
  } finally {
    workspace.close();
  }
}
function privatizeIntegrationDirectory(root: string, signal: AbortSignal): void {
  let entries = 0,
    bytes = 0;
  const walk = (directory: string) => {
    signal.throwIfAborted();
    const stat = lstatSync(directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1)
    )
      throw Error("Unsafe integration preparation directory");
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      if (++entries > 4096) throw Error("Integration preparation entry limit exceeded");
      const path = join(directory, name),
        member = lstatSync(path, { bigint: true });
      if (member.isDirectory()) walk(path);
      else if (
        member.isFile() &&
        member.nlink === 1n &&
        member.uid === BigInt(process.getuid?.() ?? -1)
      ) {
        bytes += Number(member.size);
        if (!Number.isSafeInteger(bytes) || bytes > DEFAULT_MAX_ARTIFACT_BYTES)
          throw Error("Integration source exceeds 200 MiB");
        chmodSync(path, 0o600);
      } else throw Error("Integration source contains a link or unsupported entry");
    }
  };
  walk(root);
}

/** Resolve a bounded allowlisted repository exactly once, retaining its immutable commit. */
export async function prepareIntegrationSource(
  input: { repository: string; ref?: string; signal: AbortSignal },
  context: IntegrationArtifactPreparationContext,
): Promise<{ prepared: PreparedIntegrationArtifact; repository: string; commit: string }> {
  const state = preparationState(context);
  if (state.phase !== "empty") throw Error("Integration preparation already used");
  state.phase = "preparing";
  const workspace = checkedWorkspace(state);
  try {
    const snapshot = await gitShallowCloneSnapshot({
      url: input.repository,
      ref: input.ref,
      targetDir: workspace.name("content"),
      signal: input.signal,
    });
    if (!/^[a-f0-9]{40}$/.test(snapshot.commit)) throw Error("Invalid resolved integration commit");
    privatizeIntegrationDirectory(workspace.name("content"), input.signal);
    const prepared = finishIntegrationPreparation(context, null, input.signal);
    return { prepared, repository: snapshot.canonicalUrl, commit: snapshot.commit };
  } catch (error) {
    discardIntegrationPreparation(context);
    throw error;
  } finally {
    workspace.close();
  }
}

export function describePreparedIntegration(
  prepared: PreparedIntegrationArtifact,
): IntegrationPreparationReceipt {
  const context = preparedHandles.get(prepared);
  if (!context) throw Error("Unverified prepared integration");
  const state = preparationState(context);
  if (state.phase !== "prepared" || !state.receipt)
    throw Error("Integration preparation is not available");
  return structuredClone(state.receipt);
}
export async function restorePreparedIntegration(options: {
  rootDir: string;
  receipt: unknown;
  signal: AbortSignal;
}): Promise<PreparedIntegrationArtifact> {
  const receipt = preparationReceiptSchema.parse(options.receipt);
  const state: PreparationState = {
    rootDir: resolve(options.rootDir),
    preparationId: receipt.preparationId,
    workspace: receipt.workspace,
    phase: "prepared",
    receipt,
  };
  const directory = checkedWorkspace(state);
  try {
    const content = directory.directory("content", false, true);
    try {
      if (
        String(content.stat.dev) !== receipt.content.dev ||
        String(content.stat.ino) !== receipt.content.ino
      )
        throw Error("Prepared integration content directory changed");
    } finally {
      content.close();
    }
    const path = join(workspacePath(state), "content");
    const proof = fingerprintPreparedDirectory(path, options.signal);
    if (proof.contentDigest !== receipt.contentDigest || proof.bytes !== receipt.bytes)
      throw Error("Prepared integration content changed");
    const manifest = validatePreparedIntegration(path, state.rootDir);
    if (manifest.id !== receipt.id || manifest.version !== receipt.integrationVersion)
      throw Error("Prepared integration manifest changed");
    state.manifest = structuredClone(manifest);
    const context = Object.freeze({}) as IntegrationArtifactPreparationContext;
    preparations.set(context, state);
    return preparedHandle(context, receipt);
  } finally {
    directory.close();
  }
}
export function discardIntegrationPreparation(
  context: IntegrationArtifactPreparationContext,
): void {
  const state = preparationState(context);
  if (state.phase === "discarded") return;
  if (state.phase === "published")
    throw Error("Published integration requires transaction settlement");
  const directory = checkedWorkspace(state);
  try {
    directory.check();
    rmSync(workspacePath(state), { recursive: true, force: false });
    state.phase = "discarded";
  } finally {
    directory.close();
  }
}

declare const componentLockBrand: unique symbol;
export type IntegrationComponentLock = { readonly [componentLockBrand]: true };
interface ComponentLockState {
  rootDir: string;
  id: string;
  transactionId: string;
  identity: { dev: string; ino: string };
}
const componentLocks = new WeakMap<IntegrationComponentLock, ComponentLockState>();
function componentLockDirectory(state: ComponentLockState): {
  root: AnchoredDirectory;
  locks: AnchoredDirectory;
  directory: AnchoredDirectory;
} {
  const root = new AnchoredDirectory(customDir(state.rootDir));
  let locks: AnchoredDirectory | undefined, directory: AnchoredDirectory | undefined;
  try {
    locks = root.directory(".installation-locks", false, true);
    directory = locks.directory(state.id, false, true);
    const owner = z
      .strictObject({ version: z.literal(1), transactionId: z.uuid() })
      .parse(JSON.parse(directory.read("owner.json", 2048).toString("utf8")));
    if (
      owner.transactionId !== state.transactionId ||
      String(directory.stat.dev) !== state.identity.dev ||
      String(directory.stat.ino) !== state.identity.ino ||
      directory.listBounded(2).length !== 1
    )
      throw Error("Integration component lock ownership changed");
    return { root, locks, directory };
  } catch (error) {
    directory?.close();
    locks?.close();
    root.close();
    throw error;
  }
}
export function acquireIntegrationComponentLock(options: {
  rootDir: string;
  id: string;
  transactionId?: string;
}): IntegrationComponentLock {
  assertSafeId(options.id);
  const transactionId = z.uuid().parse(options.transactionId ?? randomUUID());
  mkdirSync(customDir(options.rootDir), { recursive: true });
  const root = new AnchoredDirectory(customDir(options.rootDir));
  let locks: AnchoredDirectory | undefined, directory: AnchoredDirectory | undefined;
  try {
    locks = root.directory(".installation-locks", true, true);
    try {
      mkdirSync(locks.name(options.id), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Error("Integration component is busy; reconcile its original transaction");
      throw error;
    }
    fsyncSync(locks.fd);
    directory = locks.directory(options.id, false, true);
    directory.write("owner.json", JSON.stringify({ version: 1, transactionId }), true);
    const lock = Object.freeze({}) as IntegrationComponentLock;
    componentLocks.set(lock, {
      rootDir: options.rootDir,
      id: options.id,
      transactionId,
      identity: { dev: String(directory.stat.dev), ino: String(directory.stat.ino) },
    });
    return lock;
  } finally {
    directory?.close();
    locks?.close();
    root.close();
  }
}
export function releaseIntegrationComponentLock(lock: IntegrationComponentLock): void {
  const state = componentLocks.get(lock);
  if (!state) throw Error("Unverified integration component lock");
  const opened = componentLockDirectory(state);
  try {
    opened.directory.removeFile("owner.json");
    opened.directory.close();
    opened.locks.removeDirectory(state.id, state.identity);
    componentLocks.delete(lock);
  } finally {
    opened.directory.close();
    opened.locks.close();
    opened.root.close();
  }
}
function restoreComponentLock(state: ComponentLockState): IntegrationComponentLock {
  const opened = componentLockDirectory(state);
  opened.directory.close();
  opened.locks.close();
  opened.root.close();
  const lock = Object.freeze({}) as IntegrationComponentLock;
  componentLocks.set(lock, state);
  return lock;
}
/** Server-local receipt; HTTP callers cannot choose lock identities or paths. */
export function describeIntegrationComponentLock(
  lock: IntegrationComponentLock,
): ComponentLockState {
  const state = componentLocks.get(lock);
  if (!state) throw Error("Unverified integration component lock");
  const opened = componentLockDirectory(state);
  opened.directory.close();
  opened.locks.close();
  opened.root.close();
  return structuredClone(state);
}
export function restoreIntegrationComponentLock(
  state: ComponentLockState,
): IntegrationComponentLock {
  return restoreComponentLock(state);
}
export function inspectOptionalLockedIntegrationComponent(
  lock: IntegrationComponentLock,
  signal: AbortSignal,
) {
  const state = describeIntegrationComponentLock(lock);
  try {
    lstatSync(resolveInstallTarget(state.rootDir, state.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return inspectLockedIntegrationComponent(lock, signal);
}
export function inspectLockedIntegrationComponent(
  lock: IntegrationComponentLock,
  signal: AbortSignal,
): { contentDigest: string; version: string; identity: { dev: string; ino: string } } {
  const state = describeIntegrationComponentLock(lock);
  const fingerprint = currentIntegrationFingerprint(state.rootDir, state.id, signal);
  if (!fingerprint) throw Error("Integration directory is missing");
  const manifest = validatePreparedIntegration(
    resolveInstallTarget(state.rootDir, state.id),
    state.rootDir,
  );
  if (manifest.id !== state.id) throw Error("Integration directory and manifest identity differ");
  describeIntegrationComponentLock(lock);
  return { ...fingerprint, version: String(manifest.version) };
}
export function inspectDeclarativeIntegrationDirectory(
  directory: string,
  rootDir: string,
  signal: AbortSignal,
) {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe integration directory");
  const manifest = validatePreparedIntegration(directory, rootDir),
    value = fingerprintPreparedDirectory(directory, signal, false),
    after = lstatSync(directory, { bigint: true });
  if (stat.dev !== after.dev || stat.ino !== after.ino)
    throw Error("Integration directory changed");
  return {
    ...value,
    id: String(manifest.id),
    version: String(manifest.version),
    identity: { dev: String(stat.dev), ino: String(stat.ino) },
  };
}
/** Finish only the original terminal lock; a later writer is never released. */
export function finishIntegrationComponentLock(state: ComponentLockState): void {
  const root = new AnchoredDirectory(customDir(state.rootDir));
  let locks: AnchoredDirectory | undefined, directory: AnchoredDirectory | undefined;
  try {
    locks = root.directory(".installation-locks", false, true);
    try {
      directory = locks.directory(state.id, false, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      String(directory.stat.dev) !== state.identity.dev ||
      String(directory.stat.ino) !== state.identity.ino
    )
      return;
    if (directory.listBounded(2).length === 0) {
      directory.close();
      locks.removeDirectory(state.id, state.identity);
      return;
    }
  } finally {
    directory?.close();
    locks?.close();
    root.close();
  }
  releaseIntegrationComponentLock(restoreComponentLock(state));
}
function currentIntegrationFingerprint(
  rootDir: string,
  id: string,
  signal: AbortSignal,
): { contentDigest: string; identity: { dev: string; ino: string } } | null {
  const target = resolveInstallTarget(rootDir, id);
  let stat: import("node:fs").BigIntStats;
  try {
    stat = lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Integration destination is not a regular owned directory");
  const fingerprint = fingerprintPreparedDirectory(target, signal, false);
  const after = lstatSync(target, { bigint: true });
  if (after.dev !== stat.dev || after.ino !== stat.ino)
    throw Error("Integration destination changed during inspection");
  return {
    contentDigest: fingerprint.contentDigest,
    identity: { dev: String(stat.dev), ino: String(stat.ino) },
  };
}
export function inspectInstalledIntegrationFingerprint(options: {
  rootDir: string;
  id: string;
  signal: AbortSignal;
}): { contentDigest: string; identity: { dev: string; ino: string } } | null {
  const lock = acquireIntegrationComponentLock(options);
  try {
    return currentIntegrationFingerprint(options.rootDir, options.id, options.signal);
  } finally {
    releaseIntegrationComponentLock(lock);
  }
}
const publicationSchema = z.strictObject({
  version: z.literal(1),
  transactionId: z.uuid(),
  integrationId: z.string().regex(INTEGRATION_ID_REGEX),
  preparation: preparationReceiptSchema,
  previousContentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  previousIdentity: inodeSchema.nullable(),
  lockIdentity: inodeSchema,
  outcome: z.enum([
    "prepared",
    "previous-moved",
    "published",
    "commit-requested",
    "committed",
    "restore-requested",
    "restored",
  ]),
});
export type IntegrationPublicationReceipt = z.infer<typeof publicationSchema>;
export const integrationPublicationReceiptSchema = publicationSchema;
export const integrationPreparationReceiptSchema = preparationReceiptSchema;
declare const publicationJournalBrand: unique symbol;
export type IntegrationPublicationJournal = Readonly<{ [publicationJournalBrand]: true }>;
const publicationJournals = new WeakMap<
  IntegrationPublicationJournal,
  {
    directory: AnchoredDirectory;
    coordination: AnchoredDirectory;
    key: Buffer;
    transactionId: string;
    closed: boolean;
  }
>();
/** Server-local purpose store descriptor. No filesystem path or key is accepted over HTTP. */
export function createIntegrationPublicationJournal(input: {
  directory: AnchoredDirectory;
  coordination: AnchoredDirectory;
  key: Uint8Array;
  transactionId: string;
}): IntegrationPublicationJournal {
  z.uuid().parse(input.transactionId);
  input.directory.check();
  if (input.key.byteLength !== 32) throw Error("Invalid integration journal authentication key");
  const handle = Object.freeze({}) as IntegrationPublicationJournal;
  publicationJournals.set(handle, {
    directory: input.directory,
    coordination: input.coordination,
    key: Buffer.from(input.key),
    transactionId: input.transactionId,
    closed: false,
  });
  return handle;
}
export function closeIntegrationPublicationJournal(handle: IntegrationPublicationJournal): void {
  const journal = publicationJournals.get(handle);
  if (!journal) throw Error("Unverified integration publication journal");
  journal.closed = true;
  journal.key.fill(0);
}
function publicationJournal(handle: IntegrationPublicationJournal) {
  const journal = publicationJournals.get(handle);
  if (!journal || journal.closed) throw Error("Integration publication journal is unavailable");
  journal.directory.check();
  return journal;
}
function readPublicationRecord(state: PreparationState): IntegrationPublicationReceipt {
  if (state.journal) {
    const journal = publicationJournal(state.journal);
    const saved = z
      .strictObject({ body: z.string().max(16384), mac: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(
        JSON.parse(
          journal.directory
            .read(`publication-${journal.transactionId}.json`, 32768)
            .toString("utf8"),
        ),
      );
    const expected = createHmac("sha256", journal.key)
      .update("openmapx-integration-publication-v1\0")
      .update(saved.body)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(saved.mac, "hex")))
      throw Error("Integration publication journal authentication failed");
    const receipt = publicationSchema.parse(JSON.parse(saved.body));
    if (receipt.transactionId !== journal.transactionId)
      throw Error("Integration publication journal identity changed");
    return receipt;
  }
  const directory = checkedWorkspace(state);
  try {
    return publicationSchema.parse(
      JSON.parse(directory.read("publication.json", 16384).toString("utf8")),
    );
  } finally {
    directory.close();
  }
}
declare const publicationBrand: unique symbol;
export type IntegrationPublication = { readonly [publicationBrand]: true };
const publications = new WeakMap<
  IntegrationPublication,
  {
    context: IntegrationArtifactPreparationContext;
    lock: IntegrationComponentLock | null;
    receipt: IntegrationPublicationReceipt;
  }
>();
function publicationState(handle: IntegrationPublication) {
  const state = publications.get(handle);
  if (!state) throw Error("Unverified integration publication");
  return state;
}
export function assertIntegrationPublicationJournal(
  publication: IntegrationPublication,
  journal: IntegrationPublicationJournal,
): void {
  if (preparationState(publicationState(publication).context).journal !== journal)
    throw Error("Integration publication is not owned by its authenticated purpose journal");
  publicationJournal(journal);
}
function writePublication(
  context: IntegrationArtifactPreparationContext,
  receipt: IntegrationPublicationReceipt,
  exclusive = false,
) {
  const state = preparationState(context),
    directory = checkedWorkspace(state);
  try {
    const body = JSON.stringify(publicationSchema.parse(receipt));
    if (state.journal) {
      const journal = publicationJournal(state.journal);
      if (journal.transactionId !== receipt.transactionId)
        throw Error("Integration publication journal transaction mismatch");
      let guard: AnchoredDirectory | undefined;
      try {
        mkdirSync(journal.coordination.name("writer"), { mode: 0o700 });
        guard = journal.coordination.directory("writer", false, true);
        const name = `publication-${receipt.transactionId}.json`;
        if (exclusive && journal.directory.listBounded(2049).length >= 2048)
          throw Error("Integration purpose journal capacity reached");
        journal.directory.write(
          name,
          JSON.stringify({
            body,
            mac: createHmac("sha256", journal.key)
              .update("openmapx-integration-publication-v1\0")
              .update(body)
              .digest("hex"),
          }),
          exclusive,
        );
      } finally {
        if (guard) {
          const identity = { dev: String(guard.stat.dev), ino: String(guard.stat.ino) };
          guard.close();
          journal.coordination.removeDirectory("writer", identity);
        }
      }
    }
    directory.write("publication.json", body);
  } finally {
    directory.close();
  }
}
function sameDirectory(a: { dev: string; ino: string }, b: { dev: string; ino: string }) {
  return a.dev === b.dev && a.ino === b.ino;
}
function requirePublishedTarget(state: ReturnType<typeof publicationState>, signal: AbortSignal) {
  const value = currentIntegrationFingerprint(
    preparationState(state.context).rootDir,
    state.receipt.integrationId,
    signal,
  );
  if (
    !value ||
    value.contentDigest !== state.receipt.preparation.contentDigest ||
    !sameDirectory(value.identity, state.receipt.preparation.content)
  )
    throw Error("Published integration changed; preserve original transaction");
}
function loadPublication(state: ReturnType<typeof publicationState>) {
  const saved = readPublicationRecord(preparationState(state.context));
  const { outcome: _old, ...old } = state.receipt,
    { outcome: _new, ...current } = saved;
  if (JSON.stringify(old) !== JSON.stringify(current))
    throw Error("Integration publication journal changed");
  state.receipt = saved;
  return saved;
}

export async function publishPreparedIntegration(
  prepared: PreparedIntegrationArtifact,
  input: {
    transactionId: string;
    expectedPreviousContentDigest: string | null;
    expectedPreviousIdentity?: { dev: string; ino: string } | null;
    beforePublish?: (receipt: IntegrationPublicationReceipt) => void;
    journal?: IntegrationPublicationJournal;
    signal: AbortSignal;
  },
): Promise<IntegrationPublication> {
  z.uuid().parse(input.transactionId);
  const context = preparedHandles.get(prepared);
  if (!context) throw Error("Unverified prepared integration");
  const state = preparationState(context);
  if (state.phase !== "prepared" || !state.receipt)
    throw Error("Integration preparation unavailable");
  await restorePreparedIntegration({
    rootDir: state.rootDir,
    receipt: state.receipt,
    signal: input.signal,
  });
  const lock = acquireIntegrationComponentLock({
    rootDir: state.rootDir,
    id: prepared.id,
    transactionId: input.transactionId,
  });
  state.journal = input.journal;
  let effectStarted = false;
  let receipt: IntegrationPublicationReceipt | undefined;
  try {
    const previous = currentIntegrationFingerprint(state.rootDir, prepared.id, input.signal);
    if ((previous?.contentDigest ?? null) !== input.expectedPreviousContentDigest)
      throw Error("Integration destination changed since inspection");
    if (
      input.expectedPreviousIdentity !== undefined &&
      (previous
        ? !input.expectedPreviousIdentity ||
          !sameDirectory(previous.identity, input.expectedPreviousIdentity)
        : input.expectedPreviousIdentity !== null)
    )
      throw Error("Integration destination identity changed since inspection");
    const lockState = componentLocks.get(lock)!;
    receipt = {
      version: 1,
      transactionId: input.transactionId,
      integrationId: prepared.id,
      preparation: state.receipt,
      previousContentDigest: previous?.contentDigest ?? null,
      previousIdentity: previous?.identity ?? null,
      lockIdentity: lockState.identity,
      outcome: "prepared",
    };
    writePublication(context, receipt, true);
    input.beforePublish?.(structuredClone(receipt));
    input.signal.throwIfAborted();
    const workspace = checkedWorkspace(state);
    try {
      const target = resolveInstallTarget(state.rootDir, prepared.id);
      state.phase = "published";
      effectStarted = true;
      if (previous) {
        renameSync(target, workspace.name("previous"));
        fsyncSync(workspace.fd);
        const root = new AnchoredDirectory(customDir(state.rootDir));
        try {
          fsyncSync(root.fd);
        } finally {
          root.close();
        }
        receipt.outcome = "previous-moved";
        writePublication(context, receipt);
      }
      renameSync(workspace.name("content"), target);
      fsyncSync(workspace.fd);
      const root = new AnchoredDirectory(customDir(state.rootDir));
      try {
        fsyncSync(root.fd);
      } finally {
        root.close();
      }
      receipt.outcome = "published";
      writePublication(context, receipt);
      const handle = Object.freeze({}) as IntegrationPublication;
      publications.set(handle, { context, lock, receipt });
      requirePublishedTarget(publicationState(handle), new AbortController().signal);
      return handle;
    } finally {
      workspace.close();
    }
  } catch (error) {
    if (!effectStarted) {
      if (receipt) {
        const previous = currentIntegrationFingerprint(
          state.rootDir,
          prepared.id,
          new AbortController().signal,
        );
        if (
          (previous?.contentDigest ?? null) !== receipt.previousContentDigest ||
          (previous &&
            (!receipt.previousIdentity ||
              !sameDirectory(previous.identity, receipt.previousIdentity)))
        )
          throw Error("Integration pre-publication failure requires reconciliation", {
            cause: error,
          });
        receipt.outcome = "restored";
        writePublication(context, receipt);
        state.phase = "published";
      }
      releaseIntegrationComponentLock(lock);
    }
    throw error;
  }
}
export function describeIntegrationPublication(
  handle: IntegrationPublication,
): IntegrationPublicationReceipt {
  return structuredClone(loadPublication(publicationState(handle)));
}
/** Read only the fixed journal belonging to an already retained preparation. */
export function inspectIntegrationPublication(options: {
  rootDir: string;
  preparation: IntegrationPreparationReceipt;
  transactionId: string;
  journal?: IntegrationPublicationJournal;
}): IntegrationPublicationReceipt {
  const preparation = preparationReceiptSchema.parse(options.preparation);
  const state: PreparationState = {
    rootDir: resolve(options.rootDir),
    preparationId: preparation.preparationId,
    workspace: preparation.workspace,
    phase: "published",
    receipt: preparation,
    journal: options.journal,
  };
  const directory = checkedWorkspace(state);
  try {
    const receipt = readPublicationRecord(state);
    if (
      receipt.transactionId !== options.transactionId ||
      JSON.stringify(receipt.preparation) !== JSON.stringify(preparation)
    )
      throw Error("Integration publication does not belong to its original preparation");
    return receipt;
  } finally {
    directory.close();
  }
}
export async function restoreIntegrationPublication(options: {
  rootDir: string;
  receipt: IntegrationPublicationReceipt;
  signal: AbortSignal;
  journal?: IntegrationPublicationJournal;
}): Promise<IntegrationPublication> {
  const receipt = publicationSchema.parse(options.receipt);
  const context = Object.freeze({}) as IntegrationArtifactPreparationContext;
  preparations.set(context, {
    rootDir: resolve(options.rootDir),
    preparationId: receipt.preparation.preparationId,
    workspace: receipt.preparation.workspace,
    phase: "published",
    receipt: receipt.preparation,
    journal: options.journal,
  });
  const handle = Object.freeze({}) as IntegrationPublication;
  publications.set(handle, { context, lock: null, receipt });
  const actual = loadPublication(publicationState(handle));
  const terminal = actual.outcome === "committed" || actual.outcome === "restored";
  const lockState = {
    rootDir: options.rootDir,
    id: receipt.integrationId,
    transactionId: receipt.transactionId,
    identity: receipt.lockIdentity,
  };
  if (!terminal) publicationState(handle).lock = restoreComponentLock(lockState);
  else {
    const path = join(customDir(options.rootDir), ".installation-locks", receipt.integrationId);
    let identity: import("node:fs").BigIntStats | null = null;
    try {
      identity = lstatSync(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      identity &&
      sameDirectory({ dev: String(identity.dev), ino: String(identity.ino) }, receipt.lockIdentity)
    ) {
      const root = new AnchoredDirectory(customDir(options.rootDir));
      let locks: AnchoredDirectory | undefined, directory: AnchoredDirectory | undefined;
      try {
        locks = root.directory(".installation-locks", false, true);
        directory = locks.directory(receipt.integrationId, false, true);
        if (
          !sameDirectory(
            { dev: String(directory.stat.dev), ino: String(directory.stat.ino) },
            receipt.lockIdentity,
          )
        )
          throw Error("Original integration lock changed");
        if (directory.listBounded(2).length === 0) {
          directory.close();
          locks.removeDirectory(receipt.integrationId, receipt.lockIdentity);
        } else publicationState(handle).lock = restoreComponentLock(lockState);
      } finally {
        directory?.close();
        locks?.close();
        root.close();
      }
    }
  }
  if (["published", "commit-requested"].includes(actual.outcome))
    requirePublishedTarget(publicationState(handle), options.signal);
  return handle;
}
export async function settleIntegrationPublication(
  handle: IntegrationPublication,
  decision: "commit" | "restore",
  signal: AbortSignal,
): Promise<{ outcome: "committed" | "restored"; contentDigest: string | null }> {
  const state = publicationState(handle),
    receipt = loadPublication(state),
    preparation = preparationState(state.context);
  const terminal = receipt.outcome === "committed" || receipt.outcome === "restored";
  if (terminal && (decision === "commit") !== (receipt.outcome === "committed"))
    throw Error("Integration transaction already settled with a different decision");
  if (!terminal && !state.lock)
    throw Error("Integration transaction has no original component lock");
  const workspace = checkedWorkspace(preparation);
  let guard: AnchoredDirectory | undefined;
  try {
    try {
      mkdirSync(workspace.name("settlement-writer"), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Error("Integration settlement is busy");
      throw error;
    }
    guard = workspace.directory("settlement-writer");
    const target = resolveInstallTarget(preparation.rootDir, receipt.integrationId);
    const removeOwned = (
      name: string,
      expected: { dev: string; ino: string },
      expectedDigest: string | null,
      verifyDigest: boolean,
    ) => {
      let current: import("node:fs").BigIntStats;
      try {
        current = lstatSync(workspace.name(name), { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        !current.isDirectory() ||
        String(current.dev) !== expected.dev ||
        String(current.ino) !== expected.ino
      )
        throw Error("Integration transaction directory changed");
      if (
        verifyDigest &&
        fingerprintPreparedDirectory(workspace.name(name), signal, false).contentDigest !==
          expectedDigest
      )
        throw Error("Integration transaction bytes changed");
      rmSync(workspace.name(name), { recursive: true, force: false });
      fsyncSync(workspace.fd);
    };
    if (terminal) {
      if (receipt.outcome === "restored") {
        removeOwned(
          "rejected",
          receipt.preparation.content,
          receipt.preparation.contentDigest,
          false,
        );
        removeOwned(
          "content",
          receipt.preparation.content,
          receipt.preparation.contentDigest,
          false,
        );
      }
      if (state.lock) {
        releaseIntegrationComponentLock(state.lock!);
        state.lock = null;
      }
      return {
        outcome: receipt.outcome as "committed" | "restored",
        contentDigest:
          receipt.outcome === "committed"
            ? receipt.preparation.contentDigest
            : receipt.previousContentDigest,
      };
    }
    if (decision === "commit") {
      if (receipt.outcome === "restore-requested")
        throw Error("Integration transaction was restored");
      requirePublishedTarget(state, signal);
      const wasRequested = receipt.outcome === "commit-requested";
      receipt.outcome = "commit-requested";
      writePublication(state.context, receipt);
      if (receipt.previousIdentity)
        removeOwned(
          "previous",
          receipt.previousIdentity,
          receipt.previousContentDigest,
          !wasRequested,
        );
      receipt.outcome = "committed";
      writePublication(state.context, receipt);
      releaseIntegrationComponentLock(state.lock!);
      state.lock = null;
      return { outcome: "committed", contentDigest: receipt.preparation.contentDigest };
    }
    if (receipt.outcome === "commit-requested")
      throw Error("Integration transaction was committed");
    {
      if (receipt.outcome !== "restore-requested") {
        if (receipt.outcome === "prepared" || receipt.outcome === "previous-moved") {
          const current = currentIntegrationFingerprint(
            preparation.rootDir,
            receipt.integrationId,
            signal,
          );
          const newTarget =
            current &&
            sameDirectory(current.identity, receipt.preparation.content) &&
            current.contentDigest === receipt.preparation.contentDigest;
          if (!newTarget) {
            if (
              current &&
              (!receipt.previousIdentity ||
                !sameDirectory(current.identity, receipt.previousIdentity) ||
                current.contentDigest !== receipt.previousContentDigest)
            )
              throw Error("Integration destination changed before restoration");
            const original = workspace.directory("content", false, true);
            try {
              if (
                !sameDirectory(
                  { dev: String(original.stat.dev), ino: String(original.stat.ino) },
                  receipt.preparation.content,
                ) ||
                fingerprintPreparedDirectory(workspace.name("content"), signal).contentDigest !==
                  receipt.preparation.contentDigest
              )
                throw Error("Prepared integration changed before restoration");
            } finally {
              original.close();
            }
          }
        } else requirePublishedTarget(state, signal);
        receipt.outcome = "restore-requested";
        writePublication(state.context, receipt);
      }
      const current = currentIntegrationFingerprint(
        preparation.rootDir,
        receipt.integrationId,
        signal,
      );
      if (
        current &&
        sameDirectory(current.identity, receipt.preparation.content) &&
        current.contentDigest === receipt.preparation.contentDigest
      ) {
        renameSync(target, workspace.name("rejected"));
        fsyncSync(workspace.fd);
      } else if (
        current &&
        (!receipt.previousIdentity ||
          !sameDirectory(current.identity, receipt.previousIdentity) ||
          current.contentDigest !== receipt.previousContentDigest)
      )
        throw Error("Integration destination changed during restore");
      const after = currentIntegrationFingerprint(
        preparation.rootDir,
        receipt.integrationId,
        signal,
      );
      if (!after && receipt.previousIdentity) {
        const previous = workspace.directory("previous", false, false);
        try {
          if (
            String(previous.stat.dev) !== receipt.previousIdentity.dev ||
            String(previous.stat.ino) !== receipt.previousIdentity.ino ||
            fingerprintPreparedDirectory(workspace.name("previous"), signal, false)
              .contentDigest !== receipt.previousContentDigest
          )
            throw Error("Original integration backup changed");
        } finally {
          previous.close();
        }
        renameSync(workspace.name("previous"), target);
        fsyncSync(workspace.fd);
      }
      const restored = currentIntegrationFingerprint(
        preparation.rootDir,
        receipt.integrationId,
        signal,
      );
      if (
        (restored?.contentDigest ?? null) !== receipt.previousContentDigest ||
        (restored &&
          receipt.previousIdentity &&
          !sameDirectory(restored.identity, receipt.previousIdentity))
      )
        throw Error("Integration restoration is not proven");
      const root = new AnchoredDirectory(customDir(preparation.rootDir));
      try {
        fsyncSync(root.fd);
      } finally {
        root.close();
      }
      receipt.outcome = "restored";
      writePublication(state.context, receipt);
    }
    removeOwned("rejected", receipt.preparation.content, receipt.preparation.contentDigest, false);
    removeOwned("content", receipt.preparation.content, receipt.preparation.contentDigest, false);
    releaseIntegrationComponentLock(state.lock!);
    state.lock = null;
    return { outcome: "restored", contentDigest: receipt.previousContentDigest };
  } finally {
    if (guard) {
      const identity = { dev: String(guard.stat.dev), ino: String(guard.stat.ino) };
      guard.close();
      workspace.removeDirectory("settlement-writer", identity);
    }
    workspace.close();
  }
}

export interface RemoveOptions {
  rootDir: string;
  id: string;
}

export interface IntegrationRollbackBackup {
  id: string;
  backupDirectory: string;
}

function validateIntegrationRollbackBackup(
  rootDir: string,
  backup: IntegrationRollbackBackup,
): { target: string; backupDirectory: string } {
  const target = resolveInstallTarget(rootDir, backup.id);
  const parent = resolve(customDir(rootDir));
  const backupDirectory = resolve(backup.backupDirectory);
  const expectedPrefix = `.rollback-integration-${backup.id}-`;
  if (
    dirname(backupDirectory) !== parent ||
    !basename(backupDirectory).startsWith(expectedPrefix) ||
    !/^[a-f0-9]{12}$/.test(basename(backupDirectory).slice(expectedPrefix.length))
  ) {
    throw new Error("Invalid integration rollback backup path");
  }
  return { target, backupDirectory };
}

export function backupInstalledIntegration(
  rootDir: string,
  id: string,
): IntegrationRollbackBackup | null {
  const lock = acquireIntegrationComponentLock({ rootDir, id });
  try {
    return backupInstalledIntegrationUnlocked(rootDir, id);
  } finally {
    releaseIntegrationComponentLock(lock);
  }
}
export function restoreInstalledIntegration(
  rootDir: string,
  backup: IntegrationRollbackBackup,
): void {
  const lock = acquireIntegrationComponentLock({ rootDir, id: backup.id });
  try {
    restoreInstalledIntegrationUnlocked(rootDir, backup);
  } finally {
    releaseIntegrationComponentLock(lock);
  }
}
/** Copy an installed artifact aside while leaving the active files available. */
function backupInstalledIntegrationUnlocked(
  rootDir: string,
  id: string,
): IntegrationRollbackBackup | null {
  const target = resolveInstallTarget(rootDir, id);
  if (!existsSync(target)) return null;
  const backup: IntegrationRollbackBackup = {
    id,
    backupDirectory: join(
      customDir(rootDir),
      `.rollback-integration-${id}-${randomBytes(6).toString("hex")}`,
    ),
  };
  const validated = validateIntegrationRollbackBackup(rootDir, backup);
  cpSync(target, validated.backupDirectory, { recursive: true, errorOnExist: true, force: false });
  return backup;
}

/** Restore the exact artifact snapshot after a failed multi-component update. */
function restoreInstalledIntegrationUnlocked(
  rootDir: string,
  backup: IntegrationRollbackBackup,
): void {
  const { target, backupDirectory } = validateIntegrationRollbackBackup(rootDir, backup);
  if (!existsSync(backupDirectory)) throw new Error("Integration rollback backup is missing");
  const restoreStage = createStagePath(rootDir, `restore-${backup.id}`);
  try {
    cpSync(backupDirectory, restoreStage, { recursive: true, errorOnExist: true, force: false });
    if (existsSync(target))
      throw Error(
        "Historical integration rollback lacks a publication ownership receipt; preserve the current integration and reconcile the original journal",
      );
    renameSync(restoreStage, target);
  } catch (error) {
    rmSync(restoreStage, { recursive: true, force: true });
    throw error;
  }
  discardInstalledIntegrationBackup(rootDir, backup);
}

export function discardInstalledIntegrationBackup(
  rootDir: string,
  backup: IntegrationRollbackBackup,
): void {
  const { backupDirectory } = validateIntegrationRollbackBackup(rootDir, backup);
  rmSync(backupDirectory, { recursive: true, force: true });
}

function removeIntegrationUnlocked(opts: RemoveOptions): { directory: string } {
  const target = resolveInstallTarget(opts.rootDir, opts.id);
  if (!existsSync(target)) {
    throw new Error(
      `Community integration '${opts.id}' is not installed (${target} does not exist)`,
    );
  }
  rmSync(target, { recursive: true, force: true });
  return { directory: target };
}

export interface PackageOptions {
  rootDir: string;
  /** Installed community integration id. */
  id?: string;
  /** Explicit source directory, useful before an integration is installed. */
  source?: string;
  outFile: string;
  onLog?: InstallOptions["onLog"];
  signal?: AbortSignal;
  /**
   * Report the exact allowlisted file list and total bytes without writing an
   * archive. Never prints file contents.
   */
  dryRun?: boolean;
}

export interface PackageResult {
  id: string;
  artifactPath: string;
  /** Relative paths included in the artifact, sorted. */
  files?: string[];
  /** Total bytes of the included files. */
  totalBytes?: number;
}

// The artifact contract. Packaging copies exactly these entries into a fresh
// staging directory; everything else in the source tree — dotfiles, `.env*`,
// VCS data, sources, tests, source maps, lockfiles, `node_modules`, caches,
// unreferenced assets — is simply never collected, so it cannot leak into a
// release even if it sits next to a declared file.
const MAX_LOCALE_FILES = 100;
const MAX_LOCALE_BYTES = 256 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_LEGAL_BYTES = 1024 * 1024;
const LOCALE_NAME = /^[a-z0-9-]{2,35}\.json$/;
const LEGAL_FILES = ["LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE", "NOTICE.txt"] as const;

interface StagedFile {
  /** Path relative to the artifact root. */
  relativePath: string;
  /** Absolute source path, or null when the contents are generated. */
  absoluteSource: string | null;
  contents?: string;
  sizeBytes: number;
}

/** `lstat` a candidate without following links; return null when unusable. */
function regularFile(absolute: string): { size: number } | null {
  try {
    const stats = lstatSync(absolute);
    // A symlink, socket, device, FIFO, or hard-linked file is never packaged.
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return null;
    return { size: Number(stats.size) };
  } catch {
    return null;
  }
}

function collectStagedFile(
  directory: string,
  relativePath: string,
  maxBytes: number,
  required: boolean,
): StagedFile | null {
  const absolute = join(directory, relativePath);
  const stats = regularFile(absolute);
  if (!stats) {
    if (required) {
      throw new Error(`Required artifact file ${relativePath} is missing or is not a regular file`);
    }
    return null;
  }
  if (stats.size > maxBytes) {
    throw new Error(`Artifact file ${relativePath} exceeds its ${maxBytes}-byte limit`);
  }
  return { relativePath, absoluteSource: absolute, sizeBytes: stats.size };
}

/**
 * Build the exact list of files the artifact may contain. Generated metadata and
 * license output are produced as in-memory contents so packaging never mutates
 * the caller's source directory.
 */
function collectArtifactFiles(
  directory: string,
  manifest: Record<string, unknown>,
  generated: { metadata: string; licenses: string | null },
): StagedFile[] {
  const files: StagedFile[] = [];
  const manifestFile = collectStagedFile(directory, "manifest.json", MAX_LEGAL_BYTES, true);
  if (manifestFile) files.push(manifestFile);

  files.push({
    relativePath: ARTIFACT_METADATA_FILE,
    absoluteSource: null,
    contents: generated.metadata,
    sizeBytes: Buffer.byteLength(generated.metadata, "utf8"),
  });
  if (generated.licenses !== null) {
    files.push({
      relativePath: "dist/licenses.json",
      absoluteSource: null,
      contents: generated.licenses,
      sizeBytes: Buffer.byteLength(generated.licenses, "utf8"),
    });
  }

  // Locale files, by exact name shape and count.
  const stringsDir = join(directory, "strings");
  if (regularDirectory(stringsDir)) {
    const names = readdirSync(stringsDir)
      .filter((name) => LOCALE_NAME.test(name))
      .sort();
    if (names.length > MAX_LOCALE_FILES) {
      throw new Error(`Artifact declares more than ${MAX_LOCALE_FILES} locale files`);
    }
    for (const name of names) {
      const staged = collectStagedFile(directory, `strings/${name}`, MAX_LOCALE_BYTES, false);
      if (staged) files.push(staged);
    }
  }

  // Only the exact manifest-referenced preview, after the safe relative-path
  // validator has already run.
  const preview = resolveLayerSelectorPreview(directory, manifest);
  if (preview) {
    // `resolveLayerSelectorPreview` returns a realpath, so the relative path
    // has to be taken against the canonical root too — otherwise a symlinked
    // temp root (macOS `/var` -> `/private/var`) yields an escaping path.
    const relativePreview = relative(realpathSync(directory), preview).split(sep).join("/");
    const staged = collectStagedFile(directory, relativePreview, MAX_PREVIEW_BYTES, true);
    if (staged) files.push(staged);
  }

  for (const legal of LEGAL_FILES) {
    const staged = collectStagedFile(directory, legal, MAX_LEGAL_BYTES, false);
    if (staged) files.push(staged);
  }

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.relativePath)) {
      throw new Error(`Artifact would contain ${file.relativePath} twice`);
    }
    seen.add(file.relativePath);
  }
  // Code-unit ordering keeps the manifest of included files reproducible
  // regardless of the host locale.
  return files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1));
}

function regularDirectory(absolute: string): boolean {
  try {
    const stats = lstatSync(absolute);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

const BACKEND_BUNDLE_PATH = ["dist", "backend", "index.mjs"] as const;
const ARTIFACT_METADATA_FILE = "openmapx-artifact.json";
// Fixed build stamp so the same source always produces byte-identical output.
const DETERMINISTIC_TIMESTAMP = "1970-01-01T00:00:00Z";

function manifestDeclaresBackend(manifest: Record<string, unknown>): boolean {
  const backend = manifest.backend;
  if (!backend || typeof backend !== "object") return false;
  return Object.values(backend as Record<string, unknown>).some(
    (value) => value === true || typeof value === "string",
  );
}

const EXECUTABLE_COMMUNITY_CODE_PATHS = [
  "index.ts",
  "index.js",
  "dist/backend/index.mjs",
  "map-layer.tsx",
  "legend.tsx",
  "panel.tsx",
  "dist/frontend/index.js",
] as const;

function manifestDeclaresFrontendCode(manifest: Record<string, unknown>): boolean {
  const frontend = manifest.frontend;
  if (!frontend || typeof frontend !== "object") return false;
  const declaration = frontend as Record<string, unknown>;
  return declaration.mapLayer === true || declaration.legend === true || declaration.panel === true;
}

function assertNoExecutableCommunityCode(
  directory: string,
  manifest: Record<string, unknown>,
): void {
  const found = EXECUTABLE_COMMUNITY_CODE_PATHS.filter((path) => existsSync(join(directory, path)));
  if (
    !manifestDeclaresBackend(manifest) &&
    !manifestDeclaresFrontendCode(manifest) &&
    found.length === 0
  ) {
    return;
  }
  const details = found.length > 0 ? ` Found: ${found.join(", ")}.` : "";
  throw new Error(
    "Executable community integration code cannot be installed without an isolation boundary." +
      details +
      " Move backend behavior into an isolated service component and keep the integration artifact declarative-only.",
  );
}

export function integrationBackendBundlePath(directory: string): string {
  return join(directory, ...BACKEND_BUNDLE_PATH);
}

function assertCompatibleManifestProtocol(manifest: Record<string, unknown>): void {
  if (typeof manifest.platform === "string" && !satisfiesPlatformVersion(manifest.platform)) {
    throw new Error(
      `Extension protocol ${manifest.platform} is not compatible with ${PLATFORM_VERSION}`,
    );
  }
}

function validateDeclarativeArtifact(directory: string): void {
  if (existsSync(join(directory, "node_modules"))) {
    throw new Error("Declarative integration artifacts must not ship a node_modules/ directory.");
  }
}

/**
 * The same metadata `writeArtifactMetadata` persists, returned instead of
 * written. Packaging stages it so the caller's source tree is left untouched.
 */
function buildArtifactMetadata(manifest: Record<string, unknown>, builtAt: string): string | null {
  if (typeof manifest.id !== "string") return null;
  const metadata: ArtifactMetadata = {
    schemaVersion: 1,
    id: manifest.id,
    platformVersion: PLATFORM_VERSION,
    builtAt,
  };
  return JSON.stringify(metadata, null, 2);
}

function validateArtifactMetadata(directory: string, manifest: Record<string, unknown>): void {
  const metadataPath = join(directory, ARTIFACT_METADATA_FILE);
  if (!existsSync(metadataPath)) return;

  let value: unknown;
  try {
    value = readBoundedJson(metadataPath, 8 * 1024 * 1024);
  } catch {
    throw new Error(`${ARTIFACT_METADATA_FILE} is not valid JSON`);
  }

  const result = validatePortableArtifactMetadata(value, String(manifest.id));
  if (!result.valid) throw new Error(`${ARTIFACT_METADATA_FILE}: ${result.errors.join("; ")}`);
}

export async function packageIntegration(opts: PackageOptions): Promise<PackageResult> {
  const directory = opts.source
    ? resolve(opts.source)
    : opts.id
      ? resolveInstallTarget(opts.rootDir, opts.id)
      : "";
  if (!directory) throw new Error("Either package source or id is required");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`Package source ${directory} is not an existing directory`);
  }

  const manifest = readManifest(directory);
  if (!manifest || typeof manifest.id !== "string") {
    throw new Error(`No manifest.json with a string id in ${directory}`);
  }
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Manifest validation failed:\n  - ${validation.errors.join("\n  - ")}`);
  }
  assertCompatibleManifestProtocol(manifest);
  resolveLayerSelectorPreview(directory, manifest);
  assertNoExecutableCommunityCode(directory, manifest);

  // Authoring dependencies may exist in the source tree. The explicit file
  // allowlist below never stages node_modules; received artifacts are still
  // rejected by validateDeclarativeArtifact before installation.

  // Generated in memory, not written into the caller's tree: packaging must
  // leave the source directory byte-for-byte unchanged.
  const metadata = buildArtifactMetadata(
    manifest,
    // Deterministic: two packages built from the same source must be identical.
    DETERMINISTIC_TIMESTAMP,
  );
  if (metadata === null) throw new Error("Could not build artifact metadata");
  // Ship a license manifest alongside the bundles so OpenMapX's /licenses
  // page can surface the deps the artifact bundled in. Best-effort — only
  // emits when the source tree has a package.json with reachable deps.
  const licenses = buildArtifactLicenses(directory, manifest, opts.onLog);

  const files = collectArtifactFiles(directory, manifest, { metadata, licenses });
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const relativePaths = files.map((file) => file.relativePath);

  if (opts.dryRun) {
    // The list and the byte total only — never file contents.
    for (const file of files)
      opts.onLog?.(`${file.relativePath} (${file.sizeBytes} bytes)`, "stdout");
    opts.onLog?.(`${files.length} files, ${totalBytes} bytes`, "stdout");
    return {
      id: manifest.id,
      artifactPath: resolve(opts.outFile),
      files: relativePaths,
      totalBytes,
    };
  }

  // Built in memory from the exact allowlisted set. Platform `tar` dialects
  // disagree about the flags that make output reproducible, so the archive is
  // written with fixed ustar headers instead of shelling out.
  mkdirSync(dirname(resolve(opts.outFile)), { recursive: true });
  writeFileSync(
    resolve(opts.outFile),
    createDeterministicTarGz(
      files.map((file) => ({
        path: file.relativePath,
        contents:
          file.absoluteSource === null
            ? Buffer.from(file.contents ?? "", "utf-8")
            : readFileSync(file.absoluteSource),
      })),
    ),
  );

  return {
    id: manifest.id,
    artifactPath: resolve(opts.outFile),
    files: relativePaths,
    totalBytes,
  };
}

/** The same license manifest, returned instead of written into the source tree. */
function buildArtifactLicenses(
  directory: string,
  manifest: Record<string, unknown>,
  onLog: PackageOptions["onLog"],
): string | null {
  const pkgJsonPath = join(directory, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  let notices: ReturnType<typeof scanLicenses> = [];
  try {
    notices = scanLicenses({
      rootPackageJsonPaths: [pkgJsonPath],
      skipNamePrefixes: ["@openmapx/"],
    });
  } catch (err) {
    onLog?.(`license scan skipped: ${(err as Error).message}`, "stderr");
    return null;
  }
  if (notices.length === 0) return null;
  onLog?.(`license manifest → dist/licenses.json (${notices.length} entries)`, "stdout");
  return `${JSON.stringify({ integrationId: manifest.id, notices }, null, 2)}\n`;
}

export function removeIntegration(opts: RemoveOptions): { directory: string } {
  const lock = acquireIntegrationComponentLock({ rootDir: opts.rootDir, id: opts.id });
  try {
    return removeIntegrationUnlocked(opts);
  } finally {
    releaseIntegrationComponentLock(lock);
  }
}
