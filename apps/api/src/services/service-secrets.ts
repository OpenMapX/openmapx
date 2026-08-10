import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { serviceSecret } from "../db/schema";
import { decrypt, encrypt, isSecretsConfigured } from "./secrets";

// Vault storage for self-hosted *service* secrets (the container track). Mirrors
// the integration-secret functions in `./secrets`, reusing the same AES-256-GCM
// crypto primitives (no duplication) but keyed on `service_secret.service_id`.
// The render step decrypts these into mounted secret files; they are never
// placed in the container environment. See `resolveServiceVaultSecrets`.

export async function setServiceSecret(
  serviceId: string,
  key: string,
  value: string,
  updatedBy?: string | null,
): Promise<void> {
  const { ciphertext, iv, tag } = encrypt(value);
  await db
    .insert(serviceSecret)
    .values({ id: randomUUID(), serviceId, key, ciphertext, iv, tag, updatedBy: updatedBy ?? null })
    .onConflictDoUpdate({
      target: [serviceSecret.serviceId, serviceSecret.key],
      set: { ciphertext, iv, tag, updatedAt: new Date(), updatedBy: updatedBy ?? null },
    });
}

export async function getServiceSecret(serviceId: string, key: string): Promise<string | null> {
  try {
    const [row] = await db
      .select()
      .from(serviceSecret)
      .where(and(eq(serviceSecret.serviceId, serviceId), eq(serviceSecret.key, key)))
      .limit(1);
    if (!row) return null;
    return decrypt(row.ciphertext, row.iv, row.tag);
  } catch (err) {
    console.warn(
      `[service-secrets] Failed to retrieve secret "${key}" for service "${serviceId}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Strict vault read for security-sensitive reconciliation paths.
 *
 * Unlike the best-effort renderer helper above, an unavailable database or an
 * undecryptable row must not be mistaken for an absent secret: doing so could
 * rotate a live credential or generate a conflicting database password.
 */
export async function getServiceSecretStrict(
  serviceId: string,
  key: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(serviceSecret)
    .where(and(eq(serviceSecret.serviceId, serviceId), eq(serviceSecret.key, key)))
    .limit(1);
  if (!row) return null;
  return decrypt(row.ciphertext, row.iv, row.tag);
}

export async function deleteServiceSecret(serviceId: string, key: string): Promise<void> {
  await db
    .delete(serviceSecret)
    .where(and(eq(serviceSecret.serviceId, serviceId), eq(serviceSecret.key, key)));
}

export async function listServiceSecrets(
  serviceId: string,
): Promise<Array<{ key: string; updatedAt: Date; updatedBy: string | null }>> {
  return db
    .select({
      key: serviceSecret.key,
      updatedAt: serviceSecret.updatedAt,
      updatedBy: serviceSecret.updatedBy,
    })
    .from(serviceSecret)
    .where(eq(serviceSecret.serviceId, serviceId));
}

/** Resolve all decrypted vault secrets for a service in a single DB query. */
export async function resolveServiceVaultSecrets(
  serviceId: string,
): Promise<Record<string, string>> {
  if (!isSecretsConfigured()) return {};
  try {
    const rows = await db
      .select()
      .from(serviceSecret)
      .where(eq(serviceSecret.serviceId, serviceId));
    const result: Record<string, string> = {};
    for (const row of rows) {
      try {
        result[row.key] = decrypt(row.ciphertext, row.iv, row.tag);
      } catch (err) {
        console.warn(
          `[service-secrets] Failed to decrypt secret "${row.key}" for service "${serviceId}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return result;
  } catch (err) {
    console.warn(
      `[service-secrets] Failed to query vault secrets for service "${serviceId}":`,
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

/** All service secrets across every service — used to render the secret files. */
export async function listAllServiceSecrets(): Promise<
  Array<{ serviceId: string; key: string; updatedAt: Date; updatedBy: string | null }>
> {
  return db
    .select({
      serviceId: serviceSecret.serviceId,
      key: serviceSecret.key,
      updatedAt: serviceSecret.updatedAt,
      updatedBy: serviceSecret.updatedBy,
    })
    .from(serviceSecret);
}
