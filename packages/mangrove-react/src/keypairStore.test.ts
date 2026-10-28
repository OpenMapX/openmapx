import type { MangroveKeypair } from "@openmapx/mangrove-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keypairOwner, UNLOCK_TTL_MS, useKeypairStore } from "./keypairStore";

const kp = { publicKey: {}, privateKey: {} } as MangroveKeypair;
const jwk = { d: "private" };
const owner = keypairOwner({ id: "u1", authorityId: "s1" }) ?? "";
const other = keypairOwner({ id: "u1", authorityId: "s2" }) ?? "";
function unlock() {
  const store = useKeypairStore.getState();
  store.bindOwner(owner);
  const generation = useKeypairStore.getState().generation;
  store.setKeypair(kp, "PEM", jwk, { owner, generation, revision: "r1" });
  const snapshot = useKeypairStore.getState().getSigningSnapshot(owner);
  if (!snapshot) throw new Error("Test keypair was not unlocked");
  return snapshot;
}
beforeEach(() => {
  vi.useFakeTimers();
  useKeypairStore.getState().clear();
});
afterEach(() => {
  useKeypairStore.getState().clear();
  vi.useRealTimers();
});
describe("owner-bound keypair store", () => {
  it("returns signing material only for the exact owner", () => {
    unlock();
    expect(useKeypairStore.getState().getSigningSnapshot(owner)?.keypair).toBe(kp);
    expect(useKeypairStore.getState().getSigningSnapshot(other)).toBeNull();
  });
  it("owner switch clears public and private material", () => {
    unlock();
    useKeypairStore.getState().bindOwner(other);
    expect(useKeypairStore.getState().keypair).toBeNull();
    expect(useKeypairStore.getState().publicPem).toBeNull();
  });
  it.each(["clear", "lock"] as const)("%s invalidates delayed publication", (action) => {
    const old = unlock();
    useKeypairStore.getState()[action]();
    expect(useKeypairStore.getState().setKeypair(kp, "OLD", jwk, old)).toBe(false);
    expect(useKeypairStore.getState().keypair).toBeNull();
  });
  it("revision replacement locks the previous private key", () => {
    const old = unlock();
    useKeypairStore.getState().setPublicIdentity("NEW", { ...old, revision: "r2" });
    expect(useKeypairStore.getState().getSigningSnapshot(owner)).toBeNull();
    expect(useKeypairStore.getState().publicPem).toBe("NEW");
  });
  it("validated touch extends inactivity and idle lock keeps public identity", () => {
    const snapshot = unlock();
    vi.advanceTimersByTime(UNLOCK_TTL_MS - 1);
    expect(useKeypairStore.getState().touch(snapshot)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(useKeypairStore.getState().getSigningSnapshot(owner)).not.toBeNull();
    vi.advanceTimersByTime(UNLOCK_TTL_MS);
    expect(useKeypairStore.getState().getSigningSnapshot(owner)).toBeNull();
    expect(useKeypairStore.getState().publicPem).toBe("PEM");
    expect(useKeypairStore.getState().touch(snapshot)).toBe(false);
  });
});
