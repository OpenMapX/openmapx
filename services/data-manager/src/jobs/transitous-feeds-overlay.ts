import { existsSync, readFileSync } from "node:fs";

export interface FeedOverlayPatch {
  region: string;
  name: string;
  patch: Record<string, unknown>;
}

export interface FeedOverlayAddition {
  region: string;
  name: string;
  spec: "gbfs";
  type: "url";
  url: string;
  sourceId?: string;
  license?: string;
}

export interface FeedOverlayQuarantine {
  sourceId: string;
  reason: string;
  firstSeen: string;
  lastChecked: string;
}

export interface FeedOverlay {
  schemaVersion: 2;
  patches: FeedOverlayPatch[];
  additions: FeedOverlayAddition[];
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

function validateRegion(value: unknown, label: string): string {
  const region = nonEmptyString(value, `${label} is missing string "region"`).toLowerCase();
  if (!/^[a-z]{2}(?:-[a-z0-9]+)?$/.test(region))
    throw new Error(`${label} has invalid region "${region}"`);
  return region;
}

function validateHttpUrl(value: unknown, label: string): string {
  const url = nonEmptyString(value, `${label} is missing string "url"`);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} URL must use http/https`);
  }
  if (parsed.username || parsed.password)
    throw new Error(`${label} URL must not embed credentials`);
  return parsed.toString();
}

export function readFeedOverlay(path: string): FeedOverlay | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`Failed to parse feeds overlay at ${path}: ${(error as Error).message}`);
  }
  const obj = record(parsed, `Feeds overlay at ${path} is not a JSON object`);
  if (obj.schemaVersion !== undefined && obj.schemaVersion !== 2) {
    throw new Error(
      `Feeds overlay at ${path} has unsupported schemaVersion ${String(obj.schemaVersion)}`,
    );
  }
  const patchesRaw = obj.patches ?? [];
  const additionsRaw = obj.additions ?? [];
  const quarantineRaw = obj.quarantine ?? [];
  if (!Array.isArray(patchesRaw))
    throw new Error(`Feeds overlay at ${path} has a non-array "patches" field`);
  if (!Array.isArray(additionsRaw))
    throw new Error(`Feeds overlay at ${path} has a non-array "additions" field`);
  if (!Array.isArray(quarantineRaw))
    throw new Error(`Feeds overlay at ${path} has a non-array "quarantine" field`);

  const patches = patchesRaw.map((entry, index): FeedOverlayPatch => {
    const item = record(entry, `Feeds overlay patch #${index} at ${path} is not an object`);
    return {
      region: validateRegion(item.region, `Feeds overlay patch #${index} at ${path}`),
      name: nonEmptyString(
        item.name,
        `Feeds overlay patch #${index} at ${path} is missing string "name"`,
      ),
      patch: {
        ...record(item.patch, `Feeds overlay patch #${index} at ${path} is missing object "patch"`),
      },
    };
  });
  const additions = additionsRaw.map((entry, index): FeedOverlayAddition => {
    const label = `Feeds overlay addition #${index} at ${path}`;
    const item = record(entry, `${label} is not an object`);
    if (item.spec !== "gbfs" || item.type !== "url")
      throw new Error(`${label} must use spec=gbfs and type=url`);
    return {
      region: validateRegion(item.region, label),
      name: nonEmptyString(item.name, `${label} is missing string "name"`),
      spec: "gbfs",
      type: "url",
      url: validateHttpUrl(item.url, label),
      sourceId:
        item.sourceId === undefined
          ? undefined
          : nonEmptyString(item.sourceId, `${label} has invalid sourceId`),
      license:
        item.license === undefined
          ? undefined
          : nonEmptyString(item.license, `${label} has invalid license`),
    };
  });
  const quarantine = quarantineRaw.map((entry, index): FeedOverlayQuarantine => {
    const label = `Feeds overlay quarantine #${index} at ${path}`;
    const item = record(entry, `${label} is not an object`);
    return {
      sourceId: nonEmptyString(item.sourceId, `${label} is missing sourceId`),
      reason: nonEmptyString(item.reason, `${label} is missing reason`),
      firstSeen: nonEmptyString(item.firstSeen, `${label} is missing firstSeen`),
      lastChecked: nonEmptyString(item.lastChecked, `${label} is missing lastChecked`),
    };
  });
  const ids = new Set<string>();
  const names = new Set<string>();
  const urls = new Set<string>();
  for (const addition of additions) {
    const id = addition.sourceId ?? `${addition.region}:${addition.name}`;
    const name = `${addition.region}:${addition.name.toLowerCase()}`;
    if (ids.has(id)) throw new Error(`Feeds overlay has duplicate addition sourceId ${id}`);
    if (names.has(name)) throw new Error(`Feeds overlay has duplicate addition name ${name}`);
    if (urls.has(addition.url))
      throw new Error(`Feeds overlay has duplicate addition URL ${addition.url}`);
    ids.add(id);
    names.add(name);
    urls.add(addition.url);
  }
  return { schemaVersion: 2, patches, additions, quarantine };
}

/** Apply additions first so operator patches may intentionally amend them. */
export function applyFeedOverlay(feeds: FeedFile[], overlay: FeedOverlay): FeedOverlayApplyResult {
  let added = 0;
  let quarantined = 0;
  const quarantinedIds = new Set(overlay.quarantine.map((entry) => entry.sourceId));
  for (const addition of overlay.additions) {
    const sourceId = addition.sourceId ?? `${addition.region}:${addition.name}`;
    if (quarantinedIds.has(sourceId)) {
      quarantined++;
      continue;
    }
    let feed = feeds.find((entry) => entry.region === addition.region);
    if (!feed) {
      feed = { region: addition.region, sources: [] };
      feeds.push(feed);
    }
    feed.sources ??= [];
    if (feed.sources.some((source) => source.name === addition.name)) {
      throw new Error(`Addition collides with existing source ${addition.region}/${addition.name}`);
    }
    feed.sources.push({
      name: addition.name,
      spec: addition.spec,
      type: addition.type,
      url: addition.url,
      "openmapx-source-id": sourceId,
      ...(addition.license ? { license: addition.license } : {}),
    });
    added++;
  }

  let applied = 0;
  const unmatched: FeedOverlayPatch[] = [];
  for (const patch of overlay.patches) {
    const feed = feeds.find((entry) => entry.region === patch.region);
    const matches = feed?.sources?.filter((source) => source.name === patch.name) ?? [];
    if (matches.length === 0) {
      unmatched.push(patch);
      continue;
    }
    for (const source of matches) {
      Object.assign(source, patch.patch);
      applied++;
    }
  }
  feeds.sort((a, b) => a.region.localeCompare(b.region));
  for (const feed of feeds)
    feed.sources?.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { applied, added, quarantined, unmatched };
}
