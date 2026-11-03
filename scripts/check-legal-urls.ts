/**
 * Liveness check for the legal URLs declared in integration manifests.
 *
 * Every `manifest.json` data source carries a `url` (data portal / homepage) and
 * `providerPrivacyUrl` (privacy policy), and optionally licence, terms, DPA,
 * methodology and attribution-evidence links — which the /privacy, /terms, and
 * /licenses pages and source panels link to. A dead link there is a real legal/UX
 * problem (we already found one 404'd privacy URL by hand). This script collects
 * those URLs across all integrations, dedupes them, and HTTP-checks each.
 *
 * Classification (tuned to catch real rot without crying wolf — many providers
 * bot-block or rate-limit automated probes even though the page is fine):
 *   - OK         → final status < 400 (after following redirects).
 *   - DEAD       → GET-confirmed 404 / 410. These FAIL the check (exit non-zero).
 *   - UNVERIFIED → any other HTTP error, including 5xx, or a network/DNS error.
 *                  Outages and automated-request blocking do not prove link rot;
 *                  reported for visibility but NEVER blocks.
 * Each negative HEAD is confirmed with a real GET first, since HEAD is widely
 * mishandled.
 *
 * Covers every http(s) URL anywhere inside a data source, including nested
 * `licensing` bindings, declarations and evidence, so a schema change cannot
 * silently drop links from the check. The few hardcoded URLs in the legal page
 * content are not covered.
 *
 * NOTE: this makes real network requests, so it is inherently slower and less
 * deterministic than the offline check-legal-tables guard. Run on demand with
 * `pnpm check-legal-urls`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pMap from "p-map";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");

/** How many requests to run at once, and how long to wait for each. */
const CONCURRENCY = 12;
const TIMEOUT_MS = 12_000;
/** A browser-like UA cuts down on bot-blocking false positives. */
const USER_AGENT = "Mozilla/5.0";

/**
 * Ask for HTML the way a browser does. Some sites answer a bare wildcard Accept
 * header with a 404 for every path (Uber's developer docs do), which looks exactly
 * like a dead link. The low-priority wildcard keeps JSON/API URLs working.
 */
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

type Verdict = "ok" | "dead" | "unverified";

interface Usage {
  dir: string;
  integrationId: string;
  sourceId: string;
  /** Path of the URL inside its data source, e.g. `licensing.bindings[0].license.url`. */
  field: string;
}

interface UrlResult {
  url: string;
  verdict: Verdict;
  status?: number;
  error?: string;
}

interface ManifestDataSource {
  sourceId?: string;
  [field: string]: unknown;
}

/** Yield every http(s) URL string nested anywhere in `value`, with its path. */
function* nestedUrls(value: unknown, path = ""): Generator<[string, string]> {
  if (typeof value === "string") {
    const url = value.trim();
    if (/^https?:\/\//i.test(url)) yield [path, url];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* nestedUrls(item, `${path}[${index}]`);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      yield* nestedUrls(item, path ? `${path}.${key}` : key);
    }
  }
}

/**
 * Collect every (deduped) legal URL declared across the integration manifests.
 * An integration whose manifest sets `runtimeDataSources: true` has no static
 * URLs; it is reported, not checked, because its sources come from an upstream
 * at runtime.
 */
function collectUrls(): Map<string, Usage[]> {
  const usages = new Map<string, Usage[]>();
  if (!existsSync(INTEGRATIONS_DIR)) return usages;

  for (const entry of readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const dir = join(INTEGRATIONS_DIR, entry.name);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: {
      id?: string;
      runtimeDataSources?: boolean;
      dataSources?: ManifestDataSource[];
    };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }
    const integrationId = manifest.id ?? entry.name;
    if (manifest.runtimeDataSources === true) {
      console.log(
        `ℹ ${integrationId}: runtime data sources — their URLs are supplied by the upstream at runtime and not checked here.`,
      );
      continue;
    }

    for (const ds of manifest.dataSources ?? []) {
      for (const [field, url] of nestedUrls(ds)) {
        const usage: Usage = { dir, integrationId, sourceId: ds.sourceId ?? "?", field };
        const list = usages.get(url) ?? [];
        list.push(usage);
        usages.set(url, list);
      }
    }
  }
  return usages;
}

async function probe(url: string, method: "HEAD" | "GET"): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: ACCEPT },
    });
    // Free the socket without downloading the body.
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

function classify(url: string, status: number | undefined, err: unknown): UrlResult {
  if (status !== undefined) {
    if (status < 400) return { url, status, verdict: "ok" };
    // Only GET-confirmed missing resources block the check.
    if (status === 404 || status === 410) return { url, status, verdict: "dead" };
    // Other HTTP failures can be outages or automated-request blocking.
    return { url, status, verdict: "unverified" };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { url, verdict: "unverified", error: message };
}

/**
 * HEAD first (cheap). HEAD is widely mishandled, so confirm any non-success HEAD
 * — and any HEAD network error — with a real GET before trusting the result.
 */
async function checkUrl(url: string): Promise<UrlResult> {
  let status: number | undefined;
  let err: unknown;
  try {
    status = await probe(url, "HEAD");
  } catch (e) {
    err = e;
  }

  if (status === undefined || status >= 400) {
    // Retry transient GET failures once. Never preserve a negative HEAD result
    // when GET failed to confirm it: that result is unverified, not a dead link.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        status = await probe(url, "GET");
        err = undefined;
        if (status < 500 && status !== 429) break;
      } catch (e) {
        status = undefined;
        err = e;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return classify(url, status, err);
}

const reason = (r: UrlResult): string =>
  r.status != null ? `HTTP ${r.status}${r.error ? `; ${r.error}` : ""}` : `unreachable: ${r.error}`;

/** Expand each URL result into one entry per integration usage of that URL. */
function* withUsages(results: UrlResult[], usages: Map<string, Usage[]>) {
  for (const result of results) {
    for (const usage of usages.get(result.url) ?? []) {
      yield { dir: usage.dir, result, usage };
    }
  }
}

async function main(): Promise<void> {
  const usages = collectUrls();
  const urls = [...usages.keys()];
  if (urls.length === 0) {
    console.log("✓ No legal URLs declared in integration manifests.");
    return;
  }

  console.log(
    `Checking ${urls.length} unique legal URL(s) (source, privacy, licence, terms, DPA, evidence)…`,
  );
  const results = await pMap(urls, checkUrl, { concurrency: CONCURRENCY });
  const dead = results.filter((r) => r.verdict === "dead");
  const unverified = results.filter((r) => r.verdict === "unverified");

  // Unverified links are reported for visibility but never block: the server is
  // alive and just refused our probe, or the error was transient.
  if (unverified.length) {
    console.warn(
      `\n⚠ ${unverified.length} URL(s) could not be verified (HTTP or network/DNS failure) — not blocking:`,
    );
    for (const { dir, result, usage } of withUsages(unverified, usages)) {
      console.warn(
        `  ~ ${relative(REPO_ROOT, dir)} · ${usage.field} "${usage.sourceId}" → ${result.url}  [${reason(result)}]`,
      );
    }
  }

  if (dead.length === 0) {
    console.log(
      `\n✓ No dead legal URLs (${urls.length} checked${unverified.length ? `, ${unverified.length} unverifiable` : ""}).`,
    );
    return;
  }

  console.error(
    `\n✖ Legal URLs: ${dead.length} dead link(s) of ${urls.length} checked.\n` +
      "  Dead = GET-confirmed 404/410. These links render in /privacy, /terms, and /licenses;\n" +
      "  fix or replace them in manifest.json.\n",
  );

  const byDir = new Map<string, { result: UrlResult; usage: Usage }[]>();
  for (const { dir, result, usage } of withUsages(dead, usages)) {
    const list = byDir.get(dir) ?? [];
    list.push({ result, usage });
    byDir.set(dir, list);
  }
  for (const dir of [...byDir.keys()].sort()) {
    console.error(`${relative(REPO_ROOT, dir)}`);
    for (const { result, usage } of byDir.get(dir) ?? []) {
      console.error(
        `  • ${usage.field} · source "${usage.sourceId}" → ${result.url}  [${reason(result)}]`,
      );
    }
    console.error("");
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(`check-legal-urls crashed: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
