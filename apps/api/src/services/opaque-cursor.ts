import { createHmac, timingSafeEqual } from "node:crypto";
import { type OpaqueCursorCodec, OpaqueCursorError } from "@openmapx/integration-framework";

const CURSOR_VERSION = 1;
const MAX_CURSOR_BYTES = 2 * 1024;

interface CursorEnvelope {
  v: typeof CURSOR_VERSION;
  purpose: string;
  exp: number;
  value: unknown;
}

function invalid(message = "Cursor is invalid"): OpaqueCursorError {
  return new OpaqueCursorError("CURSOR_INVALID", message);
}

export function createOpaqueCursorCodec(
  secret: string,
  now: () => number = Date.now,
): OpaqueCursorCodec {
  if (!secret) throw new Error("Opaque cursor signing secret is required");

  const sign = (payload: string): Buffer =>
    createHmac("sha256", secret).update(payload, "utf8").digest();

  return {
    encode<T>(purpose: string, value: T, ttlMs: number): string {
      if (!purpose) throw invalid("Cursor purpose is required");
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw invalid("Cursor TTL is invalid");
      let payload: string;
      try {
        payload = Buffer.from(
          JSON.stringify({ v: CURSOR_VERSION, purpose, exp: now() + ttlMs, value }),
          "utf8",
        ).toString("base64url");
      } catch {
        throw invalid("Cursor value is not serializable");
      }
      const token = `${payload}.${sign(payload).toString("base64url")}`;
      if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) {
        throw new OpaqueCursorError("CURSOR_TOO_LARGE", "Cursor is too large");
      }
      return token;
    },

    decode<T>(token: string, purpose: string): T {
      if (!token || Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) throw invalid();
      const parts = token.split(".");
      if (parts.length !== 2) throw invalid();
      const [payload, encodedSignature] = parts;
      if (!payload || !encodedSignature) throw invalid();

      let suppliedSignature: Buffer;
      try {
        suppliedSignature = Buffer.from(encodedSignature, "base64url");
      } catch {
        throw invalid();
      }
      const expectedSignature = sign(payload);
      if (
        suppliedSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        throw invalid("Cursor signature is invalid");
      }

      let envelope: CursorEnvelope;
      try {
        envelope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CursorEnvelope;
      } catch {
        throw invalid();
      }
      if (
        envelope.v !== CURSOR_VERSION ||
        typeof envelope.purpose !== "string" ||
        typeof envelope.exp !== "number" ||
        !("value" in envelope)
      ) {
        throw invalid();
      }
      if (envelope.purpose !== purpose) {
        throw new OpaqueCursorError("CURSOR_PURPOSE_MISMATCH", "Cursor purpose does not match");
      }
      if (envelope.exp < now()) {
        throw new OpaqueCursorError("CURSOR_EXPIRED", "Cursor has expired");
      }
      return envelope.value as T;
    },
  };
}

export function cursorCodecFromEnvironment(): OpaqueCursorCodec | undefined {
  const secret = process.env.BETTER_AUTH_SECRET;
  return secret ? createOpaqueCursorCodec(secret) : undefined;
}
