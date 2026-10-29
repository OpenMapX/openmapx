/** Session-only private material. Never persist this store or its snapshots. */
import type { MangroveKeypair } from "@openmapx/mangrove-client";
import { create } from "zustand";
import type { MangroveCurrentUser } from "./transport";

export const UNLOCK_TTL_MS = 15 * 60 * 1000;
export function keypairOwner(user: MangroveCurrentUser | null): string | null {
  return user ? JSON.stringify([user.id, user.authorityId ?? null]) : null;
}
export interface KeypairBinding {
  owner: string;
  generation: number;
  revision: string;
}
export interface KeypairSigningSnapshot extends KeypairBinding {
  signal: AbortSignal;
  keypair: MangroveKeypair;
  privateJwk: JsonWebKey;
  publicPem: string;
}
interface KeypairState {
  owner: string | null;
  generation: number;
  revision: string | null;
  keypair: MangroveKeypair | null;
  publicPem: string | null;
  privateJwk: JsonWebKey | null;
  lastAccessAt: number;
  bindOwner(owner: string | null): void;
  setPublicIdentity(publicPem: string, binding: KeypairBinding): boolean;
  setKeypair(
    kp: MangroveKeypair,
    publicPem: string,
    privateJwk: JsonWebKey,
    binding: KeypairBinding,
  ): boolean;
  getSigningSnapshot(owner: string | null): KeypairSigningSnapshot | null;
  isCurrent(binding: KeypairBinding): boolean;
  advanceRevision(binding: KeypairBinding, revision: string): boolean;
  touch(binding: KeypairBinding): boolean;
  lock(): void;
  clear(): void;
}
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let signingAuthority = new AbortController();
function invalidateSigningAuthority() {
  const previous = signingAuthority;
  signingAuthority = new AbortController();
  previous.abort();
}
function cancelIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}
function scheduleIdleLock(lock: () => void) {
  cancelIdleTimer();
  idleTimer = setTimeout(lock, UNLOCK_TTL_MS);
}
const empty = { keypair: null, publicPem: null, privateJwk: null, revision: null, lastAccessAt: 0 };
export const useKeypairStore = create<KeypairState>((set, get) => ({
  ...empty,
  owner: null,
  generation: 0,
  bindOwner(owner) {
    if (get().owner === owner) return;
    invalidateSigningAuthority();
    cancelIdleTimer();
    set({ ...empty, owner, generation: get().generation + 1 });
  },
  setPublicIdentity(publicPem, binding) {
    const state = get();
    if (state.owner !== binding.owner || state.generation !== binding.generation) return false;
    if (state.revision && state.revision !== binding.revision) {
      invalidateSigningAuthority();
      cancelIdleTimer();
      set({ keypair: null, privateJwk: null, lastAccessAt: 0, generation: state.generation + 1 });
    }
    set({ publicPem, revision: binding.revision });
    return true;
  },
  setKeypair(keypair, publicPem, privateJwk, binding) {
    const state = get();
    if (
      state.owner !== binding.owner ||
      state.generation !== binding.generation ||
      (state.revision !== null && state.revision !== binding.revision)
    )
      return false;
    set({ keypair, publicPem, privateJwk, revision: binding.revision, lastAccessAt: Date.now() });
    scheduleIdleLock(() => get().lock());
    return true;
  },
  getSigningSnapshot(owner) {
    const state = get();
    if (
      !owner ||
      state.owner !== owner ||
      !state.keypair ||
      !state.privateJwk ||
      !state.publicPem ||
      !state.revision
    )
      return null;
    return {
      signal: signingAuthority.signal,
      owner,
      generation: state.generation,
      revision: state.revision,
      keypair: state.keypair,
      privateJwk: state.privateJwk,
      publicPem: state.publicPem,
    };
  },
  isCurrent(binding) {
    const state = get();
    return (
      state.owner === binding.owner &&
      state.generation === binding.generation &&
      state.revision === binding.revision
    );
  },
  advanceRevision(binding, revision) {
    if (!get().isCurrent(binding)) return false;
    invalidateSigningAuthority();
    set({ revision, generation: get().generation + 1 });
    return true;
  },
  touch(binding) {
    if (!get().isCurrent(binding) || !get().keypair) return false;
    set({ lastAccessAt: Date.now() });
    scheduleIdleLock(() => get().lock());
    return true;
  },
  lock() {
    invalidateSigningAuthority();
    cancelIdleTimer();
    set({ keypair: null, privateJwk: null, lastAccessAt: 0, generation: get().generation + 1 });
  },
  clear() {
    invalidateSigningAuthority();
    cancelIdleTimer();
    set({ ...empty, generation: get().generation + 1 });
  },
}));
