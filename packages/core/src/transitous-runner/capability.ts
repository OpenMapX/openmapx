import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TransitousRunnerScript } from "./contract";

/**
 * Single-use capability tokens for the private Transitous runner.
 *
 * The caller and the runner share only a signing key, never a list of valid
 * tokens: a token is minted per run, carries its own issue time, and is
 * unforgeable without the key. The runner enforces the "single use" half by
 * remembering the nonce of every token it has already honoured, so a token
 * captured in transit buys an attacker nothing — it is either already spent or
 * expired within minutes.
 */

/** A token is valid for one short window; runs are dispatched immediately. */
export const CAPABILITY_TTL_MS = 5 * 60_000;

const PREFIX = "trc1";
/**
 * `trc1_<issuedAtBase36>_<nonceHex>_<macHex>`. The fields are hex rather than
 * base64url precisely because base64url's alphabet contains the `_` separator,
 * which would split a token into an unparseable number of fields roughly half
 * the time.
 */
const FIELD_COUNT = 4;
const NONCE_BYTES = 16;

/** Shortest platform secret this key may be derived from. */
const MIN_KEY_CHARS = 32;

/**
 * Interpret a capability-key file's contents. Both sides call this so neither
 * encodes an assumption about the generator's output format: the key is the
 * file's trimmed bytes, whatever the platform secret happens to look like.
 */
export function parseCapabilityKey(contents: string): Buffer {
  const trimmed = contents.trim();
  if (trimmed.length < MIN_KEY_CHARS) {
    // The message never repeats the contents.
    throw new Error(`Capability key must be at least ${MIN_KEY_CHARS} characters`);
  }
  return Buffer.from(trimmed, "utf8");
}

function signature(key: Buffer | Uint8Array, payload: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

function encode(value: Buffer): string {
  return value.toString("hex");
}

/** Stable, unambiguous description of the exact run a capability authorizes. */
function runScope(run: TransitousRunnerScript): string {
  switch (run.script) {
    case "fetch":
      return JSON.stringify([run.script, run.feedPath]);
    case "fetch-operator":
      return JSON.stringify([run.script, run.metadataName]);
    case "garbage-collect":
    case "generate-attribution":
    case "feed-proxy-vars-to-json":
      return JSON.stringify([run.script]);
    case "generate-motis-config":
      return JSON.stringify([run.script, run.importOnly, run.feedProxy, run.countries]);
  }
}

export function mintTransitousCapability(
  key: Buffer | Uint8Array,
  options: { now: number; run: TransitousRunnerScript; nonce?: string },
): string {
  const issuedAt = Math.floor(options.now).toString(36);
  const nonce = options.nonce ?? encode(randomBytes(NONCE_BYTES));
  const payload = `${issuedAt}_${nonce}`;
  const signedPayload = `${payload}_${runScope(options.run)}`;
  return `${PREFIX}_${payload}_${encode(signature(key, signedPayload))}`;
}

export type CapabilityVerification =
  | { ok: true; nonce: string }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifyTransitousCapability(
  key: Buffer | Uint8Array,
  capability: string,
  run: TransitousRunnerScript,
  now: number,
): CapabilityVerification {
  const fields = capability.split("_");
  if (fields.length !== FIELD_COUNT || fields[0] !== PREFIX) {
    return { ok: false, reason: "malformed" };
  }
  const [, issuedAtField, nonce, mac] = fields as [string, string, string, string];
  if (
    !/^[0-9a-z]{1,12}$/.test(issuedAtField) ||
    !/^[0-9a-f]{32}$/.test(nonce) ||
    !/^[0-9a-f]{64}$/.test(mac)
  ) {
    return { ok: false, reason: "malformed" };
  }

  // Compare the signature before reading the clock: an unsigned token must not
  // be able to distinguish "expired" from "forged" by its response.
  const expected = signature(key, `${issuedAtField}_${nonce}_${runScope(run)}`);
  const presented = Buffer.from(mac, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "signature" };
  }

  const issuedAt = Number.parseInt(issuedAtField, 36);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: "malformed" };
  const age = now - issuedAt;
  // A token stamped in the future is rejected too: accepting one would let a
  // caller mint a capability that outlives the replay window.
  if (age < -60_000 || age > CAPABILITY_TTL_MS) return { ok: false, reason: "expired" };

  return { ok: true, nonce };
}
