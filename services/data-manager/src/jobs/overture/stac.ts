import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { assertSupportedOvertureContributors } from "@openmapx/core";
import type { RegionBbox } from "./pull.js";

export const OVERTURE_STAC_URL = "https://stac.overturemaps.org/catalog.json";
export const OVERTURE_THEME = "places";
export const OVERTURE_TYPE = "place";
export const OVERTURE_PULL_CONTRACT_VERSION = 1;

export const OVERTURE_PLACE_COLUMNS = [
  "id",
  "geometry",
  "theme",
  "type",
  "version",
  "names",
  "basic_category",
  "taxonomy",
  "addresses",
  "websites",
  "socials",
  "emails",
  "phones",
  "brand",
  "confidence",
  "operating_status",
  "sources",
] as const;

const RELEASE_RE = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const STAC_HOST = "stac.overturemaps.org";
const AWS_ASSET_HOST = "overturemaps-us-west-2.s3.us-west-2.amazonaws.com";

interface StacLink {
  rel?: unknown;
  href?: unknown;
  title?: unknown;
  type?: unknown;
}

interface StacDocument {
  id?: unknown;
  type?: unknown;
  stac_version?: unknown;
  latest?: unknown;
  collection?: unknown;
  bbox?: unknown;
  properties?: unknown;
  links?: unknown;
  assets?: unknown;
}

export interface OvertureStacAsset {
  itemId: string;
  bbox: [number, number, number, number];
  numRows: number;
  href: string;
}

export interface OvertureStacReleaseContract {
  release: string;
  stacVersion: string;
  collectionUrl: string;
  assets: OvertureStacAsset[];
  selectedAssetRows: number;
}

export interface OverturePullValidation {
  rowCount: number;
  contributors: string[];
}

export interface OverturePullContract extends OvertureStacReleaseContract {
  contractVersion: typeof OVERTURE_PULL_CONTRACT_VERSION;
  sourceCatalog: typeof OVERTURE_STAC_URL;
  theme: typeof OVERTURE_THEME;
  type: typeof OVERTURE_TYPE;
  region: string;
  regionBbox: RegionBbox;
  columns: readonly string[];
  parquetFile: string;
  parquetSizeBytes: number;
  rowCount: number;
  contributors: string[];
}

export function assertValidOvertureRelease(release: string): void {
  if (!RELEASE_RE.test(release)) {
    throw new Error(
      `Invalid Overture release "${release}": expected the upstream YYYY-MM-DD.N format`,
    );
  }
}

function asDocument(value: unknown, label: string): StacDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as StacDocument;
}

function linksOf(document: StacDocument, label: string): StacLink[] {
  if (!Array.isArray(document.links)) throw new Error(`${label} has no links array`);
  return document.links as StacLink[];
}

function resolveStacUrl(href: unknown, baseUrl: string, label: string): string {
  if (typeof href !== "string") throw new Error(`${label} has no string href`);
  const url = new URL(href, baseUrl);
  if (url.protocol !== "https:" || url.hostname !== STAC_HOST) {
    throw new Error(`${label} points outside the official Overture STAC host`);
  }
  url.hash = "";
  return url.toString();
}

function findChildUrl(
  document: StacDocument,
  baseUrl: string,
  predicate: (link: StacLink, resolvedUrl: string) => boolean,
  label: string,
): string {
  const matches = linksOf(document, label)
    .filter((link) => link.rel === "child")
    .map((link) => ({ link, url: resolveStacUrl(link.href, baseUrl, `${label} child`) }))
    .filter(({ link, url }) => predicate(link, url));
  if (matches.length !== 1) {
    throw new Error(`${label} must expose exactly one matching child; found ${matches.length}`);
  }
  const match = matches[0];
  if (!match) throw new Error(`${label} matching child disappeared during resolution`);
  return match.url;
}

async function fetchStacDocument(
  url: string,
  fetchImpl: typeof fetch,
  label: string,
): Promise<StacDocument> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Could not fetch ${label}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return asDocument(await response.json(), label);
}

export function latestReleaseFromCatalog(catalog: unknown): string {
  const document = asDocument(catalog, "Overture STAC catalog response");
  if (typeof document.latest !== "string") {
    throw new Error('Overture STAC catalog is missing its string "latest" release');
  }
  assertValidOvertureRelease(document.latest);
  return document.latest;
}

export async function discoverLatestOvertureRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const catalog = await fetchStacDocument(OVERTURE_STAC_URL, fetchImpl, "Overture STAC catalog");
  return latestReleaseFromCatalog(catalog);
}

function parseBbox(value: unknown, label: string): [number, number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error(`${label} has an invalid bbox`);
  }
  const [west, south, east, north] = value as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) {
    throw new Error(`${label} has an out-of-range bbox`);
  }
  return [west, south, east, north];
}

export function bboxIntersects(
  item: readonly [number, number, number, number],
  region: RegionBbox,
): boolean {
  return (
    item[0] <= region.east &&
    item[2] >= region.west &&
    item[1] <= region.north &&
    item[3] >= region.south
  );
}

function parseAssetHref(item: StacDocument, release: string, itemId: string): string {
  if (!item.assets || typeof item.assets !== "object" || Array.isArray(item.assets)) {
    throw new Error(`Overture STAC item ${itemId} has no assets object`);
  }
  const aws = (item.assets as Record<string, unknown>).aws;
  if (!aws || typeof aws !== "object" || Array.isArray(aws)) {
    throw new Error(`Overture STAC item ${itemId} has no AWS asset`);
  }
  const asset = aws as { href?: unknown; type?: unknown };
  if (asset.type !== "application/vnd.apache.parquet" || typeof asset.href !== "string") {
    throw new Error(`Overture STAC item ${itemId} AWS asset is not Parquet`);
  }
  const url = new URL(asset.href);
  const expectedPrefix = `/release/${release}/theme=${OVERTURE_THEME}/type=${OVERTURE_TYPE}/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== AWS_ASSET_HOST ||
    !url.pathname.startsWith(expectedPrefix) ||
    !url.pathname.endsWith(".parquet") ||
    url.pathname.includes("*") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Overture STAC item ${itemId} has an unexpected AWS asset URL`);
  }
  return url.toString();
}

function parseStacItem(
  value: StacDocument,
  release: string,
  expectedId: string,
): OvertureStacAsset & { stacVersion: string } {
  if (value.type !== "Feature" || value.id !== expectedId || value.collection !== OVERTURE_TYPE) {
    throw new Error(`Overture STAC item ${expectedId} has inconsistent identity`);
  }
  if (typeof value.stac_version !== "string" || !/^1\./.test(value.stac_version)) {
    throw new Error(`Overture STAC item ${expectedId} has an unsupported STAC version`);
  }
  const properties = value.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(`Overture STAC item ${expectedId} has no properties object`);
  }
  const numRows = (properties as { num_rows?: unknown }).num_rows;
  if (!Number.isSafeInteger(numRows) || (numRows as number) <= 0) {
    throw new Error(`Overture STAC item ${expectedId} has an invalid row count`);
  }
  return {
    itemId: expectedId,
    bbox: parseBbox(value.bbox, `Overture STAC item ${expectedId}`),
    numRows: numRows as number,
    href: parseAssetHref(value, release, expectedId),
    stacVersion: value.stac_version,
  };
}

export async function resolveOvertureStacContract(
  release: string,
  regionBbox: RegionBbox,
  fetchImpl: typeof fetch = fetch,
): Promise<OvertureStacReleaseContract> {
  assertValidOvertureRelease(release);
  const root = await fetchStacDocument(OVERTURE_STAC_URL, fetchImpl, "Overture STAC catalog");
  const latestRelease = latestReleaseFromCatalog(root);
  const matchingReleaseLinks = linksOf(root, "Overture STAC catalog")
    .filter((link) => link.rel === "child")
    .map((link) => resolveStacUrl(link.href, OVERTURE_STAC_URL, "Overture release child"))
    .filter((url) => new URL(url).pathname === `/${release}/catalog.json`);
  if (
    matchingReleaseLinks.length > 1 ||
    (release === latestRelease && matchingReleaseLinks.length !== 1)
  ) {
    throw new Error(
      `Overture STAC catalog must expose exactly one child for current release ${release}`,
    );
  }
  // The root intentionally links only the current and previous releases. Older
  // archived releases remain addressable by their validated, immutable STAC
  // path and are still verified below before any asset is trusted.
  const releaseUrl =
    matchingReleaseLinks[0] ?? new URL(`./${release}/catalog.json`, OVERTURE_STAC_URL).toString();
  const releaseCatalog = await fetchStacDocument(
    releaseUrl,
    fetchImpl,
    `Overture release ${release}`,
  );
  if (releaseCatalog.id !== release) {
    throw new Error(`Overture release catalog identity does not match ${release}`);
  }
  const themeUrl = findChildUrl(
    releaseCatalog,
    releaseUrl,
    (link) => link.title === OVERTURE_THEME,
    `Overture release ${release}`,
  );
  const themeCatalog = await fetchStacDocument(themeUrl, fetchImpl, "Overture Places catalog");
  if (themeCatalog.id !== OVERTURE_THEME) {
    throw new Error("Overture Places catalog has an inconsistent identity");
  }
  const collectionUrl = findChildUrl(
    themeCatalog,
    themeUrl,
    (link) => link.title === OVERTURE_TYPE,
    "Overture Places catalog",
  );
  const collection = await fetchStacDocument(
    collectionUrl,
    fetchImpl,
    "Overture Places collection",
  );
  if (collection.type !== "Collection" || collection.id !== OVERTURE_TYPE) {
    throw new Error("Overture Places collection has an inconsistent identity");
  }

  const itemLinks = linksOf(collection, "Overture Places collection").filter(
    (link) => link.rel === "item",
  );
  if (itemLinks.length === 0) throw new Error("Overture Places collection has no items");
  const itemUrls = itemLinks.map((link) =>
    resolveStacUrl(link.href, collectionUrl, "Overture Places item"),
  );
  if (new Set(itemUrls).size !== itemUrls.length) {
    throw new Error("Overture Places collection contains duplicate item links");
  }

  const parsedItems = await Promise.all(
    itemUrls.map(async (url) => {
      const expectedId = new URL(url).pathname
        .split("/")
        .at(-1)
        ?.replace(/\.json$/, "");
      if (!expectedId) throw new Error(`Could not derive the Overture STAC item ID from ${url}`);
      const item = await fetchStacDocument(url, fetchImpl, `Overture STAC item ${expectedId}`);
      return parseStacItem(item, release, expectedId);
    }),
  );
  const versions = new Set(parsedItems.map((item) => item.stacVersion));
  if (versions.size !== 1) throw new Error("Overture Places items disagree on STAC version");
  const ids = parsedItems.map((item) => item.itemId);
  if (new Set(ids).size !== ids.length) throw new Error("Overture Places item IDs are not unique");

  const assets = parsedItems
    .filter((item) => bboxIntersects(item.bbox, regionBbox))
    .map(({ stacVersion: _stacVersion, ...asset }) => asset)
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  if (assets.length === 0) {
    throw new Error("The configured region does not intersect any Overture Places STAC asset");
  }
  return {
    release,
    stacVersion: versions.values().next().value as string,
    collectionUrl,
    assets,
    selectedAssetRows: assets.reduce((total, asset) => total + asset.numRows, 0),
  };
}

export function pullContractPath(dataDir: string, release: string, region: string): string {
  const slug = region.replace(/\//g, "-");
  return join(dataDir, "overture", release, `${slug}.contract.json`);
}

export function buildOverturePullContract(
  stac: OvertureStacReleaseContract,
  region: string,
  regionBbox: RegionBbox,
  parquetPath: string,
  validation: OverturePullValidation,
  publishedParquetFile: string = basename(parquetPath),
): OverturePullContract {
  if (!Number.isSafeInteger(validation.rowCount) || validation.rowCount <= 0) {
    throw new Error("Overture regional snapshot contains no rows");
  }
  const contributors = [...new Set(validation.contributors.map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  if (contributors.length === 0) throw new Error("Overture regional snapshot has no contributors");
  assertSupportedOvertureContributors(contributors);
  const parquetSizeBytes = statSync(parquetPath).size;
  if (parquetSizeBytes <= 0) throw new Error("Overture regional snapshot is empty");
  return {
    contractVersion: OVERTURE_PULL_CONTRACT_VERSION,
    sourceCatalog: OVERTURE_STAC_URL,
    theme: OVERTURE_THEME,
    type: OVERTURE_TYPE,
    ...stac,
    region,
    regionBbox,
    columns: [...OVERTURE_PLACE_COLUMNS],
    parquetFile: publishedParquetFile,
    parquetSizeBytes,
    rowCount: validation.rowCount,
    contributors,
  };
}

function assertPullContract(
  value: unknown,
  dataDir: string,
  release: string,
  region: string,
): OverturePullContract {
  const contract = asDocument(value, "Overture pull contract") as unknown as OverturePullContract;
  const expectedFile = `${region.replace(/\//g, "-")}.parquet`;
  const validAssets =
    Array.isArray(contract.assets) &&
    contract.assets.length > 0 &&
    contract.assets.every((asset) => {
      try {
        if (
          !asset ||
          typeof asset.itemId !== "string" ||
          !Number.isSafeInteger(asset.numRows) ||
          asset.numRows <= 0
        ) {
          return false;
        }
        parseBbox(asset.bbox, `Overture pull contract item ${asset.itemId}`);
        parseAssetHref(
          {
            assets: {
              aws: { href: asset.href, type: "application/vnd.apache.parquet" },
            },
          },
          release,
          asset.itemId,
        );
        return true;
      } catch {
        return false;
      }
    });
  const assetRows = validAssets
    ? contract.assets.reduce((total, asset) => total + asset.numRows, 0)
    : 0;
  const validContributors =
    Array.isArray(contract.contributors) &&
    contract.contributors.length > 0 &&
    contract.contributors.every(
      (dataset) => typeof dataset === "string" && dataset.trim() === dataset,
    ) &&
    [...contract.contributors].sort().join("\0") === contract.contributors.join("\0") &&
    new Set(contract.contributors).size === contract.contributors.length;
  if (
    contract.contractVersion !== OVERTURE_PULL_CONTRACT_VERSION ||
    contract.sourceCatalog !== OVERTURE_STAC_URL ||
    contract.release !== release ||
    contract.theme !== OVERTURE_THEME ||
    contract.type !== OVERTURE_TYPE ||
    contract.region !== region ||
    contract.parquetFile !== expectedFile ||
    !validAssets ||
    contract.selectedAssetRows !== assetRows ||
    !Number.isSafeInteger(contract.rowCount) ||
    contract.rowCount <= 0 ||
    contract.rowCount > contract.selectedAssetRows ||
    !Number.isSafeInteger(contract.parquetSizeBytes) ||
    contract.parquetSizeBytes <= 0 ||
    !validContributors ||
    !Array.isArray(contract.columns) ||
    contract.columns.join("\0") !== OVERTURE_PLACE_COLUMNS.join("\0")
  ) {
    throw new Error(`Overture pull contract does not match ${release}/${region}`);
  }
  assertSupportedOvertureContributors(contract.contributors);
  const parquetPath = join(dataDir, "overture", release, expectedFile);
  if (statSync(parquetPath).size !== contract.parquetSizeBytes) {
    throw new Error("Overture parquet file size does not match its pull contract");
  }
  return contract;
}

export function readOverturePullContract(
  dataDir: string,
  release: string,
  region: string,
): OverturePullContract {
  const path = pullContractPath(dataDir, release, region);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read Overture pull contract ${path}: ${(error as Error).message}`);
  }
  return assertPullContract(parsed, dataDir, release, region);
}
