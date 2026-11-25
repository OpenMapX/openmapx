import { PERSONAL_TIMELINE_QUERY_KEY } from "@openmapx/core";
import {
  MangroveProvider,
  type MangroveTransport,
  useSetupKeypair,
} from "@openmapx/mangrove-react";
import { dehydrate, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldDehydrateOpenMapXMutation } from "./personalTimelineCachePolicy";
import { QUERY_CACHE_BUSTER } from "./recentMapDataCache";
import { MANGROVE_SIGNER_STORAGE_KEYS } from "./signOutStorage";

afterEach(() => {
  onlineManager.setOnline(true);
});

describe("personal timeline cache policy", () => {
  it("never dehydrates a paused timeline API key while retaining unrelated paused mutations", () => {
    const client = new QueryClient();
    onlineManager.setOnline(false);
    const timelineRequest = vi.fn();
    const unrelatedRequest = vi.fn();
    const timelineMutation = client.getMutationCache().build(client, {
      mutationKey: [...PERSONAL_TIMELINE_QUERY_KEY, "user-a", "connect"],
      mutationFn: async (variables) => {
        timelineRequest(variables);
        return { connected: true };
      },
    });
    const unrelatedMutation = client.getMutationCache().build(client, {
      mutationKey: ["unrelated", "write"],
      mutationFn: async (variables) => {
        unrelatedRequest(variables);
        return { ok: true };
      },
    });
    void timelineMutation.execute({ mode: "managed", apiKey: "must-never-persist" });
    void unrelatedMutation.execute({ safe: true });
    expect(timelineMutation.state.isPaused).toBe(true);
    expect(unrelatedMutation.state.isPaused).toBe(true);

    const dehydrated = dehydrate(client, {
      shouldDehydrateMutation: shouldDehydrateOpenMapXMutation,
    });
    const serialized = JSON.stringify({ buster: QUERY_CACHE_BUSTER, dehydrated });

    expect(serialized).not.toContain("must-never-persist");
    expect(dehydrated.mutations).toHaveLength(1);
    expect(dehydrated.mutations[0]?.mutationKey).toEqual(["unrelated", "write"]);
  });

  it("excludes secrets from a real paused local-key setup hook", () => {
    const client = new QueryClient();
    onlineManager.setOnline(false);
    const transport = {
      getKeypairEnvelope: async () => ({ state: "uninitialized" }),
    } as unknown as MangroveTransport;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(MangroveProvider, {
          transport,
          currentUser: { id: "owner" },
          signerStorageKeys: MANGROVE_SIGNER_STORAGE_KEYS,
          children,
        }),
      );
    const hook = renderHook(() => useSetupKeypair(), { wrapper });
    act(() =>
      hook.result.current.mutate({
        mode: "passphrase",
        passphrase: "sensitive local setup fixture",
      }),
    );
    expect(client.getMutationCache().getAll()[0]?.state.isPaused).toBe(true);
    expect(
      dehydrate(client, { shouldDehydrateMutation: shouldDehydrateOpenMapXMutation }).mutations,
    ).toEqual([]);
    hook.unmount();
  });
});
