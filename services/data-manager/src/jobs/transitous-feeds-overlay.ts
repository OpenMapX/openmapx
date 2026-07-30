import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface FeedOverlayPatch {
  sourceId: string;
  skip: boolean;
}

export interface FeedOverlayGbfsSource {
  spec: "gbfs";
  type: "url";
  region: string;
  name: string;
  url: string;
  sourceId?: string;
  license?: string;
}

export interface FeedOverlayGtfsSource {
  spec: "gtfs";
  type: "http";
  region: string;
  name: string;
  url: string;
  origin: "operator";
  license: {
    spdxIdentifier?: string;
    url?: string;
    attribution: string;
    publisher?: string;
    publisherUrl?: string;
  };
}

export type FeedOverlaySource = FeedOverlayGbfsSource | FeedOverlayGtfsSource;

export interface FeedOverlayQuarantine {
  sourceId: string;
  reason: string;
  firstSeen: string;
  lastChecked: string;
}

export interface FeedOverlay {
  version: 3;
  sources: FeedOverlaySource[];
  patches: FeedOverlayPatch[];
  quarantine: FeedOverlayQuarantine[];
}

export interface FeedOverlayApplyResult {
  applied: number;
  added: number;
  quarantined: number;
  unmatched: FeedOverlayPatch[];
}

interface FeedSource {
  name?: string;
  url?: string;
  "url-override"?: string;
  "openmapx-source-id"?: string;
  [key: string]: unknown;
}

export interface FeedFile {
  region: string;
  sources?: FeedSource[];
  [key: string]: unknown;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value.trim();
}

function optionalString(value: unknown, message: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, message);
}

function assertExactKeys(item: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(item).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field "${unknown[0]}"`);
}

function validateRegion(value: unknown, label: string): string {
  const region = nonEmptyString(value, `${label} is missing string "region"`).toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z0-9]+)?$/.test(region))
    throw new Error(`${label} has invalid region "${region}"`);
  return region;
}

function validateHttpUrl(value: unknown, label: string): string {
  const url = nonEmptyString(value, `${label} is missing string "url"`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} has invalid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} URL must use http/https`);
  }
  if (parsed.username || parsed.password)
    throw new Error(`${label} URL must not embed credentials`);
  parsed.hash = "";
  return parsed.toString();
}

function validateSafeName(value: unknown, label: string): string {
  const name = nonEmptyString(value, `${label} is missing string "name"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name)) {
    throw new Error(`${label} name must match [A-Za-z0-9][A-Za-z0-9.-]*`);
  }
  return name;
}

export function operatorSourceId(region: string, name: string): string {
  return `operator:${region}:${name}`;
}

export function catalogSourceId(region: string, name: string): string {
  return `catalog:${region}:${name}`;
}

function parseSource(value: unknown, index: number, path: string): FeedOverlaySource {
  const label = `Feeds overlay source #${index} at ${path}`;
  const item = record(value, `${label} is not an object`);
  const region = validateRegion(item.region, label);
  const url = validateHttpUrl(item.url, label);
  if (item.spec === "gbfs" && item.type === "url") {
    assertExactKeys(item, ["spec", "type", "region", "name", "url", "sourceId", "license"], label);
    return {
      spec: "gbfs",
      type: "url",
      region,
      name: nonEmptyString(item.name, `${label} is missing string "name"`),
      url,
      sourceId: optionalString(item.sourceId, `${label} has invalid sourceId`),
      license: optionalString(item.license, `${label} has invalid license`),
    };
  }
  if (item.spec !== "gtfs" || item.type !== "http" || item.origin !== "operator") {
    throw new Error(`${label} must be gbfs/url or gtfs/http with origin=operator`);
  }
  const name = validateSafeName(item.name, label);
  assertExactKeys(item, ["spec", "type", "region", "name", "url", "origin", "license"], label);
  const rawLicense = record(item.license, `${label} is missing object "license"`);
  assertExactKeys(
    rawLicense,
    ["spdxIdentifier", "url", "attribution", "publisher", "publisherUrl"],
    `${label} license`,
  );
  const license = {
    spdxIdentifier: optionalString(rawLicense.spdxIdentifier, `${label} has invalid SPDX ID`),
    url:
      rawLicense.url === undefined
        ? undefined
        : validateHttpUrl(rawLicense.url, `${label} license`),
    attribution: nonEmptyString(rawLicense.attribution, `${label} license is missing attribution`),
    publisher: optionalString(rawLicense.publisher, `${label} has invalid publisher`),
    publisherUrl:
      rawLicense.publisherUrl === undefined
        ? undefined
        : validateHttpUrl(rawLicense.publisherUrl, `${label} publisher`),
  };
  if (!license.spdxIdentifier && !license.url) {
    throw new Error(`${label} license requires spdxIdentifier or url`);
  }
  return { spec: "gtfs", type: "http", region, name, url, origin: "operator", license };
}

export function parseFeedOverlay(value: unknown, path = "<memory>"): FeedOverlay {
  const obj = record(value, `Feeds overlay at ${path} is not a JSON object`);
  if (obj.version !== 3) {
    throw new Error(`Feeds overlay at ${path} has unsupported version ${String(obj.version)}`);
  }
  if (!Array.isArray(obj.sources))
    throw new Error(`Feeds overlay at ${path} has a non-array "sources" field`);
  if (!Array.isArray(obj.patches))
    throw new Error(`Feeds overlay at ${path} has a non-array "patches" field`);
  if (!Array.isArray(obj.quarantine))
    throw new Error(`Feeds overlay at ${path} has a non-array "quarantine" field`);

  const sources = obj.sources.map((entry, index) => parseSource(entry, index, path));
  const patches = obj.patches.map((entry, index): FeedOverlayPatch => {
    const label = `Feeds overlay patch #${index} at ${path}`;
    const item = record(entry, `${label} is not an object`);
    assertExactKeys(item, ["sourceId", "skip"], label);
    if (typeof item.skip !== "boolean") throw new Error(`${label} is missing boolean "skip"`);
    return {
      sourceId: nonEmptyString(item.sourceId, `${label} is missing sourceId`),
      skip: item.skip,
    };
  });
  const quarantine = obj.quarantine.map((entry, index): FeedOverlayQuarantine => {
    const label = `Feeds overlay quarantine #${index} at ${path}`;
    const item = record(entry, `${label} is not an object`);
    assertExactKeys(item, ["sourceId", "reason", "firstSeen", "lastChecked"], label);
    return {
      sourceId: nonEmptyString(item.sourceId, `${label} is missing sourceId`),
      reason: nonEmptyString(item.reason, `${label} is missing reason`),
      firstSeen: nonEmptyString(item.firstSeen, `${label} is missing firstSeen`),
      lastChecked: nonEmptyString(item.lastChecked, `${label} is missing lastChecked`),
    };
  });

  const identities = new Set<string>();
  const names = new Set<string>();
  const urls = new Set<string>();
  for (const source of sources) {
    const sourceId =
      source.spec === "gtfs"
        ? operatorSourceId(source.region, source.name)
        : (source.sourceId ?? `gbfs:${source.region}:${source.name}`);
    // Keyed without the spec, matching applyFeedOverlay's collision key: a
    // gbfs+gtfs pair sharing region/name must fail here (API boundary), not
    // later inside the pipeline's filter stage.
    const name = `${source.region}:${source.name.toLowerCase()}`;
    if (identities.has(sourceId))
      throw new Error(`Feeds overlay has duplicate sourceId ${sourceId}`);
    if (names.has(name)) throw new Error(`Feeds overlay has duplicate source name ${name}`);
    if (urls.has(source.url))
      throw new Error(`Feeds overlay has duplicate source URL ${source.url}`);
    identities.add(sourceId);
    names.add(name);
    urls.add(source.url);
  }
  if (new Set(patches.map((patch) => patch.sourceId)).size !== patches.length) {
    throw new Error("Feeds overlay has duplicate source patches");
  }
  return { version: 3, sources, patches, quarantine };
}

export function readFeedOverlay(path: string): FeedOverlay | null {
  if (!existsSync(path)) return null;
  try {
    return parseFeedOverlay(JSON.parse(readFileSync(path, "utf-8")), path);
  } catch (error) {
    if ((error as Error).message.startsWith("Feeds overlay")) throw error;
    throw new Error(`Failed to parse feeds overlay at ${path}: ${(error as Error).message}`);
  }
}

/** Persist a validated v3 overlay with a durable same-directory atomic rename. */
export function writeFeedOverlayAtomic(path: string, overlay: FeedOverlay): void {
  const validated = parseFeedOverlay(overlay, path);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename may already have succeeded or the temporary file was never created.
    }
    throw error;
  }
}

function catalogIdentity(feed: FeedFile, source: FeedSource): string {
  return source["openmapx-source-id"] ?? catalogSourceId(feed.region, source.name ?? "");
}

/** Apply v3 desired-source records and enable/disable patches to a catalog clone. */
export function applyFeedOverlay(feeds: FeedFile[], overlay: FeedOverlay): FeedOverlayApplyResult {
  let added = 0;
  let quarantined = 0;
  const quarantinedIds = new Set(overlay.quarantine.map((entry) => entry.sourceId));
  const existingIds = new Set<string>();
  const existingNames = new Set<string>();
  const existingUrls = new Set<string>();
  for (const feed of feeds) {
    for (const source of feed.sources ?? []) {
      existingIds.add(catalogIdentity(feed, source));
      if (source.name) existingNames.add(`${feed.region}:${source.name.toLowerCase()}`);
      const rawUrl = source["url-override"] ?? source.url;
      if (rawUrl) {
        try {
          existingUrls.add(validateHttpUrl(rawUrl, "catalog source"));
        } catch {
          // Upstream catalog validation owns malformed URLs.
        }
      }
    }
  }

  for (const addition of overlay.sources) {
    const sourceId =
      addition.spec === "gtfs"
        ? operatorSourceId(addition.region, addition.name)
        : (addition.sourceId ?? `gbfs:${addition.region}:${addition.name}`);
    if (quarantinedIds.has(sourceId)) {
      quarantined++;
      continue;
    }
    const normalizedName = `${addition.region}:${addition.name.toLowerCase()}`;
    if (
      existingIds.has(sourceId) ||
      existingNames.has(normalizedName) ||
      existingUrls.has(addition.url)
    ) {
      throw new Error(`Overlay source ${sourceId} collides with the pinned catalog`);
    }
    let feed = feeds.find((entry) => entry.region === addition.region);
    if (!feed) {
      feed = { region: addition.region, sources: [] };
      feeds.push(feed);
    }
    feed.sources ??= [];
    if (addition.spec === "gtfs") {
      feed.sources.push({
        name: addition.name,
        spec: "gtfs",
        type: "http",
        url: addition.url,
        "openmapx-source-id": sourceId,
        "openmapx-origin": "operator",
        license: {
          ...(addition.license.spdxIdentifier
            ? { "spdx-identifier": addition.license.spdxIdentifier }
            : {}),
          ...(addition.license.url ? { url: addition.license.url } : {}),
          "attribution-text": addition.license.attribution,
          ...(addition.license.publisher ? { publisher: addition.license.publisher } : {}),
          ...(addition.license.publisherUrl
            ? { "publisher-url": addition.license.publisherUrl }
            : {}),
        },
      });
    } else {
      feed.sources.push({
        name: addition.name,
        spec: "gbfs",
        type: "url",
        url: addition.url,
        "openmapx-source-id": sourceId,
        ...(addition.license ? { license: addition.license } : {}),
      });
    }
    existingIds.add(sourceId);
    existingNames.add(normalizedName);
    existingUrls.add(addition.url);
    added++;
  }

  let applied = 0;
  const unmatched: FeedOverlayPatch[] = [];
  for (const patch of overlay.patches) {
    const source = feeds
      .flatMap((feed) => (feed.sources ?? []).map((candidate) => ({ feed, candidate })))
      .find(
        ({ feed, candidate }) => catalogIdentity(feed, candidate) === patch.sourceId,
      )?.candidate;
    if (!source) {
      unmatched.push(patch);
      continue;
    }
    source.skip = patch.skip;
    applied++;
  }
  feeds.sort((a, b) => a.region.localeCompare(b.region));
  for (const feed of feeds) {
    feed.sources?.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return { applied, added, quarantined, unmatched };
}
