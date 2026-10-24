// Pure functions for installing, removing, validating, and bundling community
// integrations under `custom_integrations/`. The CLI (`pnpm openmapx
// integrations …`) and the admin Store (`apps/api/src/services/store.ts`) both
// call into this module so they share one source of truth.
//
// Community install/package entry points enforce declarative-only artifacts;
// app-api never builds or executes community bundles at runtime.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  type Dirent,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { scanLicenses } from "@openmapx/core/licenses";
import { assertAllowedGitUrl, gitShallowClone, safeDownload } from "@openmapx/core/server";
import { assertTrustedConfigurationSchema } from "@openmapx/core/services/configuration-schema";
import {
  assertTrustedIntegrationDirectory,
  MAX_INTEGRATION_MANIFEST_BYTES,
} from "@openmapx/core/services/trusted-integration-schemas";
import {
  type ArtifactMetadata,
  validateArtifactMetadata as validatePortableArtifactMetadata,
} from "@openmapx/extension-contracts/artifact";
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

// The operations agent loads installed integrations only from directories and
// manifests its own account owns and nobody else can write; one it would
// reject stops it from authorizing any configuration change. Installed files
// therefore get these modes whatever the source, the archive or the umask
// declared.
const INSTALLED_DIRECTORY_MODE = 0o755;
const INSTALLED_FILE_MODE = 0o644;
const MAX_AGENT_INTEGRATION_ID_LENGTH = 64;

/**
 * Create `custom_integrations/`, or take it over as it is, in the state the
 * agent trusts: a directory owned by the installing account that neither its
 * group nor others can write.
 */
function prepareCustomDir(rootDir: string): void {
  const directory = customDir(rootDir);
  mkdirSync(directory, { recursive: true, mode: INSTALLED_DIRECTORY_MODE });
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    throw new Error(`${directory} must be a directory, not a symbolic link or a file`);
  }
  const uid = process.geteuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `${directory} is owned by uid ${stats.uid}, not by the installing account (uid ${uid}). ` +
        "The operations agent only loads integrations from a directory its own account owns.",
    );
  }
  if ((stats.mode & 0o022) !== 0) chmodSync(directory, stats.mode & 0o755);
}

/** Give a staged tree the installed modes. Symbolic links are left as they are. */
function applyInstalledModes(directory: string): void {
  chmodSync(directory, INSTALLED_DIRECTORY_MODE);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) applyInstalledModes(path);
    else if (entry.isFile()) chmodSync(path, INSTALLED_FILE_MODE);
  }
}

/**
 * Refuse a `manifest.json` the agent would not read: a symbolic link, a file
 * hard-linked to another, or one larger than the agent reads. Checked before
 * the manifest is parsed, since parsing would follow a link.
 */
function assertManifestFile(directory: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(join(directory, "manifest.json"));
  } catch {
    return; // Missing: reported when the manifest is read.
  }
  if (stats.isSymbolicLink()) {
    throw new Error("manifest.json must be a regular file, not a symbolic link");
  }
  if (!stats.isFile()) throw new Error("manifest.json must be a regular file");
  if (stats.nlink !== 1) {
    throw new Error("manifest.json must not be hard-linked to another file");
  }
  if (stats.size > MAX_INTEGRATION_MANIFEST_BYTES) {
    throw new Error(`manifest.json exceeds the ${MAX_INTEGRATION_MANIFEST_BYTES / 1024} KiB limit`);
  }
}

/**
 * The checks the operations agent's loader applies, run on the staged tree
 * after its modes are set: anything it would reject is refused here, before
 * it replaces an installed integration.
 */
function assertAgentLoads(directory: string, id: string): void {
  if (id.length > MAX_AGENT_INTEGRATION_ID_LENGTH) {
    throw new Error(
      `Integration id "${id}" is longer than the ${MAX_AGENT_INTEGRATION_ID_LENGTH} characters the operations agent loads`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(join(directory, "manifest.json")),
    );
  } catch {
    throw new Error("manifest.json is not valid UTF-8");
  }
  const manifest = readManifest(directory);
  try {
    assertTrustedConfigurationSchema(manifest?.configSchema as Record<string, unknown> | undefined);
  } catch {
    throw new Error("configSchema uses a construct the operations agent does not accept");
  }
  try {
    assertTrustedIntegrationDirectory(directory, id);
  } catch {
    throw new Error("The operations agent would not load the installed files");
  }
}

const STAGING_DIR_NAME = ".staging";
const DEFAULT_MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;
const MAX_LAYER_SELECTOR_PREVIEW_BYTES = 64 * 1024;
const TAR_BLOCK_BYTES = 512;
// Header count includes PAX and GNU metadata headers.
const MAX_TAR_HEADERS = 4096;
const MAX_PAX_RECORDS = 256;
const MAX_ARCHIVE_PATH_BYTES = 1024;
const MAX_ARCHIVE_PATH_COMPONENTS = 32;
const MAX_ARCHIVE_PATH_COMPONENT_BYTES = 255;

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

function readManifest(directory: string): Record<string, unknown> | null {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
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
}

export interface InstallResult {
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
  prepareCustomDir(opts.rootDir);

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
  let stage: string;
  if (sourceKind === "artifact") {
    stage = await stageArtifactSource(opts);
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
    assertManifestFile(stage);
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
    const replaced = existsSync(target);
    validateDeclarativeArtifact(stage);
    if (sourceKind === "artifact") {
      validateArtifactMetadata(stage, manifest);
    }
    applyInstalledModes(stage);
    assertAgentLoads(stage, id);
    if (replaced) {
      rmSync(target, { recursive: true, force: true });
    }
    renameSync(stage, target);
    return { id, directory: target, replaced };
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

async function stageArtifactSource(opts: InstallOptions): Promise<string> {
  const token = randomBytes(4).toString("hex");
  const parent = stagingDir(opts.rootDir);
  const maxArtifactBytes = opts.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  mkdirSync(parent, { recursive: true });
  const extractRoot = join(parent, `artifact-${token}`);
  const archivePath = join(parent, `artifact-${token}.tar.gz`);
  mkdirSync(extractRoot, { recursive: true });

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
    verifyArtifactSha256(sourcePath, opts.artifactSha256);
    extractTarGz(sourcePath, extractRoot, maxArtifactBytes);

    const stage = normalizeExtractedArtifactRoot(extractRoot, join(parent, `source-${token}`));
    if (sourcePath === archivePath) rmSync(archivePath, { force: true });
    return stage;
  } catch (err) {
    rmSync(extractRoot, { recursive: true, force: true });
    rmSync(archivePath, { force: true });
    throw err;
  }
}

function verifyArtifactSha256(path: string, expected: string | undefined): void {
  if (!expected) return;
  const actual = sha256File(path);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Artifact sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

type TarDescriptorType = "directory" | "file" | "hardlink" | "symlink";

interface TarDescriptor {
  type: TarDescriptorType;
  path: string;
  linkTarget?: string;
  payloadOffset: number;
  payloadLength: number;
}

function extractTarGz(archivePath: string, destDir: string, maxBytes: number): void {
  let data: Buffer;
  try {
    data = gunzipSync(readFileSync(archivePath), { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`Artifact extracted size exceeds max ${maxBytes} bytes`);
    }
    throw err;
  }

  const descriptors = validateTarDescriptors(data, destDir);
  materializeTarDescriptors(data, destDir, descriptors);
}

function validateTarDescriptors(data: Buffer, destDir: string): TarDescriptor[] {
  const descriptors: TarDescriptor[] = [];
  let pendingPath: string | undefined;
  let pendingLinkPath: string | undefined;
  const base = resolve(destDir);
  let headerCount = 0;
  let offset = 0;
  let reachedEndBlock = false;
  for (; offset + TAR_BLOCK_BYTES <= data.length; ) {
    const header = data.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (isZeroBlock(header)) {
      reachedEndBlock = true;
      break;
    }
    headerCount += 1;
    if (headerCount > MAX_TAR_HEADERS) {
      throw new Error(
        `Artifact tar header limit exceeded: maximum ${MAX_TAR_HEADERS.toLocaleString("en-US")}`,
      );
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const headerLinkPath = readTarString(header, 157, 100);
    const size = parseTarOctal(header, 124, 12);
    // The entry's mode (offset 100) is not used: installed files get fixed modes.
    const typeflag = readTarString(header, 156, 1) || "0";
    const payloadOffset = offset;
    if (size > data.length - payloadOffset) {
      throw new Error(`Artifact tar payload is truncated for ${headerPath || "unnamed entry"}`);
    }
    const payloadEnd = payloadOffset + size;
    const paddingLength = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (paddingLength > data.length - payloadEnd) {
      throw new Error(
        `Artifact tar payload padding is truncated for ${headerPath || "unnamed entry"}`,
      );
    }
    const fileData = data.subarray(payloadOffset, payloadEnd);
    offset = payloadEnd + paddingLength;

    if (typeflag === "x") {
      const records = parsePaxRecords(fileData);
      pendingPath = records.path ?? pendingPath;
      pendingLinkPath = records.linkpath ?? pendingLinkPath;
      continue;
    }
    if (typeflag === "g") {
      parsePaxRecords(fileData, false);
      continue; // Global PAX metadata does not carry per-entry paths.
    }
    if (typeflag === "L") {
      assertMetadataPathPayloadSize(fileData, "Artifact path");
      pendingPath = readTarPayloadString(fileData);
      continue;
    }
    if (typeflag === "K") {
      assertMetadataPathPayloadSize(fileData, "Artifact link target");
      pendingLinkPath = readTarPayloadString(fileData);
      continue;
    }

    const rawPath = pendingPath ?? headerPath;
    const rawLinkPath = pendingLinkPath ?? headerLinkPath;
    pendingPath = undefined;
    pendingLinkPath = undefined;
    const safePath = safeArchivePath(rawPath);
    assertArchivePathStructure(safePath, "Artifact path");
    const target = resolve(destDir, safePath);
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw new Error(`Artifact entry escapes extraction directory: ${rawPath}`);
    }

    if (typeflag === "5") {
      descriptors.push({
        type: "directory",
        path: safePath,
        payloadOffset,
        payloadLength: size,
      });
      continue;
    }
    if (typeflag === "2") {
      const linkTarget = resolveSymlinkTarget(base, target, rawLinkPath);
      descriptors.push({
        type: "symlink",
        path: safePath,
        linkTarget: linkTarget.raw,
        payloadOffset,
        payloadLength: size,
      });
      continue;
    }
    if (typeflag === "1") {
      const linkTarget = validateHardlinkTarget(base, rawLinkPath);
      descriptors.push({
        type: "hardlink",
        path: safePath,
        linkTarget,
        payloadOffset,
        payloadLength: size,
      });
      continue;
    }
    if (typeflag !== "0") {
      throw new Error(`Unsupported artifact entry type '${typeflag}' for ${rawPath}`);
    }

    descriptors.push({
      type: "file",
      path: safePath,
      payloadOffset,
      payloadLength: size,
    });
  }
  if (!reachedEndBlock && offset !== data.length) {
    throw new Error("Artifact contains a partial tar header");
  }
  return descriptors;
}

function materializeTarDescriptors(
  data: Buffer,
  destDir: string,
  descriptors: TarDescriptor[],
): void {
  const base = resolve(destDir);
  for (const descriptor of descriptors) {
    const target = resolve(destDir, descriptor.path);
    if (descriptor.type === "directory") {
      assertPathNotThroughSymlink(base, target);
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (descriptor.type === "symlink") {
      if (!descriptor.linkTarget) throw new Error("Validated artifact symlink has no target");
      resolveSymlinkTarget(base, target, descriptor.linkTarget);
      assertPathNotThroughSymlink(base, dirname(target));
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        throw new Error(`Artifact link target already exists: ${descriptor.path}`);
      }
      symlinkSync(descriptor.linkTarget, target);
      continue;
    }
    if (descriptor.type === "hardlink") {
      if (!descriptor.linkTarget) throw new Error("Validated artifact hardlink has no target");
      const linkTarget = resolveHardlinkTarget(base, descriptor.linkTarget);
      assertPathNotThroughSymlink(base, dirname(target));
      mkdirSync(dirname(target), { recursive: true });
      assertPathNotThroughSymlink(base, target);
      linkSync(linkTarget, target);
      continue;
    }

    assertPathNotThroughSymlink(base, dirname(target));
    mkdirSync(dirname(target), { recursive: true });
    assertPathNotThroughSymlink(base, target);
    writeFileSync(
      target,
      data.subarray(descriptor.payloadOffset, descriptor.payloadOffset + descriptor.payloadLength),
      { mode: INSTALLED_FILE_MODE },
    );
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function readTarString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice
    .subarray(0, nul >= 0 ? nul : undefined)
    .toString("utf-8")
    .trim();
}

function parseTarOctal(block: Buffer, start: number, length: number): number {
  const raw = readTarString(block, start, length).replace(/\0/g, "").trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid tar numeric field: ${raw}`);
  }
  return value;
}

function readTarPayloadString(data: Buffer): string {
  const nul = data.indexOf(0);
  return data
    .subarray(0, nul >= 0 ? nul : undefined)
    .toString("utf-8")
    .trimEnd();
}

function parsePaxRecords(data: Buffer, capturePaths = true): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  let count = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error("Invalid PAX payload: unterminated trailing data");
    if (space - offset > 20) throw new Error("Invalid PAX record length");
    const lengthRaw = data.subarray(offset, space).toString("utf-8");
    if (!/^\d+$/.test(lengthRaw)) throw new Error(`Invalid PAX record length: ${lengthRaw}`);
    const length = Number.parseInt(lengthRaw, 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new Error(`Invalid PAX record length: ${lengthRaw}`);
    }
    count += 1;
    if (count > MAX_PAX_RECORDS) {
      throw new Error(`PAX payload exceeds ${MAX_PAX_RECORDS} records`);
    }

    const recordEnd = offset + length;
    if (recordEnd <= space + 1 || data[recordEnd - 1] !== 10) {
      throw new Error("Invalid PAX record: declared length must include a terminating newline");
    }
    const record = data.subarray(space + 1, recordEnd - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error("Invalid PAX record: missing key/value separator");
    if (capturePaths) {
      const keyBytes = record.subarray(0, equals);
      const valueBytes = record.subarray(equals + 1);
      if (keyBytes.equals(Buffer.from("path"))) {
        assertArchiveTextBytes(valueBytes, "Artifact path");
        records.path = valueBytes.toString("utf-8");
      } else if (keyBytes.equals(Buffer.from("linkpath"))) {
        assertArchiveTextBytes(valueBytes, "Artifact link target");
        records.linkpath = valueBytes.toString("utf-8");
      }
    }
    offset += length;
  }
  return records;
}

function assertMetadataPathPayloadSize(data: Buffer, label: string): void {
  const trailingNul = data.length > 0 && data[data.length - 1] === 0 ? 1 : 0;
  if (data.length - trailingNul > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error(
      `${label} exceeds ${MAX_ARCHIVE_PATH_BYTES.toLocaleString("en-US")} UTF-8 bytes`,
    );
  }
}

function assertArchiveTextBytes(data: Buffer, label: string): void {
  if (data.length > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error(
      `${label} exceeds ${MAX_ARCHIVE_PATH_BYTES.toLocaleString("en-US")} UTF-8 bytes`,
    );
  }
}

function assertArchivePathStructure(path: string, label: string): void {
  if (Buffer.byteLength(path, "utf-8") > MAX_ARCHIVE_PATH_BYTES) {
    throw new Error(
      `${label} exceeds ${MAX_ARCHIVE_PATH_BYTES.toLocaleString("en-US")} UTF-8 bytes`,
    );
  }
  const components = path.split(sep).filter((component) => component && component !== ".");
  if (components.length > MAX_ARCHIVE_PATH_COMPONENTS) {
    throw new Error(`${label} exceeds ${MAX_ARCHIVE_PATH_COMPONENTS} components`);
  }
  for (const component of components) {
    if (Buffer.byteLength(component, "utf-8") > MAX_ARCHIVE_PATH_COMPONENT_BYTES) {
      throw new Error(`${label} component exceeds ${MAX_ARCHIVE_PATH_COMPONENT_BYTES} UTF-8 bytes`);
    }
  }
}

function safeArchivePath(path: string): string {
  const normalized = normalize(path.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.includes(`${sep}..${sep}`)
  ) {
    throw new Error(`Unsafe artifact path: ${path}`);
  }
  return normalized;
}

function assertPathNotThroughSymlink(base: string, target: string): void {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error(`Artifact path escapes extraction directory: ${target}`);
  }

  const rel = relative(resolvedBase, resolvedTarget);
  if (!rel) return;

  let current = resolvedBase;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Artifact path traverses a symlink: ${relative(resolvedBase, current)}`);
    }
  }
}

function assertSafeLinkText(rawLinkPath: string): string {
  const linkPath = rawLinkPath.replace(/\\/g, "/");
  if (!linkPath || linkPath.includes("\0")) {
    throw new Error("Artifact link has an empty or invalid target");
  }
  if (isAbsolute(linkPath) || /^[A-Za-z]:/.test(linkPath)) {
    throw new Error(`Artifact link target is not relative: ${rawLinkPath}`);
  }
  return linkPath;
}

function resolveSymlinkTarget(
  base: string,
  linkPath: string,
  rawLinkPath: string,
): { raw: string; resolved: string } {
  const raw = assertSafeLinkText(rawLinkPath);
  assertArchivePathStructure(normalize(raw), "Artifact link target");
  const resolved = resolve(dirname(linkPath), raw);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error(`Artifact symlink target escapes extraction directory: ${rawLinkPath}`);
  }
  return { raw, resolved };
}

function validateHardlinkTarget(base: string, rawLinkPath: string): string {
  const linkPath = assertSafeLinkText(rawLinkPath);
  const safePath = safeArchivePath(linkPath);
  assertArchivePathStructure(safePath, "Artifact link target");
  const resolved = resolve(base, safePath);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error(`Artifact hardlink target escapes extraction directory: ${rawLinkPath}`);
  }
  return safePath;
}

function resolveHardlinkTarget(base: string, rawLinkPath: string): string {
  const safePath = validateHardlinkTarget(base, rawLinkPath);
  const resolved = resolve(base, safePath);
  assertPathNotThroughSymlink(base, resolved);
  if (!existsSync(resolved)) {
    throw new Error(`Artifact hardlink target is missing: ${rawLinkPath}`);
  }
  return resolved;
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

/** Copy an installed artifact aside while leaving the active files available. */
export function backupInstalledIntegration(
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
export function restoreInstalledIntegration(
  rootDir: string,
  backup: IntegrationRollbackBackup,
): void {
  const { target, backupDirectory } = validateIntegrationRollbackBackup(rootDir, backup);
  if (!existsSync(backupDirectory)) throw new Error("Integration rollback backup is missing");
  const restoreStage = createStagePath(rootDir, `restore-${backup.id}`);
  try {
    cpSync(backupDirectory, restoreStage, { recursive: true, errorOnExist: true, force: false });
    applyInstalledModes(restoreStage);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
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

export function removeIntegration(opts: RemoveOptions): { directory: string } {
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
  // The operations agent reads no larger manifest; an artifact with one would
  // install nowhere.
  const manifestFile = collectStagedFile(
    directory,
    "manifest.json",
    MAX_INTEGRATION_MANIFEST_BYTES,
    true,
  );
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
    value = JSON.parse(readFileSync(metadataPath, "utf-8")) as unknown;
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
