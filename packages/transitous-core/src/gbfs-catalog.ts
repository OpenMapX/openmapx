import { createHash } from "node:crypto";
import { parseCsvRecords } from "@openmapx/mobility-formats";

export interface MobilityDataGbfsRow {
  countryCode: string;
  name: string;
  location: string;
  systemId: string;
  operatorUrl: string;
  discoveryUrl: string;
  supportedVersions: string[];
  authenticationInfoUrl?: string;
}

export interface ExistingGbfsSource {
  region: string;
  name: string;
  discoveryUrl: string;
  sourceId?: string;
  provenance: "transitous" | "atlas";
}

export interface GbfsQuarantineEntry {
  sourceId: string;
  reason: string;
  firstSeen: string;
  lastChecked: string;
}

export interface CompiledGbfsAddition {
  region: string;
  name: string;
  spec: "gbfs";
  type: "url";
  url: string;
  sourceId: string;
  license: string;
}

export interface GbfsSourceIndexEntry {
  sourceId: string;
  registrySystemId: string;
  discoveryUrl: string;
  country: string;
  name: string;
  location: string;
  operatorUrl: string;
  supportedVersions: string[];
  provenance: "mobilitydata";
  status: "included" | "excluded";
  exclusionReason?: "country" | "duplicate" | "quarantined" | "invalid" | "limit" | "validation";
  preferredSourceId?: string;
  license: string;
  licenseProvenance: "publisher-terms-via-source-index";
}

export interface CompileGbfsCatalogInput {
  rows: MobilityDataGbfsRow[];
  countries: string[];
  existingSources: ExistingGbfsSource[];
  quarantine: GbfsQuarantineEntry[];
  maxAdditions: number;
}

export interface CompileGbfsCatalogResult {
  additions: CompiledGbfsAddition[];
  sourceIndex: GbfsSourceIndexEntry[];
  summary: {
    registryRows: number;
    selectedCountries: string[];
    included: number;
    duplicate: number;
    quarantined: number;
    invalid: number;
    outOfScope: number;
    limited: number;
  };
}

const MOBILITYDATA_GBFS_LICENSE =
  "Per-feed publisher terms; see gbfs-source-index.json for discovery and operator provenance";

export function parseMobilityDataGbfsCsv(csv: string): MobilityDataGbfsRow[] {
  return parseCsvRecords(csv).map((row) => ({
    countryCode: (row["Country Code"] ?? "").trim().toLowerCase(),
    name: (row.Name ?? "").trim(),
    location: (row.Location ?? "").trim(),
    systemId: (row["System ID"] ?? "").trim(),
    operatorUrl: (row.URL ?? "").trim(),
    discoveryUrl: (row["Auto-Discovery URL"] ?? "").trim(),
    supportedVersions: (row["Supported Versions"] ?? "")
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean),
    authenticationInfoUrl: (row["Authentication Info URL"] ?? "").trim() || undefined,
  }));
}

export function normalizeGbfsDiscoveryUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    url.searchParams.sort();
    return url.toString();
  } catch {
    return null;
  }
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function stableSourceId(row: MobilityDataGbfsRow, normalizedUrl: string): string {
  const base = slug(row.systemId || row.name || "gbfs");
  const hash = createHash("sha256")
    .update(`${row.countryCode}\0${row.systemId}\0${normalizedUrl}`)
    .digest("hex")
    .slice(0, 10);
  return `mobilitydata:${row.countryCode}:${base || "gbfs"}:${hash}`;
}

export function compileGbfsCatalog(input: CompileGbfsCatalogInput): CompileGbfsCatalogResult {
  const countries = [...new Set(input.countries.map((value) => value.toLowerCase()))].sort();
  const countrySet = new Set(countries);
  const existingByUrl = new Map<string, ExistingGbfsSource>();
  for (const source of input.existingSources) {
    const normalized = normalizeGbfsDiscoveryUrl(source.discoveryUrl);
    if (normalized) existingByUrl.set(normalized, source);
  }
  const quarantined = new Set(input.quarantine.map((entry) => entry.sourceId));
  const sortedRows = [...input.rows].sort((a, b) =>
    `${a.countryCode}\0${a.systemId}\0${a.discoveryUrl}`.localeCompare(
      `${b.countryCode}\0${b.systemId}\0${b.discoveryUrl}`,
    ),
  );
  const additions: CompiledGbfsAddition[] = [];
  const sourceIndex: GbfsSourceIndexEntry[] = [];
  const claimedUrls = new Set<string>();
  const summary = {
    registryRows: input.rows.length,
    selectedCountries: countries,
    included: 0,
    duplicate: 0,
    quarantined: 0,
    invalid: 0,
    outOfScope: 0,
    limited: 0,
  };
  for (const row of sortedRows) {
    const normalized = normalizeGbfsDiscoveryUrl(row.discoveryUrl);
    const sourceId = normalized
      ? stableSourceId(row, normalized)
      : `mobilitydata:${row.countryCode}:${slug(row.systemId || row.name || "invalid")}:invalid`;
    const base: GbfsSourceIndexEntry = {
      sourceId,
      registrySystemId: row.systemId,
      discoveryUrl: normalized ?? row.discoveryUrl,
      country: row.countryCode,
      name: row.name,
      location: row.location,
      operatorUrl: row.operatorUrl,
      supportedVersions: [...row.supportedVersions].sort(),
      provenance: "mobilitydata",
      status: "excluded",
      license: MOBILITYDATA_GBFS_LICENSE,
      licenseProvenance: "publisher-terms-via-source-index",
    };
    if (!countrySet.has(row.countryCode)) {
      summary.outOfScope++;
      sourceIndex.push({ ...base, exclusionReason: "country" });
      continue;
    }
    if (!normalized || !row.systemId || !row.name || row.authenticationInfoUrl) {
      summary.invalid++;
      sourceIndex.push({ ...base, exclusionReason: "invalid" });
      continue;
    }
    const preferred = existingByUrl.get(normalized);
    if (preferred || claimedUrls.has(normalized)) {
      summary.duplicate++;
      sourceIndex.push({
        ...base,
        exclusionReason: "duplicate",
        preferredSourceId: preferred?.sourceId ?? preferred?.name,
      });
      continue;
    }
    if (quarantined.has(sourceId)) {
      summary.quarantined++;
      sourceIndex.push({ ...base, exclusionReason: "quarantined" });
      continue;
    }
    if (additions.length >= input.maxAdditions) {
      summary.limited++;
      sourceIndex.push({ ...base, exclusionReason: "limit" });
      continue;
    }
    claimedUrls.add(normalized);
    additions.push({
      region: row.countryCode,
      name: `openmapx-${slug(row.systemId)}`,
      spec: "gbfs",
      type: "url",
      url: normalized,
      sourceId,
      license: MOBILITYDATA_GBFS_LICENSE,
    });
    summary.included++;
    sourceIndex.push({ ...base, status: "included" });
  }
  additions.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  sourceIndex.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return { additions, sourceIndex, summary };
}
