/**
 * Liveness check for the legal URLs declared in integration manifests.
 *
 * Every `manifest.json` data source carries a `providerPrivacyUrl` (privacy
 * policy) and optionally a `licenseUrl` (license text) that the /privacy and
 * /terms pages link to. A dead link there is a real legal/UX problem (we already
 * found one 404'd privacy URL by hand). This script collects those URLs across
 * all integrations, dedupes them, and does an HTTP status check on each.
 *
 * Classification (tuned to catch real rot without crying wolf — many providers
 * bot-block or rate-limit automated probes even though the page is fine):
 *   - OK         → final status < 400 (after following redirects).
 *   - DEAD       → 404 / 410 / any 5xx / DNS resolution failure. These FAIL the
 *                  check (exit non-zero); they mean the resource is gone or the
 *                  host doesn't exist.
 *   - UNVERIFIED → any other 4xx (401/403/405/406/429/400/451…) or a transient
 *                  network error (timeout, connection reset/refused, TLS). The
 *                  server is alive but refused our probe; reported for visibility
 *                  but NEVER blocks.
 * Each negative HEAD is confirmed with a real GET first, since HEAD is widely
 * mishandled.
 *
 * Covers only the two URL fields above (not the source `url` or `dpaUrl`, and not
 * the few hardcoded URLs in the legal page content).
 *
 * NOTE: this makes real network requests, so it is inherently slower and less
 * deterministic than the offline check-legal-tables guard. Run on demand with
 * `pnpm check-legal-urls`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");

/** The manifest fields this check covers. */
const URL_FIELDS = ["providerPrivacyUrl", "licenseUrl"] as const;
type UrlField = (typeof URL_FIELDS)[number];

/** How many requests to run at once, and how long to wait for each. */
const CONCURRENCY = 12;
const TIMEOUT_MS = 12_000;
/** A browser-like UA cuts down on bot-blocking false positives. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 OpenMapX-LinkCheck/1.0";

type Verdict = "ok" | "dead" | "unverified";

interface Usage {
  dir: string;
  integrationId: string;
  sourceId: string;
  field: UrlField;
}

interface UrlResult {
  url: string;
  verdict: Verdict;
  status?: number;
  error?: string;
}

interface ManifestDataSource {
  sourceId?: string;
  providerPrivacyUrl?: string;
  licenseUrl?: string;
}

/** Collect every (deduped) legal URL declared across the integration manifests. */
function collectUrls(): Map<string, Usage[]> {
  const usages = new Map<string, Usage[]>();
  if (!existsSync(INTEGRATIONS_DIR)) return usages;

  for (const entry of readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const dir = join(INTEGRATIONS_DIR, entry.name);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;

    let manifest: { id?: string; dataSources?: ManifestDataSource[] };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      continue;
    }
    const integrationId = manifest.id ?? entry.name;

    for (const ds of manifest.dataSources ?? []) {
      for (const field of URL_FIELDS) {
        const value = ds[field];
        if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) continue;
        const url = value.trim();
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
      headers: { "user-agent": USER_AGENT, accept: "*/*" },
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

/** True only for a permanent DNS resolution failure (host does not exist). */
function dnsFailed(err: unknown): boolean {
  let e: unknown = err;
  while (e && typeof e === "object") {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND") return true;
    if (code === "EAI_AGAIN") return false; // temporary name-resolution failure = transient
    const cause = (e as { cause?: unknown }).cause;
    if (!cause || cause === e) break;
    e = cause;
  }
  return false;
}

function classify(url: string, status: number | undefined, err: unknown): UrlResult {
  if (status !== undefined) {
    if (status < 400) return { url, status, verdict: "ok" };
    // Only these clearly mean the resource is gone or the server is broken.
    if (status === 404 || status === 410 || status >= 500) return { url, status, verdict: "dead" };
    // Any other 4xx = server alive but refusing our automated probe — not dead.
    return { url, status, verdict: "unverified" };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { url, verdict: dnsFailed(err) ? "dead" : "unverified", error: message };
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
    try {
      status = await probe(url, "GET");
      err = undefined;
    } catch (e) {
      if (status === undefined) err = e; // keep a HEAD status if we had one
    }
  }

  return classify(url, status, err);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const reason = (r: UrlResult): string =>
  r.status != null ? `HTTP ${r.status}` : `unreachable: ${r.error}`;

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

  console.log(`Checking ${urls.length} unique legal URL(s) (privacy + license)…`);
  const results = await mapPool(urls, CONCURRENCY, checkUrl);
  const dead = results.filter((r) => r.verdict === "dead");
  const unverified = results.filter((r) => r.verdict === "unverified");

  // Unverified links are reported for visibility but never block: the server is
  // alive and just refused our probe, or the error was transient.
  if (unverified.length) {
    console.warn(
      `\n⚠ ${unverified.length} URL(s) could not be verified (server refused probe or transient error) — not blocking:`,
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
      "  Dead = 404/410/5xx/DNS failure. These privacy/license links render in /privacy and /terms;\n" +
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
