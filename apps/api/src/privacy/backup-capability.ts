import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  createPrivacyBackupCapability,
  type PrivacyBackupCapabilityPayload,
  privacyBackupSubjectLocatorDigest,
} from "@openmapx/core/ops";

/** Load the API/ops shared capability key without following links or logging it. */
export async function loadPrivacyBackupCapabilityKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const path = env.OPS_PRIVACY_BACKUP_CAPABILITY_KEY_FILE?.trim();
  if (!path || !path.startsWith("/"))
    throw new Error("privacy backup capability key is unavailable");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : info.uid;
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size !== 43 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== expectedUid
    )
      throw new Error("invalid capability key");
    const value = Buffer.alloc(43);
    const read = await handle.read(value, 0, value.byteLength, 0);
    const encoded = value.subarray(0, read.bytesRead).toString("utf8");
    if (read.bytesRead !== value.byteLength || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
      throw new Error("invalid capability key");
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== encoded)
      throw new Error("invalid capability key");
    return key;
  } catch {
    throw new Error("privacy backup capability key is unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function issuePrivacyBackupCapability(
  input: Omit<
    PrivacyBackupCapabilityPayload,
    "version" | "id" | "issuedAt" | "expiresAt" | "subjectLocatorDigest"
  > &
    Partial<Pick<PrivacyBackupCapabilityPayload, "id" | "issuedAt" | "expiresAt">> & {
      subjectLocator: { kind: "user_id"; value: string };
    },
  key: Uint8Array,
  now = new Date(),
): string {
  const { subjectLocator, ...capability } = input;
  return createPrivacyBackupCapability(
    { ...capability, subjectLocatorDigest: privacyBackupSubjectLocatorDigest(subjectLocator) },
    key,
    now,
  );
}

/** Build the exact locator binding used by the dedicated ops channel without
 * ever serializing the locator into a capability or an event. */
export { privacyBackupSubjectLocatorDigest };
