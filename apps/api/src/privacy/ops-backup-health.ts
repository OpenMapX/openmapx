import { isPrivacyBackupCollectorImage } from "@openmapx/core/ops";

const MAX_HEALTH_BYTES = 4_096;

async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEALTH_BYTES) throw new Error("health response too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Accept only an ops-agent observation of the exact configured image and a
 * readable, descriptor-validated backup inventory. Configuration strings by
 * themselves never establish an operational backup extraction capability. */
export async function probeOpsPrivacyBackupCapability(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const baseUrl = env.OPS_AGENT_URL?.trim();
  const expectedImage = env.OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE?.trim();
  if (!baseUrl || !expectedImage || !isPrivacyBackupCollectorImage(expectedImage)) return false;
  let url: URL;
  try {
    url = new URL("/health", baseUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const payload = JSON.parse(await boundedText(response)) as Record<string, unknown>;
    const backup = payload.privacyBackup;
    return (
      payload.ok === true &&
      !!backup &&
      typeof backup === "object" &&
      !Array.isArray(backup) &&
      (backup as Record<string, unknown>).ready === true &&
      (backup as Record<string, unknown>).inventoryReadable === true &&
      (backup as Record<string, unknown>).collectorImage === expectedImage
    );
  } catch {
    return false;
  }
}
