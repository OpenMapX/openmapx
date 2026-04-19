// packages/core/src/integration/installer.ts
//
// Pure functions for installing, removing, validating, and bundling community
// integrations under `custom_integrations/`. The CLI (`pnpm openmapx
// integrations …`) and the admin Store (`apps/api/src/services/store.ts`) both
// call into this module so they share one source of truth.
//
// Subprocess work (git, npx esbuild) goes through the shared
// `spawnWithBufferedLogs` helper in core. Filesystem ops are inline.

import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitShallowClone } from "../git-clone";
import { assertAllowedGitUrl } from "../git-url";
import { spawnWithBufferedLogs } from "../spawn";
import { INTEGRATION_ID_REGEX, validateManifest } from "./manifest";

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
    hasBundle: existsSync(join(directory, "dist", "index.js")),
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
  /** `github:user/repo`, an https Git URL, or an absolute/relative local path. */
  source: string;
  ref?: string;
  /**
   * Whether to allow installing from a local filesystem path. Defaults to
   * `true`. Set to `false` for admin-facing endpoints (the admin Store), where
   * arbitrary local paths are out-of-scope.
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
  mkdirSync(customDir(opts.rootDir), { recursive: true });

  const allowLocal = opts.allowLocalSources ?? true;
  const gitUrl = resolveGitUrl(opts.source);

  // Validate the source before doing any work. assertAllowedGitUrl throws on
  // non-https URLs and off-allowlist hosts; local paths are gated by the
  // caller-supplied flag.
  if (gitUrl) {
    assertAllowedGitUrl(gitUrl);
  } else if (!allowLocal) {
    throw new Error(
      `Source '${opts.source}' is not a github:<user>/<repo> spec or an https Git URL. Local paths are not allowed in this context.`,
    );
  }

  // Stage by either cloning into a tmp dir (git source) or copying into a tmp
  // dir (local source). The tmp dir lives long enough to validate the
  // manifest, then renameSync swaps it into place atomically.
  let stage: string;
  if (gitUrl) {
    stage = await gitShallowClone({
      url: gitUrl,
      ref: opts.ref,
      signal: opts.signal,
      onLog: opts.onLog,
    });
  } else {
    if (!existsSync(opts.source) || !statSync(opts.source).isDirectory()) {
      throw new Error(
        `Source '${opts.source}' is neither a github:<user>/<repo> spec, an https Git URL, nor an existing local directory`,
      );
    }
    stage = stageLocalSource(opts.source);
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

function stageLocalSource(source: string): string {
  const stage = join(tmpdir(), `openmapx-integration-${randomBytes(4).toString("hex")}`);
  cpSync(source, stage, { recursive: true });
  rmSync(join(stage, ".git"), { recursive: true, force: true });
  return stage;
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

const FRONTEND_FILES = ["map-layer.tsx", "legend.tsx", "panel.tsx"] as const;
type FrontendFile = (typeof FRONTEND_FILES)[number];

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

export async function buildIntegration(opts: BuildOptions): Promise<BuildResult> {
  const directory = resolveInstallTarget(opts.rootDir, opts.id);
  if (!existsSync(directory)) {
    throw new Error(`Community integration '${opts.id}' is not installed`);
  }
  const manifest = readManifest(directory);
  if (!manifest) {
    throw new Error(`No manifest.json in ${directory}`);
  }

  const present = FRONTEND_FILES.filter((f) => existsSync(join(directory, f)));
  if (present.length === 0) {
    return {
      bundlePath: null,
      skipped: true,
      reason: "no frontend components (map-layer/legend/panel)",
    };
  }

  // The build resolves `react`, `@openmapx/core`, etc. via the workspace's
  // hoisted node_modules — `npx esbuild` runs from the integration's directory
  // and walks up to find them. Surface a clear error rather than letting
  // esbuild fail mid-bundle.
  const repoNodeModules = join(opts.rootDir, "node_modules");
  if (!existsSync(repoNodeModules)) {
    throw new Error(
      `Cannot build '${opts.id}': ${repoNodeModules} not found. Run \`pnpm install\` at the repo root first.`,
    );
  }

  const distDir = join(directory, "dist");
  mkdirSync(distDir, { recursive: true });

  const entryPath = join(directory, ".build-entry.tsx");
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

  const bundlePath = join(distDir, "index.js");
  try {
    await spawnWithBufferedLogs(
      "npx",
      [
        "esbuild",
        entryPath,
        "--bundle",
        "--format=esm",
        `--outfile=${bundlePath}`,
        "--external:react",
        "--external:react-dom",
        "--external:@openmapx/core",
        "--external:maplibre-gl",
        "--external:@mui/*",
        "--jsx=automatic",
        "--target=es2022",
        "--minify",
      ],
      {
        cwd: directory,
        signal: opts.signal,
        onLog: opts.onLog,
      },
    );
  } finally {
    rmSync(entryPath, { force: true });
  }

  return { bundlePath, skipped: false };
}
