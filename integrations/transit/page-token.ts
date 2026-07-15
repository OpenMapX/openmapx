import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 15 * 60;

export interface TransitPageTokenPayload {
  v: 1;
  cursor: string;
  source: string;
  instance: string;
  datasetEpoch: string;
  fingerprint: string;
  direction: "previous" | "next";
  exp: number;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(body: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/** Hash routing inputs without retaining coordinates or upstream identifiers in telemetry. */
export function transitRequestFingerprint(query: Record<string, string | undefined>): string {
  const canonical = Object.entries(query)
    .filter(([key, value]) => key !== "page_token" && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return createHash("sha256").update(canonical).digest("base64url");
}

export function signTransitPageToken(
  input: Omit<TransitPageTokenPayload, "v" | "exp">,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for transit paging");
  const body = encode(
    JSON.stringify({ ...input, v: TOKEN_VERSION, exp: nowSeconds + TOKEN_TTL_SECONDS }),
  );
  return `${body}.${signature(body, secret).toString("base64url")}`;
}

export function verifyTransitPageToken(
  token: string,
  secret: string,
  expectedFingerprint: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TransitPageTokenPayload {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for transit paging");
  const [body, encodedSignature, extra] = token.split(".");
  if (!body || !encodedSignature || extra) throw new Error("invalid page token");
  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = signature(body, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid page token signature");
  }
  let payload: TransitPageTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid page token payload");
  }
  if (
    payload.v !== TOKEN_VERSION ||
    typeof payload.cursor !== "string" ||
    !payload.cursor ||
    !["previous", "next"].includes(payload.direction) ||
    payload.fingerprint !== expectedFingerprint ||
    !Number.isFinite(payload.exp) ||
    payload.exp < nowSeconds
  ) {
    throw new Error("expired or mismatched page token");
  }
  return payload;
}
