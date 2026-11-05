import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  type PreparedConfigurationRecord,
  preparedConfigurationRecordSchema,
} from "./configuration-preparation-records";
import { canonicalJson, opsOperationFingerprint } from "./fingerprint";
import { inspectTrustedConfigurationSnapshot } from "./trusted-config";

export * from "./configuration-preparation-records";

const domain = "openmapx-prepared-configuration-candidate-v1\0";
export function encodePreparedConfigurationRecord(
  record: PreparedConfigurationRecord,
  token: string,
): Buffer {
  const parsed = preparedConfigurationRecordSchema.parse(record);
  const mac = createHmac("sha256", token)
    .update(domain)
    .update(canonicalJson(parsed))
    .digest("base64url");
  const bytes = Buffer.from(`${JSON.stringify({ record: parsed, mac })}\n`);
  if (bytes.length > 768 * 1024) throw new Error("Prepared configuration unavailable");
  return bytes;
}
export function inspectPreparedConfigurationRecord(bytes: Uint8Array, token: string) {
  if (bytes.byteLength > 768 * 1024) throw new Error("Prepared configuration unavailable");
  const envelope = z
    .strictObject({
      record: preparedConfigurationRecordSchema,
      mac: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const expected = createHmac("sha256", token)
    .update(domain)
    .update(canonicalJson(envelope.record))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.mac, "base64url")))
    throw new Error("Prepared configuration unavailable");
  const sealed = Buffer.from(envelope.record.sealed, "base64");
  if (sealed.toString("base64") !== envelope.record.sealed)
    throw new Error("Prepared configuration unavailable");
  const snapshot = inspectTrustedConfigurationSnapshot(sealed, { token });
  if (
    snapshot.operationKey !== envelope.record.operationKey ||
    opsOperationFingerprint(
      envelope.record.operation as Parameters<typeof opsOperationFingerprint>[0],
    ) !== snapshot.operationFingerprint
  )
    throw new Error("Prepared configuration unavailable");
  return { record: envelope.record, sealed, snapshot };
}
