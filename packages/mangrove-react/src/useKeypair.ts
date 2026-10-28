/** Encrypted-only local key lifecycle, bound to an exact host session. */
import {
  createWebAuthnIdentity,
  decryptWithPassphrase,
  decryptWithWebAuthn,
  encryptForWebAuthnIdentities,
  encryptWithPassphrase,
  generateKeypair,
  importPublicJwk,
  jwkToKeypair,
  keypairToJwk,
  type MangroveKeypair,
  publicKeyToPem,
} from "@openmapx/mangrove-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { type KeypairSigningSnapshot, keypairOwner, useKeypairStore } from "./keypairStore";
import {
  useMangroveCurrentUser,
  useMangroveTransport,
  useMangroveWebauthnKeyName,
} from "./provider";
import {
  type EnvelopeState,
  type KeypairEnvelopeEncrypted,
  type KeypairWrap,
  MAX_KEYPAIR_WRAPS,
  MangroveConflictError,
  type UpdateKeypairWrapsPayload,
  type WrapMeta,
} from "./types";

export const MANGROVE_KEYPAIR_QUERY_KEY = ["mangroveKeypairState"] as const;

/** Every operation has both a component lifetime and a store generation. */
function useKeypairOperation() {
  const owner = keypairOwner(useMangroveCurrentUser());
  const lifetime = useRef({ owner, active: false });
  useLayoutEffect(() => {
    const current = { owner, active: true };
    lifetime.current = current;
    useKeypairStore.getState().bindOwner(owner);
    return () => {
      current.active = false;
    };
  }, [owner]);
  return useCallback(() => {
    const current = lifetime.current;
    const state = useKeypairStore.getState();
    if (!owner || !current.active || current.owner !== owner || state.owner !== owner)
      throw new Error("Keypair session changed");
    const generation = state.generation;
    const assert = () => {
      const latest = useKeypairStore.getState();
      if (
        !current.active ||
        lifetime.current !== current ||
        latest.owner !== owner ||
        latest.generation !== generation
      )
        throw new Error("Keypair session changed");
    };
    return {
      owner,
      generation,
      assert,
      async wait<T>(promise: Promise<T>): Promise<T> {
        try {
          const value = await promise;
          assert();
          return value;
        } catch (error) {
          assert();
          const status =
            error && typeof error === "object"
              ? ((error as { status?: number; statusCode?: number }).status ??
                (error as { statusCode?: number }).statusCode)
              : undefined;
          if (status === 409) throw new MangroveConflictError();
          throw error;
        }
      },
    };
  }, [owner]);
}
type Operation = ReturnType<ReturnType<typeof useKeypairOperation>>;

export function useKeypairState(): {
  data: EnvelopeState | null;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
} {
  const transport = useMangroveTransport();
  const owner = keypairOwner(useMangroveCurrentUser());
  const q = useQuery({
    queryKey: [...MANGROVE_KEYPAIR_QUERY_KEY, owner],
    enabled: !!owner,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => transport.getKeypairEnvelope(),
  });
  return { data: owner ? (q.data ?? null) : null, isLoading: q.isLoading, refetch: q.refetch };
}

export function useUserKeypair() {
  const owner = keypairOwner(useMangroveCurrentUser());
  const begin = useKeypairOperation();
  const store = useKeypairStore();
  const state = useKeypairState();
  const envelope = state.data;
  const keypair =
    store.owner === owner && envelope?.state === "ready" && store.revision === envelope.revision
      ? store.keypair
      : null;
  const publicPem =
    store.owner === owner && envelope?.state === "ready" && store.revision === envelope.revision
      ? store.publicPem
      : null;
  useEffect(() => {
    if (!owner || envelope?.state !== "ready") return;
    const op = begin();
    let cancelled = false;
    void (async () => {
      const pub = await op.wait(importPublicJwk(envelope.publicJwk));
      const pem = await op.wait(publicKeyToPem(pub));
      if (!cancelled)
        useKeypairStore.getState().setPublicIdentity(pem, { ...op, revision: envelope.revision });
    })().catch(() => {
      /* Invalid public metadata cannot grant authority. */
    });
    return () => {
      cancelled = true;
    };
  }, [owner, envelope, begin]);
  return {
    keypair,
    publicPem,
    needsUnlock: envelope?.state === "ready" && !keypair,
    needsSetup: envelope?.state === "uninitialized" || (!!owner && !state.isLoading && !envelope),
    isEncrypted: envelope?.state === "ready",
    isAuthed: !!owner,
    isLoading: state.isLoading,
    clear: store.clear,
  };
}

function extractPublicJwk(privateJwk: JsonWebKey): JsonWebKey {
  if (
    privateJwk.kty !== "EC" ||
    privateJwk.crv !== "P-256" ||
    !privateJwk.x ||
    !privateJwk.y ||
    !privateJwk.d
  )
    throw new Error("Expected ECDSA P-256 private JWK");
  return { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y };
}
async function verifiedKeypair(
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
): Promise<MangroveKeypair> {
  if ("d" in publicJwk) throw new Error("Expected a public key");
  const kp = await jwkToKeypair({ privateJwk, publicJwk });
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const signature = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    kp.privateKey,
    challenge,
  );
  if (
    !(await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      kp.publicKey,
      signature,
      challenge,
    ))
  )
    throw new Error("Private key does not match public identity");
  return kp;
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
export type SetupInput = SetupPassphraseInput | SetupPassphraseAndWebAuthnInput;
async function prepareSetup(input: SetupInput, op: Operation, webauthnKeyName?: string) {
  if (input.mode !== "passphrase" && input.mode !== "passphrase+webauthn")
    throw new Error("Encrypted setup is required");
  const serialized = input.importJwk
    ? { privateJwk: structuredClone(input.importJwk), publicJwk: extractPublicJwk(input.importJwk) }
    : await op.wait(keypairToJwk(await op.wait(generateKeypair())));
  const kp = await op.wait(verifiedKeypair(serialized.privateJwk, serialized.publicJwk));
  const pem = await op.wait(publicKeyToPem(kp.publicKey));
  const passphraseCiphertext = await op.wait(
    encryptWithPassphrase(serialized.privateJwk, input.passphrase),
  );
  const wraps: WrapMeta[] = [
    {
      wrapType: "passphrase",
      label:
        input.mode === "passphrase"
          ? (input.label ?? "Passphrase")
          : (input.passphraseLabel ?? "Passphrase"),
      identityString: null,
    },
  ];
  let recipientsCiphertext: string | null = null;
  if (input.mode === "passphrase+webauthn") {
    const identityString = await op.wait(
      createWebAuthnIdentity({ rpId: input.rpId, type: "passkey", keyName: webauthnKeyName }),
    );
    recipientsCiphertext = await op.wait(
      encryptForWebAuthnIdentities(serialized.privateJwk, [identityString], input.rpId),
    );
    wraps.push({ wrapType: "webauthn", label: input.webauthnLabel ?? "Passkey", identityString });
  }
  return {
    kp,
    pem,
    serialized,
    payload: { publicJwk: serialized.publicJwk, passphraseCiphertext, recipientsCiphertext, wraps },
  };
}
function publishSetup(
  prepared: Awaited<ReturnType<typeof prepareSetup>>,
  op: Operation,
  revision: string,
) {
  op.assert();
  if (
    !useKeypairStore
      .getState()
      .setKeypair(prepared.kp, prepared.pem, prepared.serialized.privateJwk, { ...op, revision })
  )
    throw new MangroveConflictError();
}
export function useSetupKeypair() {
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation(),
    name = useMangroveWebauthnKeyName();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async (input: SetupInput) => {
      const op = begin();
      const prepared = await prepareSetup(input, op, name);
      op.assert();
      const { revision } = await op.wait(transport.createKeypairEnvelope(prepared.payload));
      publishSetup(prepared, op, revision);
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
export interface UnlockPassphraseInput {
  method: "passphrase";
  passphrase: string;
}
export interface UnlockWebAuthnInput {
  method: "webauthn";
  rpId?: string;
  identityString?: string;
}
export type UnlockInput = UnlockPassphraseInput | UnlockWebAuthnInput;
export function useUnlockKeypair() {
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async (input: UnlockInput) => {
      let op = begin();
      const env = await op.wait(transport.getKeypairEnvelope());
      if (env?.state !== "ready") throw new Error("No keypair to unlock");
      const publicKey = await op.wait(importPublicJwk(env.publicJwk));
      const pem = await op.wait(publicKeyToPem(publicKey));
      if (!useKeypairStore.getState().setPublicIdentity(pem, { ...op, revision: env.revision }))
        throw new MangroveConflictError();
      op = begin();
      let privateJwk: JsonWebKey;
      if (input.method === "passphrase") {
        if (!env.passphraseCiphertext)
          throw new Error("No passphrase unlock method is configured for this account");
        try {
          privateJwk = await op.wait(
            decryptWithPassphrase(env.passphraseCiphertext, input.passphrase),
          );
        } catch {
          op.assert();
          throw new Error("Incorrect passphrase");
        }
      } else {
        if (!env.recipientsCiphertext)
          throw new Error("No passkey unlock method is configured for this account");
        privateJwk = await op.wait(
          decryptWithWebAuthn(env.recipientsCiphertext, {
            rpId: input.rpId,
            identityString: input.identityString,
          }),
        );
      }
      const kp = await op.wait(verifiedKeypair(privateJwk, env.publicJwk));
      if (
        !useKeypairStore
          .getState()
          .setKeypair(kp, pem, privateJwk, { ...op, revision: env.revision })
      )
        throw new MangroveConflictError();
      op.assert();
      qc.setQueryData([...MANGROVE_KEYPAIR_QUERY_KEY, op.owner], env);
    },
  });
}

async function fetchBoundEnvelope(
  transport: ReturnType<typeof useMangroveTransport>,
  op: Operation,
  snapshot: KeypairSigningSnapshot,
): Promise<KeypairEnvelopeEncrypted> {
  const env = await op.wait(transport.getKeypairEnvelope());
  if (
    env?.state !== "ready" ||
    env.revision !== snapshot.revision ||
    !useKeypairStore.getState().isCurrent(snapshot)
  ) {
    if (useKeypairStore.getState().isCurrent(snapshot)) useKeypairStore.getState().lock();
    throw new MangroveConflictError();
  }
  return env;
}
function requireUnlocked(op: Operation) {
  const snapshot = useKeypairStore.getState().getSigningSnapshot(op.owner);
  if (!snapshot) throw new Error("Keypair must be unlocked to manage unlock methods");
  return snapshot;
}
function meta(w: KeypairWrap): WrapMeta {
  return { wrapType: w.wrapType, label: w.label, identityString: w.identityString };
}
async function replaceWraps(
  transport: ReturnType<typeof useMangroveTransport>,
  op: Operation,
  snapshot: KeypairSigningSnapshot,
  payload: Omit<UpdateKeypairWrapsPayload, "expectedRevision">,
) {
  op.assert();
  if (!useKeypairStore.getState().isCurrent(snapshot)) throw new MangroveConflictError();
  try {
    const { revision } = await op.wait(
      transport.updateKeypairWraps({ ...payload, expectedRevision: snapshot.revision }),
    );
    if (!useKeypairStore.getState().advanceRevision(snapshot, revision))
      throw new MangroveConflictError();
  } catch (error) {
    if (error instanceof MangroveConflictError && useKeypairStore.getState().isCurrent(snapshot))
      useKeypairStore.getState().lock();
    throw error;
  }
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
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation(),
    name = useMangroveWebauthnKeyName();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async (input: AddWrapInput) => {
      const op = begin(),
        snapshot = requireUnlocked(op);
      const env = await fetchBoundEnvelope(transport, op, snapshot);
      if (env.wraps.length >= MAX_KEYPAIR_WRAPS)
        throw new Error(`At most ${MAX_KEYPAIR_WRAPS} unlock methods are supported`);
      const wraps = env.wraps.map(meta);
      let passphraseCiphertext = env.passphraseCiphertext,
        recipientsCiphertext = env.recipientsCiphertext;
      if (input.wrapType === "passphrase") {
        if (wraps.some((w) => w.wrapType === "passphrase"))
          throw new Error("A passphrase wrap already exists. Remove it first.");
        passphraseCiphertext = await op.wait(
          encryptWithPassphrase(snapshot.privateJwk, input.passphrase),
        );
        wraps.push({
          wrapType: "passphrase",
          label: input.label ?? "Passphrase",
          identityString: null,
        });
      } else {
        const identityString = await op.wait(
          createWebAuthnIdentity({ rpId: input.rpId, type: "passkey", keyName: name }),
        );
        wraps.push({ wrapType: "webauthn", label: input.label ?? "Passkey", identityString });
        recipientsCiphertext = await op.wait(
          encryptForWebAuthnIdentities(
            snapshot.privateJwk,
            wraps
              .filter((w) => w.wrapType === "webauthn")
              .map((w) => w.identityString)
              .filter((value): value is string => !!value),
            input.rpId,
          ),
        );
      }
      await replaceWraps(transport, op, snapshot, {
        passphraseCiphertext,
        recipientsCiphertext,
        wraps,
      });
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
export function useRemoveWrap() {
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async (wrapId: string) => {
      const op = begin(),
        snapshot = requireUnlocked(op);
      const env = await fetchBoundEnvelope(transport, op, snapshot);
      const target = env.wraps.find((w) => w.id === wrapId);
      if (!target) throw new Error("Wrap not found");
      if (env.wraps.length <= 1) throw new Error("Cannot remove the last unlock method");
      const wraps = env.wraps.filter((w) => w.id !== wrapId).map(meta),
        web = wraps.filter((w) => w.wrapType === "webauthn");
      const recipientsCiphertext = web.length
        ? target.wrapType === "webauthn"
          ? await op.wait(
              encryptForWebAuthnIdentities(
                snapshot.privateJwk,
                web.map((w) => w.identityString).filter((value): value is string => !!value),
              ),
            )
          : env.recipientsCiphertext
        : null;
      const passphraseCiphertext = wraps.some((w) => w.wrapType === "passphrase")
        ? env.passphraseCiphertext
        : null;
      await replaceWraps(transport, op, snapshot, {
        passphraseCiphertext,
        recipientsCiphertext,
        wraps,
      });
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
export function useChangePassphrase() {
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async (input: { passphrase: string }) => {
      const op = begin(),
        snapshot = requireUnlocked(op);
      const env = await fetchBoundEnvelope(transport, op, snapshot);
      if (!env.wraps.some((w) => w.wrapType === "passphrase"))
        throw new Error("No passphrase is set. Add one instead of changing it.");
      const passphraseCiphertext = await op.wait(
        encryptWithPassphrase(snapshot.privateJwk, input.passphrase),
      );
      await replaceWraps(transport, op, snapshot, {
        passphraseCiphertext,
        recipientsCiphertext: env.recipientsCiphertext,
        wraps: env.wraps.map(meta),
      });
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
async function deletionEnvelope(
  transport: ReturnType<typeof useMangroveTransport>,
  op: Operation,
  cached: EnvelopeState | null,
) {
  const knownRevision = useKeypairStore.getState().revision;
  const env = cached ?? (await op.wait(transport.getKeypairEnvelope()));
  if (knownRevision && (env?.state !== "ready" || env.revision !== knownRevision)) {
    useKeypairStore.getState().lock();
    throw new MangroveConflictError();
  }
  return env;
}
export function useRegenerateMangroveKeypair() {
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation();
  const state = useKeypairState();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async () => {
      const op = begin();
      const env = await deletionEnvelope(transport, op, state.data);
      if (env?.state === "ready")
        await op.wait(transport.deleteKeypairEnvelope({ expectedRevision: env.revision }));
      op.assert();
      useKeypairStore.getState().clear();
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
export function useImportMangroveKeypair() {
  const qc = useQueryClient(),
    transport = useMangroveTransport(),
    begin = useKeypairOperation(),
    name = useMangroveWebauthnKeyName();
  const state = useKeypairState();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async (input: SetupInput & { importJwk: JsonWebKey }) => {
      const op = begin();
      const env = await deletionEnvelope(transport, op, state.data);
      const prepared = await prepareSetup(input, op, name);
      if (env?.state === "ready")
        await op.wait(transport.deleteKeypairEnvelope({ expectedRevision: env.revision }));
      op.assert();
      useKeypairStore.getState().clear();
      // A fresh generation after deletion cannot authorize work from another session.
      const next = begin();
      const { revision } = await next.wait(transport.createKeypairEnvelope(prepared.payload));
      publishSetup(prepared, next, revision);
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
export function useRefreshKeypair() {
  const qc = useQueryClient(),
    begin = useKeypairOperation();
  return useMutation({
    mutationKey: ["mangrovePrivate"],
    gcTime: 0,
    retry: false,
    mutationFn: async () => {
      begin().assert();
      useKeypairStore.getState().clear();
      await qc.invalidateQueries({ queryKey: MANGROVE_KEYPAIR_QUERY_KEY });
    },
  });
}
export function useMangroveKeypairExport(): {
  privateJwk: JsonWebKey | null;
  reason: "noEnvelope" | "locked" | null;
} {
  const owner = keypairOwner(useMangroveCurrentUser());
  const envelope = useKeypairState().data;
  const store = useKeypairStore();
  const snapshot = store.getSigningSnapshot(owner);
  if (envelope?.state !== "ready") return { privateJwk: null, reason: "noEnvelope" };
  if (!snapshot || snapshot.revision !== envelope.revision)
    return { privateJwk: null, reason: "locked" };
  return { privateJwk: snapshot.privateJwk, reason: null };
}
