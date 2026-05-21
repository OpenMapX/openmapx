// packages/core/src/integration/installer.ts
//
// Pure functions for installing, removing, validating, and bundling community
// integrations under `custom_integrations/`. The CLI (`pnpm openmapx
// integrations …`) and the admin Store (`apps/api/src/services/store.ts`) both
// call into this module so they share one source of truth.
//
// Bundling uses esbuild's JS API (`import("esbuild")`). The CLI ships esbuild
// as a dep and is the only entry point that requests builds — app-api never
// builds at runtime; it consumes prebuilt artifacts.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  assertAllowedGitUrl,
  gitShallowClone,
  safeDownload,
  scanLicenses,
  spawnWithBufferedLogs,
} from "@openmapx/core/server";
import { INTEGRATION_ID_REGEX, validateManifest } from "./manifest";
import { PLATFORM_VERSION } from "./platform";

// Bare specifiers community frontend bundles import as externals; the host
// page's import map resolves them to singleton ESM modules under
// `apps/web/public/runtime/`. Adding to this list also requires adding the
// module to `apps/web/scripts/build-runtime-modules.mjs` and to the import map
// in `apps/web/src/app/layout.tsx`.
//
// `@openmapx/integration-framework/react` MUST be shared — it owns the
// IntegrationRegistryContext. If a plugin bundle inlines its own copy,
// `useIntegrationRegistry()` reads from a different context than the one the
// host provides and falls back to the empty default registry.
const FRONTEND_RUNTIME_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@openmapx/core",
  "@openmapx/integration-framework",
  "@openmapx/integration-framework/react",
] as const;

// Server runtime exposes these as already-loaded modules; integrations must
// not bundle their own copies (would break IntegrationContext singletons).
// `@openmapx/place-ids` owns the place-resolver registry — if a plugin inlines
// its own copy, `registerPlaceResolver()` writes into a private map while
// `/api/places/:id` reads from the host's, so resolvers never run.
// `@openmapx/integration-framework` itself owns the community-module registry,
// IntegrationEventBus, and PLATFORM_VERSION; backend bundles inlining their
// own copy would write into a private community-module map and report
// version skew against a separate constant.
const BACKEND_RUNTIME_EXTERNALS = [
  "@openmapx/core",
  "@openmapx/core/server",
  "@openmapx/integration-framework",
  "@openmapx/place-ids",
] as const;

export interface IntegrationSummary {
  id: string;
  name: string;
  version: string;
  quality: string;
  hasBundle: boolean;
  directory: string;
}

function customDir(rootDir: string): string {
  return join(rootDir, "custom_integrations");
}

const STAGING_DIR_NAME = ".staging";
const DEFAULT_MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

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

function summarise(directory: string): IntegrationSummary | null {
  const manifest = readManifest(directory);
  if (!manifest || typeof manifest.id !== "string") return null;
  return {
    id: manifest.id,
    name: typeof manifest.name === "string" ? manifest.name : manifest.id,
    version: typeof manifest.version === "string" ? manifest.version : "?",
    quality: typeof manifest.quality === "string" ? manifest.quality : "community",
    hasBundle: existsSync(join(directory, ...FRONTEND_BUNDLE_PATH)),
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

export function validateIntegrationDirectory(directory: string): ValidateResult {
  const manifest = readManifest(directory);
  if (!manifest) {
    return { id: directory, valid: false, errors: ["manifest.json missing or invalid JSON"] };
  }
  const result = validateManifest(manifest);
  return {
    id: typeof manifest.id === "string" ? manifest.id : directory,
    valid: result.valid,
    errors: result.errors,
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
   * `source` clones/copies a working directory and (optionally) builds bundles
   * locally — used by the CLI for dev workflows. `artifact` extracts a
   * prebuilt OpenMapX community-integration release tarball — used by the
   * admin Store for production installs.
   */
  sourceKind?: "source" | "artifact";
  ref?: string;
  artifactSha256?: string;
  maxArtifactBytes?: number;
  /**
   * Build dist/frontend/index.js for declared frontend components before the
   * atomic swap. CLI-only; only set when installing from source. esbuild is
   * loaded via the JS API and must be resolvable from this process.
   */
  buildFrontend?: boolean;
  /**
   * Build dist/backend/index.mjs for backend integration code before the
   * atomic swap. CLI-only; only set when installing from source.
   */
  buildBackend?: boolean;
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
  build?: BuildResult;
  backendBuild?: BuildResult;
  artifact?: ArtifactValidationResult;
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
    const manifest = readManifest(stage);
    if (!manifest || typeof manifest.id !== "string") {
      throw new Error("Source has no manifest.json with a string `id` at its root");
    }

    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Manifest validation failed:\n  - ${validation.errors.join("\n  - ")}`);
    }

    // The schema regex already enforces the slug shape, but resolveInstallTarget
    // (via assertSafeId) gives a single point of defense if the schema ever
    // loosens AND verifies the resolved path stays under custom_integrations/.
    const id = manifest.id;
    const target = resolveInstallTarget(opts.rootDir, id);
    const replaced = existsSync(target);
    const build = opts.buildFrontend
      ? await buildIntegrationDirectory({
          rootDir: opts.rootDir,
          directory: stage,
          id,
          onLog: opts.onLog,
          signal: opts.signal,
        })
      : undefined;
    const backendBuild = opts.buildBackend
      ? await buildIntegrationBackendDirectory({
          rootDir: opts.rootDir,
          directory: stage,
          id,
          onLog: opts.onLog,
          signal: opts.signal,
        })
      : undefined;
    // Artifact installs must arrive fully prebuilt. Source installs that
    // skipped building (CLI `--no-build`) are accepted; they will run only if
    // the dist/ outputs are committed in the source tree.
    const requirePrebuilt = sourceKind === "artifact";
    const artifact = validateArtifactContract(stage, manifest, {
      requirePrebuiltFrontend: requirePrebuilt,
      requirePrebuiltBackend: requirePrebuilt,
    });
    if (sourceKind === "artifact") {
      validateArtifactMetadata(stage, manifest);
    }
    if (replaced) {
      rmSync(target, { recursive: true, force: true });
    }
    renameSync(stage, target);
    return { id, directory: target, replaced, build, backendBuild, artifact };
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
      await safeDownload(opts.source, {
        destPath: archivePath,
        maxBytes: maxArtifactBytes,
        timeoutMs: 5 * 60_000,
        headers: { "User-Agent": "OpenMapX integration installer" },
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

  let pendingPath: string | undefined;
  let pendingLinkPath: string | undefined;
  const base = resolve(destDir);
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (isZeroBlock(header)) break;

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const headerLinkPath = readTarString(header, 157, 100);
    const size = parseTarOctal(header, 124, 12);
    const mode = parseTarOctal(header, 100, 8);
    const typeflag = readTarString(header, 156, 1) || "0";
    const fileData = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === "x") {
      const records = parsePaxRecords(fileData);
      pendingPath = records.path ?? pendingPath;
      pendingLinkPath = records.linkpath ?? pendingLinkPath;
      continue;
    }
    if (typeflag === "g") continue; // Global PAX metadata does not carry per-entry paths.
    if (typeflag === "L") {
      pendingPath = readTarPayloadString(fileData);
      continue;
    }
    if (typeflag === "K") {
      pendingLinkPath = readTarPayloadString(fileData);
      continue;
    }

    const rawPath = pendingPath ?? headerPath;
    const rawLinkPath = pendingLinkPath ?? headerLinkPath;
    pendingPath = undefined;
    pendingLinkPath = undefined;
    const safePath = safeArchivePath(rawPath);
    const target = resolve(destDir, safePath);
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw new Error(`Artifact entry escapes extraction directory: ${rawPath}`);
    }

    if (typeflag === "5") {
      assertPathNotThroughSymlink(base, target);
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (typeflag === "2") {
      const linkTarget = resolveSymlinkTarget(base, target, rawLinkPath);
      assertPathNotThroughSymlink(base, dirname(target));
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        throw new Error(`Artifact link target already exists: ${rawPath}`);
      }
      symlinkSync(linkTarget.raw, target);
      continue;
    }
    if (typeflag === "1") {
      const linkTarget = resolveHardlinkTarget(base, rawLinkPath);
      assertPathNotThroughSymlink(base, dirname(target));
      mkdirSync(dirname(target), { recursive: true });
      assertPathNotThroughSymlink(base, target);
      linkSync(linkTarget, target);
      continue;
    }
    if (typeflag !== "0") {
      throw new Error(`Unsupported artifact entry type '${typeflag}' for ${rawPath}`);
    }

    assertPathNotThroughSymlink(base, dirname(target));
    mkdirSync(dirname(target), { recursive: true });
    assertPathNotThroughSymlink(base, target);
    writeFileSync(target, fileData);
    if (mode > 0) {
      try {
        chmodSync(target, mode & 0o777);
      } catch {
        // Non-fatal on filesystems that do not support chmod.
      }
    }
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
  if (!Number.isFinite(value) || value < 0) {
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

function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const lengthRaw = data.subarray(offset, space).toString("utf-8");
    const length = Number.parseInt(lengthRaw, 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) {
      throw new Error(`Invalid PAX record length: ${lengthRaw}`);
    }

    let record = data.subarray(space + 1, offset + length);
    if (record.length > 0 && record[record.length - 1] === 10) {
      record = record.subarray(0, -1);
    }
    const equals = record.indexOf(0x3d);
    if (equals > 0) {
      const key = record.subarray(0, equals).toString("utf-8");
      const value = record.subarray(equals + 1).toString("utf-8");
      records[key] = value;
    }
    offset += length;
  }
  return records;
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
  const resolved = resolve(dirname(linkPath), raw);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error(`Artifact symlink target escapes extraction directory: ${rawLinkPath}`);
  }
  return { raw, resolved };
}

function resolveHardlinkTarget(base: string, rawLinkPath: string): string {
  const linkPath = assertSafeLinkText(rawLinkPath);
  const safePath = safeArchivePath(linkPath);
  const resolved = resolve(base, safePath);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error(`Artifact hardlink target escapes extraction directory: ${rawLinkPath}`);
  }
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

export interface BuildOptions {
  rootDir: string;
  id: string;
  onLog?: InstallOptions["onLog"];
  signal?: AbortSignal;
}

export interface BuildResult {
  bundlePath: string | null;
  skipped: boolean;
  reason?: string;
}

export interface ArtifactValidationResult {
  hasFrontendBundle: boolean;
  hasBackendBundle: boolean;
}

export interface PackageOptions {
  rootDir: string;
  /** Installed community integration id. */
  id?: string;
  /** Explicit source directory, useful before an integration is installed. */
  source?: string;
  outFile: string;
  buildFrontend?: boolean;
  buildBackend?: boolean;
  onLog?: InstallOptions["onLog"];
  signal?: AbortSignal;
}

export interface PackageResult {
  id: string;
  artifactPath: string;
  validation: ArtifactValidationResult;
}

interface ArtifactMetadataBundle {
  path: string;
  sha256: string;
}

interface ArtifactMetadata {
  schemaVersion: 1;
  id: string;
  platformVersion: string;
  builtAt: string;
  bundles: {
    frontend?: ArtifactMetadataBundle;
    backend?: ArtifactMetadataBundle;
  };
}

const FRONTEND_FILES = ["map-layer.tsx", "legend.tsx", "panel.tsx"] as const;
type FrontendFile = (typeof FRONTEND_FILES)[number];
const FRONTEND_BUNDLE_PATH = ["dist", "frontend", "index.js"] as const;
const BACKEND_BUNDLE_PATH = ["dist", "backend", "index.mjs"] as const;
const ARTIFACT_METADATA_FILE = "openmapx-artifact.json";

const FRONTEND_EXPORT_NAME: Record<FrontendFile, string> = {
  "map-layer.tsx": "mapLayer",
  "legend.tsx": "legend",
  "panel.tsx": "panel",
};

const FRONTEND_LOCAL_NAME: Record<FrontendFile, string> = {
  "map-layer.tsx": "MapLayer",
  "legend.tsx": "Legend",
  "panel.tsx": "Panel",
};

function manifestDeclaresFrontend(manifest: Record<string, unknown>): boolean {
  const frontend = manifest.frontend;
  if (!frontend || typeof frontend !== "object") return false;
  return Object.values(frontend as Record<string, unknown>).some((value) => value === true);
}

function manifestDeclaresBackend(manifest: Record<string, unknown>): boolean {
  const backend = manifest.backend;
  if (!backend || typeof backend !== "object") return false;
  return Object.values(backend as Record<string, unknown>).some(
    (value) => value === true || typeof value === "string",
  );
}

function hasFrontendSources(directory: string): boolean {
  return FRONTEND_FILES.some((file) => existsSync(join(directory, file)));
}

function hasBackendSource(directory: string): boolean {
  return existsSync(join(directory, "index.ts")) || existsSync(join(directory, "index.js"));
}

function frontendBundlePath(directory: string): string {
  return join(directory, ...FRONTEND_BUNDLE_PATH);
}

export function integrationFrontendBundlePath(directory: string): string {
  return frontendBundlePath(directory);
}

export function integrationBackendBundlePath(directory: string): string {
  return join(directory, ...BACKEND_BUNDLE_PATH);
}

function validateArtifactContract(
  directory: string,
  manifest: Record<string, unknown>,
  opts: { requirePrebuiltFrontend: boolean; requirePrebuiltBackend: boolean },
): ArtifactValidationResult {
  const hasFrontend = manifestDeclaresFrontend(manifest) || hasFrontendSources(directory);
  const hasFrontendBundle = existsSync(frontendBundlePath(directory));
  if (opts.requirePrebuiltFrontend && hasFrontend && !hasFrontendBundle) {
    throw new Error(
      "Integration declares frontend components but no prebuilt dist/frontend/index.js was found. " +
        "Package the integration with `pnpm openmapx integrations package` before installing through the admin API.",
    );
  }

  const hasBackend = manifestDeclaresBackend(manifest) || hasBackendSource(directory);
  const hasBackendBundle = existsSync(integrationBackendBundlePath(directory));
  if (opts.requirePrebuiltBackend && hasBackend && !hasBackendBundle) {
    throw new Error(
      "Integration contains backend code but no prebuilt dist/backend/index.mjs was found. " +
        "Package the integration with `pnpm openmapx integrations package` before installing through the admin API.",
    );
  }

  if (existsSync(join(directory, "node_modules"))) {
    throw new Error(
      "Integration artifacts must not ship a node_modules/ directory. Bundle all runtime " +
        "dependencies into dist/backend/index.mjs via the CLI packager.",
    );
  }

  return { hasFrontendBundle, hasBackendBundle };
}

function relativeArtifactPath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/");
}

function resolveArtifactRelativePath(directory: string, path: string): string {
  const safePath = safeArchivePath(path);
  const target = resolve(directory, safePath);
  const base = resolve(directory);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`Artifact metadata path escapes integration directory: ${path}`);
  }
  return target;
}

function writeArtifactMetadata(
  directory: string,
  manifest: Record<string, unknown>,
  validation: ArtifactValidationResult,
): void {
  if (typeof manifest.id !== "string") return;

  const frontendBundle = frontendBundlePath(directory);
  const backendBundle = integrationBackendBundlePath(directory);
  const metadata: ArtifactMetadata = {
    schemaVersion: 1,
    id: manifest.id,
    platformVersion: PLATFORM_VERSION,
    builtAt: new Date().toISOString(),
    bundles: {},
  };

  if (validation.hasFrontendBundle && existsSync(frontendBundle)) {
    metadata.bundles.frontend = {
      path: relativeArtifactPath(directory, frontendBundle),
      sha256: sha256File(frontendBundle),
    };
  }
  if (validation.hasBackendBundle && existsSync(backendBundle)) {
    metadata.bundles.backend = {
      path: relativeArtifactPath(directory, backendBundle),
      sha256: sha256File(backendBundle),
    };
  }

  writeFileSync(
    join(directory, ARTIFACT_METADATA_FILE),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );
}

function validateArtifactMetadata(directory: string, manifest: Record<string, unknown>): void {
  const metadataPath = join(directory, ARTIFACT_METADATA_FILE);
  if (!existsSync(metadataPath)) return;

  let metadata: ArtifactMetadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as ArtifactMetadata;
  } catch {
    throw new Error(`${ARTIFACT_METADATA_FILE} is not valid JSON`);
  }

  if (metadata.schemaVersion !== 1) {
    throw new Error(
      `Unsupported ${ARTIFACT_METADATA_FILE} schemaVersion: ${metadata.schemaVersion}`,
    );
  }
  if (typeof manifest.id === "string" && metadata.id !== manifest.id) {
    throw new Error(
      `${ARTIFACT_METADATA_FILE} id mismatch: metadata has ${metadata.id}, manifest has ${manifest.id}`,
    );
  }

  for (const [name, bundle] of Object.entries(metadata.bundles ?? {})) {
    if (!bundle) continue;
    const path = resolveArtifactRelativePath(directory, bundle.path);
    if (!existsSync(path)) {
      throw new Error(`${ARTIFACT_METADATA_FILE} ${name} bundle is missing: ${bundle.path}`);
    }
    const actual = sha256File(path);
    if (actual.toLowerCase() !== bundle.sha256.toLowerCase()) {
      throw new Error(
        `${ARTIFACT_METADATA_FILE} ${name} bundle checksum mismatch: expected ${bundle.sha256}, got ${actual}`,
      );
    }
  }
}

// esbuild is loaded lazily through its JS API so the api image never imports
// it (only the CLI ever requests a build). Resolution flows through normal
// node module lookup from this package — esbuild is a `@openmapx/cli` runtime
// dependency. If a non-CLI consumer ever asks for a build, this surfaces a
// clear error rather than hanging.
type EsbuildModule = typeof import("esbuild");
let esbuildModule: EsbuildModule | null = null;
async function loadEsbuild(): Promise<EsbuildModule> {
  if (esbuildModule) return esbuildModule;
  try {
    esbuildModule = (await import("esbuild")) as EsbuildModule;
  } catch {
    throw new Error(
      "esbuild is not available in this process. Run integration builds through the OpenMapX CLI " +
        "(`pnpm openmapx integrations build|package`), which ships esbuild as a dependency.",
    );
  }
  return esbuildModule;
}

export async function buildIntegration(opts: BuildOptions): Promise<BuildResult> {
  const directory = resolveInstallTarget(opts.rootDir, opts.id);
  if (!existsSync(directory)) {
    throw new Error(`Community integration '${opts.id}' is not installed`);
  }
  const manifest = readManifest(directory);
  if (!manifest) {
    throw new Error(`No manifest.json in ${directory}`);
  }

  return buildIntegrationDirectory({ ...opts, directory });
}

export async function buildIntegrationBackend(opts: BuildOptions): Promise<BuildResult> {
  const directory = resolveInstallTarget(opts.rootDir, opts.id);
  if (!existsSync(directory)) {
    throw new Error(`Community integration '${opts.id}' is not installed`);
  }
  const manifest = readManifest(directory);
  if (!manifest) {
    throw new Error(`No manifest.json in ${directory}`);
  }

  return buildIntegrationBackendDirectory({ ...opts, directory });
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

  if (opts.buildFrontend) {
    await buildIntegrationDirectory({
      rootDir: opts.rootDir,
      directory,
      id: manifest.id,
      onLog: opts.onLog,
      signal: opts.signal,
    });
  }
  if (opts.buildBackend ?? opts.buildFrontend) {
    await buildIntegrationBackendDirectory({
      rootDir: opts.rootDir,
      directory,
      id: manifest.id,
      onLog: opts.onLog,
      signal: opts.signal,
    });
  }

  const artifactValidation = validateArtifactContract(directory, manifest, {
    requirePrebuiltFrontend: true,
    requirePrebuiltBackend: true,
  });
  writeArtifactMetadata(directory, manifest, artifactValidation);
  // Ship a license manifest alongside the bundles so OpenMapX's /licenses
  // page can surface the deps the artifact bundled in. Best-effort — only
  // emits when the source tree has a package.json with reachable deps.
  writeArtifactLicenses(directory, manifest, opts.onLog);

  mkdirSync(dirname(resolve(opts.outFile)), { recursive: true });
  await spawnWithBufferedLogs("tar", ["-czf", resolve(opts.outFile), "-C", directory, "."], {
    signal: opts.signal,
    onLog: opts.onLog,
  });

  return { id: manifest.id, artifactPath: resolve(opts.outFile), validation: artifactValidation };
}

function writeArtifactLicenses(
  directory: string,
  manifest: Record<string, unknown>,
  onLog: PackageOptions["onLog"],
): void {
  const pkgJsonPath = join(directory, "package.json");
  if (!existsSync(pkgJsonPath)) return;
  let notices: ReturnType<typeof scanLicenses> = [];
  try {
    notices = scanLicenses({
      rootPackageJsonPaths: [pkgJsonPath],
      skipNamePrefixes: ["@openmapx/"],
    });
  } catch (err) {
    onLog?.(`license scan skipped: ${(err as Error).message}`, "stderr");
    return;
  }
  if (notices.length === 0) return;
  const distDir = join(directory, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "licenses.json"),
    `${JSON.stringify({ integrationId: manifest.id, notices }, null, 2)}\n`,
    "utf-8",
  );
  onLog?.(`license manifest → dist/licenses.json (${notices.length} entries)`, "stdout");
}

function backendEntryPath(directory: string): string | null {
  const ts = join(directory, "index.ts");
  if (existsSync(ts)) return ts;
  const js = join(directory, "index.js");
  return existsSync(js) ? js : null;
}

async function buildIntegrationBackendDirectory(
  opts: BuildOptions & { directory: string },
): Promise<BuildResult> {
  const entryPath = backendEntryPath(opts.directory);
  if (!entryPath) {
    return {
      bundlePath: null,
      skipped: true,
      reason: "no backend entry (index.ts/index.js)",
    };
  }

  const esbuild = await loadEsbuild();
  const bundlePath = integrationBackendBundlePath(opts.directory);
  mkdirSync(dirname(bundlePath), { recursive: true });
  opts.signal?.throwIfAborted();

  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundlePath,
    target: "node24",
    external: [...BACKEND_RUNTIME_EXTERNALS],
    minify: true,
    absWorkingDir: opts.directory,
    logLevel: "warning",
  });
  opts.onLog?.(`backend bundle → ${bundlePath}`, "stdout");

  return { bundlePath, skipped: false };
}

async function buildIntegrationDirectory(
  opts: BuildOptions & { directory: string },
): Promise<BuildResult> {
  const { directory } = opts;
  const present = FRONTEND_FILES.filter((f) => existsSync(join(directory, f)));
  if (present.length === 0) {
    return {
      bundlePath: null,
      skipped: true,
      reason: "no frontend components (map-layer/legend/panel)",
    };
  }

  const esbuild = await loadEsbuild();
  const distDir = dirname(frontendBundlePath(directory));
  mkdirSync(distDir, { recursive: true });

  const token = randomBytes(4).toString("hex");
  const entryPath = join(directory, `.openmapx-build-entry-${token}.tsx`);
  // JSON.stringify so the id is properly quoted/escaped — defense in depth on
  // top of the slug regex (which already excludes `"`, `\`, `${`, etc.).
  const idLiteral = JSON.stringify(opts.id);
  const lines: string[] = [
    "// Auto-generated build entry",
    'import type { CommunityIntegrationModule } from "@openmapx/core";',
    "",
  ];
  for (const file of present) {
    const local = FRONTEND_LOCAL_NAME[file];
    lines.push(`import ${local} from "./${file.replace(/\.tsx$/, "")}";`);
  }
  lines.push("", `const mod: CommunityIntegrationModule = { id: ${idLiteral} };`);
  for (const file of present) {
    lines.push(`mod.${FRONTEND_EXPORT_NAME[file]} = ${FRONTEND_LOCAL_NAME[file]};`);
  }
  lines.push(
    "",
    "window.__openmapx_integrations = window.__openmapx_integrations || [];",
    "window.__openmapx_integrations.push(mod);",
    "",
  );
  writeFileSync(entryPath, lines.join("\n"), "utf-8");

  const bundlePath = frontendBundlePath(directory);
  try {
    opts.signal?.throwIfAborted();
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      outfile: bundlePath,
      // React and @openmapx/core are exposed as singletons through the host
      // page's import map (apps/web/src/app/layout.tsx). Any other dep the
      // integration uses gets bundled in.
      external: [...FRONTEND_RUNTIME_EXTERNALS],
      jsx: "automatic",
      target: "es2022",
      minify: true,
      absWorkingDir: directory,
      logLevel: "warning",
    });
    opts.onLog?.(`frontend bundle → ${bundlePath}`, "stdout");
  } finally {
    rmSync(entryPath, { force: true });
  }

  return { bundlePath, skipped: false };
}
