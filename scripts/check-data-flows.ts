/**
 * Pre-commit guard: every external host an integration contacts at runtime must
 * be disclosed as a declared data source (so it appears in /privacy + /terms),
 * and a server-only source must not actually render media client-side.
 *
 * What it does, per integration under integrations/:
 *   1. Statically extracts the external hosts its runtime code contacts — both
 *      from its own files AND from the shared `@openmapx/core` / `@openmapx/mobility-core`
 *      clients it imports (resolved through the barrel/subpath export maps and the
 *      intra-package relative-import graph, so e.g. importing `overpassQuerySafe`
 *      pulls in overpass-api.de + overpass.kumi.systems).
 *   2. Normalizes every host to its registrable domain (eTLD+1) so cosmetic
 *      `api.`/`data.` subdomain differences don't flag.
 *   3. Diffs against the registrable domains declared in the manifest's
 *      `dataSources[].url`. Anything left over — minus a built-in allowlist of
 *      docs/license/own-infra hosts and a checked-in suppressions file — is an
 *      undisclosed third-party data flow and fails the check.
 *   4. Media-exposure: flags a data source whose `endUserExposure` is "server-only"
 *      while the integration emits image/media URLs for a host that the API
 *      image-proxy does NOT allowlist (so the browser would load it directly).
 *
 * Accepted exceptions live in scripts/data-flows.allow.json. Run on demand with
 * `pnpm check-data-flows`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");
const ALLOW_FILE = join(REPO_ROOT, "scripts", "data-flows.allow.json");

/** Shared workspace packages whose clients we follow into. */
const SHARED_PACKAGES: Record<string, string> = {
  "@openmapx/core": join(REPO_ROOT, "packages/core"),
  "@openmapx/mobility-core": join(REPO_ROOT, "packages/mobility-core"),
};

/**
 * Multi-label public suffixes we need to compute eTLD+1 correctly (no PSL lib in
 * the tree). Anything not listed falls back to the last two labels.
 */
const MULTI_SUFFIX = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "com.br",
  "gov.br",
  "org.br",
  "co.jp",
  "or.jp",
  "ne.jp",
  "go.jp",
  "ac.jp",
  "co.za",
  "com.tr",
  "gov.tr",
  "com.mx",
  "com.ar",
  "gob.ar",
  "co.in",
  "gov.in",
  "org.in",
  "com.sg",
  "gov.sg",
  "com.my",
  "gov.my",
  "co.id",
  "go.id",
  "com.ua",
  "gov.ua",
]);

/**
 * Built-in allowlist of registrable domains that are never a disclosable data
 * flow: license/docs hosts, font/asset CDNs, and same-controller CDN siblings of
 * declared catalog hosts (github / jsdelivr). Own-infra (localhost, docker
 * service names, *.test) is filtered earlier and never reaches here.
 */
const ALLOWED_DOMAINS = new Set([
  // License / spec / docs
  "creativecommons.org",
  "opendatacommons.org",
  "w3.org",
  "schema.org",
  "spdx.org",
  "gnu.org",
  "apache.org",
  "opensource.org",
  "mozilla.org",
  "github.io",
  // Catalog/code hosts (server-side, no user data) + their CDN siblings
  "github.com",
  "githubusercontent.com",
  "jsdelivr.net",
  "jsdelivr.com",
  // Our own + fonts/assets
  "openmapx.org",
  "google.com",
  "gstatic.com",
  "googleapis.com",
  "plus.codes",
  // Shared OSM geo infrastructure used as a server-side utility across many
  // integrations (reverse-geocode / POI / fallback) and disclosed in full by the
  // geocoding-nominatim / poi-overpass integrations. ODbL, server-side, bbox only.
  "openstreetmap.org",
  "nominatim.org",
  "overpass-api.de",
  "kumi.systems",
  // Disclosed controllers reached at a sibling host than the declared one (same
  // org, same privacy policy — eTLD+1 can't see the relationship).
  "entur.io", // Entur AS API host (sources declare developer.entur.org)
  "transitous.org", // Transitous (sources declare api.transitous.org)
  "staticflickr.com", // Flickr CDN (declared as flickr.com; images go via the proxy)
  "wikidata.org", // Wikimedia (disclosed by the knowledge integrations)
  "wikimedia.org",
  "sharedmobility.ch", // Swiss shared-mobility GBFS catalog (server-side)
  // Multi-tenant open-data platforms / generic infra that merely *host* feeds.
  "opendatasoft.com", // Opendatasoft SAS platform (disclosed via ev-charging)
  "govdata.de", // German open-data catalog (feed discovery)
  "azure.com", // generic cloud host where some open-data feeds live
]);

interface Suppressions {
  /** Registrable domains accepted globally. */
  global?: string[];
  /** Registrable domains accepted for a specific integration id. */
  perIntegration?: Record<string, string[]>;
}

interface Finding {
  integrationId: string;
  dir: string;
  kind: "undisclosed-host" | "media-exposure";
  detail: string;
}

const HOST_RE = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)/gi;
// Follow only *value* imports/exports when walking the shared-package graph — a
// `import type`/`export type` reaches no runtime host, and following it
// over-attributes hosts to integrations that merely use a type.
const REL_IMPORT_RE =
  /(?:^|[\n;])\s*(?:import|export)\s+(?!type\s)[^\n;]*?\bfrom\s+["'](\.[^"']+)["']/g;

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Lowercase registrable domain (eTLD+1) for a hostname. */
export function registrable(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join(".") : last2;
}

/** Is this an own-infra / test / non-routable host we should ignore? */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes(".")) return true; // single-label docker service name (app-api, nominatim, …)
  if (h === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
  return /\.(test|example|invalid|local|internal|localhost)$/.test(h) || h === "example.com";
}

/**
 * Remove comments before host extraction so dataset-provenance URLs in JSDoc
 * (e.g. `* https://ckan.open.nrw.de/dataset/...`) aren't mistaken for a runtime
 * data flow. Strips block comments wholesale, and line comments only when the
 * `//` isn't part of a `://` scheme (so real URLs in string literals survive).
 */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function extractHosts(content: string): Set<string> {
  const hosts = new Set<string>();
  const src = stripComments(content);
  for (const m of src.matchAll(HOST_RE)) {
    const host = m[1].toLowerCase();
    // Skip template-interpolated hosts — `https://www.x.${country}.com` captures a
    // truncated "www.x" that isn't a real host (these are deep-link URL builders).
    const tail = src.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 2);
    if (/^\.?\$/.test(tail)) continue;
    if (host.includes("http")) continue; // two adjacent URLs concatenated (e.g. "nps.govhttps")
    if (!isInternalHost(host)) hosts.add(host);
  }
  return hosts;
}

/** All .ts/.tsx runtime files under a dir (excluding tests, node_modules, dist). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "strings")
          continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Resolve a relative import specifier from a file to an on-disk .ts(x) file. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Transitive external hosts reachable from a shared-package entry file (cached). */
const transitiveCache = new Map<string, Set<string>>();
function transitiveHosts(entryFile: string): Set<string> {
  const cached = transitiveCache.get(entryFile);
  if (cached) return cached;
  const hosts = new Set<string>();
  transitiveCache.set(entryFile, hosts); // set early to break import cycles
  const seen = new Set<string>([entryFile]);
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (!file || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const h of extractHosts(content)) hosts.add(h);
    for (const m of content.matchAll(REL_IMPORT_RE)) {
      const resolved = resolveRelative(file, m[1]);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        stack.push(resolved);
      }
    }
  }
  return hosts;
}

/** Build a `symbol -> source file` map from a barrel's named re-exports. */
function buildBarrelMap(indexFile: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(indexFile)) return map;
  const content = readFileSync(indexFile, "utf8");
  const re = /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](\.[^"']+)["']/g;
  for (const m of content.matchAll(re)) {
    const file = resolveRelative(indexFile, m[2]);
    if (!file) continue;
    for (const raw of m[1].split(",")) {
      const name = raw
        .replace(/\btype\s+/g, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) map.set(name, file);
    }
  }
  return map;
}

/** Resolve a package subpath export (e.g. "./gbfs-provider-base") to a file. */
function subpathFile(
  packageRoot: string,
  exportsMap: Record<string, unknown>,
  subpath: string,
): string | null {
  const entry = exportsMap[subpath] as { default?: string } | string | undefined;
  const rel = typeof entry === "string" ? entry : entry?.default;
  if (!rel) return null;
  const file = resolve(packageRoot, rel);
  return existsSync(file) ? file : null;
}

interface SharedResolver {
  barrel: Map<string, string>;
  exportsMap: Record<string, unknown>;
  packageRoot: string;
  indexFile: string;
}

function buildSharedResolvers(): Record<string, SharedResolver> {
  const out: Record<string, SharedResolver> = {};
  for (const [pkg, root] of Object.entries(SHARED_PACKAGES)) {
    const pkgJson = readJson<{ exports?: Record<string, unknown> }>(join(root, "package.json"));
    const exportsMap = pkgJson?.exports ?? {};
    const dotEntry = exportsMap["."] as { default?: string } | undefined;
    const indexFile = resolve(root, dotEntry?.default ?? "src/index.ts");
    out[pkg] = { barrel: buildBarrelMap(indexFile), exportsMap, packageRoot: root, indexFile };
  }
  return out;
}

const IMPORT_RE =
  /import\s+(type\s+)?(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+\w+|(\w+))?\s*from\s+["']([^"']+)["']/g;

/** Hosts contacted via an integration's imports of the shared packages. */
function sharedHostsForFile(
  content: string,
  resolvers: Record<string, SharedResolver>,
): Set<string> {
  const hosts = new Set<string>();
  for (const m of content.matchAll(IMPORT_RE)) {
    const isTypeOnly = Boolean(m[1]);
    if (isTypeOnly) continue;
    const named = m[3];
    const spec = m[5];

    let pkg: string | undefined;
    for (const p of Object.keys(SHARED_PACKAGES)) {
      if (spec === p || spec.startsWith(`${p}/`)) {
        pkg = p;
        break;
      }
    }
    if (!pkg) continue;
    const resolver = resolvers[pkg];
    const entryFiles: string[] = [];

    if (spec === pkg) {
      // Barrel import — resolve each value symbol to its defining file.
      const symbols = (named ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0].trim());
      for (const sym of symbols) {
        const file = resolver.barrel.get(sym);
        if (file) entryFiles.push(file);
      }
    } else {
      // Subpath import — resolve via the exports map.
      const subpath = `.${spec.slice(pkg.length)}`;
      const file = subpathFile(resolver.packageRoot, resolver.exportsMap, subpath);
      if (file) entryFiles.push(file);
    }

    for (const file of entryFiles) {
      for (const h of transitiveHosts(file)) hosts.add(h);
    }
  }
  return hosts;
}

/** Image hosts the API image-proxy will fetch on the browser's behalf. */
function imageProxyAllowedHosts(): Set<string> {
  const file = join(REPO_ROOT, "apps/api/src/routes/image-proxy.ts");
  const set = new Set<string>();
  if (!existsSync(file)) return set;
  const content = readFileSync(file, "utf8");
  const block = content.match(/ALLOWED_HOSTS\s*=\s*\[([\s\S]*?)\]/);
  if (block) {
    for (const m of block[1].matchAll(/["']([a-z0-9.-]+)["']/gi)) set.add(m[1].toLowerCase());
  }
  return set;
}

/** Does a host match an image-proxy allowlist entry (host or subdomain)? */
export function proxyAllows(host: string, allow: Set<string>): boolean {
  const h = host.toLowerCase();
  for (const a of allow) if (h === a || h.endsWith(`.${a}`)) return true;
  return false;
}

const MEDIA_HOST_RE =
  /(?:thumbnailUrl|imageUrl|photoUrl|image|src)?\s*[:=]?\s*["'`]https?:\/\/([a-z0-9.-]+)\/[^"'`]*\.(?:jpe?g|png|webp|gif|svg|avif)/gi;

function main(): void {
  // `--audit` lists, per integration, contacted hosts whose registrable domain is
  // already declared but whose exact host isn't the url/apiHost ("sibling" hosts).
  // These are covered by the eTLD+1 match, so adding apiHosts for them is optional
  // documentation, not required — it confirms nothing necessary is missing.
  const AUDIT = process.argv.includes("--audit");
  const resolvers = buildSharedResolvers();
  const proxyHosts = imageProxyAllowedHosts();
  const supp = readJson<Suppressions>(ALLOW_FILE) ?? {};
  const globalSupp = new Set((supp.global ?? []).map((d) => d.toLowerCase()));

  const findings: Finding[] = [];
  const auditByDir = new Map<string, string[]>();

  for (const entry of readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const dir = join(INTEGRATIONS_DIR, entry.name);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson<{
      id?: string;
      dataSources?: { url?: string; endUserExposure?: string; apiHosts?: string[] }[];
    }>(manifestPath);
    if (!manifest) continue;
    const id = manifest.id ?? entry.name;
    const sources = manifest.dataSources ?? [];

    // Declared registrable domains: the host of each source's `url` plus any
    // explicit `apiHosts` (the real data-API host when it differs from `url`).
    const declared = new Set<string>();
    const declaredExact = new Set<string>();
    for (const ds of sources) {
      const m = (ds.url ?? "").match(/^https?:\/\/([a-z0-9.-]+)/i);
      if (m && !isInternalHost(m[1])) {
        declared.add(registrable(m[1]));
        declaredExact.add(m[1].toLowerCase());
      }
      for (const host of ds.apiHosts ?? []) {
        const h = host
          .replace(/^https?:\/\//, "")
          .split("/")[0]
          .toLowerCase();
        if (h && !isInternalHost(h)) {
          declared.add(registrable(h));
          declaredExact.add(h);
        }
      }
    }

    // Contacted hosts (own files + shared clients) and media-host scan.
    const contacted = new Set<string>();
    const mediaHosts = new Set<string>();
    for (const file of listSourceFiles(dir)) {
      const content = readFileSync(file, "utf8");
      for (const h of extractHosts(content)) contacted.add(h);
      for (const h of sharedHostsForFile(content, resolvers)) contacted.add(h);
      for (const m of stripComments(content).matchAll(MEDIA_HOST_RE)) {
        const host = m[1].toLowerCase();
        if (!isInternalHost(host)) mediaHosts.add(host);
      }
    }

    const perSupp = new Set((supp.perIntegration?.[id] ?? []).map((d) => d.toLowerCase()));

    // 1) Undisclosed-host diff (by registrable domain).
    const undisclosed = new Set<string>();
    for (const host of contacted) {
      const dom = registrable(host);
      if (declared.has(dom)) continue;
      if (ALLOWED_DOMAINS.has(dom) || globalSupp.has(dom) || perSupp.has(dom)) continue;
      undisclosed.add(dom);
    }
    for (const dom of [...undisclosed].sort()) {
      findings.push({
        integrationId: id,
        dir,
        kind: "undisclosed-host",
        detail: `${dom} (contacted but not in any dataSources[].url)`,
      });
    }

    // 2) Media-exposure: server-only source but media host not proxied.
    const hasServerOnly = sources.some((s) => s.endUserExposure === "server-only");
    if (hasServerOnly) {
      for (const host of mediaHosts) {
        if (proxyAllows(host, proxyHosts)) continue;
        if (/^tiles?\d*[.-]/.test(host)) continue; // map raster tiles load direct by design, not photo media
        const dom = registrable(host);
        if (ALLOWED_DOMAINS.has(dom) || globalSupp.has(dom) || perSupp.has(dom)) continue;
        findings.push({
          integrationId: id,
          dir,
          kind: "media-exposure",
          detail: `${host} — image URL emitted but not in the API image-proxy allowlist while a source is "server-only" (would load directly in the browser → exposure may be "direct"/"mixed", or add the host to the image-proxy allowlist)`,
        });
      }
    }

    if (AUDIT) {
      const siblings = [...contacted]
        .filter((h) => !declaredExact.has(h) && declared.has(registrable(h)))
        .sort();
      if (siblings.length) auditByDir.set(dir, siblings);
    }
  }

  if (AUDIT) {
    const uncovered = findings.filter((f) => f.kind === "undisclosed-host").length;
    let total = 0;
    console.log(
      "Data-flow audit — sibling hosts (contacted host shares a declared source's registrable\n" +
        "domain but isn't its exact url/apiHost; covered by the eTLD+1 match, so apiHosts here is\n" +
        "optional documentation, not required):\n",
    );
    for (const dir of [...auditByDir.keys()].sort()) {
      const siblings = auditByDir.get(dir) ?? [];
      total += siblings.length;
      console.log(`${relative(REPO_ROOT, dir)}\n  ${siblings.join(", ")}`);
    }
    if (total === 0) console.log("(none)");
    console.log(
      `\nSummary: ${uncovered} uncovered host(s) [would fail the gate], ${total} sibling-host case(s) [optional apiHosts candidates].`,
    );
    return;
  }

  if (findings.length === 0) {
    console.log(
      "✓ Data flows: every contacted host is declared or allowlisted; no media-exposure mismatches.",
    );
    return;
  }

  const byDir = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byDir.get(f.dir) ?? [];
    list.push(f);
    byDir.set(f.dir, list);
  }

  console.error(
    `✖ Data flows: ${findings.length} issue(s) across ${byDir.size} integration(s).\n` +
      "  Declare the host as a dataSources entry, fix the exposure, or add an accepted\n" +
      "  exception to scripts/data-flows.allow.json.\n",
  );
  for (const dir of [...byDir.keys()].sort()) {
    console.error(relative(REPO_ROOT, dir));
    for (const f of byDir.get(dir) ?? []) {
      console.error(`  • [${f.kind}] ${f.detail}`);
    }
    console.error("");
  }
  process.exit(1);
}

// Only run the gate when executed directly (CLI / pre-commit), so importing this
// module for its pure helpers (registrable, isInternalHost, …) is side-effect-free.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
