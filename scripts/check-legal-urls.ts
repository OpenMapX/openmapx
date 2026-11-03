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
 *   - DEAD       → GET-confirmed 404 / 410, or a host name that does not exist
 *                  (NXDOMAIN, confirmed by a direct DNS query after a pause).
 *                  These FAIL the check (exit non-zero).
 *   - UNVERIFIED → any other HTTP error, including 5xx, or any other network/DNS
 *                  error, such as a timeout or a name server that does not answer.
 *                  Outages and automated-request blocking do not prove link rot;
 *                  reported for visibility but NEVER blocks.
 * Each negative HEAD is confirmed with a real GET first, since HEAD is widely
 * mishandled.
 *
 * Covers every http(s) URL anywhere inside a data source, including nested
 * `licensing` bindings, declarations and evidence, so a schema change cannot
 * silently drop links from the check. Placeholder addresses on the operator's own
 * machine or network (localhost, private IP ranges, `.local`) are skipped. The few
 * hardcoded URLs in the legal page content are not covered.
 *
 * When `LEGAL_URLS_REPORT` names a file, a Markdown report of the run is written
 * there; the scheduled workflow shows it in the run summary and in its issue.
 *
 * NOTE: this makes real network requests, so it is inherently slower and less
 * deterministic than the offline check-legal-tables guard. Run on demand with
 * `pnpm check-legal-urls`.
 */
import dns from "node:dns";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pMap from "p-map";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");

/** How many requests to run at once, and how long to wait for each. */
const CONCURRENCY = 12;
const TIMEOUT_MS = 12_000;
/** Pause before the DNS query that confirms a host name does not exist. */
const DNS_RECHECK_DELAY_MS = 2_000;
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

interface CollectedUrls {
  usages: Map<string, Usage[]>;
  skipped: Map<string, Usage[]>;
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
 * True for an address that can only exist on the operator's own machine or
 * network, such as a self-hosted server's documented default. Such a URL is a
 * placeholder rather than a public link, so it cannot be checked from CI.
 */
function isPlaceholderHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (hostname === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(hostname)) {
    return true;
  }
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(hostname) === 6) {
    return hostname === "::1" || /^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname);
  }
  return false;
}

function addUsage(map: Map<string, Usage[]>, url: string, usage: Usage): void {
  const list = map.get(url) ?? [];
  list.push(usage);
  map.set(url, list);
}

/**
 * Collect every (deduped) legal URL declared across the integration manifests.
 * An integration whose manifest sets `runtimeDataSources: true` has no static
 * URLs; it is reported, not checked, because its sources come from an upstream
 * at runtime.
 */
function collectUrls(): CollectedUrls {
  const usages = new Map<string, Usage[]>();
  const skipped = new Map<string, Usage[]>();
  if (!existsSync(INTEGRATIONS_DIR)) return { usages, skipped };

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
        addUsage(isPlaceholderHost(url) ? skipped : usages, url, usage);
      }
    }
  }
  return { usages, skipped };
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

/** The system error code behind a failed request, such as `ENOTFOUND`. */
function errorCode(err: unknown): string | undefined {
  const withCode = (value: unknown) =>
    value && typeof value === "object" && "code" in value && typeof value.code === "string"
      ? value.code
      : undefined;
  const cause = err && typeof err === "object" && "cause" in err ? err.cause : undefined;
  return withCode(cause) ?? withCode(err);
}

type HostResolution = "missing" | "no-answer" | "other";

/**
 * Ask DNS directly whether a host name exists, after a pause so that a brief
 * resolver failure is not mistaken for a missing domain. `missing` means both the
 * IPv4 and the IPv6 query answered NXDOMAIN.
 */
async function resolveHost(hostname: string): Promise<HostResolution> {
  await new Promise((done) => setTimeout(done, DNS_RECHECK_DELAY_MS));
  const resolver = new dns.promises.Resolver({ timeout: 5_000, tries: 2 });
  const codes = await Promise.all(
    [resolver.resolve4(hostname), resolver.resolve6(hostname)].map((query) =>
      query.then(
        () => "OK",
        (e: unknown) => errorCode(e) ?? "UNKNOWN",
      ),
    ),
  );
  if (codes.every((code) => code === dns.NOTFOUND)) return "missing";
  if (codes.every((code) => code === dns.SERVFAIL)) return "no-answer";
  return "other";
}

/** One DNS confirmation per host name, shared by every URL on that host. */
const hostResolutions = new Map<string, Promise<HostResolution>>();

function classify(url: string, status: number | undefined, err: unknown): UrlResult {
  if (status !== undefined) {
    if (status < 400) return { url, status, verdict: "ok" };
    // Only GET-confirmed missing resources block the check.
    if (status === 404 || status === 410) return { url, status, verdict: "dead" };
    // Other HTTP failures can be outages or automated-request blocking.
    return { url, status, verdict: "unverified" };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);
  return { url, verdict: "unverified", error: code ? `${message} (${code})` : message };
}

/**
 * A request that failed because the host name did not resolve is dead only when
 * a direct DNS query confirms the name does not exist. Any other DNS outcome
 * leaves it unverified.
 */
async function confirmMissingHost(result: UrlResult, err: unknown): Promise<UrlResult> {
  const code = errorCode(err);
  // Linux reports a name server that does not answer as a temporary failure.
  if (result.status !== undefined || (code !== "ENOTFOUND" && code !== "EAI_AGAIN")) {
    return result;
  }
  const hostname = new URL(result.url).hostname;
  let resolution = hostResolutions.get(hostname);
  if (!resolution) {
    resolution = resolveHost(hostname);
    hostResolutions.set(hostname, resolution);
  }
  switch (await resolution) {
    case "missing":
      return { url: result.url, verdict: "dead", error: "domain does not exist (NXDOMAIN)" };
    case "no-answer":
      return {
        ...result,
        error: `${result.error}; DNS SERVFAIL: the domain's name servers do not answer`,
      };
    default:
      return result;
  }
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

  return confirmMissingHost(classify(url, status, err), err);
}

const reason = (r: UrlResult): string =>
  r.status != null
    ? `HTTP ${r.status}${r.error ? `; ${r.error}` : ""}`
    : r.verdict === "dead"
      ? `${r.error}`
      : `unreachable: ${r.error}`;

/** Expand each URL result into one entry per integration usage of that URL. */
function* withUsages(results: UrlResult[], usages: Map<string, Usage[]>) {
  for (const result of results) {
    for (const usage of usages.get(result.url) ?? []) {
      yield { dir: usage.dir, result, usage };
    }
  }
}

/** Escape text for a Markdown table cell. */
const cell = (text: string): string => text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function markdownTable(results: UrlResult[], usages: Map<string, Usage[]>): string[] {
  const rows = [...withUsages(results, usages)].sort(
    (a, b) =>
      a.dir.localeCompare(b.dir) ||
      a.usage.sourceId.localeCompare(b.usage.sourceId) ||
      a.usage.field.localeCompare(b.usage.field),
  );
  return [
    "| Integration | Source | Field | URL | Result |",
    "|---|---|---|---|---|",
    ...rows.map(
      ({ dir, result, usage }) =>
        `| \`${cell(relative(REPO_ROOT, dir))}\` | \`${cell(usage.sourceId)}\` | \`${cell(usage.field)}\` | ${cell(result.url)} | ${cell(reason(result))} |`,
    ),
  ];
}

/** Write the Markdown report the scheduled workflow publishes, if one was requested. */
function writeReport(
  checked: number,
  dead: UrlResult[],
  unverified: UrlResult[],
  { usages, skipped }: CollectedUrls,
): void {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone network check runs outside Turbo; the scheduled workflow names its report file.
  const path = process.env.LEGAL_URLS_REPORT;
  if (!path) return;
  const lines = ["## Legal URL liveness", ""];
  lines.push(
    dead.length
      ? `**${dead.length} dead link(s)** of ${checked} checked. These links render in /privacy, /terms and /licenses: fix or replace them in the integration's \`manifest.json\`, then run \`pnpm check-legal-urls\`.`
      : `No dead links among ${checked} checked.`,
    "",
  );
  if (dead.length) lines.push(...markdownTable(dead, usages), "");
  if (unverified.length) {
    lines.push(
      "<details>",
      `<summary>${unverified.length} URL(s) could not be verified (not blocking)</summary>`,
      "",
      "Bot blocking, rate limits, server errors and network failures do not prove a link is dead. A link that stays here for weeks deserves a look in a browser.",
      "",
      ...markdownTable(unverified, usages),
      "",
      "</details>",
      "",
    );
  }
  if (skipped.size) {
    lines.push(
      `Skipped ${skipped.size} placeholder address(es) on the operator's own machine or network: ${[...skipped.keys()].map((url) => `\`${url}\``).join(", ")}.`,
      "",
    );
  }
  writeFileSync(path, lines.join("\n"));
}

async function main(): Promise<void> {
  const collected = collectUrls();
  const { usages, skipped } = collected;
  const urls = [...usages.keys()];
  for (const [url, list] of skipped) {
    console.log(
      `ℹ skipped placeholder ${url} (${list.map((u) => `${relative(REPO_ROOT, u.dir)} · ${u.field}`).join(", ")}) — not a public address.`,
    );
  }
  if (urls.length === 0) {
    console.log("✓ No public legal URLs declared in integration manifests.");
    writeReport(0, [], [], collected);
    return;
  }

  console.log(
    `Checking ${urls.length} unique legal URL(s) (source, privacy, licence, terms, DPA, evidence)…`,
  );
  const results = await pMap(urls, checkUrl, { concurrency: CONCURRENCY });
  const dead = results.filter((r) => r.verdict === "dead");
  const unverified = results.filter((r) => r.verdict === "unverified");
  writeReport(urls.length, dead, unverified, collected);

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
      "  Dead = GET-confirmed 404/410 or a domain that does not exist. These links render in\n" +
      "  /privacy, /terms, and /licenses; fix or replace them in manifest.json.\n",
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
