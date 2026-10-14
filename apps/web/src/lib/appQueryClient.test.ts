import { DEFAULT_QUERY_GC_TIME_MS } from "@openmapx/core";
import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./appQueryClient";

const queryFn = async () => "value";
const gcTimes = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .map((q) => q.gcTime);

describe("createAppQueryClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("arms no garbage-collection timer in a server render, whatever a hook asks", () => {
    const client = createAppQueryClient(true);
    new QueryObserver(client, { queryKey: ["hook-gc"], queryFn, gcTime: 600_000, enabled: false });
    client.getQueryCache().build(client, { queryKey: ["default-gc"], queryFn });

    expect(gcTimes(client)).toEqual([Infinity, Infinity]);
    vi.advanceTimersByTime(2 * DEFAULT_QUERY_GC_TIME_MS);
    expect(client.getQueryCache().getAll()).toHaveLength(2);
  });

  it("collects unused queries in the browser after their gcTime", () => {
    const client = createAppQueryClient(false);
    client.getQueryCache().build(client, { queryKey: ["default-gc"], queryFn });
    client.getQueryCache().build(client, { queryKey: ["hook-gc"], queryFn, gcTime: 600_000 });

    expect(gcTimes(client)).toEqual([DEFAULT_QUERY_GC_TIME_MS, 600_000]);
    vi.advanceTimersByTime(DEFAULT_QUERY_GC_TIME_MS);
    expect(client.getQueryCache().getAll()).toEqual([]);
  });
});
