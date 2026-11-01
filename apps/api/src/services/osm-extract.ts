import type { DatasetMetadata } from "@openmapx/core/data-manager-contracts";
import * as dm from "@openmapx/core/data-manager-sdk";
import type { OpsResultFor } from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";
const DATA_MANAGER_TIMEOUT_MS = 5_000;
const DATA_MANAGER_MAX_BYTES = 1024 * 1024;

type OsmInventory = OpsResultFor<"data.inspect">["osm"];

/** How current the OSM extract on disk is, from its own header. */
export interface OsmExtract {
  /** The time the extract's data is current to. */
  timestamp: string;
  /** The diff feed that continues the extract. */
  replicationUrl?: string;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** An https URL short enough to show, or nothing, so a bad record cannot fail the response. */
function httpsUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function isTimestamp(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

/**
 * The extract time data-manager recorded for the PBF the inventory found:
 * the same file name and size, so a record of an earlier or another file is
 * never shown as this one's.
 */
export function osmExtractFor(
  osm: OsmInventory,
  datasets: readonly DatasetMetadata[],
): OsmExtract | undefined {
  if (!osm.found || !osm.filename) return undefined;
  const dataset = datasets.find(
    (d) =>
      d.type === "osm-pbf" &&
      basename(d.path) === osm.filename &&
      d.sizeBytes === osm.sizeBytes &&
      isTimestamp(d.osmTimestamp),
  );
  if (!dataset?.osmTimestamp) return undefined;
  const replicationUrl = httpsUrl(dataset.osmReplicationUrl);
  return {
    timestamp: new Date(dataset.osmTimestamp).toISOString(),
    ...(replicationUrl ? { replicationUrl } : {}),
  };
}

/** The datasets data-manager has recorded, or none when it cannot be reached. */
export async function readDataManagerDatasets(): Promise<DatasetMetadata[]> {
  try {
    const response = await dm.getDatasets({
      transport: dm.createDataManagerTransport({
        baseUrl: envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
        authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
        requestTimeoutMs: DATA_MANAGER_TIMEOUT_MS,
        maxJsonBytes: DATA_MANAGER_MAX_BYTES,
      }),
    });
    return dm.unwrapDataManagerResponse(response).datasets;
  } catch {
    return [];
  }
}
