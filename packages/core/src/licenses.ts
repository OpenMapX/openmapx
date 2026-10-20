// Open-source license discovery.
//
// Walks production dependencies from one or more root `package.json`s, follows
// the pnpm/npm resolution chain via Node's `createRequire`, and extracts a
// per-package license notice with the actual LICENSE file body when present.
//
// Used by:
//   - apps/web's build-time generator → JSON consumed by the /licenses page
//   - The CLI's `integrations package` command → ships `dist/licenses.json`
//     alongside community integration artifacts so the page can surface the
//     dependencies bundled into the artifact

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

export interface LicenseNotice {
  /** npm package name. */
  name: string;
  /** Installed version. */
  version: string;
  /** SPDX identifier (or `Custom` / `Not specified` when the field is missing). */
  license: string;
  /** Optional URL pointing at the license body. */
  licenseUrl?: string;
  /** Project homepage or repository URL. */
  projectUrl?: string;
  /** Full LICENSE file content when one was discovered next to the package. */
  licenseText?: string;
}

export interface ScanLicensesOptions {
  /**
   * `package.json` files whose production dependencies seed the walk. Each
   * file's dependencies + optionalDependencies are followed; the workspace
   * roots themselves are not emitted as notices.
   */
  rootPackageJsonPaths: string[];
  /**
   * Skip packages whose name starts with any of these prefixes — used to
   * exclude workspace packages from the notice list (they're not third-party
   * dependencies and have no separate license obligation).
   */
  skipNamePrefixes?: string[];
  /**
   * Cap the LICENSE file size we'll embed in the JSON. License files in the
   * wild are tens of KB at most; anything bigger is almost certainly not a
   * real license (some packages ship docs in `LICENSE.md`). Defaults to 64 KB.
   */
  maxLicenseTextBytes?: number;
}

const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "LICENSE-MIT",
  "LICENSE.MIT",
  "License",
  "License.md",
  "License.txt",
  "Licence",
  "Licence.md",
  "Licence.txt",
  "license",
  "license.md",
  "license.txt",
  "licence",
  "licence.md",
  "licence.txt",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
  "UNLICENSE",
] as const;

const LICENSE_DIRECTORIES = ["LICENSES", "Licenses", "licenses"] as const;

const ROOT_LICENSE_PATTERN = /^(?:licen[cs]e|copying|unlicense)(?:[-_.].+)?$/i;

const NON_TEXT_LICENSE_SUFFIX =
  /\.(?:[cm]?[jt]sx?|d\.[cm]?ts|json|ya?ml|toml|html?|css|sh|py|map|wasm|node|png|jpe?g|gif|svg|ico|pdf)$/i;

const SPDX_OPERATORS = new Set([
  "and",
  "or",
  "with",
  "custom",
  "not",
  "specified",
  "unlicensed",
  "see",
  "license",
  "in",
]);

interface PackageJsonShape {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string | { type?: string; url?: string };
  licenses?:
    | string
    | { type?: string; url?: string }
    | Array<string | { type?: string; url?: string }>;
  homepage?: string;
  repository?: string | { type?: string; url?: string; directory?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * Walk production deps from the given roots and return a sorted, deduped list
 * of license notices for every third-party package reachable from them.
 */
export function scanLicenses(opts: ScanLicensesOptions): LicenseNotice[] {
  const maxLicenseBytes = opts.maxLicenseTextBytes ?? 64 * 1024;
  const skipPrefixes = opts.skipNamePrefixes ?? [];
  const queue: Array<{ name: string; fromDir: string }> = [];
  const visited = new Set<string>();
  const noticesByKey = new Map<string, LicenseNotice>();

  for (const rootPath of opts.rootPackageJsonPaths) {
    const pkg = readPackageJson(rootPath);
    if (!pkg) continue;
    const fromDir = dirname(rootPath);
    for (const name of dependencyNames(pkg)) {
      queue.push({ name, fromDir });
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor];
    if (!item) continue;
    const { name, fromDir } = item;
    const pkgJsonPath = resolvePackageJsonPath(name, fromDir);
    if (!pkgJsonPath) continue;

    const realPath = realpathSafe(pkgJsonPath);
    if (visited.has(realPath)) continue;
    visited.add(realPath);

    const pkg = readPackageJson(realPath);
    if (!pkg) continue;
    const pkgName = pkg.name ?? name;
    const pkgVersion = pkg.version ?? "";
    const pkgDir = dirname(realPath);

    const isSkipped =
      pkg.private === true ||
      skipPrefixes.some((prefix) => pkgName.startsWith(prefix)) ||
      // Defensive: workspace packages with `main`/`exports` pointing at TS
      // source rarely live inside a `node_modules/` tree. If the resolved
      // dir doesn't contain a `node_modules` segment, treat it as a local
      // workspace package even if no prefix matched.
      !pkgDir.includes(`${sep}node_modules${sep}`);

    if (!isSkipped) {
      const key = `${pkgName}@${pkgVersion}`;
      if (!noticesByKey.has(key)) {
        noticesByKey.set(key, buildNotice(pkg, pkgName, pkgVersion, pkgDir, maxLicenseBytes));
      }
    }

    for (const depName of dependencyNames(pkg)) {
      queue.push({ name: depName, fromDir: pkgDir });
    }
  }

  return Array.from(noticesByKey.values()).sort(compareNotices);
}

function compareNotices(a: LicenseNotice, b: LicenseNotice): number {
  const byName = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.version.localeCompare(b.version, "en", { numeric: true });
}

function readPackageJson(path: string): PackageJsonShape | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJsonShape;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: PackageJsonShape): string[] {
  return Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) });
}

function resolvePackageJsonPath(name: string, fromDir: string): string | null {
  const req = createRequire(join(fromDir, "package.json"));
  // Fast path — most packages expose `./package.json` in their `exports` map.
  try {
    return req.resolve(`${name}/package.json`);
  } catch {
    // Some packages restrict access to package.json via the `exports` field.
    // Resolve the entry point and walk back to the nearest package.json.
  }
  try {
    return findEnclosingPackageJson(req.resolve(name)) ?? findNodeModulesPackageJson(name, fromDir);
  } catch {
    return findNodeModulesPackageJson(name, fromDir);
  }
}

function findEnclosingPackageJson(entry: string): string | null {
  let dir = dirname(entry);
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "package.json");
    const pkg = readPackageJson(candidate);
    // Skip subdirectory module-type markers (e.g. `dist/cjs/package.json`
    // containing only `{"type": "commonjs"}`) that lack a package name.
    if (typeof pkg?.name === "string" && pkg.name.trim() !== "") {
      return candidate;
    }
    dir = dirname(dir);
  }
  return null;
}

function findNodeModulesPackageJson(name: string, fromDir: string): string | null {
  let dir = fromDir;
  while (dir !== dirname(dir)) {
    const nested = join(dir, "node_modules", name, "package.json");
    if (existsSync(nested)) return nested;
    dir = dirname(dir);
  }
  return null;
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function buildNotice(
  pkg: PackageJsonShape,
  name: string,
  version: string,
  pkgDir: string,
  maxLicenseBytes: number,
): LicenseNotice {
  const info = extractLicenseField(pkg);
  const notice: LicenseNotice = {
    name,
    version,
    license: info.license,
    licenseUrl: info.licenseUrl,
    projectUrl: extractProjectUrl(pkg),
  };
  const text = readLicenseFile(pkgDir, maxLicenseBytes, info.license);
  if (text) notice.licenseText = text;
  return notice;
}

function extractLicenseField(pkg: PackageJsonShape): { license: string; licenseUrl?: string } {
  const sources: Array<string | { type?: string; url?: string }> = [];
  if (pkg.license !== undefined) sources.push(pkg.license);
  if (Array.isArray(pkg.licenses)) sources.push(...pkg.licenses);
  else if (pkg.licenses !== undefined) sources.push(pkg.licenses);

  for (const entry of sources) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed) return { license: trimmed };
    } else if (entry && typeof entry === "object") {
      const type = entry.type?.trim();
      if (type) return { license: type, licenseUrl: normalizeUrl(entry.url) };
    }
  }
  return { license: "Not specified" };
}

function extractProjectUrl(pkg: PackageJsonShape): string | undefined {
  const homepage = normalizeUrl(pkg.homepage);
  if (homepage) return homepage;
  const repo = pkg.repository;
  if (!repo) return undefined;
  return normalizeUrl(typeof repo === "string" ? repo : repo.url);
}

function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const cleaned = url
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  if (!cleaned) return undefined;
  if (cleaned.startsWith("git://")) return `https://${cleaned.slice("git://".length)}`;
  if (cleaned.startsWith("github:")) return `https://github.com/${cleaned.slice("github:".length)}`;
  return cleaned.startsWith("http://") || cleaned.startsWith("https://") ? cleaned : undefined;
}

function readTextFileWithinLimit(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const text = readFileSync(fd, "utf8").trim();
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

function joinLicenseTexts(paths: string[], maxBytes: number): string | undefined {
  const parts: string[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const text = readTextFileWithinLimit(path, maxBytes);
    if (!text) continue;
    const separatorBytes = parts.length > 0 ? 7 : 0; // "\n\n---\n\n".length
    const nextBytes = Buffer.byteLength(text, "utf8");
    if (totalBytes + separatorBytes + nextBytes > maxBytes) continue;
    parts.push(text);
    totalBytes += separatorBytes + nextBytes;
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}

function extractSpdxTokens(declaredLicense: string | undefined): string[] {
  if (!declaredLicense) return [];
  const rawTokens = declaredLicense.split(/[\s(),/]+/);
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTokens) {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || SPDX_OPERATORS.has(cleaned)) continue;
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      tokens.push(cleaned);
    }
  }
  return tokens;
}

function stripLicenseExtension(filename: string): string {
  return filename.replace(/\.(?:txt|md|rst|license|licence)$/i, "").toLowerCase();
}

function readLicenseDirectory(
  pkgDir: string,
  entries: Set<string>,
  maxBytes: number,
  declaredLicense?: string,
): string | undefined {
  for (const dirName of LICENSE_DIRECTORIES) {
    if (!entries.has(dirName)) continue;
    const dirPath = join(pkgDir, dirName);
    let children: string[];
    try {
      children = readdirSync(dirPath)
        .filter((name) => !name.startsWith(".") && !NON_TEXT_LICENSE_SUFFIX.test(name))
        .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    } catch {
      continue;
    }
    if (children.length === 0) continue;

    // Prefer license files matching the package's declared SPDX expression
    // (e.g. REUSE 3.3 `LICENSES/<SPDX-ID>.txt`), since REUSE directories can
    // also carry auxiliary licenses for build configs, docs, or demo sites.
    const spdxTokens = extractSpdxTokens(declaredLicense);
    if (spdxTokens.length > 0) {
      const matchedPaths: string[] = [];
      const used = new Set<string>();
      for (const token of spdxTokens) {
        for (const child of children) {
          if (used.has(child)) continue;
          const stem = stripLicenseExtension(child);
          if (stem === token || child.toLowerCase() === token) {
            used.add(child);
            matchedPaths.push(join(dirPath, child));
          }
        }
      }
      const matchedText = joinLicenseTexts(matchedPaths, maxBytes);
      if (matchedText) return matchedText;
    }

    const fallbackText = joinLicenseTexts(
      children.map((child) => join(dirPath, child)),
      maxBytes,
    );
    if (fallbackText) return fallbackText;
  }
  return undefined;
}

function readLicenseFile(
  pkgDir: string,
  maxBytes: number,
  declaredLicense?: string,
): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(pkgDir);
  } catch {
    return undefined;
  }
  const present = new Set(entries);
  for (const candidate of LICENSE_FILENAMES) {
    if (!present.has(candidate)) continue;
    const text = readTextFileWithinLimit(join(pkgDir, candidate), maxBytes);
    if (text) return text;
  }

  // Match suffixed or multi-license root files (e.g. `LICENSE-MIT.txt`,
  // `LICENSE.BSD`, or dual `license-mit` + `license-cc0`).
  const variantFiles = entries
    .filter((name) => ROOT_LICENSE_PATTERN.test(name) && !NON_TEXT_LICENSE_SUFFIX.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  if (variantFiles.length > 0) {
    const variantText = joinLicenseTexts(
      variantFiles.map((name) => join(pkgDir, name)),
      maxBytes,
    );
    if (variantText) return variantText;
  }

  // Support REUSE / SPDX `LICENSES/` (or `licenses/`) subdirectories.
  return readLicenseDirectory(pkgDir, present, maxBytes, declaredLicense);
}
