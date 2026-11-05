/** One deterministic source review shared by CLI and remote catalog proposals. */
import { createHash } from "node:crypto";
import type { TransitousFeedFile } from "./feed-source";
import {
  compileGbfsCatalog,
  type ExistingGbfsSource,
  type GbfsQuarantineEntry,
  type MobilityDataGbfsRow,
} from "./gbfs-catalog";

export type CatalogChangeField =
  | "endpoint"
  | "origin"
  | "license"
  | "attribution"
  | "eligibility"
  | "metadata";
export interface CatalogSourceChange {
  id: string;
  region: string;
  source: string;
  change: "added" | "removed" | "changed";
  fields: CatalogChangeField[];
  licenseStatus: "declared" | "unknown";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
export interface CatalogFeedDiff {
  digest: string;
  total: number;
  changes: CatalogSourceChange[];
  addedRegions: string[];
  removedRegions: string[];
  modifiedRegions: string[];
  addedSources: number;
  removedSources: number;
  licenseChanges: Array<{ region: string; source: string }>;
  requiresLicenseAcknowledgment: boolean;
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw Error("Catalog metadata is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`,
      )
      .join(",")}}`;
  throw Error("Catalog metadata must be JSON");
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Unreadable/malformed catalog entries may never disappear from a review. */
export function parseCatalogFeedFile(raw: string): TransitousFeedFile {
  if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024)
    throw Error("Catalog feed file exceeds its byte limit");
  const value: unknown = JSON.parse(raw);
  if (!object(value) || (value.sources !== undefined && !Array.isArray(value.sources)))
    throw Error("Invalid catalog feed file");
  canonical(value);
  const names = new Set<string>();
  for (const source of value.sources ?? []) {
    if (
      !object(source) ||
      typeof source.name !== "string" ||
      !source.name ||
      source.name.length > 512 ||
      names.has(source.name)
    )
      throw Error("Invalid or duplicate catalog source identity");
    names.add(source.name);
  }
  return value as TransitousFeedFile;
}
function sources(feeds: ReadonlyMap<string, TransitousFeedFile>) {
  const entries = new Map<
    string,
    { region: string; source: string; data: Record<string, unknown> }
  >();
  let bytes = 0;
  for (const [region, feed] of feeds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(region))
      throw Error("Invalid catalog region identity");
    const raw = canonical(feed);
    bytes += Buffer.byteLength(raw, "utf8");
    if (bytes > 128 * 1024 * 1024) throw Error("Catalog review exceeds its byte limit");
    for (const source of parseCatalogFeedFile(raw).sources ?? []) {
      const id = `${region}/${source.name}`;
      if (entries.has(id) || entries.size >= 100000)
        throw Error("Catalog review identity/entry limit");
      entries.set(id, {
        region,
        source: source.name!,
        data: source as unknown as Record<string, unknown>,
      });
    }
  }
  return entries;
}
const fieldKeys: Record<Exclude<CatalogChangeField, "metadata">, string[]> = {
  endpoint: ["url", "url-override", "spec", "type", "api-key"],
  origin: ["openmapx-origin", "origin", "transitland-atlas-id", "mdb-id"],
  license: ["license"],
  attribution: ["attribution", "attributions", "credit", "credits"],
  eligibility: ["skip", "skip-reason", "policy", "eligible"],
};
export function diffCatalogFeeds(
  previous: ReadonlyMap<string, TransitousFeedFile>,
  next: ReadonlyMap<string, TransitousFeedFile>,
): CatalogFeedDiff {
  const before = sources(previous),
    after = sources(next),
    changes: CatalogSourceChange[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(id),
      current = after.get(id),
      a = old?.data ?? null,
      b = current?.data ?? null;
    if (canonical(a) === canonical(b)) continue;
    const selected = current ?? old!;
    const fields: CatalogChangeField[] = [];
    for (const [field, keys] of Object.entries(fieldKeys)) {
      if (keys.some((key) => canonical(a?.[key] ?? null) !== canonical(b?.[key] ?? null)))
        fields.push(field as CatalogChangeField);
    }
    if (!fields.length) fields.push("metadata");
    const license = b?.license ?? a?.license;
    changes.push({
      id,
      region: selected.region,
      source: selected.source,
      change: !old ? "added" : !current ? "removed" : "changed",
      fields,
      licenseStatus: object(license) && Object.keys(license).length ? "declared" : "unknown",
      before: a,
      after: b,
    });
  }
  const addedRegions = [...next.keys()].filter((region) => !previous.has(region)).sort(),
    removedRegions = [...previous.keys()].filter((region) => !next.has(region)).sort();
  const licenseChanges = changes
    .filter(
      (row) =>
        row.change === "changed" &&
        (row.fields.includes("license") || row.fields.includes("attribution")),
    )
    .map(({ region, source }) => ({ region, source }));
  return {
    digest: createHash("sha256").update(canonical(changes)).digest("hex"),
    total: changes.length,
    changes,
    addedRegions,
    removedRegions,
    modifiedRegions: [
      ...new Set(
        changes
          .filter((row) => previous.has(row.region) && next.has(row.region))
          .map((row) => row.region),
      ),
    ].sort(),
    addedSources: changes.filter((row) => row.change === "added").length,
    removedSources: changes.filter((row) => row.change === "removed").length,
    licenseChanges,
    requiresLicenseAcknowledgment: changes.some(
      (row) =>
        row.fields.includes("license") ||
        row.fields.includes("attribution") ||
        (row.change === "added" && row.licenseStatus === "unknown"),
    ),
  };
}
export function catalogDiffPage(diff: CatalogFeedDiff, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > diff.total)
    throw Error("Invalid catalog review offset");
  const rows: CatalogSourceChange[] = [];
  let bytes = 4096;
  for (const row of diff.changes.slice(offset, offset + 100)) {
    const size = Buffer.byteLength(canonical(row), "utf8") + 1;
    if (size > 3 * 1024 * 1024 - 4096)
      throw Error("Catalog review row exceeds its full-metadata byte limit");
    if (bytes + size > 3 * 1024 * 1024) break;
    rows.push(row);
    bytes += size;
  }
  return {
    digest: diff.digest,
    total: diff.total,
    offset,
    rows,
    nextOffset: offset + rows.length < diff.total ? offset + rows.length : null,
  };
}
/** Read one exact Git object tree; never fall back to working-tree/remote HEAD. */
export async function readCatalogFeedSnapshot(
  commit: string,
  git: (args: string[]) => Promise<string>,
): Promise<Map<string, TransitousFeedFile>> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("Catalog review requires an exact commit");
  const listing = await git(["ls-tree", "-z", "--name-only", `${commit}:feeds`]);
  if (Buffer.byteLength(listing, "utf8") > 16 * 1024 * 1024)
    throw Error("Catalog listing exceeds its byte limit");
  const names = listing.split("\0").filter(Boolean);
  if (names.length > 50000) throw Error("Catalog listing exceeds its entry limit");
  const feeds = new Map<string, TransitousFeedFile>();
  let bytes = 0;
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const region = name.slice(0, -5);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(region) || feeds.has(region))
      throw Error("Invalid catalog feed filename");
    const raw = await git(["show", `${commit}:feeds/${name}`]);
    bytes += Buffer.byteLength(raw, "utf8");
    if (bytes > 128 * 1024 * 1024) throw Error("Catalog snapshot exceeds its byte limit");
    feeds.set(region, parseCatalogFeedFile(raw));
  }
  return feeds;
}

/** Read full feed-owned Atlas metadata at the exact gitlink, including license changes. */
export async function readAtlasFeedSnapshot(
  commit: string,
  git: (args: string[]) => Promise<string>,
): Promise<Map<string, TransitousFeedFile>> {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("Atlas review requires an exact commit");
  const listing = await git(["ls-tree", "-r", "-z", "--name-only", commit, "--", "feeds"]);
  if (Buffer.byteLength(listing, "utf8") > 16 * 1024 * 1024)
    throw Error("Atlas listing exceeds its byte limit");
  const names = listing.split("\0").filter(Boolean);
  if (names.length > 50000) throw Error("Atlas listing exceeds its entry limit");
  const result = new Map<string, TransitousFeedFile>(),
    ids = new Set<string>();
  let bytes = 0;
  for (const name of names.sort()) {
    if (!name.endsWith(".dmfr.json")) continue;
    if (
      !name.startsWith("feeds/") ||
      name.length > 4096 ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw Error("Invalid Atlas feed filename");
    const raw = await git(["show", `${commit}:${name}`]);
    bytes += Buffer.byteLength(raw, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024 || bytes > 128 * 1024 * 1024)
      throw Error("Atlas review exceeds its byte limit");
    const document: unknown = JSON.parse(raw);
    canonical(document);
    if (!object(document) || !Array.isArray(document.feeds))
      throw Error("Malformed Atlas feed metadata");
    const sources = document.feeds.map((feed: unknown) => {
      if (
        !object(feed) ||
        typeof feed.id !== "string" ||
        !feed.id ||
        feed.id.length > 512 ||
        ids.has(feed.id) ||
        ids.size >= 100000
      )
        throw Error("Invalid or duplicate Atlas feed identity");
      ids.add(feed.id);
      return {
        name: feed.id,
        origin: "transitland-atlas",
        metadata: feed,
        ...(object(feed.license) ? { license: feed.license } : {}),
      };
    });
    result.set(`atlas.${createHash("sha256").update(name).digest("hex").slice(0, 32)}`, {
      sources,
    });
  }
  return result;
}

/** Include every GBFS registry row, including exclusions/conflicts/quarantine. */
export function reviewCatalogPair(input: {
  previousFeeds: ReadonlyMap<string, TransitousFeedFile>;
  nextFeeds: ReadonlyMap<string, TransitousFeedFile>;
  previousAtlas?: ReadonlyMap<string, TransitousFeedFile>;
  nextAtlas?: ReadonlyMap<string, TransitousFeedFile>;
  previousGbfsRows: MobilityDataGbfsRow[];
  nextGbfsRows: MobilityDataGbfsRow[];
  countries: string[];
  quarantine: GbfsQuarantineEntry[];
  maxAdditions: number;
}): CatalogFeedDiff {
  const withGbfs = (
    feeds: ReadonlyMap<string, TransitousFeedFile>,
    rows: MobilityDataGbfsRow[],
  ) => {
    const existingSources: ExistingGbfsSource[] = [];
    for (const [region, feed] of feeds)
      for (const source of feed.sources ?? []) {
        if (source.spec === "gbfs" && source.url && source.name)
          existingSources.push({
            region,
            name: source.name,
            discoveryUrl: source.url,
            sourceId: source["openmapx-source-id"],
            provenance: "transitous",
          });
      }
    if (rows.length > 100000) throw Error("GBFS review exceeds its entry limit");
    const compiled = compileGbfsCatalog({
      rows,
      countries: input.countries,
      quarantine: input.quarantine,
      maxAdditions: input.maxAdditions,
      existingSources,
    });
    const grouped = new Map<string, typeof compiled.sourceIndex>();
    for (const entry of compiled.sourceIndex) {
      const group = grouped.get(entry.sourceId);
      if (group) group.push(entry);
      else grouped.set(entry.sourceId, [entry]);
    }
    const result = new Map(feeds);
    for (const [sourceId, entries] of grouped) {
      const first = entries[0]!,
        region = `mobilitydata.${/^[a-z]{2,3}$/.test(first.country) ? first.country : "unknown"}`;
      if (feeds.has(region)) throw Error("Catalog/GBFS namespace collision");
      const previous = result.get(region)?.sources ?? [];
      const source = {
        name: sourceId,
        spec: "gbfs" as const,
        type: "url" as const,
        url: first.discoveryUrl,
        origin: "mobilitydata",
        eligibility: entries.map((row) => ({
          status: row.status,
          reason: row.exclusionReason ?? null,
          preferredSourceId: row.preferredSourceId ?? null,
        })),
        registry: JSON.parse(JSON.stringify(entries)).sort((a: unknown, b: unknown) =>
          canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0,
        ),
      };
      result.set(region, { sources: [...previous, source] });
    }
    return result;
  };
  const withAtlas = (
    feeds: ReadonlyMap<string, TransitousFeedFile>,
    atlas: ReadonlyMap<string, TransitousFeedFile> | undefined,
  ) => {
    const result = new Map(feeds),
      referenced = new Set(
        [...feeds.values()].flatMap((feed) =>
          (feed.sources ?? [])
            .map((source) => source["transitland-atlas-id"])
            .filter((id): id is string => typeof id === "string"),
        ),
      );
    for (const [region, metadata] of atlas ?? []) {
      const sources = (metadata.sources ?? []).filter(
        (source) => source.name && referenced.has(source.name),
      );
      if (!sources.length) continue;
      if (result.has(region)) throw Error("Catalog/Atlas namespace collision");
      result.set(region, { sources });
    }
    return result;
  };
  return diffCatalogFeeds(
    withGbfs(withAtlas(input.previousFeeds, input.previousAtlas), input.previousGbfsRows),
    withGbfs(withAtlas(input.nextFeeds, input.nextAtlas), input.nextGbfsRows),
  );
}

/** Policy and overlay metadata share one canonical encoding across DM and host. */
export function catalogCompilerSettings(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const defaults = {
    MOTIS_TWO_SLOT: "false",
    MOTIS_GBFS_CATALOG_ENABLED: "false",
    MOTIS_GBFS_CATALOG_MAX_ADDITIONS: "50",
    MOTIS_GBFS_CATALOG_TIMEOUT_MS: "5000",
    MOTIS_GBFS_CATALOG_CONCURRENCY: "4",
    MOTIS_GBFS_CATALOG_MAX_FAILURE_RATIO: "0.35",
  };
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, env[key] ?? fallback]),
  );
}
export function catalogReviewInputDigests(
  operationsProfile: object,
  overlay: { patches: unknown[]; quarantine: unknown[] } | null,
  compilerSettings = catalogCompilerSettings({}),
) {
  return {
    overlayDigest: createHash("sha256").update(canonical(overlay)).digest("hex"),
    sourcePolicyRevision: createHash("sha256")
      .update(
        canonical({
          compilerSettings,
          operationsProfile: JSON.parse(JSON.stringify(operationsProfile)),
          sourcePolicy: { patches: overlay?.patches ?? [], quarantine: overlay?.quarantine ?? [] },
        }),
      )
      .digest("hex"),
  };
}
