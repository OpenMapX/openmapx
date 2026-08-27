import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_SALT = "openmapx:mobile-auth-handoff:key:v1";
const KEY_INFO = "better-auth-one-time-token-at-rest";
const AAD_PREFIX = "openmapx:mobile-auth-handoff:row:v1:";

export interface EncryptedHandoffToken {
  version: number;
  ciphertext: string;
  iv: string;
  tag: string;
}

function key(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for mobile auth handoff encryption");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from(KEY_SALT, "utf8"),
      Buffer.from(KEY_INFO, "utf8"),
      KEY_BYTES,
    ),
  );
}

function aad(rowId: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${rowId}`, "utf8");
}

/** Encrypts one short-lived Better Auth token with a fresh nonce. */
export function encryptHandoffToken(token: string, rowId: string): EncryptedHandoffToken {
  const derivedKey = key();
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, derivedKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(rowId));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
      version: 1,
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    derivedKey.fill(0);
  }
}

/** Authenticates and decrypts a token only for the row that owns it. */
export function decryptHandoffToken(envelope: EncryptedHandoffToken, rowId: string): string {
  if (envelope.version !== 1) throw new Error("unsupported mobile auth handoff key version");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("invalid mobile auth handoff encryption envelope");
  }

  const derivedKey = key();
  try {
    const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(rowId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } finally {
    derivedKey.fill(0);
  }
}
