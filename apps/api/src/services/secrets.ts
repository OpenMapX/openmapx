import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { integrationSecret } from "../db/schema";

const ALGORITHM = "aes-256-gcm" as const;

export function isSecretsConfigured(): boolean {
  const keyHex = process.env.OPENMAPX_SECRETS_KEY;
  if (!keyHex) return false;
  return Buffer.from(keyHex, "hex").length === 32;
}

function getSecretsKey(): Buffer {
  const keyHex = process.env.OPENMAPX_SECRETS_KEY;
  if (!keyHex) {
    throw new Error("OPENMAPX_SECRETS_KEY is not set. Generate one with: openssl rand -hex 32");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("OPENMAPX_SECRETS_KEY must be 64 hex characters (32 bytes)");
  }
  return key;
}

export function encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const key = getSecretsKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decrypt(ciphertext: string, iv: string, tag: string): string {
  const key = getSecretsKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export async function setSecret(
  integrationId: string,
  key: string,
  value: string,
  updatedBy?: string | null,
): Promise<void> {
  const { ciphertext, iv, tag } = encrypt(value);
  await db
    .insert(integrationSecret)
    .values({
      id: randomUUID(),
      integrationId,
      key,
      ciphertext,
      iv,
      tag,
      updatedBy: updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [integrationSecret.integrationId, integrationSecret.key],
      set: {
        ciphertext,
        iv,
        tag,
        updatedAt: new Date(),
        updatedBy: updatedBy ?? null,
      },
    });
}

export async function getSecret(integrationId: string, key: string): Promise<string | null> {
  try {
    const [row] = await db
      .select()
      .from(integrationSecret)
      .where(
        and(eq(integrationSecret.integrationId, integrationId), eq(integrationSecret.key, key)),
      )
      .limit(1);
    if (!row) return null;
    return decrypt(row.ciphertext, row.iv, row.tag);
  } catch (err) {
    console.warn(
      `[secrets] Failed to retrieve secret "${key}" for integration "${integrationId}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function deleteSecret(integrationId: string, key: string): Promise<void> {
  await db
    .delete(integrationSecret)
    .where(and(eq(integrationSecret.integrationId, integrationId), eq(integrationSecret.key, key)));
}

export async function listSecrets(
  integrationId: string,
): Promise<Array<{ key: string; updatedAt: Date; updatedBy: string | null }>> {
  return db
    .select({
      key: integrationSecret.key,
      updatedAt: integrationSecret.updatedAt,
      updatedBy: integrationSecret.updatedBy,
    })
    .from(integrationSecret)
    .where(eq(integrationSecret.integrationId, integrationId));
}

/** Resolve all decrypted vault secrets for an integration in a single DB query. */
export async function resolveVaultSecrets(integrationId: string): Promise<Record<string, string>> {
  if (!isSecretsConfigured()) return {};
  try {
    const rows = await db
      .select()
      .from(integrationSecret)
      .where(eq(integrationSecret.integrationId, integrationId));
    const result: Record<string, string> = {};
    for (const row of rows) {
      try {
        result[row.key] = decrypt(row.ciphertext, row.iv, row.tag);
      } catch (err) {
        console.warn(
          `[secrets] Failed to decrypt secret "${row.key}" for integration "${integrationId}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return result;
  } catch (err) {
    console.warn(
      `[secrets] Failed to query vault secrets for integration "${integrationId}":`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

export async function listAllSecrets(): Promise<
  Array<{ integrationId: string; key: string; updatedAt: Date; updatedBy: string | null }>
> {
  return db
    .select({
      integrationId: integrationSecret.integrationId,
      key: integrationSecret.key,
      updatedAt: integrationSecret.updatedAt,
      updatedBy: integrationSecret.updatedBy,
    })
    .from(integrationSecret);
}
