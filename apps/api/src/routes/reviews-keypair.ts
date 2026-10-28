/** Authenticated encrypted-only key envelopes. Private keys never cross this boundary. */

import { randomUUID } from "node:crypto";
import { httpError } from "@openmapx/integration-framework";
import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { db } from "../db";
import { mangroveKeypair, mangroveKeypairWrap } from "../db/schema";
import { getUserId, requireAuthHook } from "../utils/require-auth";
import { declareRouteAuth } from "../utils/route-auth";

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
// One passphrase plus a generous set of device passkeys. Check this before
// per-wrap validation so authenticated callers cannot fan one request out into
// unbounded object mapping or database rows. The React client mirrors this
// value as a preflight; this server-side check remains authoritative.
export const MAX_KEYPAIR_WRAPS = 32;

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
  const allowed = new Set(["kty", "crv", "x", "y", "alg", "ext", "key_ops", "kid"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (jwk.alg !== undefined && jwk.alg !== "ES256") return false;
  if (jwk.ext !== undefined && typeof jwk.ext !== "boolean") return false;
  if (jwk.kid !== undefined && typeof jwk.kid !== "string") return false;
  if (
    jwk.key_ops !== undefined &&
    (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((op) => op !== "verify"))
  )
    return false;
  for (const val of Object.values(jwk)) {
    if (typeof val === "string" && val.length > MAX_JWK_STRING_CHARS) return false;
  }
  return true;
}

export function validateWrap(w: WrapInput): {
  wrapType: WrapType;
  label: string;
  identityString: string | null;
} {
  if (!w || typeof w !== "object") throw httpError(400, "Invalid wrap");
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
  if (body.wraps.length > MAX_KEYPAIR_WRAPS) {
    throw httpError(400, `At most ${MAX_KEYPAIR_WRAPS} keypair wraps are supported`);
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

function readBody(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw httpError(400, "Invalid encrypted envelope fields");
  }
  return value as Record<string, unknown>;
}
function expectedRevision(body: Record<string, unknown>): string {
  const value = body.expectedRevision;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw httpError(400, "expectedRevision is required");
  }
  return value;
}
const encryptedFields = ["passphraseCiphertext", "recipientsCiphertext", "wraps"];

export const reviewsKeypairRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "session");
  fastify.addHook("preHandler", requireAuthHook);
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  fastify.get("/reviews/keypair", async (request, reply) => {
    const userId = getUserId(request);
    // Both queries see the same snapshot even when wraps are concurrently replaced.
    const envelope = await db.transaction(
      async (tx) => {
        const [row] = await tx
          .select()
          .from(mangroveKeypair)
          .where(eq(mangroveKeypair.userId, userId))
          .limit(1);
        if (!row) return null;
        const wraps = await tx
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
        return {
          revision: row.revision,
          publicJwk: row.publicJwk,
          passphraseCiphertext: row.passphraseCiphertext,
          recipientsCiphertext: row.recipientsCiphertext,
          wraps: wireWraps,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return envelope ? reply.send(envelope) : reply.status(204).send();
  });

  fastify.post("/reviews/keypair", async (request, reply) => {
    const userId = getUserId(request);
    const body = readBody(request.body, ["publicJwk", ...encryptedFields]);
    if (!isMangrovePublicJwk(body.publicJwk))
      throw httpError(400, "publicJwk must be a valid P-256 public JWK");
    const state = validateEncryptedState(body);
    const revision = randomUUID();
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(mangroveKeypair)
        .values({
          userId,
          revision,
          publicJwk: body.publicJwk,
          passphraseCiphertext: state.passphraseCiphertext,
          recipientsCiphertext: state.recipientsCiphertext,
        })
        .onConflictDoNothing()
        .returning({ revision: mangroveKeypair.revision });
      if (!created) throw httpError(409, "Keypair revision conflict");
      await tx
        .insert(mangroveKeypairWrap)
        .values(state.wraps.map((w) => ({ id: randomUUID(), userId, ...w })));
    });
    return reply.status(201).send({ revision });
  });

  fastify.put("/reviews/keypair/wraps", async (request, reply) => {
    const userId = getUserId(request);
    const body = readBody(request.body, ["expectedRevision", ...encryptedFields]);
    const expected = expectedRevision(body);
    const state = validateEncryptedState(body);
    const revision = randomUUID();
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(mangroveKeypair)
        .set({
          revision,
          passphraseCiphertext: state.passphraseCiphertext,
          recipientsCiphertext: state.recipientsCiphertext,
        })
        .where(and(eq(mangroveKeypair.userId, userId), eq(mangroveKeypair.revision, expected)))
        .returning({ revision: mangroveKeypair.revision });
      if (!updated) throw httpError(409, "Keypair revision conflict");
      await tx.delete(mangroveKeypairWrap).where(eq(mangroveKeypairWrap.userId, userId));
      await tx
        .insert(mangroveKeypairWrap)
        .values(state.wraps.map((w) => ({ id: randomUUID(), userId, ...w })));
    });
    return reply.send({ revision });
  });

  fastify.delete("/reviews/keypair", async (request, reply) => {
    const userId = getUserId(request);
    const expected = expectedRevision(readBody(request.body, ["expectedRevision"]));
    await db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(mangroveKeypair)
        .where(and(eq(mangroveKeypair.userId, userId), eq(mangroveKeypair.revision, expected)))
        .returning({ userId: mangroveKeypair.userId });
      if (!deleted) throw httpError(409, "Keypair revision conflict");
      // Child metadata is removed by the parent FK cascade.
    });
    return reply.send({ deleted: true });
  });
};
