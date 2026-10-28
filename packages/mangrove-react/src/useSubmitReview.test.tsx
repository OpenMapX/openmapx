import { generateKeypair, publicKeyToPem, signMangroveReview } from "@openmapx/mangrove-client";
import { dehydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useKeypairStore } from "./keypairStore";
import { MangroveProvider } from "./provider";
import type { SignerTransport } from "./signer";
import { useMangroveSigner } from "./signerProvider";
import type { MangroveTransport } from "./transport";
import { MANGROVE_KEYPAIR_QUERY_KEY } from "./useKeypair";
import { useSubmitReview } from "./useSubmitReview";

beforeEach(() => sessionStorage.clear());
async function fixture(tamper = false) {
  const kp = await generateKeypair();
  const publicPem = await publicKeyToPem(kp.publicKey);
  const submitted: string[] = [];
  const signer: SignerTransport = {
    getConfig: async () => ({
      configured: true,
      clientId: "id",
      redirectUri: `${location.origin}/auth/mangrove`,
      signerUrl: "https://signer.mangrove.reviews",
      accountUrl: "https://mangrove.reviews/account",
    }),
    getAccount: async () => ({ reviewerId: "reviewer", publicPem }),
    signReview: async (_token, payload) => ({
      jwt: await signMangroveReview({ ...payload, ...(tamper ? { rating: 100 } : {}) }, kp),
      publicPem,
      reviewerId: "reviewer",
    }),
    revokeSession: async () => undefined,
  };
  const transport = {
    signer,
    getKeypairEnvelope: async () => ({ state: "uninitialized" }),
    submitReview: async ({ jwt }: { jwt: string }) => {
      submitted.push(jwt);
      return { id: "submitted" };
    },
  } as unknown as MangroveTransport;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MangroveProvider transport={transport} currentUser={{ id: "a" }}>
        {children}
      </MangroveProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => ({ signer: useMangroveSigner(), submit: useSubmitReview() }), {
    wrapper,
  });
  await waitFor(() => expect(hook.result.current.signer.config?.configured).toBe(true));
  const controller = hook.result.current.signer.controller;
  if (!controller) throw new Error("Signer controller missing");
  let login = "";
  await act(async () => {
    login = await controller.beginLogin("osm", "/");
  });
  await act(async () => {
    await controller.acceptCallback(
      `${location.origin}/auth/mangrove#session_token=${"secret".repeat(8)}&state=${new URL(login).searchParams.get("state")}`,
    );
  });
  return { ...hook, client, submitted, signer, transport, kp, publicPem };
}
describe("review submission with delegated signing", () => {
  it("relays a verified signer JWT with a zero rating and keeps tokens out of mutations", async () => {
    const f = await fixture();
    let result: unknown;
    await act(async () => {
      result = await f.result.current.submit.mutateAsync({
        subject: { lat: 50, lng: 6, name: "Place" },
        stars: 0,
        opinion: "Fine",
      });
    });
    expect(result).toEqual({ id: "submitted" });
    expect(f.submitted).toHaveLength(1);
    const body = JSON.parse(atob(f.submitted[0].split(".")[1]));
    expect(body.rating).toBe(0);
    expect(
      JSON.stringify(dehydrate(f.client, { shouldDehydrateMutation: () => true })),
    ).not.toContain("secret".repeat(8));
  });
  it("refuses a correctly signed JWT whose review content was changed", async () => {
    const f = await fixture(true);
    await act(async () => {
      await expect(
        f.result.current.submit.mutateAsync({
          subject: { lat: 50, lng: 6, name: "Place" },
          stars: 0,
        }),
      ).rejects.toThrow();
    });
    expect(f.submitted).toEqual([]);
  });
  it("does not submit a late signing response after unmount", async () => {
    const f = await fixture();
    const sign = f.signer.signReview;
    let finish!: () => void;
    f.signer.signReview = async (...args) => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return sign(...args);
    };
    const pending = f.result.current.submit.mutateAsync({
      subject: { lat: 50, lng: 6, name: "Place" },
      stars: 0,
    });
    const outcome = expect(pending).rejects.toThrow();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    f.unmount();
    finish();
    await outcome;
    expect(f.submitted).toEqual([]);
  });
  it("cancels an in-flight relay when the signing mode changes", async () => {
    const f = await fixture();
    let entered = false;
    f.transport.submitReview = async (_payload, options) =>
      new Promise((_resolve, reject) => {
        entered = true;
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    const pending = f.result.current.submit.mutateAsync({
      subject: { lat: 50, lng: 6, name: "Place" },
      stars: 0,
    });
    const outcome = expect(pending).rejects.toThrow("cancelled");
    await waitFor(() => expect(entered).toBe(true));
    act(() => f.result.current.signer.controller?.selectLocal());
    await outcome;
  });
  it("cancels a local relay when its key is locked and shared signing is selected", async () => {
    const f = await fixture();
    const publicJwk = await crypto.subtle.exportKey("jwk", f.kp.publicKey);
    act(() => {
      f.result.current.signer.controller?.selectLocal();
      f.client.setQueryData([...MANGROVE_KEYPAIR_QUERY_KEY, JSON.stringify(["a", null])], {
        state: "ready",
        revision: "local-r1",
        publicJwk,
        wraps: [],
        passphraseCiphertext: null,
        recipientsCiphertext: null,
      });
      const state = useKeypairStore.getState();
      state.setKeypair(
        f.kp,
        f.publicPem,
        {},
        {
          owner: state.owner!,
          generation: state.generation,
          revision: "local-r1",
        },
      );
    });
    let relaySignal: AbortSignal | undefined;
    f.transport.submitReview = async (_payload, options) =>
      new Promise((_resolve, reject) => {
        relaySignal = options?.signal;
        relaySignal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
    const pending = f.result.current.submit.mutateAsync({
      subject: { lat: 50, lng: 6, name: "Place" },
      stars: 0,
    });
    const outcome = expect(pending).rejects.toThrow("cancelled");
    await waitFor(() => expect(relaySignal).toBeDefined());
    act(() => useKeypairStore.getState().lock());
    await act(async () => {
      await f.result.current.signer.controller?.beginLogin("osm", "/");
    });
    expect(relaySignal?.aborted).toBe(true);
    await outcome;
  });
});
