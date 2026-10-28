import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useEffect } from "react";
import { describe, expect, it } from "vitest";
import { MangroveProvider } from "./provider";
import { createMangroveSigner, type SignerTransport } from "./signer";
import { useMangroveSigner } from "./signerProvider";
import type { MangroveTransport } from "./transport";

describe("callback controller lifecycle", () => {
  it("accepts a callback from a child effect, including Strict Mode remounts", async () => {
    sessionStorage.clear();
    const config = {
      configured: true as const,
      clientId: "id",
      redirectUri: `${location.origin}/auth/mangrove`,
      signerUrl: "https://signer.mangrove.reviews",
      accountUrl: "https://mangrove.reviews/account",
    };
    const signer: SignerTransport = {
      getConfig: async () => config,
      getAccount: async () => ({ reviewerId: "reviewer", publicPem: "PUBLIC" }),
      signReview: async () => {
        throw new Error("unused");
      },
      revokeSession: async () => undefined,
    };
    const seed = createMangroveSigner({
      owner: JSON.stringify(["a", "a"]),
      origin: location.origin,
      storage: sessionStorage,
      transport: signer,
    });
    seed.activate();
    const login = new URL(await seed.beginLogin("osm", "/"));
    seed.dispose();
    const callback = `${location.origin}/auth/mangrove#session_token=${"secret".repeat(8)}&state=${login.searchParams.get("state")}`;
    const client = new QueryClient();
    const transport = {
      signer,
      getKeypairEnvelope: async () => ({ state: "uninitialized" }),
    } as unknown as MangroveTransport;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <QueryClientProvider client={client}>
          <MangroveProvider transport={transport} currentUser={{ id: "a" }}>
            {children}
          </MangroveProvider>
        </QueryClientProvider>
      </StrictMode>
    );
    const hook = renderHook(
      () => {
        const value = useMangroveSigner();
        useEffect(() => {
          void value.controller?.acceptCallback(callback).catch(() => undefined);
        }, [value.controller]);
        return value;
      },
      { wrapper },
    );
    await waitFor(() => expect(hook.result.current.account?.reviewerId).toBe("reviewer"));
    act(() => hook.unmount());
    expect(JSON.stringify(decodeURIComponent(location.href))).not.toContain("secret");
  });
});
