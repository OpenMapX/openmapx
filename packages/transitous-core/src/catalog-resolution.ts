/** Fixed upstream resolution shared by proposal producers; no active pin writes. */
import { createHash } from "node:crypto";
import { type MobilityDataGbfsRow, parseMobilityDataGbfsCsv } from "./gbfs-catalog";
export interface ResolvedGbfsCatalogPin {
  schemaVersion: 1;
  source: "mobilitydata-gbfs";
  commit: string;
  url: string;
  sha256: string;
  lockedAt: string;
  lockedBy: string;
}
const COMMIT_URL = "https://api.github.com/repos/MobilityData/gbfs/commits/master";
async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.ok) throw Error(`MobilityData acquisition failed: HTTP ${response.status}`);
  if (!response.body) throw Error("MobilityData response body is missing");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw Error("MobilityData response exceeds its byte limit");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
function options(signal?: AbortSignal): RequestInit {
  return {
    headers: { "User-Agent": "Open-MapX-transitous-bump" },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
    redirect: "error",
  };
}
export async function fetchPinnedGbfsCatalog(
  pin: ResolvedGbfsCatalogPin,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (
    !/^[a-f0-9]{40}$/.test(pin.commit) ||
    pin.url !== `https://raw.githubusercontent.com/MobilityData/gbfs/${pin.commit}/systems.csv`
  )
    throw Error("GBFS acquisition requires the exact pinned upstream URL");
  const csv = await boundedText(await fetchImpl(pin.url, options(signal)), 32 * 1024 * 1024);
  if (createHash("sha256").update(csv).digest("hex") !== pin.sha256)
    throw Error("Pinned GBFS content digest changed");
  return csv;
}
export async function resolveGbfsCatalogCandidate(
  lockedBy: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  signal?: AbortSignal,
): Promise<{
  lock: ResolvedGbfsCatalogPin;
  countryCounts: Map<string, number>;
  rows: MobilityDataGbfsRow[];
}> {
  const commit: unknown = JSON.parse(
    await boundedText(await fetchImpl(COMMIT_URL, options(signal)), 65536),
  );
  if (
    !commit ||
    typeof commit !== "object" ||
    !("sha" in commit) ||
    typeof commit.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(commit.sha)
  )
    throw Error("MobilityData commit lookup returned an invalid SHA");
  const url = `https://raw.githubusercontent.com/MobilityData/gbfs/${commit.sha}/systems.csv`;
  const csv = await boundedText(await fetchImpl(url, options(signal)), 32 * 1024 * 1024),
    countryCounts = new Map<string, number>();
  const rows = parseCatalogGbfsRows(csv);
  for (const row of rows)
    countryCounts.set(row.countryCode, (countryCounts.get(row.countryCode) ?? 0) + 1);
  return {
    lock: {
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: commit.sha,
      url,
      sha256: createHash("sha256").update(csv).digest("hex"),
      lockedAt: now().toISOString(),
      lockedBy,
    },
    countryCounts,
    rows,
  };
}

export function parseCatalogGbfsRows(csv: string): MobilityDataGbfsRow[] {
  let separators = 0;
  for (const character of csv)
    if ((character === "\n" || character === "\r") && ++separators > 200002)
      throw Error("GBFS registry exceeds its entry limit");
  const rows = parseMobilityDataGbfsCsv(csv);
  if (rows.length > 100000) throw Error("GBFS registry exceeds its entry limit");
  return rows;
}
