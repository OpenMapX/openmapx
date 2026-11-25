import z from "zod/v4";
import { countSchema } from "./common";
export const datasetTypeSchema = z.enum([
  "osm-pbf",
  "osm-pbf-bz2",
  "osrm-graph",
  "otp-graph",
  "motis-data",
  "motis-staging-data",
  "motis-feed-proxy-config",
  "gtfs",
  "tile-mbtiles",
  "tile-fonts",
  "pelias-placeholder-data",
  "pelias-whosonfirst-data",
]);
export const datasetMetadataSchema = z.strictObject({
  type: datasetTypeSchema,
  id: z.string().min(1),
  region: z.string().optional(),
  url: z.string().optional(),
  sizeBytes: countSchema,
  downloadedAt: z.string().min(1),
  sha256: z.string().optional(),
  md5: z.string().optional(),
  path: z.string().min(1),
  /** An OSM PBF's replication timestamp: the time its data is current to. */
  osmTimestamp: z.string().optional(),
  /** The diff feed an OSM PBF's header names as continuing it. */
  osmReplicationUrl: z.string().optional(),
});
export const datasetsSchema = z.strictObject({ datasets: z.array(datasetMetadataSchema) });
export const reloadDatasetsSchema = z.strictObject({ ok: z.literal(true), datasets: countSchema });
const linkIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const hardlinkEntrySchema = z.strictObject({
  source: z.string().min(1).max(1024),
  target: z.string().min(1).max(1024),
  consumerService: linkIdentity,
  dataType: linkIdentity,
  instance: linkIdentity.optional(),
  targetFilename: linkIdentity.optional(),
});
/**
 * A generation's hardlink plan, named by that generation's revision. The
 * operation key names the application: a repeated request with the same key
 * and body observes the first one instead of linking again. `leaseId` names the
 * lease the sending agent or host CLI operation holds; data-manager then takes
 * no lease of its own.
 */
export const linkRequestSchema = z.strictObject({
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  requestedDeadlineAt: z.number().int().nonnegative().safe(),
  revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  plan: z.array(hardlinkEntrySchema).max(2000),
  prune: z.boolean().optional(),
  leaseId: z.uuid().optional(),
});
export const linkResultSchema = z.strictObject({
  ok: z.literal(true),
  linked: countSchema,
  skipped: countSchema,
  pruned: countSchema,
});
const phase = z.enum([
  "database-schema",
  "offline-storage",
  "job-reconciliation",
  "cron-schedulers",
  "complete",
]);
export const readyStatusSchema = z.strictObject({
  ok: z.literal(true),
  status: z.literal("ready"),
  phase,
  uptime: countSchema,
  dataDir: z.string(),
});
export const unreadyStatusSchema = z.strictObject({
  ok: z.literal(false),
  status: z.enum(["starting", "failed"]),
  phase,
  uptime: countSchema,
  dataDir: z.string(),
});
export type DatasetType = z.infer<typeof datasetTypeSchema>;
export type DatasetMetadata = z.infer<typeof datasetMetadataSchema>;
export type HardlinkEntry = z.infer<typeof hardlinkEntrySchema>;
export type DataManagerStatus =
  | z.infer<typeof readyStatusSchema>
  | z.infer<typeof unreadyStatusSchema>;
