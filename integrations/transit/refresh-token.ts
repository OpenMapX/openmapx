import { createHmac, timingSafeEqual } from "node:crypto";

interface RefreshHandlePayload {
  v: 1;
  id: string;
  exp: number;
}

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function signRefreshHandle(id: string, secret: string, expiresAt: number): string {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for itinerary refresh");
  const body = Buffer.from(JSON.stringify({ v: 1, id, exp: expiresAt }), "utf8").toString(
    "base64url",
  );
  return `${body}.${signature(body, secret).toString("base64url")}`;
}

export function verifyRefreshHandle(
  token: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): RefreshHandlePayload {
  const [body, encodedSignature, extra] = token.split(".");
  if (!secret || !body || !encodedSignature || extra) throw new Error("invalid refresh token");
  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = signature(body, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid refresh token signature");
  }
  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as RefreshHandlePayload;
  if (payload.v !== 1 || !payload.id || !Number.isFinite(payload.exp) || payload.exp < nowSeconds) {
    throw new Error("expired refresh token");
  }
  return payload;
}
