import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../../test/app.js";
import { mockRequireAuth } from "../../test/auth.js";
import { createDbMock, type DbMock } from "../../test/db.js";

const USER_ID = "user-A";

const authMock = mockRequireAuth(USER_ID);
const dbMock: DbMock = createDbMock();

vi.mock("../../utils/require-auth.js", () => authMock);
vi.mock("../../db/index.js", () => ({ db: dbMock.db }));
vi.mock("../../db/schema.js", () => ({
  mangroveKeypair: {
    userId: "mangrove_keypair.user_id",
    encryptionMode: "mangrove_keypair.encryption_mode",
    publicJwk: "mangrove_keypair.public_jwk",
    privateJwk: "mangrove_keypair.private_jwk",
    passphraseCiphertext: "mangrove_keypair.passphrase_ciphertext",
    recipientsCiphertext: "mangrove_keypair.recipients_ciphertext",
  },
  mangroveKeypairWrap: {
    id: "mangrove_keypair_wrap.id",
    userId: "mangrove_keypair_wrap.user_id",
    wrapType: "mangrove_keypair_wrap.wrap_type",
    label: "mangrove_keypair_wrap.label",
    identityString: "mangrove_keypair_wrap.identity_string",
    createdAt: "mangrove_keypair_wrap.created_at",
  },
}));

const PUBLIC_JWK = { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) };
const PRIVATE_JWK = { ...PUBLIC_JWK, d: "d".repeat(43) };

describe("reviews-keypair validation helpers", () => {
  // Imported after the vi.mock calls so the route module's mocked deps resolve.
  let isMangrovePublicJwk: typeof import("../reviews-keypair.js").isMangrovePublicJwk;
  let isMangrovePrivateJwk: typeof import("../reviews-keypair.js").isMangrovePrivateJwk;
  let validateWrap: typeof import("../reviews-keypair.js").validateWrap;
  let validateEncryptedState: typeof import("../reviews-keypair.js").validateEncryptedState;

  beforeAll(async () => {
    const mod = await import("../reviews-keypair.js");
    isMangrovePublicJwk = mod.isMangrovePublicJwk;
    isMangrovePrivateJwk = mod.isMangrovePrivateJwk;
    validateWrap = mod.validateWrap;
    validateEncryptedState = mod.validateEncryptedState;
  });

  describe("isMangrovePublicJwk", () => {
    it("accepts a valid P-256 public JWK", () => {
      expect(isMangrovePublicJwk(PUBLIC_JWK)).toBe(true);
    });

    it.each([
      ["null", null],
      ["non-object", "nope"],
      ["wrong kty", { kty: "RSA", crv: "P-256", x: "a", y: "b" }],
      ["wrong crv", { kty: "EC", crv: "P-384", x: "a", y: "b" }],
      ["missing x", { kty: "EC", crv: "P-256", y: "b" }],
      ["empty x", { kty: "EC", crv: "P-256", x: "", y: "b" }],
      ["oversized x", { kty: "EC", crv: "P-256", x: "x".repeat(129), y: "b" }],
    ])("rejects %s", (_label, jwk) => {
      expect(isMangrovePublicJwk(jwk)).toBe(false);
    });

    it("rejects a JWK with too many keys", () => {
      const jwk: Record<string, unknown> = { ...PUBLIC_JWK };
      for (let i = 0; i < 16; i++) jwk[`k${i}`] = "v";
      expect(isMangrovePublicJwk(jwk)).toBe(false);
    });

    it("rejects a JWK carrying an oversized string field", () => {
      expect(isMangrovePublicJwk({ ...PUBLIC_JWK, kid: "z".repeat(257) })).toBe(false);
    });
  });

  describe("isMangrovePrivateJwk", () => {
    it("accepts a valid private JWK (has d)", () => {
      expect(isMangrovePrivateJwk(PRIVATE_JWK)).toBe(true);
    });
    it("rejects a public JWK (no d)", () => {
      expect(isMangrovePrivateJwk(PUBLIC_JWK)).toBe(false);
    });
  });

  describe("validateWrap", () => {
    it("normalizes a passphrase wrap (identityString forced null)", () => {
      expect(
        validateWrap({ wrapType: "passphrase", label: "Pass", identityString: "ignored" }),
      ).toEqual({ wrapType: "passphrase", label: "Pass", identityString: null });
    });

    it("keeps the identityString for a webauthn wrap", () => {
      expect(
        validateWrap({
          wrapType: "webauthn",
          label: "Key",
          identityString: "AGE-PLUGIN-FIDO2PRF-1",
        }),
      ).toEqual({ wrapType: "webauthn", label: "Key", identityString: "AGE-PLUGIN-FIDO2PRF-1" });
    });

    it("truncates an over-long label to 80 chars", () => {
      expect(validateWrap({ wrapType: "passphrase", label: "L".repeat(200) }).label).toHaveLength(
        80,
      );
    });

    it.each([
      ["invalid wrapType", { wrapType: "nope" as never, label: "x" }],
      ["missing label", { wrapType: "passphrase" as const }],
      ["webauthn without identityString", { wrapType: "webauthn" as const, label: "x" }],
      [
        "webauthn identityString too long",
        { wrapType: "webauthn" as const, label: "x", identityString: "i".repeat(4097) },
      ],
    ])("rejects %s with a 400", (_label, wrap) => {
      try {
        validateWrap(wrap);
        throw new Error("expected validateWrap to throw");
      } catch (err) {
        expect((err as { statusCode?: number }).statusCode).toBe(400);
      }
    });
  });

  describe("validateEncryptedState", () => {
    const passWrap = { wrapType: "passphrase" as const, label: "Pass" };
    const webauthnWrap = {
      wrapType: "webauthn" as const,
      label: "Key",
      identityString: "AGE-PLUGIN-FIDO2PRF-1",
    };

    it("accepts a passphrase-only envelope", () => {
      const state = validateEncryptedState({ passphraseCiphertext: "ct", wraps: [passWrap] });
      expect(state.passphraseCiphertext).toBe("ct");
      expect(state.recipientsCiphertext).toBeNull();
      expect(state.wraps).toHaveLength(1);
    });

    it("accepts a combined passphrase + webauthn envelope", () => {
      const state = validateEncryptedState({
        passphraseCiphertext: "p",
        recipientsCiphertext: "r",
        wraps: [passWrap, webauthnWrap],
      });
      expect(state.wraps).toHaveLength(2);
    });

    it.each([
      ["no ciphertext at all", { wraps: [passWrap] }],
      ["no wraps", { passphraseCiphertext: "ct", wraps: [] }],
      ["two passphrase wraps", { passphraseCiphertext: "ct", wraps: [passWrap, passWrap] }],
      [
        "passphrase wrap but no passphrase ciphertext",
        { recipientsCiphertext: "r", wraps: [passWrap] },
      ],
      [
        "passphrase ciphertext but no passphrase wrap",
        { passphraseCiphertext: "ct", recipientsCiphertext: "r", wraps: [webauthnWrap] },
      ],
      [
        "webauthn wrap but no recipients ciphertext",
        { passphraseCiphertext: "ct", wraps: [passWrap, webauthnWrap] },
      ],
      [
        "oversized passphrase ciphertext",
        { passphraseCiphertext: "c".repeat(64 * 1024 + 1), wraps: [passWrap] },
      ],
    ])("rejects %s with a 400", (_label, body) => {
      try {
        validateEncryptedState(body as Parameters<typeof validateEncryptedState>[0]);
        throw new Error("expected validateEncryptedState to throw");
      } catch (err) {
        expect((err as { statusCode?: number }).statusCode).toBe(400);
      }
    });
  });
});

describe("reviews-keypair routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { reviewsKeypairRoute } = await import("../reviews-keypair.js");
    app = await buildTestApp(reviewsKeypairRoute, { prefix: "/api" });
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const get = () => app.inject({ method: "GET", url: "/api/reviews/keypair" });
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/reviews/keypair", payload });
  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: "/api/reviews/keypair/wraps", payload });
  const del = () => app.inject({ method: "DELETE", url: "/api/reviews/keypair" });

  it("rejects an unauthenticated request with 401", async () => {
    authMock.requireAuthHook.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    });
    const res = await get();
    expect(res.statusCode).toBe(401);
  });

  it("GET returns 204 when the user has no keypair", async () => {
    dbMock.queueSelect([]);
    const res = await get();
    expect(res.statusCode).toBe(204);
  });

  it("GET returns the unencrypted envelope", async () => {
    dbMock.queueSelect([
      { encryptionMode: "unencrypted", publicJwk: PUBLIC_JWK, privateJwk: PRIVATE_JWK },
    ]);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "unencrypted", publicJwk: PUBLIC_JWK });
  });

  it("GET returns the encrypted envelope with wrap metadata", async () => {
    dbMock.queueSelect([
      {
        encryptionMode: "encrypted",
        publicJwk: PUBLIC_JWK,
        passphraseCiphertext: "pct",
        recipientsCiphertext: null,
      },
    ]);
    dbMock.queueSelect([
      {
        id: "w1",
        wrapType: "passphrase",
        label: "Pass",
        identityString: null,
        createdAt: new Date("2026-06-14T00:00:00Z"),
      },
    ]);
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("encrypted");
    expect(body.wraps).toEqual([
      {
        id: "w1",
        wrapType: "passphrase",
        label: "Pass",
        identityString: null,
        createdAt: "2026-06-14T00:00:00.000Z",
      },
    ]);
  });

  it("POST rejects an invalid publicJwk with 400", async () => {
    dbMock.queueSelect([]); // no existing keypair
    const res = await post({ mode: "unencrypted", publicJwk: { kty: "RSA" } });
    expect(res.statusCode).toBe(400);
  });

  it("POST returns 409 when a keypair already exists", async () => {
    dbMock.queueSelect([{ userId: USER_ID }]);
    const res = await post({ mode: "unencrypted", publicJwk: PUBLIC_JWK, privateJwk: PRIVATE_JWK });
    expect(res.statusCode).toBe(409);
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });

  it("POST creates an unencrypted keypair (201)", async () => {
    dbMock.queueSelect([]);
    const res = await post({ mode: "unencrypted", publicJwk: PUBLIC_JWK, privateJwk: PRIVATE_JWK });
    expect(res.statusCode).toBe(201);
    expect(dbMock.db.insert).toHaveBeenCalled();
  });

  it("POST creates an encrypted keypair in a transaction (201)", async () => {
    dbMock.queueSelect([]);
    const res = await post({
      mode: "encrypted",
      publicJwk: PUBLIC_JWK,
      passphraseCiphertext: "ct",
      wraps: [{ wrapType: "passphrase", label: "Pass" }],
    });
    expect(res.statusCode).toBe(201);
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
  });

  it("PUT returns 404 when there is no keypair", async () => {
    dbMock.queueSelect([]);
    const res = await put({
      passphraseCiphertext: "ct",
      wraps: [{ wrapType: "passphrase", label: "P" }],
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT returns 409 for an unencrypted keypair", async () => {
    dbMock.queueSelect([{ mode: "unencrypted" }]);
    const res = await put({
      passphraseCiphertext: "ct",
      wraps: [{ wrapType: "passphrase", label: "P" }],
    });
    expect(res.statusCode).toBe(409);
  });

  it("PUT replaces wraps for an encrypted keypair (200)", async () => {
    dbMock.queueSelect([{ mode: "encrypted" }]);
    const res = await put({
      passphraseCiphertext: "ct",
      wraps: [{ wrapType: "passphrase", label: "P" }],
    });
    expect(res.statusCode).toBe(200);
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
  });

  it("DELETE wipes the keypair and wraps in a transaction", async () => {
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
  });
});
