import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { mobileAuthHandoff } from "../db/schema";

/**
 * The system-browser → WebView session handoff.
 *
 * The installed app never holds a session. When a sign-in has to happen in the
 * system browser, the browser establishes it and hands back one opaque code.
 * That code is only useful to whoever started the attempt, because redeeming it
 * requires the PKCE verifier, and the verifier never left the app's memory.
 *
 * Three properties do all the work here.
 *
 * **Single use, enforced by the database.** Consumption is a conditional UPDATE
 * that only matches an unconsumed, unexpired row. Two racing redemptions of the
 * same code therefore produce exactly one winner, because the loser's UPDATE
 * matches nothing — no read-then-write, no advisory lock, no window.
 *
 * **Uniform failures.** Every rejection returns the same shape. A caller must
 * not be able to tell "no such code" from "wrong verifier" from "already used":
 * the difference tells an attacker which of their guesses was structurally
 * right, and there is no legitimate client that benefits from knowing.
 *
 * **Nothing recoverable at rest.** The callback code is stored hashed; the
 * verifier is never stored at all. A database dump yields no redeemable value.
 */

export type HandoffPurpose = "sign-in" | "link-provider" | "add-passkey";

export const HANDOFF_TTL_MS = 2 * 60_000;
/** How many unconsumed attempts one account may have outstanding. */
export const MAX_OUTSTANDING_PER_USER = 5;

const PURPOSES: ReadonlySet<string> = new Set<HandoffPurpose>([
  "sign-in",
  "link-provider",
  "add-passkey",
]);

/** Base64url with no padding, which is the only encoding this accepts. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface IssueHandoffInput {
  userId: string;
  purpose: string;
  /** S256 challenge, base64url. */
  codeChallenge: string;
  state: string;
  /** The Better Auth one-time token this handoff will release exactly once. */
  oneTimeToken: string;
  nowMs: number;
}

export interface ExchangeHandoffInput {
  callbackCode: string;
  codeVerifier: string;
  state: string;
  nowMs: number;
}

export type IssueResult =
  | { ok: true; callbackCode: string; expiresAtMs: number }
  | { ok: false; reason: "invalid-request" | "too-many-attempts" };

/**
 * Deliberately one failure reason.
 *
 * Distinguishing "expired" from "wrong verifier" would let a caller confirm that
 * a code they guessed existed.
 */
export type ExchangeResult = { ok: true; oneTimeToken: string } | { ok: false; reason: "invalid" };

export interface HandoffDeps {
  db?: typeof defaultDb;
  randomId?: () => string;
  randomCode?: () => string;
}

/** SHA-256, base64url. Used for the stored index of the callback code. */
export function hashCallbackCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("base64url");
}

/** The S256 transformation a verifier must satisfy to match a stored challenge. */
export function challengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Constant-time string comparison that tolerates differing lengths. */
function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still compare something of equal length, so the early return does not
    // become a length oracle for callers timing this.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function bounded(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" && value.length >= min && value.length <= max && BASE64URL.test(value)
  );
}

export class MobileAuthHandoffService {
  private readonly db: typeof defaultDb;
  private readonly randomId: () => string;
  private readonly randomCode: () => string;

  constructor(deps: HandoffDeps = {}) {
    this.db = deps.db ?? defaultDb;
    this.randomId = deps.randomId ?? (() => randomBytes(16).toString("hex"));
    // 32 bytes. The code travels through an OS-routed custom-scheme URL, so it
    // has to be unguessable on its own even though PKCE also protects it.
    this.randomCode = deps.randomCode ?? (() => randomBytes(32).toString("base64url"));
  }

  async issue(input: IssueHandoffInput): Promise<IssueResult> {
    if (!PURPOSES.has(input.purpose)) return { ok: false, reason: "invalid-request" };
    // 43 characters is the shortest a base64url SHA-256 digest can be; anything
    // shorter is not an S256 challenge whatever else it might be.
    if (!bounded(input.codeChallenge, 43, 128)) return { ok: false, reason: "invalid-request" };
    if (!bounded(input.state, 16, 128)) return { ok: false, reason: "invalid-request" };
    if (typeof input.oneTimeToken !== "string" || input.oneTimeToken.length === 0) {
      return { ok: false, reason: "invalid-request" };
    }

    await this.scrubExpired(input.nowMs);

    const outstanding = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mobileAuthHandoff)
      .where(and(eq(mobileAuthHandoff.userId, input.userId), isNull(mobileAuthHandoff.consumedAt)));
    if ((outstanding[0]?.count ?? 0) >= MAX_OUTSTANDING_PER_USER) {
      return { ok: false, reason: "too-many-attempts" };
    }

    const callbackCode = this.randomCode();
    const expiresAtMs = input.nowMs + HANDOFF_TTL_MS;
    await this.db.insert(mobileAuthHandoff).values({
      id: this.randomId(),
      callbackCodeHash: hashCallbackCode(callbackCode),
      codeChallenge: input.codeChallenge,
      state: input.state,
      purpose: input.purpose,
      userId: input.userId,
      oneTimeToken: input.oneTimeToken,
      createdAt: new Date(input.nowMs),
      expiresAt: new Date(expiresAtMs),
    });

    return { ok: true, callbackCode, expiresAtMs };
  }

  async exchange(input: ExchangeHandoffInput): Promise<ExchangeResult> {
    if (!bounded(input.callbackCode, 16, 256)) return { ok: false, reason: "invalid" };
    // RFC 7636 fixes the verifier at 43–128 characters.
    if (!bounded(input.codeVerifier, 43, 128)) return { ok: false, reason: "invalid" };
    if (!bounded(input.state, 16, 128)) return { ok: false, reason: "invalid" };

    const hash = hashCallbackCode(input.callbackCode);

    // One conditional UPDATE. Two racing redemptions produce one winner because
    // the loser's WHERE no longer matches — there is no read-then-write window
    // for them to both pass through.
    const consumed = await this.db
      .update(mobileAuthHandoff)
      .set({ consumedAt: new Date(input.nowMs) })
      .where(
        and(
          eq(mobileAuthHandoff.callbackCodeHash, hash),
          isNull(mobileAuthHandoff.consumedAt),
          // Through the typed operator, not a raw fragment: a raw one sends the
          // Date as timestamptz against a timestamp column and the driver
          // refuses it.
          gt(mobileAuthHandoff.expiresAt, new Date(input.nowMs)),
        ),
      )
      .returning({
        codeChallenge: mobileAuthHandoff.codeChallenge,
        state: mobileAuthHandoff.state,
        oneTimeToken: mobileAuthHandoff.oneTimeToken,
      });

    const row = consumed[0];
    if (!row) return { ok: false, reason: "invalid" };

    // Checked after consuming on purpose: a wrong verifier has still burned the
    // attempt, so a caller cannot grind through guesses against one live code.
    const verifierMatches = equals(challengeForVerifier(input.codeVerifier), row.codeChallenge);
    const stateMatches = equals(input.state, row.state);
    if (!verifierMatches || !stateMatches) return { ok: false, reason: "invalid" };

    // The row's only remaining value is the token it just released.
    await this.db.delete(mobileAuthHandoff).where(eq(mobileAuthHandoff.callbackCodeHash, hash));

    return { ok: true, oneTimeToken: row.oneTimeToken };
  }

  /** Drops rows that can no longer be redeemed. Opportunistic, never required. */
  async scrubExpired(nowMs: number): Promise<void> {
    await this.db.delete(mobileAuthHandoff).where(lt(mobileAuthHandoff.expiresAt, new Date(nowMs)));
  }
}
