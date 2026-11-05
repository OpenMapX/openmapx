/** Bounded portable encryption. No storage, host reads or secret-valued diagnostics. */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import {
  canonicalFeedCredentialMap,
  parseFeedCredentialMapJson,
} from "@openmapx/transitous-core/feed-credentials";
import z from "zod/v4";
import {
  type CredentialTransferEnvelope,
  credentialTransferEnvelopeSchema,
  credentialTransferFieldSchema,
} from "../../../../../packages/core/src/api/contracts/integration-admin/credential-transfer";

export const TRANSFER_MAX_BYTES = 1048576;
const unavailable = () => new Error("Credential transfer is invalid or unavailable");
const payloadSchema = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(
      credentialTransferFieldSchema.extend({ value: z.string().refine((v) => v.isWellFormed()) }),
    )
    .max(1000),
});
export type CredentialTransferPayload = z.infer<typeof payloadSchema>;
const actors = new Set<string>();
function bounded(value: unknown, max = TRANSFER_MAX_BYTES) {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > max) throw unavailable();
  return text;
}
export function decodeTransferredFeedCredentialMap(text: string): Readonly<Record<string, string>> {
  if (Buffer.byteLength(text) > 65536) throw unavailable();
  return canonicalFeedCredentialMap(parseFeedCredentialMapJson(text)).values;
}
function payload(value: unknown): CredentialTransferPayload {
  const parsed = payloadSchema.parse(value),
    seen = new Set<string>();
  bounded(parsed);
  for (const entry of parsed.entries) {
    const identity = `${entry.scope}:${entry.id}:${entry.key}`;
    if (seen.has(identity)) throw unavailable();
    seen.add(identity);
    if (
      entry.scope === "service" &&
      entry.id === "data-manager" &&
      entry.key === "TRANSITOUS_API_KEYS"
    )
      decodeTransferredFeedCredentialMap(entry.value);
    else if (Buffer.byteLength(entry.value) > 16384) throw unavailable();
  }
  return parsed;
}
async function derived<T>(
  actorId: string,
  passphrase: string,
  salt: Buffer,
  run: (key: Buffer) => T,
): Promise<T> {
  if (
    !actorId ||
    !passphrase.isWellFormed() ||
    Buffer.byteLength(passphrase) < 12 ||
    Buffer.byteLength(passphrase) > 1024 ||
    actors.has(actorId) ||
    actors.size >= 2
  )
    throw unavailable();
  actors.add(actorId);
  const pass = Buffer.from(passphrase);
  let key: Buffer | undefined;
  try {
    key = await new Promise<Buffer>((resolve, reject) =>
      scrypt(pass, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) =>
        error ? reject(unavailable()) : resolve(result),
      ),
    );
    return run(key);
  } finally {
    pass.fill(0);
    key?.fill(0);
    actors.delete(actorId);
  }
}
function aad(envelope: CredentialTransferEnvelope) {
  return Buffer.from(
    canonicalJson({
      format: envelope.format,
      version: envelope.version,
      kdf: envelope.kdf,
      cipher: { name: envelope.cipher.name, iv: envelope.cipher.iv },
    }),
  );
}
function decoded(value: string, bytes?: number) {
  const result = Buffer.from(value, "base64url");
  if (result.toString("base64url") !== value || (bytes !== undefined && result.length !== bytes))
    throw unavailable();
  return result;
}
export async function encryptCredentialTransfer(
  actorId: string,
  value: unknown,
  passphrase: string,
): Promise<CredentialTransferEnvelope> {
  const plaintext = Buffer.from(bounded(payload(value))),
    salt = randomBytes(16),
    iv = randomBytes(12);
  // Reject expansion before allocating a KDF slot.
  if (Math.ceil((plaintext.length * 4) / 3) + 512 > TRANSFER_MAX_BYTES) {
    plaintext.fill(0);
    throw unavailable();
  }
  try {
    return await derived(actorId, passphrase, salt, (key) => {
      const envelope: CredentialTransferEnvelope = {
        format: "openmapx-vault-transfer",
        version: 1,
        kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: salt.toString("base64url") },
        cipher: { name: "aes-256-gcm", iv: iv.toString("base64url"), tag: "" },
        ciphertext: "",
      };
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(envelope));
      envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString(
        "base64url",
      );
      envelope.cipher.tag = cipher.getAuthTag().toString("base64url");
      bounded(envelope);
      return credentialTransferEnvelopeSchema.parse(envelope);
    });
  } finally {
    plaintext.fill(0);
  }
}
export async function decryptCredentialTransfer(
  actorId: string,
  value: unknown,
  passphrase: string,
): Promise<CredentialTransferPayload> {
  bounded(value);
  const envelope = credentialTransferEnvelopeSchema.parse(value),
    salt = decoded(envelope.kdf.salt, 16),
    iv = decoded(envelope.cipher.iv, 12),
    tag = decoded(envelope.cipher.tag, 16),
    ciphertext = decoded(envelope.ciphertext);
  if (ciphertext.length > TRANSFER_MAX_BYTES) throw unavailable();
  return derived(actorId, passphrase, salt, (key) => {
    let plaintext: Buffer | undefined;
    try {
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(envelope));
      cipher.setAuthTag(tag);
      plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
      if (plaintext.length > TRANSFER_MAX_BYTES) throw unavailable();
      return payload(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
    } catch {
      throw unavailable();
    } finally {
      plaintext?.fill(0);
    }
  });
}
