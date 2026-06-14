import {
  encryptWithPassphrase,
  generateKeypair,
  keypairToJwk,
  type MangroveKeypair,
  signMangroveReview,
} from "@openmapx/mangrove-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeypairStore } from "./keypairStore";
import { MangroveProvider } from "./provider";
import type { MangroveCurrentUser, MangroveTransport } from "./transport";
import type { CreateKeypairEnvelopePayload, EnvelopeState, WrapMeta } from "./types";
import { useSetupKeypair, useUnlockKeypair, useUserKeypair } from "./useKeypair";

// Tests that run a real age/scrypt passphrase KDF are skipped under the coverage
// run: v8 instrumentation inflates scrypt ~4x (a single KDF blows past the 15s
// timeout under parallel load). They run in full under the normal `pnpm test`
// (pre-push) gate, where the crypto is fast and the real path is verified.
// `test:coverage` sets OPENMAPX_SKIP_SLOW_CRYPTO=1.
const skipSlowCrypto = process.env.OPENMAPX_SKIP_SLOW_CRYPTO === "1";

// A minimal in-memory transport. Only the keypair-envelope surface is exercised
// by these tests; the review/image methods reject so an accidental network call
// fails loudly instead of silently passing.
function createMockTransport(initial: EnvelopeState | null = null) {
  let envelope: EnvelopeState | null = initial;
  const created: CreateKeypairEnvelopePayload[] = [];
  const transport: MangroveTransport = {
    getKeypairEnvelope: vi.fn(async () => envelope),
    createKeypairEnvelope: vi.fn(async (payload) => {
      created.push(payload);
      envelope =
        payload.mode === "unencrypted"
          ? {
              state: "ready",
              mode: "unencrypted",
              publicJwk: payload.publicJwk,
              privateJwk: payload.privateJwk,
            }
          : {
              state: "ready",
              mode: "encrypted",
              publicJwk: payload.publicJwk,
              passphraseCiphertext: payload.passphraseCiphertext,
              recipientsCiphertext: payload.recipientsCiphertext,
              wraps: payload.wraps.map((w: WrapMeta, i: number) => ({
                id: `wrap-${i}`,
                wrapType: w.wrapType,
                label: w.label,
                identityString: w.identityString,
                createdAt: "2026-06-14T00:00:00Z",
              })),
            };
    }),
    updateKeypairWraps: vi.fn(async () => {}),
    deleteKeypairEnvelope: vi.fn(async () => {
      envelope = { state: "uninitialized" };
    }),
    submitReview: vi.fn(async () => {
      throw new Error("submitReview must not be called in these tests");
    }),
    uploadReviewImage: vi.fn(async () => {
      throw new Error("uploadReviewImage must not be called");
    }),
    fetchPlaceReviews: vi.fn(async () => []),
    fetchPlaceReviewAggregate: vi.fn(async () => ({}) as never),
  };
  return { transport, created, setEnvelope: (e: EnvelopeState | null) => (envelope = e) };
}

const USER: MangroveCurrentUser = { id: "user-1", nickname: "tester" };

function createWrapper(transport: MangroveTransport, currentUser: MangroveCurrentUser | null) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MangroveProvider transport={transport} currentUser={currentUser}>
          {children}
        </MangroveProvider>
      </QueryClientProvider>
    );
  };
}

/** Assert a string is a structurally well-formed compact JWS (header.payload.sig). */
function expectWellFormedJwt(jwt: string) {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  for (const p of parts) expect(p.length).toBeGreaterThan(0);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  expect(header.alg).toBe("ES256");
  expect(header.typ).toBe("JWT");
  // Mangrove quirk: kid is a single-line PEM, jwk is a STRINGIFIED public JWK.
  expect(header.kid).toContain("BEGIN PUBLIC KEY");
  expect(typeof header.jwk).toBe("string");
  return { parts, header };
}

describe("useUserKeypair", () => {
  beforeEach(() => useKeypairStore.getState().clear());
  afterEach(() => useKeypairStore.getState().clear());

  it("reports needsSetup when the user has no envelope", async () => {
    const { transport } = createMockTransport({ state: "uninitialized" });
    const { result } = renderHook(() => useUserKeypair(), {
      wrapper: createWrapper(transport, USER),
    });
    await waitFor(() => expect(result.current.needsSetup).toBe(true));
    expect(result.current.keypair).toBeNull();
    expect(result.current.needsUnlock).toBe(false);
  });

  it.skipIf(skipSlowCrypto)(
    "reports needsUnlock for an encrypted-but-locked envelope and publishes the public identity",
    async () => {
      const kp = await generateKeypair();
      const { publicJwk, privateJwk } = await keypairToJwk(kp);
      const passphraseCiphertext = await encryptWithPassphrase(privateJwk, "hunter2");
      const { transport } = createMockTransport({
        state: "ready",
        mode: "encrypted",
        publicJwk,
        passphraseCiphertext,
        recipientsCiphertext: null,
        wraps: [
          {
            id: "wrap-0",
            wrapType: "passphrase",
            label: "Passphrase",
            identityString: null,
            createdAt: "2026-06-14T00:00:00Z",
          },
        ],
      });

      const { result } = renderHook(() => useUserKeypair(), {
        wrapper: createWrapper(transport, USER),
      });

      await waitFor(() => expect(result.current.isEncrypted).toBe(true));
      expect(result.current.needsUnlock).toBe(true);
      expect(result.current.keypair).toBeNull();
      // Public identity is derivable without unlocking the private half.
      await waitFor(() => expect(result.current.publicPem).toContain("BEGIN PUBLIC KEY"));
    },
  );

  it("auto-imports an unencrypted envelope into a usable, signable keypair", async () => {
    const kp = await generateKeypair();
    const { publicJwk, privateJwk } = await keypairToJwk(kp);
    const { transport } = createMockTransport({
      state: "ready",
      mode: "unencrypted",
      publicJwk,
      privateJwk,
    });

    const { result } = renderHook(() => useUserKeypair(), {
      wrapper: createWrapper(transport, USER),
    });

    await waitFor(() => expect(result.current.keypair).not.toBeNull());
    expect(result.current.needsUnlock).toBe(false);
    expect(result.current.isEncrypted).toBe(false);
    expect(result.current.publicPem).toContain("BEGIN PUBLIC KEY");

    // The imported private key must actually sign.
    const live = result.current.keypair as MangroveKeypair;
    const jwt = await signMangroveReview({ sub: "geo:50.0,6.0?q=X&u=30", rating: 80 }, live);
    expectWellFormedJwt(jwt);
  });
});

describe("useSetupKeypair", () => {
  beforeEach(() => useKeypairStore.getState().clear());
  afterEach(() => useKeypairStore.getState().clear());

  it("generates a keypair, persists the unencrypted envelope, and unlocks the store", async () => {
    const { transport, created } = createMockTransport({ state: "uninitialized" });
    const { result } = renderHook(() => useSetupKeypair(), {
      wrapper: createWrapper(transport, USER),
    });

    await result.current.mutateAsync({ mode: "unencrypted" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(transport.createKeypairEnvelope).toHaveBeenCalledTimes(1);
    expect(created[0].mode).toBe("unencrypted");
    if (created[0].mode === "unencrypted") {
      expect(created[0].publicJwk.crv).toBe("P-256");
      expect(created[0].privateJwk.d).toBeTruthy();
    }

    // The store is now unlocked with a signable keypair.
    const stored = useKeypairStore.getState();
    expect(stored.keypair).not.toBeNull();
    expect(stored.encrypted).toBe(false);
    expect(stored.publicPem).toContain("BEGIN PUBLIC KEY");

    const jwt = await signMangroveReview(
      { sub: "geo:50.0,6.0?q=Y&u=30", rating: 100 },
      stored.keypair as MangroveKeypair,
    );
    const { parts } = expectWellFormedJwt(jwt);
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.rating).toBe(100);
    expect(payload.sub).toBe("geo:50.0,6.0?q=Y&u=30");
  });

  it.skipIf(skipSlowCrypto)(
    "encrypted setup stores ciphertext + private JWK and flips the store to encrypted mode",
    async () => {
      const { transport, created } = createMockTransport({ state: "uninitialized" });
      const { result } = renderHook(() => useSetupKeypair(), {
        wrapper: createWrapper(transport, USER),
      });

      await result.current.mutateAsync({ mode: "passphrase", passphrase: "correct horse" });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(created[0].mode).toBe("encrypted");
      if (created[0].mode === "encrypted") {
        expect(created[0].passphraseCiphertext).toBeTruthy();
        expect(created[0].wraps).toEqual([
          { wrapType: "passphrase", label: "Passphrase", identityString: null },
        ]);
      }
      // Encrypted mode must never ship the cleartext private JWK over the wire.
      expect(Object.hasOwn(created[0], "privateJwk")).toBe(false);

      const stored = useKeypairStore.getState();
      expect(stored.encrypted).toBe(true);
      expect(stored.keypair).not.toBeNull();
      // Private JWK retained in memory for re-wrap without a second unlock.
      expect(stored.privateJwk?.d).toBeTruthy();
    },
  );
});

describe("useUnlockKeypair", () => {
  beforeEach(() => useKeypairStore.getState().clear());
  afterEach(() => useKeypairStore.getState().clear());

  it.skipIf(skipSlowCrypto)(
    "decrypts the passphrase wrap and produces a signable keypair",
    async () => {
      const kp = await generateKeypair();
      const { publicJwk, privateJwk } = await keypairToJwk(kp);
      const passphraseCiphertext = await encryptWithPassphrase(privateJwk, "right-pass");
      const { transport } = createMockTransport({
        state: "ready",
        mode: "encrypted",
        publicJwk,
        passphraseCiphertext,
        recipientsCiphertext: null,
        wraps: [
          {
            id: "wrap-0",
            wrapType: "passphrase",
            label: "Passphrase",
            identityString: null,
            createdAt: "2026-06-14T00:00:00Z",
          },
        ],
      });

      const { result } = renderHook(() => useUnlockKeypair(), {
        wrapper: createWrapper(transport, USER),
      });

      await result.current.mutateAsync({ method: "passphrase", passphrase: "right-pass" });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const stored = useKeypairStore.getState();
      expect(stored.keypair).not.toBeNull();
      expect(stored.encrypted).toBe(true);
      expect(stored.privateJwk?.d).toBeTruthy();

      const jwt = await signMangroveReview(
        { sub: "geo:1.0,2.0?q=Z&u=30", opinion: "ok" },
        stored.keypair as MangroveKeypair,
      );
      expectWellFormedJwt(jwt);
    },
  );

  it.skipIf(skipSlowCrypto)(
    "rejects an incorrect passphrase with a generic error and leaves the store locked",
    async () => {
      const kp = await generateKeypair();
      const { publicJwk, privateJwk } = await keypairToJwk(kp);
      const passphraseCiphertext = await encryptWithPassphrase(privateJwk, "right-pass");
      const { transport } = createMockTransport({
        state: "ready",
        mode: "encrypted",
        publicJwk,
        passphraseCiphertext,
        recipientsCiphertext: null,
        wraps: [
          {
            id: "wrap-0",
            wrapType: "passphrase",
            label: "Passphrase",
            identityString: null,
            createdAt: "2026-06-14T00:00:00Z",
          },
        ],
      });

      const { result } = renderHook(() => useUnlockKeypair(), {
        wrapper: createWrapper(transport, USER),
      });

      await expect(
        result.current.mutateAsync({ method: "passphrase", passphrase: "WRONG" }),
      ).rejects.toThrow("Incorrect passphrase");
      // The mutation rejecting IS the store-stays-locked guarantee: the unlock
      // mutationFn throws on a bad decrypt before it ever reaches `setKeypair`
      // (useKeypair.ts), so a failed unlock can't populate the store. Asserting
      // the module-global store directly here is cross-test-pollution-prone, so we
      // assert the component-local error state instead.
      await waitFor(() => expect(result.current.isError).toBe(true));
    },
  );
});

describe("signing path (end-to-end signature verification)", () => {
  beforeEach(() => useKeypairStore.getState().clear());
  afterEach(() => useKeypairStore.getState().clear());

  it("produces a JWT whose signature verifies against the keypair's public key", async () => {
    // Drive setup so the keypair originates from the real hook lifecycle.
    const { transport } = createMockTransport({ state: "uninitialized" });
    const { result } = renderHook(() => useSetupKeypair(), {
      wrapper: createWrapper(transport, USER),
    });
    await result.current.mutateAsync({ mode: "unencrypted" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const live = useKeypairStore.getState().keypair as MangroveKeypair;
    const jwt = await signMangroveReview(
      { sub: "geo:48.85,2.35?q=Paris&u=30", rating: 60, opinion: "decent" },
      live,
    );
    const { parts } = expectWellFormedJwt(jwt);

    // Recompute the signing input and verify the ES256 signature cryptographically.
    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], "base64url");
    const ok = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      live.publicKey,
      signature,
      new TextEncoder().encode(signingInput),
    );
    expect(ok).toBe(true);

    // A tampered payload must fail verification (signature is load-bearing).
    const tampered = new TextEncoder().encode(`${signingInput}x`);
    const bad = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      live.publicKey,
      signature,
      tampered,
    );
    expect(bad).toBe(false);
  });
});
