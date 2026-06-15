/**
 * Client-side Mangrove keypair lifecycle hooks.
 *
 * All HTTP/storage operations go through the {@link MangroveTransport} provided
 * via {@link MangroveProvider}. Authentication state comes from
 * `useMangroveCurrentUser()` — the host is responsible for telling this layer
 * who's signed in.
 *
 * Hooks:
 *   - `useKeypairState()` — current envelope state from the server.
 *   - `useUserKeypair()` — decrypted keypair if unlocked, else null.
 *   - `useSetupKeypair()` — first-time setup (3 modes).
 *   - `useUnlockKeypair()` — decrypt via passphrase or WebAuthn.
 *   - `useAddWrap()`, `useRemoveWrap()` — manage unlock methods.
 *   - `useChangePassphrase()` — rotate the scrypt-wrap passphrase.
 *   - `useRegenerateMangroveKeypair()` — wipe everything + start over.
 *   - `useImportMangroveKeypair()` — replace the envelope with an imported JWK.
 *   - `useRefreshKeypair()` — re-pull envelope state from the server.
 *   - `useMangroveKeypairExport()` — raw private JWK for backup / cross-device import.
 */

import {
  createWebAuthnIdentity,
  decryptWithPassphrase,
  decryptWithWebAuthn,
  encryptForWebAuthnIdentities,
  encryptWithPassphrase,
  generateKeypair as generateMangroveKeypair,
  importPublicJwk,
  jwkToKeypair,
  keypairToJwk,
  type MangroveKeypair,
  publicKeyToPem,
  type SerializedMangroveKeypair,
} from "@openmapx/mangrove-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useKeypairStore } from "./keypairStore";
import {
  useMangroveCurrentUser,
  useMangroveTransport,
  useMangroveWebauthnKeyName,
} from "./provider";
import type { EnvelopeState, KeypairEnvelopeEncrypted, KeypairWrap, WrapMeta } from "./types";

// ── envelope state query ────────────────────────────────────────────────

export function useKeypairState(): {
  data: EnvelopeState | null;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
} {
  const transport = useMangroveTransport();
  const currentUser = useMangroveCurrentUser();
  const userId = currentUser?.id ?? null;

  const q = useQuery({
    queryKey: ["mangroveKeypairState", userId],
    enabled: !!userId,
    // In unencrypted mode the GET response contains the private JWK, so we
    // want to pull it over the wire as rarely as possible. Every mutation
    // that can change envelope state invalidates this query explicitly, so
    // `Infinity` is safe — no background refresh, no window-focus refetch.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => transport.getKeypairEnvelope(),
  });

  return { data: q.data ?? null, isLoading: q.isLoading, refetch: q.refetch };
}

// ── live (decrypted) keypair ─────────────────────────────────────────────

export function useUserKeypair(): {
  keypair: MangroveKeypair | null;
  publicPem: string | null;
  /** True when an envelope exists but is not unlocked. */
  needsUnlock: boolean;
  /** True when the user has no envelope at all (setup wizard should fire). */
  needsSetup: boolean;
  /** True when the user is in encrypted mode overall. */
  isEncrypted: boolean;
  isAuthed: boolean;
  isLoading: boolean;
  clear: () => void;
} {
  const currentUser = useMangroveCurrentUser();
  const isAuthed = !!currentUser?.id;
  const { keypair, publicPem, setKeypair, setPublicIdentity, clear } = useKeypairStore();
  const state = useKeypairState();

  const envelope = state.data;
  const needsSetup = envelope?.state === "uninitialized";
  const isEncrypted = envelope?.state === "ready" && envelope.mode === "encrypted";
  const isUnencrypted = envelope?.state === "ready" && envelope.mode === "unencrypted";

  useEffect(() => {
    if (!isAuthed || !isUnencrypted || keypair) return;
    if (envelope?.state !== "ready" || envelope.mode !== "unencrypted") return;
    let cancelled = false;
    (async () => {
      const kp = await jwkToKeypair({
        privateJwk: envelope.privateJwk,
        publicJwk: envelope.publicJwk,
      });
      if (cancelled) return;
      const pem = await publicKeyToPem(kp.publicKey);
      if (cancelled) return;
      setKeypair(kp, pem, false, null);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, isUnencrypted, envelope, keypair, setKeypair]);

  // Publish the public identity even while the private key is locked. The
  // public JWK isn't sensitive (same value Mangrove publishes with every
  // review), so keeping it in memory across idle-locks is safe and lets the
  // UI keep identifying the user's own reviews without forcing an unlock.
  useEffect(() => {
    if (!isAuthed || publicPem) return;
    if (envelope?.state !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const pub = await importPublicJwk(envelope.publicJwk);
        const pem = await publicKeyToPem(pub);
        if (cancelled) return;
        setPublicIdentity(pem);
      } catch {
        // Envelope with an unimportable public JWK — not actionable here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthed, envelope, publicPem, setPublicIdentity]);

  return {
    keypair,
    publicPem,
    needsUnlock: isEncrypted && !keypair,
    needsSetup: !!needsSetup,
    isEncrypted,
    isAuthed,
    isLoading: state.isLoading,
    clear,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function extractPublicJwk(privateJwk: JsonWebKey): JsonWebKey {
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || !privateJwk.x || !privateJwk.y) {
    throw new Error("Expected ECDSA P-256 private JWK");
  }
  return { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y };
}

interface EncryptedPayload {
  passphraseCiphertext: string | null;
  recipientsCiphertext: string | null;
  wraps: WrapMeta[];
}

async function buildEncryptedPayload(
  privateJwk: JsonWebKey,
  opts: {
    passphrase?: { value: string; label: string };
    webauthn?: { rpId?: string; identities: { identityString: string; label: string }[] };
  },
): Promise<EncryptedPayload> {
  const wraps: WrapMeta[] = [];
  let passphraseCiphertext: string | null = null;
  let recipientsCiphertext: string | null = null;

  if (opts.passphrase) {
    passphraseCiphertext = await encryptWithPassphrase(privateJwk, opts.passphrase.value);
    wraps.push({ wrapType: "passphrase", label: opts.passphrase.label, identityString: null });
  }

  if (opts.webauthn && opts.webauthn.identities.length > 0) {
    recipientsCiphertext = await encryptForWebAuthnIdentities(
      privateJwk,
      opts.webauthn.identities.map((i) => i.identityString),
      opts.webauthn.rpId,
    );
    for (const i of opts.webauthn.identities) {
      wraps.push({ wrapType: "webauthn", label: i.label, identityString: i.identityString });
    }
  }

  if (wraps.length === 0) {
    throw new Error("At least one unlock method is required");
  }

  return { passphraseCiphertext, recipientsCiphertext, wraps };
}

// ── setup (first-time) ───────────────────────────────────────────────────

export interface SetupUnencryptedInput {
  mode: "unencrypted";
  importJwk?: JsonWebKey;
}
export interface SetupPassphraseInput {
  mode: "passphrase";
  passphrase: string;
  label?: string;
  importJwk?: JsonWebKey;
}
export interface SetupPassphraseAndWebAuthnInput {
  mode: "passphrase+webauthn";
  passphrase: string;
  passphraseLabel?: string;
  webauthnLabel?: string;
  rpId?: string;
  importJwk?: JsonWebKey;
}
export type SetupInput =
  | SetupUnencryptedInput
  | SetupPassphraseInput
  | SetupPassphraseAndWebAuthnInput;

export function useSetupKeypair() {
  const qc = useQueryClient();
  const transport = useMangroveTransport();
  const webauthnKeyName = useMangroveWebauthnKeyName();
  const { setKeypair } = useKeypairStore();
  return useMutation({
    mutationFn: async (input: SetupInput): Promise<void> => {
      let serialized: SerializedMangroveKeypair;
      let kp: MangroveKeypair;
      if (input.importJwk) {
        const pub = extractPublicJwk(input.importJwk);
        kp = await jwkToKeypair({ privateJwk: input.importJwk, publicJwk: pub });
        serialized = { privateJwk: input.importJwk, publicJwk: pub };
      } else {
        kp = await generateMangroveKeypair();
        serialized = await keypairToJwk(kp);
      }
      const pem = await publicKeyToPem(kp.publicKey);

      if (input.mode === "unencrypted") {
        await transport.createKeypairEnvelope({
          mode: "unencrypted",
          publicJwk: serialized.publicJwk,
          privateJwk: serialized.privateJwk,
        });
        setKeypair(kp, pem, false, null);
        return;
      }

      const passphrase = {
        value: input.passphrase,
        label:
          input.mode === "passphrase+webauthn"
            ? (input.passphraseLabel ?? "Passphrase")
            : (input.label ?? "Passphrase"),
      };

      let webauthn: Parameters<typeof buildEncryptedPayload>[1]["webauthn"] | undefined;
      if (input.mode === "passphrase+webauthn") {
        const identityString = await createWebAuthnIdentity({
          rpId: input.rpId,
          type: "passkey",
          keyName: webauthnKeyName,
        });
        webauthn = {
          rpId: input.rpId,
          identities: [{ identityString, label: input.webauthnLabel ?? "Passkey" }],
        };
      }

      const payload = await buildEncryptedPayload(serialized.privateJwk, {
        passphrase,
        webauthn,
      });

      await transport.createKeypairEnvelope({
        mode: "encrypted",
        publicJwk: serialized.publicJwk,
        ...payload,
      });
      setKeypair(kp, pem, true, serialized.privateJwk);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mangroveKeypairState"] });
    },
  });
}

// ── unlock ───────────────────────────────────────────────────────────────

export interface UnlockPassphraseInput {
  method: "passphrase";
  passphrase: string;
}
export interface UnlockWebAuthnInput {
  method: "webauthn";
  rpId?: string;
  /**
   * Optional specific credential to unlock with. If omitted, the browser's
   * discoverable-credential picker is used.
   */
  identityString?: string;
}
export type UnlockInput = UnlockPassphraseInput | UnlockWebAuthnInput;

export function useUnlockKeypair() {
  const transport = useMangroveTransport();
  const { setKeypair } = useKeypairStore();
  return useMutation({
    mutationFn: async (input: UnlockInput): Promise<void> => {
      const env = await transport.getKeypairEnvelope();
      if (env?.state !== "ready") throw new Error("No keypair to unlock");
      if (env.mode !== "encrypted") throw new Error("Keypair is not encrypted");

      let privateJwk: JsonWebKey;
      if (input.method === "passphrase") {
        if (!env.passphraseCiphertext) {
          throw new Error("No passphrase unlock method is configured for this account");
        }
        try {
          privateJwk = await decryptWithPassphrase(env.passphraseCiphertext, input.passphrase);
        } catch {
          throw new Error("Incorrect passphrase");
        }
      } else {
        if (!env.recipientsCiphertext) {
          throw new Error("No passkey unlock method is configured for this account");
        }
        privateJwk = await decryptWithWebAuthn(env.recipientsCiphertext, {
          rpId: input.rpId,
          identityString: input.identityString,
        });
      }

      const kp = await jwkToKeypair({ privateJwk, publicJwk: env.publicJwk });
      const pem = await publicKeyToPem(kp.publicKey);
      setKeypair(kp, pem, true, privateJwk);
    },
  });
}

// ── add / remove wraps ───────────────────────────────────────────────────

async function fetchReadyEncryptedEnvelope(
  transport: ReturnType<typeof useMangroveTransport>,
): Promise<KeypairEnvelopeEncrypted> {
  const env = await transport.getKeypairEnvelope();
  if (env?.state !== "ready" || env.mode !== "encrypted") {
    throw new Error("Keypair must be encrypted to manage wraps");
  }
  return env;
}

function currentPassphraseWrap(env: KeypairEnvelopeEncrypted): KeypairWrap | undefined {
  return env.wraps.find((w) => w.wrapType === "passphrase");
}
function currentWebAuthnWraps(env: KeypairEnvelopeEncrypted): KeypairWrap[] {
  return env.wraps.filter((w) => w.wrapType === "webauthn");
}

export interface AddPassphraseWrapInput {
  wrapType: "passphrase";
  passphrase: string;
  label?: string;
}
export interface AddWebAuthnWrapInput {
  wrapType: "webauthn";
  label?: string;
  rpId?: string;
}
export type AddWrapInput = AddPassphraseWrapInput | AddWebAuthnWrapInput;

export function useAddWrap() {
  const qc = useQueryClient();
  const transport = useMangroveTransport();
  const webauthnKeyName = useMangroveWebauthnKeyName();
  return useMutation({
    mutationFn: async (input: AddWrapInput): Promise<void> => {
      const { privateJwk } = useKeypairStore.getState();
      if (!privateJwk) {
        throw new Error(
          "Keypair must be unlocked before adding a new method. Unlock first, then retry.",
        );
      }

      const env = await fetchReadyEncryptedEnvelope(transport);

      if (input.wrapType === "passphrase") {
        if (currentPassphraseWrap(env)) {
          throw new Error("A passphrase wrap already exists. Remove it first.");
        }
        const passphraseCiphertext = await encryptWithPassphrase(privateJwk, input.passphrase);
        const wraps: WrapMeta[] = [
          { wrapType: "passphrase", label: input.label ?? "Passphrase", identityString: null },
          ...currentWebAuthnWraps(env).map((w) => ({
            wrapType: "webauthn" as const,
            label: w.label,
            identityString: w.identityString,
          })),
        ];
        await transport.updateKeypairWraps({
          passphraseCiphertext,
          recipientsCiphertext: env.recipientsCiphertext,
          wraps,
        });
        return;
      }

      const identityString = await createWebAuthnIdentity({
        rpId: input.rpId,
        type: "passkey",
        keyName: webauthnKeyName,
      });
      const existing = currentWebAuthnWraps(env);
      const allIdentities = [
        ...existing.map((w) => w.identityString).filter((s): s is string => !!s),
        identityString,
      ];
      const recipientsCiphertext = await encryptForWebAuthnIdentities(
        privateJwk,
        allIdentities,
        input.rpId,
      );
      const existingPassphrase = currentPassphraseWrap(env);
      const wraps: WrapMeta[] = [
        ...(existingPassphrase
          ? [
              {
                wrapType: "passphrase" as const,
                label: existingPassphrase.label,
                identityString: null,
              },
            ]
          : []),
        ...existing.map((w) => ({
          wrapType: "webauthn" as const,
          label: w.label,
          identityString: w.identityString,
        })),
        { wrapType: "webauthn", label: input.label ?? "Passkey", identityString },
      ];
      await transport.updateKeypairWraps({
        passphraseCiphertext: env.passphraseCiphertext,
        recipientsCiphertext,
        wraps,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mangroveKeypairState"] });
    },
  });
}

export function useRemoveWrap() {
  const qc = useQueryClient();
  const transport = useMangroveTransport();
  return useMutation({
    mutationFn: async (wrapId: string): Promise<void> => {
      const { privateJwk } = useKeypairStore.getState();
      if (!privateJwk) {
        throw new Error("Keypair must be unlocked to remove an unlock method.");
      }
      const env = await fetchReadyEncryptedEnvelope(transport);
      const target = env.wraps.find((w) => w.id === wrapId);
      if (!target) throw new Error("Wrap not found");
      if (env.wraps.length <= 1) {
        throw new Error("Cannot remove the last unlock method");
      }

      const remaining = env.wraps.filter((w) => w.id !== wrapId);
      const passphraseWrap = remaining.find((w) => w.wrapType === "passphrase");
      const webauthnWraps = remaining.filter((w) => w.wrapType === "webauthn");

      let passphraseCiphertext: string | null = null;
      if (passphraseWrap) {
        passphraseCiphertext = env.passphraseCiphertext;
      }

      let recipientsCiphertext: string | null = null;
      if (webauthnWraps.length > 0) {
        if (target.wrapType === "webauthn") {
          const identities = webauthnWraps
            .map((w) => w.identityString)
            .filter((s): s is string => !!s);
          recipientsCiphertext = await encryptForWebAuthnIdentities(privateJwk, identities);
        } else {
          recipientsCiphertext = env.recipientsCiphertext;
        }
      }

      const wraps: WrapMeta[] = remaining.map((w) => ({
        wrapType: w.wrapType,
        label: w.label,
        identityString: w.identityString,
      }));

      await transport.updateKeypairWraps({ passphraseCiphertext, recipientsCiphertext, wraps });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mangroveKeypairState"] });
    },
  });
}

/**
 * Rotate the passphrase that unlocks the current keypair. The private key
 * itself doesn't change — only the scrypt ciphertext that wraps it. Requires
 * the keypair to be unlocked (we need the plaintext private JWK to
 * re-encrypt under the new passphrase) and a passphrase wrap to already
 * exist (otherwise use {@link useAddWrap} with `wrapType: "passphrase"`).
 */
export function useChangePassphrase() {
  const qc = useQueryClient();
  const transport = useMangroveTransport();
  return useMutation({
    mutationFn: async (input: { passphrase: string }): Promise<void> => {
      const { privateJwk } = useKeypairStore.getState();
      if (!privateJwk) {
        throw new Error("Keypair must be unlocked to change the passphrase.");
      }
      const env = await fetchReadyEncryptedEnvelope(transport);
      const existing = currentPassphraseWrap(env);
      if (!existing) {
        throw new Error("No passphrase is set. Add one instead of changing it.");
      }

      const passphraseCiphertext = await encryptWithPassphrase(privateJwk, input.passphrase);
      const wraps: WrapMeta[] = [
        { wrapType: "passphrase", label: existing.label, identityString: null },
        ...currentWebAuthnWraps(env).map((w) => ({
          wrapType: "webauthn" as const,
          label: w.label,
          identityString: w.identityString,
        })),
      ];
      await transport.updateKeypairWraps({
        passphraseCiphertext,
        recipientsCiphertext: env.recipientsCiphertext,
        wraps,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mangroveKeypairState"] });
    },
  });
}

// ── regenerate / import ──────────────────────────────────────────────────

export function useRegenerateMangroveKeypair() {
  const transport = useMangroveTransport();
  const { clear } = useKeypairStore();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await transport.deleteKeypairEnvelope();
    },
    onSuccess: async () => {
      clear();
      await qc.invalidateQueries({ queryKey: ["mangroveKeypairState"] });
    },
  });
}

/** Replace the envelope with an imported JWK in the caller-specified mode. */
export function useImportMangroveKeypair() {
  const setup = useSetupKeypair();
  const regenerate = useRegenerateMangroveKeypair();
  return useMutation({
    mutationFn: async (input: SetupInput & { importJwk: JsonWebKey }): Promise<void> => {
      try {
        await regenerate.mutateAsync();
      } catch {
        // no existing envelope — fine
      }
      await setup.mutateAsync(input);
    },
  });
}

export function useRefreshKeypair() {
  const { clear } = useKeypairStore();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      clear();
      await qc.invalidateQueries({ queryKey: ["mangroveKeypairState"] });
    },
  });
}

// ── export ───────────────────────────────────────────────────────────────

/**
 * Exposes the raw private JWK for backup / cross-device import. Mangrove's
 * own web UI persists keypairs in the same JWK shape, so a user can
 * round-trip between the host app and mangrove.reviews.
 *
 * Available when:
 *   - Unencrypted mode: always (server holds cleartext private JWK).
 *   - Encrypted mode: only while unlocked (private JWK is in memory).
 */
export function useMangroveKeypairExport(): {
  privateJwk: JsonWebKey | null;
  reason: "noEnvelope" | "locked" | null;
} {
  const envelope = useKeypairState().data;
  const privateJwkStore = useKeypairStore((s) => s.privateJwk);

  if (envelope?.state !== "ready") {
    return { privateJwk: null, reason: "noEnvelope" };
  }
  if (envelope.mode === "unencrypted") {
    return { privateJwk: envelope.privateJwk, reason: null };
  }
  if (privateJwkStore) {
    return { privateJwk: privateJwkStore, reason: null };
  }
  return { privateJwk: null, reason: "locked" };
}
