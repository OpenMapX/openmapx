/** Portable bounded inventory. Data only, never host authority. */
import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const nonnegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedInventoryString = z.string().max(2_048);
const nullableInventoryString = boundedInventoryString.nullable();
const motisGbfsSource = z.strictObject({
  sourceId: boundedInventoryString,
  country: boundedInventoryString,
  status: z.enum(["configured", "excluded"]),
  observation: z.enum(["validated", "unknown"]),
  errorClass: boundedInventoryString.optional(),
  lastObservedSuccess: boundedInventoryString.optional(),
  lastErrorAt: boundedInventoryString.optional(),
  dataAge: z.literal("unknown"),
});
const motisTransitousInventory = z.strictObject({
  configFound: z.boolean(),
  datasetCount: nonnegativeSafeInteger,
  realtimeFeedCount: nonnegativeSafeInteger,
  gbfsFeedCount: nonnegativeSafeInteger,
  feedProxyUrlCount: nonnegativeSafeInteger,
  gbfsProxyUrl: nullableInventoryString,
  feedProxyMode: z.enum(["none", "self-hosted", "transitous-cloud", "mixed"]),
  feedProxyConfigFound: z.boolean(),
  feedProxyVarsFound: z.boolean(),
  feedProxyFeedCount: nonnegativeSafeInteger,
  capabilityState: z.enum(["healthy", "stale", "missing", "error"]),
  capabilityError: boundedInventoryString.optional(),
  activeEpoch: nullableInventoryString,
  candidateEpoch: nullableInventoryString,
  testedAt: nullableInventoryString,
  configHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  licenseHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  rentalProviderCount: nonnegativeSafeInteger,
  rentalProviderGroupCount: nonnegativeSafeInteger,
  rollbackAvailable: z.boolean(),
  operationsProfile: z.enum(["regional-assisted", "regional-sovereign", "planet", "unknown"]),
  activeSlot: z.enum(["A", "B"]).nullable(),
  previousHealthySlot: z.enum(["A", "B"]).nullable(),
  preflightState: z.enum(["passed", "blocked", "missing"]),
  preflightRequiredDiskBytes: nonnegativeSafeInteger.nullable(),
  preflightFreeDiskBytes: nonnegativeSafeInteger.nullable(),
  pinProposalPending: z.boolean(),
  crowdsourceState: z.literal("disabled-pending-review"),
  gbfsCatalog: z.strictObject({
    state: z.enum(["active", "missing", "error"]),
    commit: nullableInventoryString,
    lockedAt: nullableInventoryString,
    registryRows: nonnegativeSafeInteger,
    registryAdded: nonnegativeSafeInteger,
    transitousPreferred: nonnegativeSafeInteger,
    quarantined: nonnegativeSafeInteger,
    validationFailed: nonnegativeSafeInteger,
    sources: z.array(motisGbfsSource).max(500),
  }),
});

export const dataInspectionResultSchema = z.strictObject({
  osm: z.strictObject({
    items: z
      .array(
        z.strictObject({
          artifactId: z.string().regex(/^[a-f0-9]{64}$/),
          filename: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[^/\\]+$/),
          region: z.string().max(512).nullable(),
          sizeBytes: nonnegativeSafeInteger,
          modifiedAt: timestampSchema,
          sourceFingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          fingerprintState: z.enum(["verified", "missing", "stale"]),
        }),
      )
      .max(500),
    total: nonnegativeSafeInteger,
    limit: z.number().int().min(1).max(500),
    offset: nonnegativeSafeInteger,
    unavailable: z.boolean(),
  }),
  builds: z
    .array(
      z.strictObject({
        target: z.enum([
          "valhalla",
          "osrm",
          "otp",
          "motis",
          "motisFeedProxy",
          "tiles",
          "pelias",
          "nominatim",
          "photon",
          "overpass",
        ]),
        built: z.boolean(),
        builtAt: timestampSchema.optional(),
        readiness: z.enum(["ready", "missing", "incomplete", "stale", "unknown"]),
        reason: boundedInventoryString.nullable(),
        sizeBytes: nonnegativeSafeInteger.nullable(),
        sourceFingerprints: z
          .array(
            z.strictObject({
              id: boundedInventoryString,
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .max(10000),
        buildRecordVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
        region: boundedInventoryString.nullable(),
        runtimeImages: z.record(z.string().max(64), boundedInventoryString),
      }),
    )
    .max(10),
  motisTransitous: motisTransitousInventory,
});
