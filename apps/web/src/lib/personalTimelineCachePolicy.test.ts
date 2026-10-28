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
import {
  PERSONAL_TIMELINE_CACHE_BUSTER,
  shouldDehydrateOpenMapXMutation,
} from "./personalTimelineCachePolicy";

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
    const serialized = JSON.stringify({ buster: PERSONAL_TIMELINE_CACHE_BUSTER, dehydrated });

    expect(serialized).not.toContain("must-never-persist");
    expect(dehydrated.mutations).toHaveLength(1);
    expect(dehydrated.mutations[0]?.mutationKey).toEqual(["unrelated", "write"]);
  });

  it("uses a cache buster newer than the legacy timeline-mutation format", () => {
    expect(PERSONAL_TIMELINE_CACHE_BUSTER).not.toBe("v1");
  });
  it("never dehydrates paused local review-key secrets", () => {
    const client = new QueryClient();
    onlineManager.setOnline(false);
    const mutation = client.getMutationCache().build(client, {
      mutationKey: ["mangrovePrivate", "setup"],
      mutationFn: async () => undefined,
    });
    void mutation.execute({
      passphrase: "private passphrase fixture",
      importJwk: { d: "private scalar fixture" },
    });
    expect(mutation.state.isPaused).toBe(true);
    const stored = JSON.stringify(
      dehydrate(client, { shouldDehydrateMutation: shouldDehydrateOpenMapXMutation }),
    );
    expect(stored).not.toContain("private passphrase fixture");
    expect(stored).not.toContain("private scalar fixture");
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
