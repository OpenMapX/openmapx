import {
  type Attribution,
  type IntegrationContext,
  type LandmarkAsset,
  resolveIntegrationContributors,
} from "@openmapx/integration-framework";
import { createOpenLandmarksClient, type OpenLandmarksClient } from "./client";
import type { OpenLandmarksAssetRecord } from "./schema";

export interface OpenLandmarksProviderOptions {
  /** The provider integration's id. */
  id: string;
  /** Manifest data sources the provider's receipts use, model source first. */
  sourceIds: readonly string[];
  baseUrl: string;
  channel: "latest" | "preview";
  retainsReleases: boolean;
  /** Map one upstream record, given the receipts resolved from the manifest. */
  normalize: (
    record: OpenLandmarksAssetRecord,
    receipts: readonly Attribution[],
  ) => LandmarkAsset | null;
}

/**
 * Start a catalogue client for an Open Landmarks v1 upstream and register it
 * as a `landmark-models` provider with a health check.
 */
export function createOpenLandmarksProvider(
  ctx: IntegrationContext,
  options: OpenLandmarksProviderOptions,
): OpenLandmarksClient {
  const receipts = resolveIntegrationContributors(ctx, options.sourceIds);
  const client = createOpenLandmarksClient({
    baseUrl: options.baseUrl,
    channel: options.channel,
    retainsReleases: options.retainsReleases,
    http: ctx.http,
    log: ctx.log,
    normalize: (record) => options.normalize(record, receipts),
  });
  client.start();
  ctx.onShutdown(async () => client.stop());
  ctx.registerLandmarkModelProvider({
    id: options.id,
    sourceIds: options.sourceIds,
    snapshot: () => client.snapshot(),
    fetchModelGzip: (sha256, signal) => client.fetchModelGzip(sha256, signal),
  });
  ctx.registerHealthCheck(async () =>
    client.snapshot()
      ? { status: "up" }
      : { status: "down", error: client.status().lastError ?? "Catalogue not loaded yet" },
  );
  return client;
}
