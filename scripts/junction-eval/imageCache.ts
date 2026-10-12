import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function cacheEvaluationImage(
  directory: string,
  id: string,
  asset: string,
  request: typeof fetch = fetch,
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("invalid-image-id");
  const filename = `${id}.jpg`;
  const target = join(directory, filename);
  if (readCachedImage(target)) return filename;
  const url = new URL(asset);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("invalid-asset-url");
  const response = await request(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 8_000_000) {
    await response.body?.cancel();
    throw new Error("asset-too-large");
  }
  if (!response.body) throw new Error("empty-asset");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8_000_000) {
        await reader.cancel();
        throw new Error("asset-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length);
  validateJpeg(bytes);
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!readCachedImage(target)) throw error;
    return filename;
  }
  try {
    writeFileSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
  return filename;
}

function validateJpeg(bytes: Uint8Array): void {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    throw new Error("invalid-jpeg");
}

function readCachedImage(target: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 8_000_000) throw new Error("invalid-cache-file");
    validateJpeg(readFileSync(descriptor));
    return true;
  } finally {
    closeSync(descriptor);
  }
}
