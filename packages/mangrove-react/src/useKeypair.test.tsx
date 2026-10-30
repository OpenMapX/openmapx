import {
  generateKeypair,
  importPublicJwk,
  keypairToJwk,
  publicKeyToPem,
} from "@openmapx/mangrove-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keypairOwner, useKeypairStore } from "./keypairStore";
import { MangroveProvider } from "./provider";
import type { MangroveCurrentUser, MangroveTransport } from "./transport";
import { type EnvelopeState, MangroveConflictError } from "./types";
import {
  MANGROVE_KEYPAIR_QUERY_KEY,
  useAddWrap,
  useChangePassphrase,
  useImportMangroveKeypair,
  useMangroveKeypairExport,
  useRemoveWrap,
  useSetupKeypair,
  useUnlockKeypair,
  useUserKeypair,
} from "./useKeypair";

vi.mock("@openmapx/mangrove-client", async (original) => ({
  ...(await original<object>()),
  encryptWithPassphrase: vi.fn(async (jwk) => JSON.stringify(jwk)),
  decryptWithPassphrase: vi.fn(async (cipher) => JSON.parse(cipher)),
  createWebAuthnIdentity: vi.fn(async () => "test-identity"),
  encryptForWebAuthnIdentities: vi.fn(async (jwk) => JSON.stringify(jwk)),
}));
const USER = { id: "u1", authorityId: "s1" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function envelope(): Promise<
  Extract<EnvelopeState, { state: "ready" }> & { passphraseCiphertext: string }
> {
  const { publicJwk, privateJwk } = await keypairToJwk(await generateKeypair());
  return {
    state: "ready",
    revision: "r1",
    publicJwk,
    passphraseCiphertext: JSON.stringify(privateJwk),
    recipientsCiphertext: null,
    wraps: [
      {
        id: "w",
        wrapType: "passphrase",
        label: "Pass",
        identityString: null,
        createdAt: "2026-10-28",
      },
    ],
  };
}
function harness(env: EnvelopeState = { state: "uninitialized" }) {
  const owner: { current: MangroveCurrentUser | null } = { current: USER };
  const transport: MangroveTransport = {
    getKeypairEnvelope: vi.fn(async () => env),
    createKeypairEnvelope: vi.fn(async () => ({ revision: "created" })),
    updateKeypairWraps: vi.fn(async () => ({ revision: "r2" })),
    deleteKeypairEnvelope: vi.fn(async () => {}),
    submitReview: vi.fn(),
    uploadReviewImage: vi.fn(),
    fetchPlaceReviews: vi.fn(),
    fetchPlaceReviewAggregate: vi.fn(),
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MangroveProvider transport={transport} currentUser={owner.current}>
          {children}
        </MangroveProvider>
      </QueryClientProvider>
    );
  }
  return { owner, transport, wrapper, client };
}
afterEach(() => {
  useKeypairStore.getState().clear();
  vi.clearAllMocks();
});
describe("encrypted lifecycle", () => {
  it("setup sends encrypted data only and binds returned revision", async () => {
    const h = harness();
    const { result } = renderHook(useSetupKeypair, { wrapper: h.wrapper });
    await act(() => result.current.mutateAsync({ mode: "passphrase", passphrase: "pass" }));
    const payload = vi.mocked(h.transport.createKeypairEnvelope).mock.calls[0][0];
    expect(payload).not.toHaveProperty("mode");
    expect(payload).not.toHaveProperty("privateJwk");
    expect(useKeypairStore.getState().getSigningSnapshot(keypairOwner(USER))?.revision).toBe(
      "created",
    );
  });
  it.each(["logout", "same-user-session", "clear", "unmount"])(
    "blocks delayed setup after %s",
    async (change) => {
      const h = harness();
      const pending = deferred<{ revision: string }>();
      vi.mocked(h.transport.createKeypairEnvelope).mockReturnValue(pending.promise);
      const hook = renderHook(useSetupKeypair, { wrapper: h.wrapper });
      const operation = hook.result.current.mutateAsync({ mode: "passphrase", passphrase: "pass" });
      const rejected = expect(operation).rejects.toThrow();
      await waitFor(() => expect(h.transport.createKeypairEnvelope).toHaveBeenCalledTimes(1));
      if (change === "unmount") hook.unmount();
      else if (change === "clear") useKeypairStore.getState().clear();
      else {
        h.owner.current = change === "logout" ? null : { ...USER, authorityId: "s2" };
        hook.rerender();
      }
      pending.resolve({ revision: "late" });
      await rejected;
      expect(useKeypairStore.getState().keypair).toBeNull();
    },
  );
  it.each(["clear", "logout", "same-user-session", "unmount"])(
    "blocks delayed decrypt after %s",
    async (change) => {
      const env = await envelope();
      const h = harness(env);
      const { decryptWithPassphrase } = await import("@openmapx/mangrove-client");
      const pending = deferred<JsonWebKey>();
      vi.mocked(decryptWithPassphrase).mockReturnValueOnce(pending.promise);
      const { result, rerender, unmount } = renderHook(useUnlockKeypair, { wrapper: h.wrapper });
      const operation = result.current.mutateAsync({ method: "passphrase", passphrase: "pass" });
      const rejected = expect(operation).rejects.toThrow();
      await waitFor(() => expect(decryptWithPassphrase).toHaveBeenCalled());
      if (change === "unmount") unmount();
      else if (change === "clear") useKeypairStore.getState().clear();
      else {
        h.owner.current = change === "logout" ? null : { ...USER, authorityId: "s2" };
        rerender();
      }
      pending.resolve(JSON.parse(env.passphraseCiphertext));
      await rejected;
      expect(useKeypairStore.getState().keypair).toBeNull();
    },
  );
  it("verifies actual private/public agreement after decrypt", async () => {
    const env = await envelope();
    const other = await envelope();
    env.passphraseCiphertext = other.passphraseCiphertext;
    const h = harness(env);
    const { result } = renderHook(useUnlockKeypair, { wrapper: h.wrapper });
    await expect(
      result.current.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    ).rejects.toThrow();
    expect(useKeypairStore.getState().keypair).toBeNull();
  });
  it("unlocks, preserves identity while locked, and refuses a different session", async () => {
    const env = await envelope();
    const h = harness(env);
    const { result, rerender } = renderHook(
      () => ({ unlock: useUnlockKeypair(), live: useUserKeypair() }),
      { wrapper: h.wrapper },
    );
    await act(() =>
      result.current.unlock.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    expect(result.current.live.keypair).not.toBeNull();
    act(() => useKeypairStore.getState().lock());
    expect(result.current.live.keypair).toBeNull();
    expect(result.current.live.publicPem).toContain("PUBLIC KEY");
    h.owner.current = { ...USER, authorityId: "s2" };
    rerender();
    expect(result.current.live.keypair).toBeNull();
  });
  it("publishes a verified replacement envelope so the current identity can sign and export", async () => {
    const original = await envelope();
    const replacement = { ...(await envelope()), revision: "r2" };
    const h = harness(original);
    const queryKey = [...MANGROVE_KEYPAIR_QUERY_KEY, keypairOwner(USER)];
    const { result } = renderHook(
      () => ({
        unlock: useUnlockKeypair(),
        live: useUserKeypair(),
        exported: useMangroveKeypairExport(),
      }),
      { wrapper: h.wrapper },
    );
    await waitFor(() => expect(result.current.live.publicPem).toContain("PUBLIC KEY"));
    expect(h.client.getQueryData(queryKey)).toEqual(original);
    vi.mocked(h.transport.getKeypairEnvelope).mockResolvedValue(replacement);
    await act(() =>
      result.current.unlock.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    await waitFor(() => expect(result.current.live.keypair).not.toBeNull());
    expect(h.client.getQueryData(queryKey)).toEqual(replacement);
    expect(result.current.live.needsUnlock).toBe(false);
    const publicKey = await importPublicJwk(replacement.publicJwk);
    expect(result.current.live.publicPem).toBe(await publicKeyToPem(publicKey));
    expect(result.current.exported).toEqual({
      privateJwk: JSON.parse(replacement.passphraseCiphertext),
      reason: null,
    });
    const keypair = result.current.live.keypair;
    if (!keypair) throw new Error("Expected the replacement keypair to be available for signing");
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const signature = await globalThis.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keypair.privateKey,
      challenge,
    );
    expect(
      await globalThis.crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        challenge,
      ),
    ).toBe(true);
  });
  it("does not publish a delayed unlock into either session's envelope cache", async () => {
    const original = await envelope();
    const replacement = { ...(await envelope()), revision: "r2" };
    const nextSessionEnvelope = { ...(await envelope()), revision: "r3" };
    const h = harness(original);
    const originalQueryKey = [...MANGROVE_KEYPAIR_QUERY_KEY, keypairOwner(USER)];
    // Retain the old session's cache so a late completion cannot silently replace it.
    h.client.setQueryDefaults(originalQueryKey, { gcTime: Number.POSITIVE_INFINITY });
    const { result, rerender } = renderHook(
      () => ({ unlock: useUnlockKeypair(), live: useUserKeypair() }),
      { wrapper: h.wrapper },
    );
    await waitFor(() => expect(result.current.live.publicPem).toContain("PUBLIC KEY"));
    vi.mocked(h.transport.getKeypairEnvelope).mockResolvedValue(replacement);
    const { decryptWithPassphrase } = await import("@openmapx/mangrove-client");
    const pending = deferred<JsonWebKey>();
    vi.mocked(decryptWithPassphrase).mockReturnValueOnce(pending.promise);
    const operation = result.current.unlock.mutateAsync({
      method: "passphrase",
      passphrase: "pass",
    });
    const rejected = expect(operation).rejects.toThrow("Keypair session changed");
    await waitFor(() => expect(decryptWithPassphrase).toHaveBeenCalled());
    expect(h.client.getQueryData(originalQueryKey)).toEqual(original);
    h.owner.current = { ...USER, authorityId: "s2" };
    vi.mocked(h.transport.getKeypairEnvelope).mockResolvedValue(nextSessionEnvelope);
    rerender();
    await waitFor(() => expect(result.current.live.publicPem).toContain("PUBLIC KEY"));
    pending.resolve(JSON.parse(replacement.passphraseCiphertext));
    await rejected;
    expect(h.client.getQueryData(originalQueryKey)).toEqual(original);
    expect(
      h.client.getQueryData([...MANGROVE_KEYPAIR_QUERY_KEY, keypairOwner(h.owner.current)]),
    ).toEqual(nextSessionEnvelope);
    expect(result.current.live.keypair).toBeNull();
  });
  it("wrap replacement uses the unlocked revision and refuses a freshly fetched replacement", async () => {
    const env = await envelope();
    const h = harness(env);
    const { result } = renderHook(
      () => ({ unlock: useUnlockKeypair(), change: useChangePassphrase() }),
      { wrapper: h.wrapper },
    );
    await act(() =>
      result.current.unlock.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    vi.mocked(h.transport.getKeypairEnvelope).mockResolvedValue({ ...env, revision: "recreated" });
    await expect(result.current.change.mutateAsync({ passphrase: "next" })).rejects.toBeInstanceOf(
      MangroveConflictError,
    );
    expect(h.transport.updateKeypairWraps).not.toHaveBeenCalled();
    expect(useKeypairStore.getState().getSigningSnapshot(keypairOwner(USER))).toBeNull();
  });
  it("advances revision on wrap success and propagates 409 without retry", async () => {
    const env = await envelope();
    const h = harness(env);
    const { result } = renderHook(
      () => ({ unlock: useUnlockKeypair(), change: useChangePassphrase() }),
      { wrapper: h.wrapper },
    );
    await act(() =>
      result.current.unlock.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    await act(() => result.current.change.mutateAsync({ passphrase: "next" }));
    expect(h.transport.updateKeypairWraps).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: "r1" }),
    );
    expect(useKeypairStore.getState().revision).toBe("r2");
    vi.mocked(h.transport.getKeypairEnvelope).mockResolvedValue({ ...env, revision: "r2" });
    vi.mocked(h.transport.updateKeypairWraps).mockRejectedValue({ status: 409 });
    await expect(result.current.change.mutateAsync({ passphrase: "again" })).rejects.toBeInstanceOf(
      MangroveConflictError,
    );
    expect(h.transport.updateKeypairWraps).toHaveBeenCalledTimes(2);
  });
  it("does not delete a freshly fetched replacement when import began with an old revision", async () => {
    const env = await envelope();
    const first = harness(env);
    const unlocked = renderHook(useUnlockKeypair, { wrapper: first.wrapper });
    await act(() =>
      unlocked.result.current.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    const replacement = harness({ ...env, revision: "replacement" });
    const importing = renderHook(useImportMangroveKeypair, { wrapper: replacement.wrapper });
    await act(async () => {
      await expect(
        importing.result.current.mutateAsync({
          mode: "passphrase",
          passphrase: "new",
          importJwk: JSON.parse(env.passphraseCiphertext),
        }),
      ).rejects.toBeInstanceOf(MangroveConflictError);
    });
    expect(replacement.transport.deleteKeypairEnvelope).not.toHaveBeenCalled();
  });
  it.skipIf(process.env.OPENMAPX_SKIP_SLOW_CRYPTO === "1")(
    "real age passphrase setup and unlock remain interoperable",
    async () => {
      const real = await vi.importActual<typeof import("@openmapx/mangrove-client")>(
        "@openmapx/mangrove-client",
      );
      const env = await envelope(),
        privateJwk = JSON.parse(env.passphraseCiphertext);
      env.passphraseCiphertext = await real.encryptWithPassphrase(privateJwk, "correct-pass");
      const { decryptWithPassphrase } = await import("@openmapx/mangrove-client");
      vi.mocked(decryptWithPassphrase).mockImplementationOnce(real.decryptWithPassphrase);
      const h = harness(env),
        { result } = renderHook(useUnlockKeypair, { wrapper: h.wrapper });
      await act(() =>
        result.current.mutateAsync({ method: "passphrase", passphrase: "correct-pass" }),
      );
      const snapshot = useKeypairStore.getState().getSigningSnapshot(keypairOwner(USER));
      expect(snapshot?.privateJwk.d).toBe(privateJwk.d);
    },
  );
  it("adds and removes passkey wraps with the unlocked revision", async () => {
    const env = await envelope(),
      h = harness(env);
    const { result } = renderHook(
      () => ({ unlock: useUnlockKeypair(), add: useAddWrap(), remove: useRemoveWrap() }),
      { wrapper: h.wrapper },
    );
    await act(() =>
      result.current.unlock.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    await act(() => result.current.add.mutateAsync({ wrapType: "webauthn", label: "Device" }));
    expect(h.transport.updateKeypairWraps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedRevision: "r1",
        wraps: expect.arrayContaining([
          { wrapType: "webauthn", label: "Device", identityString: "test-identity" },
        ]),
      }),
    );
    vi.mocked(h.transport.getKeypairEnvelope).mockResolvedValue({
      ...env,
      revision: "r2",
      recipientsCiphertext: "recipients",
      wraps: [
        ...env.wraps,
        {
          id: "device",
          wrapType: "webauthn",
          label: "Device",
          identityString: "test-identity",
          createdAt: "now",
        },
      ],
    });
    vi.mocked(h.transport.updateKeypairWraps).mockResolvedValue({ revision: "r3" });
    await act(() => result.current.remove.mutateAsync("device"));
    expect(h.transport.updateKeypairWraps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedRevision: "r2",
        recipientsCiphertext: null,
        passphraseCiphertext: env.passphraseCiphertext,
      }),
    );
  });
  it("rejects a 33rd wrap before creating a credential", async () => {
    const env = await envelope();
    env.wraps.push(
      ...Array.from({ length: 31 }, (_, i) => ({
        id: `w-${i}`,
        wrapType: "webauthn" as const,
        label: "Device",
        identityString: "identity",
        createdAt: "now",
      })),
    );
    const h = harness(env);
    const { result } = renderHook(() => ({ unlock: useUnlockKeypair(), add: useAddWrap() }), {
      wrapper: h.wrapper,
    });
    await act(() =>
      result.current.unlock.mutateAsync({ method: "passphrase", passphrase: "pass" }),
    );
    await expect(result.current.add.mutateAsync({ wrapType: "webauthn" })).rejects.toThrow(
      "At most 32",
    );
    expect(h.transport.updateKeypairWraps).not.toHaveBeenCalled();
    const { createWebAuthnIdentity } = await import("@openmapx/mangrove-client");
    expect(createWebAuthnIdentity).not.toHaveBeenCalled();
  });
  it("import must not swallow a deletion conflict or create a new envelope", async () => {
    const env = await envelope();
    const h = harness(env);
    vi.mocked(h.transport.deleteKeypairEnvelope).mockRejectedValue({ status: 409 });
    const { result } = renderHook(useImportMangroveKeypair, { wrapper: h.wrapper });
    await expect(
      result.current.mutateAsync({
        mode: "passphrase",
        passphrase: "new",
        importJwk: JSON.parse(env.passphraseCiphertext),
      }),
    ).rejects.toBeInstanceOf(MangroveConflictError);
    expect(h.transport.createKeypairEnvelope).not.toHaveBeenCalled();
  });
});
