import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sql } from "../db";
import { mobileAuthHandoff } from "../db/schema";
import {
  challengeForVerifier,
  HANDOFF_TTL_MS,
  hashCallbackCode,
  MAX_OUTSTANDING_PER_USER,
  MobileAuthHandoffService,
} from "./mobileAuthHandoff";

const USER = "handoff-test-user";
const OTHER_USER = "handoff-test-user-2";
const NOW = 1_700_000_000_000;
const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipDatabase)("MobileAuthHandoffService with PostgreSQL", () => {
  beforeAll(async () => {
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "mobile-handoff-database-test-secret-with-at-least-thirty-two-characters",
    );
    // CI applies the real Drizzle migrations first. A missing database or
    // schema is therefore a test failure, never a reason to silently skip.
    await sql`
      insert into "user" (id, name, email) values
        (${USER}, 'Handoff Tester', 'handoff@example.test'),
        (${OTHER_USER}, 'Other Tester', 'other@example.test')
      on conflict (id) do nothing
    `;
  });

  afterAll(() => vi.unstubAllEnvs());

  beforeEach(async () => {
    await db.delete(mobileAuthHandoff).where(eq(mobileAuthHandoff.userId, USER));
    await db.delete(mobileAuthHandoff).where(eq(mobileAuthHandoff.userId, OTHER_USER));
  });

  afterEach(async () => {
    await db.delete(mobileAuthHandoff).where(eq(mobileAuthHandoff.userId, USER));
    await db.delete(mobileAuthHandoff).where(eq(mobileAuthHandoff.userId, OTHER_USER));
  });

  const VERIFIER = randomBytes(32).toString("base64url");
  const CHALLENGE = challengeForVerifier(VERIFIER);
  const STATE = randomBytes(16).toString("base64url");

  const service = new MobileAuthHandoffService();

  async function issued(overrides: Record<string, unknown> = {}) {
    const result = await service.issue({
      userId: USER,
      purpose: "sign-in",
      codeChallenge: CHALLENGE,
      state: STATE,
      oneTimeToken: "ott-value",
      nowMs: NOW,
      ...overrides,
    });
    if (!result.ok) throw new Error(`issue failed: ${result.reason}`);
    return result;
  }

  describe("MobileAuthHandoffService.issue", () => {
    it("returns a code that expires in two minutes", async () => {
      const result = await issued();

      expect(result.expiresAtMs).toBe(NOW + HANDOFF_TTL_MS);
      expect(result.callbackCode.length).toBeGreaterThan(32);
    });

    it("stores the code hashed, never in the clear", async () => {
      const result = await issued();

      const rows = await db
        .select()
        .from(mobileAuthHandoff)
        .where(eq(mobileAuthHandoff.callbackCodeHash, hashCallbackCode(result.callbackCode)));

      // A database read must not yield something redeemable.
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(result.callbackCode);
      expect(JSON.stringify(rows[0])).not.toContain("ott-value");
      expect(rows[0]).toMatchObject({ tokenKeyVersion: 1 });
    });

    it("stores the challenge and never the verifier", async () => {
      await issued();

      const rows = await db
        .select()
        .from(mobileAuthHandoff)
        .where(eq(mobileAuthHandoff.userId, USER));

      // The whole point of PKCE: another app that intercepted the callback still
      // cannot redeem it.
      expect(rows[0].codeChallenge).toBe(CHALLENGE);
      expect(JSON.stringify(rows[0])).not.toContain(VERIFIER);
    });

    it.each(["", "sign_in", "delete-account", "SIGN-IN"])(
      "refuses the purpose %j",
      async (purpose) => {
        await expect(
          service.issue({
            userId: USER,
            purpose,
            codeChallenge: CHALLENGE,
            state: STATE,
            oneTimeToken: "ott",
            nowMs: NOW,
          }),
        ).resolves.toEqual({ ok: false, reason: "invalid-request" });
      },
    );

    it.each([
      { label: "a too-short challenge", codeChallenge: "abc" },
      { label: "a non-base64url challenge", codeChallenge: `${"a".repeat(42)}+/=` },
      { label: "a too-short state", state: "short" },
    ])("refuses $label", async (overrides) => {
      await expect(
        service.issue({
          userId: USER,
          purpose: "sign-in",
          codeChallenge: CHALLENGE,
          state: STATE,
          oneTimeToken: "ott",
          nowMs: NOW,
          ...overrides,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid-request" });
    });

    it("caps how many attempts one account may have outstanding", async () => {
      for (let index = 0; index < MAX_OUTSTANDING_PER_USER; index += 1) await issued();

      await expect(
        service.issue({
          userId: USER,
          purpose: "sign-in",
          codeChallenge: CHALLENGE,
          state: STATE,
          oneTimeToken: "ott",
          nowMs: NOW,
        }),
      ).resolves.toEqual({ ok: false, reason: "too-many-attempts" });
    });
  });

  describe("MobileAuthHandoffService.exchange", () => {
    it("releases the token once", async () => {
      const { callbackCode } = await issued();

      await expect(
        service.exchange({
          callbackCode,
          codeVerifier: VERIFIER,
          state: STATE,
          nowMs: NOW + 1_000,
        }),
      ).resolves.toEqual({ ok: true, oneTimeToken: "ott-value" });
    });

    it("refuses a replay", async () => {
      const { callbackCode } = await issued();
      await service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW });

      await expect(
        service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it("lets exactly one of two racing redemptions win", async () => {
      const { callbackCode } = await issued();

      const outcomes = await Promise.all([
        service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW }),
        service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW }),
      ]);

      // A conditional UPDATE, not a read-then-write: the loser's WHERE simply
      // matches nothing, so there is no window for both to pass.
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    });

    it("refuses a wrong verifier", async () => {
      const { callbackCode } = await issued();

      await expect(
        service.exchange({
          callbackCode,
          codeVerifier: randomBytes(32).toString("base64url"),
          state: STATE,
          nowMs: NOW,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it("burns the attempt even when the verifier was wrong", async () => {
      const { callbackCode } = await issued();
      await service.exchange({
        callbackCode,
        codeVerifier: randomBytes(32).toString("base64url"),
        state: STATE,
        nowMs: NOW,
      });

      // Otherwise a caller could grind guesses against one live code.
      await expect(
        service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it("refuses a mismatched state", async () => {
      const { callbackCode } = await issued();

      await expect(
        service.exchange({
          callbackCode,
          codeVerifier: VERIFIER,
          state: randomBytes(16).toString("base64url"),
          nowMs: NOW,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it("refuses an expired handoff", async () => {
      const { callbackCode } = await issued();

      await expect(
        service.exchange({
          callbackCode,
          codeVerifier: VERIFIER,
          state: STATE,
          nowMs: NOW + HANDOFF_TTL_MS + 1,
        }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it.each([
      { label: "a code that never existed", callbackCode: randomBytes(32).toString("base64url") },
      { label: "malformed base64url", callbackCode: "not+valid/base64url=" },
      { label: "an empty code", callbackCode: "" },
    ])("reports $label the same way as every other failure", async ({ callbackCode }) => {
      // Different errors would tell an attacker which of their guesses was
      // structurally right.
      await expect(
        service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it("refuses a verifier outside the length RFC 7636 fixes", async () => {
      const { callbackCode } = await issued();

      await expect(
        service.exchange({ callbackCode, codeVerifier: "tooshort", state: STATE, nowMs: NOW }),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    });

    it("leaves nothing behind once redeemed", async () => {
      const { callbackCode } = await issued();
      await service.exchange({ callbackCode, codeVerifier: VERIFIER, state: STATE, nowMs: NOW });

      const rows = await db
        .select()
        .from(mobileAuthHandoff)
        .where(eq(mobileAuthHandoff.userId, USER));

      expect(rows).toEqual([]);
    });
  });

  describe("MobileAuthHandoffService.scrubExpired", () => {
    it("drops rows that can no longer be redeemed", async () => {
      await issued();

      await service.scrubExpired(NOW + HANDOFF_TTL_MS + 1);

      const rows = await db
        .select()
        .from(mobileAuthHandoff)
        .where(eq(mobileAuthHandoff.userId, USER));
      expect(rows).toEqual([]);
    });

    it("keeps a live row", async () => {
      await issued();

      await service.scrubExpired(NOW + 1_000);

      const rows = await db
        .select()
        .from(mobileAuthHandoff)
        .where(eq(mobileAuthHandoff.userId, USER));
      expect(rows).toHaveLength(1);
    });
  });
});
