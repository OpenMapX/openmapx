import { PERSONAL_TIMELINE_QUERY_KEY } from "@openmapx/core";
import { dehydrate, onlineManager, QueryClient } from "@tanstack/react-query";
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
});
