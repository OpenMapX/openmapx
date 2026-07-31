/**
 * Auth-gated endpoints for the logged-in user's Mangrove keypair.
 *
 * Encryption modes:
 *   `unencrypted` → server sees the signing key (explicit opt-in).
 *   `encrypted`   → server stores age-armored ciphertexts only; decryption
 *                   happens on the client with age-encryption.js using either
 *                   a passphrase or a WebAuthn passkey.
 *
 * The age v1 spec forbids mixing a scrypt (passphrase) recipient with any
 * other recipient in the same ciphertext. To let a user unlock with EITHER
 * their passphrase OR any registered passkey, we persist two ciphertexts of
 * the same plaintext:
 *   - `passphraseCiphertext`  (age scrypt-only, set iff user has a passphrase)
 *   - `recipientsCiphertext`  (age webauthn, 1..N passkey recipients)
 *
 * Either column may be null; at least one must be non-null in encrypted mode.
 *
 *  GET    /api/reviews/keypair        — current envelope + wrap metadata (or 204)
 *  POST   /api/reviews/keypair        — create the envelope from scratch
 *  PUT    /api/reviews/keypair/wraps  — atomically replace ciphertexts + wrap list
 *  DELETE /api/reviews/keypair        — discard everything
 */

import { randomUUID } from "node:crypto";
import { httpError } from "@openmapx/integration-framework";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { mangroveKeypair, mangroveKeypairWrap } from "../db/schema";
import { getUserId, requireAuthHook } from "../utils/require-auth";

type EncryptionMode = "unencrypted" | "encrypted";
type WrapType = "passphrase" | "webauthn";

interface WrapInput {
  wrapType?: WrapType;
  label?: string;
  identityString?: string | null;
}

interface WrapWire {
  id: string;
  wrapType: WrapType;
  label: string;
  identityString: string | null;
  createdAt: string;
}

// An age-encrypted P-256 JWK is ~400 bytes armored; even with many recipients
// it stays well under 8 KB. 64 KB gives us plenty of headroom without letting
// an authenticated user pin arbitrary blobs in the DB.
const MAX_CIPHERTEXT_CHARS = 64 * 1024;
// Age webauthn plugin identity strings are ~200–400 chars. 4 KB is generous.
const MAX_IDENTITY_STRING_CHARS = 4 * 1024;

// P-256 x/y/d are 32 bytes → 43 chars base64url. Allow slack for padding/variants.
const MAX_JWK_COORD_CHARS = 128;
// JWKs may carry a few optional fields (alg, ext, key_ops, kid, metadata). Cap
// to prevent an authenticated user from pinning arbitrary blobs in the jsonb column.
const MAX_JWK_STRING_CHARS = 256;
const MAX_JWK_KEYS = 16;

function isCoord(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_JWK_COORD_CHARS;
}

export function isMangrovePublicJwk(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const jwk = v as Record<string, unknown>;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") return false;
  if (!isCoord(jwk.x) || !isCoord(jwk.y)) return false;
  const keys = Object.keys(jwk);
  if (keys.length > MAX_JWK_KEYS) return false;
  for (const val of Object.values(jwk)) {
    if (typeof val === "string" && val.length > MAX_JWK_STRING_CHARS) return false;
  }
  return true;
}

export function isMangrovePrivateJwk(v: unknown): v is Record<string, unknown> {
  return isMangrovePublicJwk(v) && isCoord((v as Record<string, unknown>).d);
}

export function validateWrap(w: WrapInput): {
  wrapType: WrapType;
  label: string;
  identityString: string | null;
} {
  if (w.wrapType !== "passphrase" && w.wrapType !== "webauthn") {
    throw Object.assign(new Error("wrap.wrapType must be 'passphrase' or 'webauthn'"), {
      statusCode: 400,
    });
  }
  if (typeof w.label !== "string" || w.label.length === 0) {
    throw httpError(400, "wrap.label is required");
  }
  if (w.wrapType === "webauthn") {
    if (typeof w.identityString !== "string") {
      throw Object.assign(new Error("webauthn wrap requires an identityString"), {
        statusCode: 400,
      });
    }
    if (w.identityString.length > MAX_IDENTITY_STRING_CHARS) {
      throw Object.assign(new Error("wrap.identityString exceeds maximum length"), {
        statusCode: 400,
      });
    }
  }
  return {
    wrapType: w.wrapType,
    label: w.label.slice(0, 80),
    identityString: w.wrapType === "webauthn" ? (w.identityString as string) : null,
  };
}

interface EncryptedState {
  passphraseCiphertext: string | null;
  recipientsCiphertext: string | null;
  wraps: ReturnType<typeof validateWrap>[];
}

export function validateEncryptedState(body: {
  passphraseCiphertext?: string | null;
  recipientsCiphertext?: string | null;
  wraps?: WrapInput[];
}): EncryptedState {
  const passphraseCiphertext =
    typeof body.passphraseCiphertext === "string" ? body.passphraseCiphertext : null;
  const recipientsCiphertext =
    typeof body.recipientsCiphertext === "string" ? body.recipientsCiphertext : null;

  if (!passphraseCiphertext && !recipientsCiphertext) {
    throw Object.assign(
      new Error("At least one of passphraseCiphertext / recipientsCiphertext is required"),
      { statusCode: 400 },
    );
  }
  if (passphraseCiphertext && passphraseCiphertext.length > MAX_CIPHERTEXT_CHARS) {
    throw Object.assign(new Error("passphraseCiphertext exceeds maximum length"), {
      statusCode: 400,
    });
  }
  if (recipientsCiphertext && recipientsCiphertext.length > MAX_CIPHERTEXT_CHARS) {
    throw Object.assign(new Error("recipientsCiphertext exceeds maximum length"), {
      statusCode: 400,
    });
  }

  if (!Array.isArray(body.wraps) || body.wraps.length === 0) {
    throw httpError(400, "At least one wrap is required");
  }
  const wraps = body.wraps.map(validateWrap);

  const passphraseCount = wraps.filter((w) => w.wrapType === "passphrase").length;
  if (passphraseCount > 1) {
    throw httpError(400, "At most one passphrase wrap per user");
  }
  const hasPassphrase = passphraseCount === 1;
  const hasWebauthn = wraps.some((w) => w.wrapType === "webauthn");

  if (hasPassphrase && !passphraseCiphertext) {
    throw Object.assign(new Error("passphrase wrap present but passphraseCiphertext missing"), {
      statusCode: 400,
    });
  }
  if (!hasPassphrase && passphraseCiphertext) {
    throw Object.assign(new Error("passphraseCiphertext present but no passphrase wrap"), {
      statusCode: 400,
    });
  }
  if (hasWebauthn && !recipientsCiphertext) {
    throw Object.assign(new Error("webauthn wrap present but recipientsCiphertext missing"), {
      statusCode: 400,
    });
  }
  if (!hasWebauthn && recipientsCiphertext) {
    throw Object.assign(new Error("recipientsCiphertext present but no webauthn wrap"), {
      statusCode: 400,
    });
  }

  return { passphraseCiphertext, recipientsCiphertext, wraps };
}

export const reviewsKeypairRoute: FastifyPluginAsync = async (fastify) => {
  // Every keypair route is per-user; authenticate once here so no handler can
  // forget the check.
  fastify.addHook("preHandler", requireAuthHook);
  // Responses carry per-user key material — the cleartext private JWK in
  // unencrypted mode. Keep them out of every HTTP cache and proxy.
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  /** GET — current envelope state. */
  fastify.get("/reviews/keypair", async (request, reply) => {
    const userId = getUserId(request);

    const [row] = await db
      .select()
      .from(mangroveKeypair)
      .where(eq(mangroveKeypair.userId, userId))
      .limit(1);

    if (!row) return reply.status(204).send();

    if (row.encryptionMode === "unencrypted") {
      return reply.send({
        mode: "unencrypted" as const,
        publicJwk: row.publicJwk,
        privateJwk: row.privateJwk,
      });
    }

    const wraps = await db
      .select()
      .from(mangroveKeypairWrap)
      .where(eq(mangroveKeypairWrap.userId, userId));

    const wireWraps: WrapWire[] = wraps.map((w) => ({
      id: w.id,
      wrapType: w.wrapType as WrapType,
      label: w.label,
      identityString: w.identityString,
      createdAt: w.createdAt.toISOString(),
    }));

    return reply.send({
      mode: "encrypted" as const,
      publicJwk: row.publicJwk,
      passphraseCiphertext: row.passphraseCiphertext,
      recipientsCiphertext: row.recipientsCiphertext,
      wraps: wireWraps,
    });
  });

  /** POST — create the keypair envelope. Rejects if one already exists. */
  fastify.post("/reviews/keypair", async (request, reply) => {
    const userId = getUserId(request);

    const [existing] = await db
      .select({ userId: mangroveKeypair.userId })
      .from(mangroveKeypair)
      .where(eq(mangroveKeypair.userId, userId))
      .limit(1);
    if (existing) {
      return reply
        .status(409)
        .send({ error: "Keypair already exists. DELETE it first to start over." });
    }

    const body = request.body as {
      mode?: EncryptionMode;
      publicJwk?: unknown;
      privateJwk?: unknown;
      passphraseCiphertext?: string | null;
      recipientsCiphertext?: string | null;
      wraps?: WrapInput[];
    } | null;

    if (!body || !isMangrovePublicJwk(body.publicJwk)) {
      return reply.status(400).send({ error: "publicJwk must be a valid P-256 JWK" });
    }

    if (body.mode === "unencrypted") {
      if (!isMangrovePrivateJwk(body.privateJwk)) {
        return reply.status(400).send({ error: "privateJwk must be a valid P-256 JWK with d" });
      }
      await db.insert(mangroveKeypair).values({
        userId,
        encryptionMode: "unencrypted",
        publicJwk: body.publicJwk,
        privateJwk: body.privateJwk,
      });
      return reply.status(201).send({ ok: true });
    }

    if (body.mode !== "encrypted") {
      return reply.status(400).send({ error: "mode must be 'unencrypted' or 'encrypted'" });
    }

    let state: EncryptedState;
    try {
      state = validateEncryptedState(body);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return reply.status(status).send({ error: (err as Error).message });
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(mangroveKeypair).values({
          userId,
          encryptionMode: "encrypted",
          publicJwk: body.publicJwk as Record<string, unknown>,
          passphraseCiphertext: state.passphraseCiphertext,
          recipientsCiphertext: state.recipientsCiphertext,
        });
        await tx.insert(mangroveKeypairWrap).values(
          state.wraps.map((w) => ({
            id: randomUUID(),
            userId,
            wrapType: w.wrapType,
            label: w.label,
            identityString: w.identityString,
          })),
        );
      });
    } catch (err) {
      fastify.log.warn(err, "Keypair POST failed");
      return reply.status(500).send({ error: "Keypair creation failed" });
    }

    return reply.status(201).send({ ok: true });
  });

  /**
   * PUT — atomically replace ciphertexts + wrap list (for add/remove/rename
   * passphrase or passkeys). Client re-encrypts the private JWK locally before
   * calling; server only stores the new state.
   */
  fastify.put("/reviews/keypair/wraps", async (request, reply) => {
    const userId = getUserId(request);

    const [kp] = await db
      .select({ mode: mangroveKeypair.encryptionMode })
      .from(mangroveKeypair)
      .where(eq(mangroveKeypair.userId, userId))
      .limit(1);
    if (!kp) return reply.status(404).send({ error: "No keypair" });
    if (kp.mode !== "encrypted") {
      return reply.status(409).send({ error: "Wraps only apply to encrypted keypairs" });
    }

    const body = request.body as {
      passphraseCiphertext?: string | null;
      recipientsCiphertext?: string | null;
      wraps?: WrapInput[];
    } | null;
    if (!body) return reply.status(400).send({ error: "Body required" });

    let state: EncryptedState;
    try {
      state = validateEncryptedState(body);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 400;
      return reply.status(status).send({ error: (err as Error).message });
    }

    try {
      await db.transaction(async (tx) => {
        await tx
          .update(mangroveKeypair)
          .set({
            passphraseCiphertext: state.passphraseCiphertext,
            recipientsCiphertext: state.recipientsCiphertext,
          })
          .where(eq(mangroveKeypair.userId, userId));
        await tx.delete(mangroveKeypairWrap).where(eq(mangroveKeypairWrap.userId, userId));
        await tx.insert(mangroveKeypairWrap).values(
          state.wraps.map((w) => ({
            id: randomUUID(),
            userId,
            wrapType: w.wrapType,
            label: w.label,
            identityString: w.identityString,
          })),
        );
      });
    } catch (err) {
      fastify.log.warn(err, "Wraps PUT failed");
      return reply.status(500).send({ error: "Wrap update failed" });
    }

    return reply.send({ ok: true });
  });

  /** DELETE — wipe keypair + all wraps. Next GET returns 204. */
  fastify.delete("/reviews/keypair", async (request, reply) => {
    const userId = getUserId(request);
    await db.transaction(async (tx) => {
      await tx.delete(mangroveKeypairWrap).where(eq(mangroveKeypairWrap.userId, userId));
      await tx.delete(mangroveKeypair).where(eq(mangroveKeypair.userId, userId));
    });
    return reply.send({ deleted: true });
  });
};
