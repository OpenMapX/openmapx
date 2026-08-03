import z from "zod/v4";

export const OFFLINE_PACKAGE_SCHEMA_VERSION = 1 as const;
export const OFFLINE_PACKAGE_ALGORITHM_VERSION = "pmtiles-area-v1" as const;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
export const OFFLINE_PACKAGE_MAX_ZOOM = 24;
export const OFFLINE_PACKAGE_MAX_AREA_SQUARE_DEGREES = 2_000;

export interface OfflinePackageBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OfflinePackageRequest {
  bbox: OfflinePackageBbox;
  minZoom: number;
  maxZoom: number;
  provider: "openmapx";
}

export interface OfflinePackageSourceDescriptor {
  datasetId: "openmapx";
  datasetVersion: string;
  sourceMaxZoom: number;
  sourceBounds: OfflinePackageBbox;
  tileSchema: "openmaptiles";
  styleProvider: "openmapx";
  styleVersion: string;
  packageAlgorithmVersion: string;
  attribution: string[];
}

export interface CanonicalOfflinePackageRequest {
  request: OfflinePackageRequest;
  effective: {
    bbox: OfflinePackageBbox;
    minZoom: number;
    maxZoom: number;
  };
  source: OfflinePackageSourceDescriptor;
  requestKey: string;
}

export type OfflinePackageJobStatus = "preparing" | "ready-to-download" | "failed" | "expired";

export type OfflinePackageLocalStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "paused"
  | "verifying"
  | "ready"
  | "error"
  | "deleting";

export interface OfflineMapPackageManifest {
  schemaVersion: 1;
  packageId: string;
  requestKey: string;
  dataset: {
    id: "openmapx";
    version: string;
    generatedAt: string;
    sourceMaxZoom: number;
    tileSchema: "openmaptiles";
  };
  coverage: {
    bbox: OfflinePackageBbox;
    minZoom: number;
    maxZoom: number;
  };
  archive: {
    url: string;
    contentType: "application/vnd.pmtiles";
    byteLength: number;
    sha256: string;
    etag: string;
  };
  style: {
    provider: "openmapx";
    version: string;
    variants: Array<"light" | "dark">;
    assetBaseUrl: string;
  };
  attribution: string[];
}

export interface OfflinePackageJob {
  jobId: string;
  requestKey: string;
  status: OfflinePackageJobStatus;
  packageId?: string;
  manifest?: OfflineMapPackageManifest;
  errorCode?:
    | "unsupported-provider"
    | "invalid-request"
    | "capacity"
    | "generation-failed"
    | "expired";
  errorMessage?: string;
}

export interface OfflinePackageCapability {
  available: boolean;
  provider: "openmapx";
  datasetVersion?: string;
  styleVersion?: string;
  sourceMaxZoom?: number;
  sourceBounds?: OfflinePackageBbox;
  reason?: "unsupported-provider" | "source-unavailable" | "capacity";
}

export interface OfflinePackageCoordinate {
  longitude: number;
  latitude: number;
}

export interface OfflinePackageCompatibility {
  datasetVersion: string;
  styleVersion: string;
  tileSchema: "openmaptiles";
}

const bboxSchema = z
  .object({
    west: z.number().finite(),
    south: z.number().finite(),
    east: z.number().finite(),
    north: z.number().finite(),
  })
  .superRefine((bbox, ctx) => {
    if (bbox.west < -180 || bbox.west > 180 || bbox.east < -180 || bbox.east > 180) {
      ctx.addIssue({ code: "custom", message: "longitude must be between -180 and 180" });
    }
    if (bbox.south < -90 || bbox.south > 90 || bbox.north < -90 || bbox.north > 90) {
      ctx.addIssue({ code: "custom", message: "latitude must be between -90 and 90" });
    }
    if (bbox.east <= bbox.west) {
      ctx.addIssue({ code: "custom", message: "east must be greater than west" });
    }
    if (bbox.north <= bbox.south) {
      ctx.addIssue({ code: "custom", message: "north must be greater than south" });
    }
  });

const packageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "invalid package id");
const archiveUrlSchema = z
  .string()
  .regex(/^\/api\/offline\/packages\/[A-Za-z0-9_-]{8,128}\/archive$/, "invalid archive URL");

export const offlinePackageRequestSchema = z.object({
  bbox: bboxSchema,
  minZoom: z.number().finite(),
  maxZoom: z.number().finite(),
  provider: z.literal("openmapx"),
});

export const offlineMapPackageManifestSchema = z
  .object({
    schemaVersion: z.literal(OFFLINE_PACKAGE_SCHEMA_VERSION),
    packageId: packageIdSchema,
    requestKey: z.string().min(1).max(2048),
    dataset: z.object({
      id: z.literal("openmapx"),
      version: z.string().min(1).max(256),
      generatedAt: z.iso.datetime(),
      sourceMaxZoom: z.number().int().min(0).max(OFFLINE_PACKAGE_MAX_ZOOM),
      tileSchema: z.literal("openmaptiles"),
    }),
    coverage: z.object({
      bbox: bboxSchema,
      minZoom: z.number().int().min(0).max(OFFLINE_PACKAGE_MAX_ZOOM),
      maxZoom: z.number().int().min(0).max(OFFLINE_PACKAGE_MAX_ZOOM),
    }),
    archive: z.object({
      url: archiveUrlSchema,
      contentType: z.literal("application/vnd.pmtiles"),
      byteLength: z.number().int().positive().safe(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      etag: z.string().regex(/^sha256-[0-9a-f]{64}$/),
    }),
    style: z.object({
      provider: z.literal("openmapx"),
      version: z.string().min(1).max(256),
      variants: z.array(z.enum(["light", "dark"])).min(1),
      assetBaseUrl: z.string().regex(/^\/[^\s]*$/),
    }),
    attribution: z.array(z.string().min(1).max(2048)).min(1),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.coverage.maxZoom > manifest.dataset.sourceMaxZoom) {
      ctx.addIssue({
        code: "custom",
        path: ["coverage", "maxZoom"],
        message: "coverage maxZoom cannot exceed dataset sourceMaxZoom",
      });
    }
    if (manifest.coverage.minZoom > manifest.coverage.maxZoom) {
      ctx.addIssue({
        code: "custom",
        path: ["coverage", "minZoom"],
        message: "coverage minZoom cannot exceed maxZoom",
      });
    }
    const archivePackageId = manifest.archive.url.split("/")[4];
    if (archivePackageId !== manifest.packageId) {
      ctx.addIssue({
        code: "custom",
        path: ["archive", "url"],
        message: "archive URL package id must match packageId",
      });
    }
  });

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeLongitude(value: number): number {
  if (value === 180 || value === -180) return value;
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function normalizeZoom(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite zoom`);
  const normalized = Math.round(value);
  if (normalized < 0 || normalized > OFFLINE_PACKAGE_MAX_ZOOM) {
    throw new Error(`${name} must be between 0 and ${OFFLINE_PACKAGE_MAX_ZOOM}`);
  }
  return normalized;
}

function assertSourceDescriptor(source: OfflinePackageSourceDescriptor): void {
  if (source.datasetId !== "openmapx" || source.tileSchema !== "openmaptiles") {
    throw new Error("unsupported package source");
  }
  if (source.styleProvider !== "openmapx") throw new Error("unsupported provider");
  if (!source.datasetVersion || !source.styleVersion || !source.packageAlgorithmVersion) {
    throw new Error("source version metadata is required");
  }
  if (
    !Number.isInteger(source.sourceMaxZoom) ||
    source.sourceMaxZoom < 0 ||
    source.sourceMaxZoom > OFFLINE_PACKAGE_MAX_ZOOM
  ) {
    throw new Error("source max zoom is invalid");
  }
  const bounds = source.sourceBounds;
  if (
    ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite) ||
    bounds.west < -180 ||
    bounds.east > 180 ||
    bounds.south < -90 ||
    bounds.north > 90 ||
    bounds.east <= bounds.west ||
    bounds.north <= bounds.south
  ) {
    throw new Error("source bounds are invalid");
  }
}

function canonicalBbox(bbox: OfflinePackageBbox): OfflinePackageBbox {
  if (![bbox.west, bbox.south, bbox.east, bbox.north].every(Number.isFinite)) {
    throw new Error("bbox coordinate must be finite");
  }
  const normalized = {
    west: roundCoordinate(normalizeLongitude(bbox.west)),
    south: roundCoordinate(
      Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, bbox.south)),
    ),
    east: roundCoordinate(normalizeLongitude(bbox.east)),
    north: roundCoordinate(
      Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, bbox.north)),
    ),
  };
  if (normalized.east <= normalized.west) {
    throw new Error("dateline-crossing bbox is not supported; east must be greater than west");
  }
  if (normalized.north <= normalized.south) throw new Error("north must be greater than south");
  return normalized;
}

export function canonicalizeOfflinePackageRequest(
  request: OfflinePackageRequest,
  source: OfflinePackageSourceDescriptor,
): CanonicalOfflinePackageRequest {
  assertSourceDescriptor(source);
  if (request.provider !== "openmapx") throw new Error("unsupported provider");

  const bbox = canonicalBbox(request.bbox);
  const minZoom = normalizeZoom(request.minZoom, "minZoom");
  const maxZoom = normalizeZoom(request.maxZoom, "maxZoom");
  if (maxZoom < minZoom) throw new Error("maxZoom must be greater than or equal to minZoom");
  if (minZoom > source.sourceMaxZoom) throw new Error("minZoom exceeds source max zoom");

  const sourceBounds = canonicalBbox(source.sourceBounds);
  if (
    bbox.west < sourceBounds.west ||
    bbox.south < sourceBounds.south ||
    bbox.east > sourceBounds.east ||
    bbox.north > sourceBounds.north
  ) {
    throw new Error("bbox is outside source bounds");
  }
  if (
    (bbox.east - bbox.west) * (bbox.north - bbox.south) >
    OFFLINE_PACKAGE_MAX_AREA_SQUARE_DEGREES
  ) {
    throw new Error("bbox exceeds the offline package area cap");
  }

  const canonical: CanonicalOfflinePackageRequest = {
    request: { bbox, minZoom, maxZoom, provider: request.provider },
    effective: { bbox, minZoom, maxZoom: Math.min(maxZoom, source.sourceMaxZoom) },
    source,
    requestKey: "",
  };
  canonical.requestKey = offlinePackageRequestKey(canonical);
  return canonical;
}

export function offlinePackageRequestKey(canonical: CanonicalOfflinePackageRequest): string {
  return JSON.stringify({
    version: 1,
    provider: canonical.request.provider,
    source: {
      datasetId: canonical.source.datasetId,
      datasetVersion: canonical.source.datasetVersion,
      tileSchema: canonical.source.tileSchema,
      styleProvider: canonical.source.styleProvider,
      styleVersion: canonical.source.styleVersion,
      packageAlgorithmVersion: canonical.source.packageAlgorithmVersion,
    },
    requested: { maxZoom: canonical.request.maxZoom },
    effective: canonical.effective,
  });
}

export function validateOfflineMapPackageManifest(raw: unknown): OfflineMapPackageManifest {
  const parsed = offlineMapPackageManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid offline map package manifest: ${parsed.error.message}`);
  }
  return parsed.data as OfflineMapPackageManifest;
}

export function parseOfflinePackageRequest(raw: unknown): OfflinePackageRequest {
  const parsed = offlinePackageRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid offline package request: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function isOfflinePackageCompatible(
  manifest: OfflineMapPackageManifest,
  compatibility: OfflinePackageCompatibility,
): boolean {
  return (
    manifest.dataset.id === "openmapx" &&
    manifest.dataset.version === compatibility.datasetVersion &&
    manifest.dataset.tileSchema === compatibility.tileSchema &&
    manifest.style.provider === "openmapx" &&
    manifest.style.version === compatibility.styleVersion
  );
}

export function packageContainsPoint(
  manifest: OfflineMapPackageManifest,
  point: OfflinePackageCoordinate,
): boolean {
  const { bbox } = manifest.coverage;
  return (
    point.longitude >= bbox.west &&
    point.longitude <= bbox.east &&
    point.latitude >= bbox.south &&
    point.latitude <= bbox.north
  );
}

function coverageArea(manifest: OfflineMapPackageManifest): number {
  const { bbox } = manifest.coverage;
  return (bbox.east - bbox.west) * (bbox.north - bbox.south);
}

export function selectOfflinePackage(
  packages: OfflineMapPackageManifest[],
  point: OfflinePackageCoordinate,
  compatibility: OfflinePackageCompatibility,
): OfflineMapPackageManifest | undefined {
  return packages
    .filter(
      (candidate) =>
        isOfflinePackageCompatible(candidate, compatibility) &&
        packageContainsPoint(candidate, point),
    )
    .sort((a, b) => coverageArea(a) - coverageArea(b) || a.packageId.localeCompare(b.packageId))[0];
}
