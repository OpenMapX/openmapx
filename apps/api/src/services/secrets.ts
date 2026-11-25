import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { integrationSecret } from "../db/schema";
import { processLogger } from "../process-logger";
import {
  type AdministrativeConfigurationReadContext,
  assertAdministrativeConfigurationRead,
} from "./administrative-configuration-context";
import { readGeneratedKeyFile } from "./generated-key-file";

const ALGORITHM = "aes-256-gcm" as const;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE_VARIABLE = "OPENMAPX_SECRETS_KEY_FILE";
const KEY_UID_VARIABLE = "OPENMAPX_SECRETS_KEY_UID";
const KEY_VARIABLE = "OPENMAPX_SECRETS_KEY";
const KEY_FORMAT =
  "32 random bytes as 43 base64url characters, the format `pnpm openmapx compose render` " +
  "generates; the former 64-character hex format is not accepted";

/** The secrets key is absent, unreadable or not in the one accepted format. */
export class SecretsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsKeyError";
  }
}

/** A stored secret does not open with the configured secrets key. */
export class SecretDecryptionError extends Error {
  constructor() {
    super(
      "A stored secret cannot be decrypted with the configured secrets key: the key differs " +
        "from the one the secret was saved with, or the stored value is damaged",
    );
    this.name = "SecretDecryptionError";
  }
}

function decodeSecretsKey(value: string, origin: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    decoded.length !== 32 ||
    decoded.toString("base64url") !== value
  ) {
    throw new SecretsKeyError(`${origin} must hold ${KEY_FORMAT}`);
  }
  return decoded;
}

let cachedKey: { source: string; key: Buffer } | undefined;

/**
 * The API's secrets key. A rendered deployment mounts the file
 * `openmapx compose render` generated and names it in
 * OPENMAPX_SECRETS_KEY_FILE; development without a render may put the same
 * value in OPENMAPX_SECRETS_KEY. The key is read once per source.
 */
function getSecretsKey(): Buffer {
  const path = process.env[KEY_FILE_VARIABLE]?.trim() ?? "";
  const inline = process.env[KEY_VARIABLE]?.trim() ?? "";
  if (path && inline) {
    throw new SecretsKeyError(
      `Set either ${KEY_FILE_VARIABLE} or ${KEY_VARIABLE}, not both; a rendered deployment uses the key file`,
    );
  }
  if (!path && !inline) {
    throw new SecretsKeyError(
      `The secrets key is not configured: run \`pnpm openmapx compose render\`, which generates it and gives the api service ${KEY_FILE_VARIABLE}`,
    );
  }
  const source = path ? `file:${path}` : `env:${inline}`;
  if (cachedKey?.source === source) return cachedKey.key;
  let key: Buffer;
  if (path) {
    // The render's own rule: exact bytes, one link, mode 0444, the deployment's owner.
    try {
      key = readGeneratedKeyFile(path, "Secrets key file", process.env[KEY_UID_VARIABLE]);
    } catch (error) {
      throw new SecretsKeyError(
        `${(error as Error).message} (${KEY_FILE_VARIABLE}). It must hold ${KEY_FORMAT}, with no newline; restore it byte for byte or run \`pnpm openmapx compose render\` to generate it`,
      );
    }
  } else {
    key = decodeSecretsKey(inline, KEY_VARIABLE);
  }
  cachedKey = { source, key };
  return key;
}

/**
 * Why the secrets key cannot be used, or null when it can: the variable or
 * file rule that failed and how to fix it. Never includes key material.
 */
export function secretsKeyProblem(): string | null {
  try {
    getSecretsKey();
    return null;
  } catch (error) {
    return error instanceof SecretsKeyError ? error.message : "The secrets key cannot be read";
  }
}

export function isSecretsConfigured(): boolean {
  return secretsKeyProblem() === null;
}

/** Throws the reason the secrets key cannot be used, or returns. */
export function assertSecretsConfigured(): void {
  getSecretsKey();
}

/**
 * The version of the secrets key that `encrypt` uses. Every sealed value
 * records the version it was written with, so a later key can be introduced
 * beside this one and rows told apart during a rotation.
 */
export const SECRETS_KEY_VERSION = 1 as const;

/** One value sealed with the secrets key, as it is stored. */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
}

/**
 * The additional authenticated data that binds a sealed value to the row that
 * holds it: `<table>:<row natural key>`. A ciphertext copied into another row
 * then fails to decrypt.
 */
export const secretAad = {
  systemSecret: (key: string) => `system_secret:${key}`,
  integrationSecret: (integrationId: string, key: string) =>
    `integration_secret:${integrationId}:${key}`,
  serviceSecret: (serviceId: string, key: string) => `service_secret:${serviceId}:${key}`,
  personalTimelineConnection: (userId: string) => `personal_timeline_connection:${userId}`,
  transitCredentialPreview: (id: string) => `transit_credential_preview:${id}`,
  transitCredentialAuthorization: (id: string) => `transit_credential_preview:${id}:authorization`,
  configurationMigrationPreview: (id: string) => `configuration_migration_preview:${id}`,
  dataSubjectRequestLocator: (id: string) => `data_subject_request:${id}:locator`,
  platformConfigurationAuthorization: (jobId: string, operationKey: string) =>
    `platform_configuration_intent:${jobId}:${operationKey}`,
} as const;

export function encrypt(
  plaintext: string,
  aad: string,
): SealedSecret & { keyVersion: typeof SECRETS_KEY_VERSION } {
  const key = getSecretsKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: SECRETS_KEY_VERSION,
  };
}

/** Opens a sealed value for the row named by `aad`. Refuses an unknown key version. */
export function decrypt(sealed: SealedSecret, aad: string): string {
  if (sealed.keyVersion !== SECRETS_KEY_VERSION) throw new SecretDecryptionError();
  const key = getSecretsKey();
  const ivBytes = Buffer.from(sealed.iv, "base64");
  const tagBytes = Buffer.from(sealed.tag, "base64");
  // A shortened tag would weaken authentication; only the lengths encrypt() writes open.
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new SecretDecryptionError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, ivBytes, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tagBytes);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    throw new SecretDecryptionError();
  }
}

export async function setSecret(
  integrationId: string,
  key: string,
  value: string,
  updatedBy?: string | null,
): Promise<void> {
  const sealed = encrypt(value, secretAad.integrationSecret(integrationId, key));
  await db
    .insert(integrationSecret)
    .values({
      integrationId,
      key,
      ...sealed,
      updatedByUserId: updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [integrationSecret.integrationId, integrationSecret.key],
      set: {
        ...sealed,
        updatedAt: new Date(),
        updatedByUserId: updatedBy ?? null,
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
    return decrypt(row, secretAad.integrationSecret(integrationId, key));
  } catch (err) {
    processLogger.warn(
      { component: "secrets", err, integrationId, secretKey: key },
      "Failed to retrieve a secret",
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
      updatedBy: integrationSecret.updatedByUserId,
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
        result[row.key] = decrypt(row, secretAad.integrationSecret(integrationId, row.key));
      } catch (err) {
        processLogger.warn(
          { component: "secrets", err, integrationId, secretKey: row.key },
          "Failed to decrypt a secret",
        );
      }
    }
    return result;
  } catch (err) {
    processLogger.warn(
      { component: "secrets", err, integrationId },
      "Failed to query vault secrets",
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
      updatedBy: integrationSecret.updatedByUserId,
    })
    .from(integrationSecret);
}

export async function resolveIntegrationVaultSecretsStrict(
  integrationId: string,
  context: AdministrativeConfigurationReadContext,
): Promise<Record<string, string>> {
  try {
    assertAdministrativeConfigurationRead(context);
    const result: Record<string, string> = {};
    for (const row of context.integrationSecretRows.filter(
      (row) => row.integrationId === integrationId,
    )) {
      if (Object.hasOwn(result, row.key)) throw new Error("duplicate secret");
      result[row.key] = decrypt(row, secretAad.integrationSecret(row.integrationId, row.key));
    }
    return result;
  } catch {
    throw new Error("Configuration acquisition unavailable");
  }
}
