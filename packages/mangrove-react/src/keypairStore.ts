/**
 * Session-scoped in-memory cache for the logged-in user's Mangrove keypair.
 *
 * Three distinct layers live here:
 *
 *  - **Public identity** (`publicPem`): derived from the server-stored public
 *    JWK, which is public information by design. Retained for the whole
 *    session so "is this my review?" checks, fingerprint display, etc. keep
 *    working even when the private key is locked.
 *  - **Unlocked keypair** (`keypair` + `privateJwk`): the sensitive half. Set
 *    after a successful unlock; cleared by {@link KeypairState.lock}
 *    automatically after `UNLOCK_TTL_MS` of inactivity (encrypted mode only).
 *    `privateJwk` is kept alongside so we can re-encrypt the envelope on
 *    add/remove-wrap without a second unlock ceremony.
 *  - **Session-level clear** ({@link KeypairState.clear}): called on
 *    regenerate / full keypair delete / sign-out. Wipes everything, including
 *    the public identity.
 *
 * Intentionally NOT persisted to storage — the server is the source of truth
 * for the envelope.
 */

import type { MangroveKeypair } from "@openmapx/mangrove-client";
import { create } from "zustand";

/** After this much inactivity, auto-lock the private half of an encrypted keypair. */
export const UNLOCK_TTL_MS = 15 * 60 * 1000;

interface KeypairState {
  keypair: MangroveKeypair | null;
  publicPem: string | null;
  /**
   * Cleartext private JWK — retained while unlocked so we can re-encrypt the
   * envelope after add/remove-wrap operations without a second unlock.
   */
  privateJwk: JsonWebKey | null;
  /** True iff the user's envelope is encrypted (triggers idle auto-lock). */
  encrypted: boolean;
  /** Timestamp of last touch (unlock, sign, or explicit set). */
  lastAccessAt: number;
  /**
   * Publish only the public identity (no private material). Safe to call
   * whenever the envelope is fetched from the server — lets UI checks like
   * "is this my review?" work without requiring an unlock.
   */
  setPublicIdentity(publicPem: string): void;
  /** Publish a full unlocked keypair. */
  setKeypair(
    kp: MangroveKeypair,
    publicPem: string,
    encrypted: boolean,
    privateJwk: JsonWebKey | null,
  ): void;
  /** Refresh the inactivity timer — call before any signing op. */
  touch(): void;
  /** Drop the private half (idle lock). Retains `publicPem`. */
  lock(): void;
  /** Wipe everything, including the public identity. */
  clear(): void;
}

let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleLock(lock: () => void) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(lock, UNLOCK_TTL_MS);
}

function cancelIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export const useKeypairStore = create<KeypairState>((set, get) => ({
  keypair: null,
  publicPem: null,
  privateJwk: null,
  encrypted: false,
  lastAccessAt: 0,
  setPublicIdentity(publicPem) {
    const current = get().publicPem;
    if (current === publicPem) return;
    set({ publicPem });
  },
  setKeypair(kp, publicPem, encrypted, privateJwk) {
    set({ keypair: kp, publicPem, encrypted, privateJwk, lastAccessAt: Date.now() });
    if (encrypted) scheduleIdleLock(() => get().lock());
  },
  touch() {
    const { encrypted, keypair } = get();
    if (!keypair) return;
    set({ lastAccessAt: Date.now() });
    if (encrypted) scheduleIdleLock(() => get().lock());
  },
  lock() {
    cancelIdleTimer();
    set({ keypair: null, privateJwk: null, lastAccessAt: 0 });
  },
  clear() {
    cancelIdleTimer();
    set({
      keypair: null,
      publicPem: null,
      privateJwk: null,
      encrypted: false,
      lastAccessAt: 0,
    });
  },
}));
