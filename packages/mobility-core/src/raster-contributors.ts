import { readCapturedContributors, snapshotContributors } from "./contributors";
import type { Attribution } from "./types/attribution.js";

/** ASCII-safe canonical receipt; HTTP caches store this with its body. */
export const RASTER_CONTRIBUTORS_HEADER = "X-OpenMapX-Contributors";
export const MAX_RASTER_RECEIPT_BYTES = 16_384;
export const MAX_RASTER_IMAGE_BYTES = 8 * 1024 * 1024;

export function encodeRasterContributors(receipts: readonly Attribution[]): string {
  const header = encodeURIComponent(JSON.stringify(snapshotContributors(receipts)));
  if (header.length > MAX_RASTER_RECEIPT_BYTES) throw new Error("Raster receipt exceeds limit");
  return header;
}

export function decodeRasterContributors(header: string | null): Attribution[] {
  if (!header || header.length > MAX_RASTER_RECEIPT_BYTES) return [];
  try {
    return snapshotContributors(readCapturedContributors(decodeURIComponent(header)) ?? []);
  } catch {
    return [];
  }
}

/** Bound the streamed bytes too: Content-Length may be absent or compressed. */
export async function readRasterResponseBytes(response: Response): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RASTER_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error("Raster image exceeds limit");
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RASTER_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Raster image exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
