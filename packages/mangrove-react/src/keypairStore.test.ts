import type { MangroveKeypair } from "@openmapx/mangrove-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNLOCK_TTL_MS, useKeypairStore } from "./keypairStore";

// A keypair object is opaque to the store — it only ever stores/retrieves the
// reference, never touches the CryptoKeys — so a typed stub is sufficient here.
const fakeKeypair = { publicKey: {}, privateKey: {} } as unknown as MangroveKeypair;
const fakePrivateJwk: JsonWebKey = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" };

function reset() {
  useKeypairStore.getState().clear();
}

describe("keypairStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });
  afterEach(() => {
    reset();
    vi.useRealTimers();
  });

  it("starts fully locked and empty", () => {
    const s = useKeypairStore.getState();
    expect(s.keypair).toBeNull();
    expect(s.publicPem).toBeNull();
    expect(s.privateJwk).toBeNull();
    expect(s.encrypted).toBe(false);
    expect(s.lastAccessAt).toBe(0);
  });

  it("setPublicIdentity publishes the public half without unlocking", () => {
    useKeypairStore.getState().setPublicIdentity("PEM-A");
    const s = useKeypairStore.getState();
    expect(s.publicPem).toBe("PEM-A");
    expect(s.keypair).toBeNull();
    expect(s.privateJwk).toBeNull();
  });

  it("setPublicIdentity is a no-op when the value is unchanged", () => {
    useKeypairStore.getState().setPublicIdentity("PEM-A");
    const before = useKeypairStore.getState();
    useKeypairStore.getState().setPublicIdentity("PEM-A");
    // Same identity input must not produce a new state object.
    expect(useKeypairStore.getState()).toBe(before);
  });

  it("setKeypair moves locked -> unlocked and records the access time", () => {
    vi.setSystemTime(new Date("2026-06-14T12:00:00Z"));
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);
    const s = useKeypairStore.getState();
    expect(s.keypair).toBe(fakeKeypair);
    expect(s.publicPem).toBe("PEM-A");
    expect(s.privateJwk).toBe(fakePrivateJwk);
    expect(s.encrypted).toBe(true);
    expect(s.lastAccessAt).toBe(Date.parse("2026-06-14T12:00:00Z"));
  });

  it("auto-locks the private half after UNLOCK_TTL_MS of inactivity (encrypted mode)", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);
    expect(useKeypairStore.getState().keypair).toBe(fakeKeypair);

    // Just shy of the TTL — still unlocked.
    vi.advanceTimersByTime(UNLOCK_TTL_MS - 1);
    expect(useKeypairStore.getState().keypair).toBe(fakeKeypair);

    // Cross the TTL boundary — the idle timer fires and re-locks.
    vi.advanceTimersByTime(1);
    const s = useKeypairStore.getState();
    expect(s.keypair).toBeNull();
    expect(s.privateJwk).toBeNull();
    expect(s.lastAccessAt).toBe(0);
    // Public identity survives the idle lock so "is this my review?" keeps working.
    expect(s.publicPem).toBe("PEM-A");
  });

  it("does NOT auto-lock in unencrypted mode", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", false, null);
    vi.advanceTimersByTime(UNLOCK_TTL_MS * 3);
    expect(useKeypairStore.getState().keypair).toBe(fakeKeypair);
  });

  it("touch refreshes the idle timer so activity defers the auto-lock", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);

    // Almost expired, then touch resets the countdown.
    vi.advanceTimersByTime(UNLOCK_TTL_MS - 1);
    useKeypairStore.getState().touch();

    // Past where the original timer would have fired — still unlocked.
    vi.advanceTimersByTime(2);
    expect(useKeypairStore.getState().keypair).toBe(fakeKeypair);

    // A further full TTL with no activity finally re-locks.
    vi.advanceTimersByTime(UNLOCK_TTL_MS);
    expect(useKeypairStore.getState().keypair).toBeNull();
  });

  it("touch is a no-op when there is no unlocked keypair", () => {
    vi.setSystemTime(new Date("2026-06-14T12:00:00Z"));
    useKeypairStore.getState().touch();
    expect(useKeypairStore.getState().lastAccessAt).toBe(0);
  });

  it("lock drops the private half but retains the public identity", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);
    useKeypairStore.getState().lock();
    const s = useKeypairStore.getState();
    expect(s.keypair).toBeNull();
    expect(s.privateJwk).toBeNull();
    expect(s.lastAccessAt).toBe(0);
    expect(s.publicPem).toBe("PEM-A");
  });

  it("a manual lock cancels the pending idle timer (no later re-lock side effects)", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);
    useKeypairStore.getState().lock();
    // Re-publish a fresh keypair, then advance past the ORIGINAL timer's deadline.
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-B", false, null);
    vi.advanceTimersByTime(UNLOCK_TTL_MS);
    // The cancelled timer must not fire and clobber the new unencrypted keypair.
    expect(useKeypairStore.getState().keypair).toBe(fakeKeypair);
  });

  it("clear wipes everything including the public identity", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);
    useKeypairStore.getState().clear();
    const s = useKeypairStore.getState();
    expect(s.keypair).toBeNull();
    expect(s.publicPem).toBeNull();
    expect(s.privateJwk).toBeNull();
    expect(s.encrypted).toBe(false);
    expect(s.lastAccessAt).toBe(0);
  });

  it("clear cancels a pending idle timer so it cannot fire afterwards", () => {
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-A", true, fakePrivateJwk);
    useKeypairStore.getState().clear();
    // Re-establish state, then run past the original deadline — nothing should re-lock it.
    useKeypairStore.getState().setKeypair(fakeKeypair, "PEM-C", false, null);
    vi.advanceTimersByTime(UNLOCK_TTL_MS);
    expect(useKeypairStore.getState().keypair).toBe(fakeKeypair);
  });
});
