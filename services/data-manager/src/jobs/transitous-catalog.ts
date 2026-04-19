/**
 * Minimal Transitous catalog fetcher for the data-manager.
 *
 * Walks the `public-transport/transitous` GitHub repo (main branch) at
 * `feeds/*.json`, extracts every `sources[]` entry of type `http` + spec
 * `gtfs`, and returns `{id, country, url}` tuples that `downloadGtfs` can
 * stream through `curlAtomic`. Kept deliberately lightweight — no BBox
 * lookups, no local caching (data-manager already dedupes downloads via its
 * state store).
 */

const USER_AGENT = "openmapx-data-manager/1.0";
const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com/public-transport/transitous/main";
const TIMEOUT_MS = 15_000;

export interface TransitousFeed {
  id: string;
  country: string;
  url: string;
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

interface TransitousFeedSource {
  name: string;
  type: string;
  url?: string;
  spec?: string;
  skip?: boolean;
}

interface TransitousFeedFile {
  sources: TransitousFeedSource[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": USER_AGENT };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function slugify(name: string, countryCode: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `${countryCode}_${base}`;
}

export async function fetchTransitousCatalog(): Promise<TransitousFeed[]> {
  const tree = await fetchJson<{ tree: GitHubTreeEntry[] }>(
    `${GITHUB_API}/repos/public-transport/transitous/git/trees/main?recursive=1`,
  );
  if (!tree?.tree) {
    throw new Error(
      "Failed to list public-transport/transitous repository tree " +
        "(GitHub may be rate-limiting anonymous requests — set GITHUB_TOKEN to raise the limit to 5000 req/h)",
    );
  }

  const feedFiles = tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith("feeds/") && e.path.endsWith(".json"))
    .map((e) => e.path);

  const feeds: TransitousFeed[] = [];

  // Fetch feed files in parallel (max 10 concurrent) — same shape as the
  // apps/api catalog fetcher.
  for (let i = 0; i < feedFiles.length; i += 10) {
    const chunk = feedFiles.slice(i, i + 10);
    const results = await Promise.allSettled(
      chunk.map(async (path) => {
        const content = await fetchText(`${RAW_BASE}/${path}`);
        if (!content) return;
        const data = JSON.parse(content) as TransitousFeedFile;
        const filename = path.replace("feeds/", "").replace(".json", "");
        const countryCode = filename.split("-")[0].split(".")[0].toLowerCase();
        for (const source of data.sources ?? []) {
          if (source.skip) continue;
          if (source.type !== "http") continue;
          if (!source.url) continue;
          if ((source.spec ?? "gtfs") !== "gtfs") continue;
          feeds.push({
            id: slugify(source.name, countryCode),
            country: countryCode,
            url: source.url,
          });
        }
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[transitous-catalog] failed to parse feed file:", r.reason);
      }
    }
  }

  return feeds;
}
