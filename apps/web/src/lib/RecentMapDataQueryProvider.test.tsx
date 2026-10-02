import { dehydrate, QueryClient, useIsRestoring, useQuery } from "@tanstack/react-query";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test";
import {
  PERSONAL_TIMELINE_CACHE_BUSTER,
  removePersonalTimelineMutations,
} from "./personalTimelineCachePolicy";
import { RecentMapDataQueryProvider } from "./RecentMapDataQueryProvider";
import { RECENT_MAP_DATA_CACHE_ENABLED_KEY } from "./recentMapDataCache";

beforeEach(() => localStorage.setItem(RECENT_MAP_DATA_CACHE_ENABLED_KEY, "true"));
afterEach(() => localStorage.clear());

function fixture() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const stored = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  stored.setQueryData(["place", "test"], "cached");
  const snapshot: PersistedClient = {
    timestamp: Date.now(),
    buster: PERSONAL_TIMELINE_CACHE_BUSTER,
    clientState: dehydrate(stored),
  };
  const persister = {
    restoreClient: vi.fn(async () => snapshot) as ReturnType<typeof vi.fn> &
      Persister["restoreClient"],
    persistClient: vi.fn() as ReturnType<typeof vi.fn> & Persister["persistClient"],
    removeClient: vi.fn(async () => {}) as ReturnType<typeof vi.fn> & Persister["removeClient"],
  };
  const queryFn = vi.fn(async () => "network") as ReturnType<typeof vi.fn> &
    (() => Promise<string>);
  const persistOptions = {
    persister,
    buster: PERSONAL_TIMELINE_CACHE_BUSTER,
    maxAge: 24 * 60 * 60 * 1000,
  };
  return { queryClient, snapshot, persister, queryFn, persistOptions };
}

function Probe({ queryFn }: { queryFn: () => Promise<string> }) {
  const restoring = useIsRestoring();
  const query = useQuery({ queryKey: ["place", "test"], queryFn, staleTime: 60_000 });
  return <span>{restoring ? "restoring" : (query.data ?? "waiting")}</span>;
}

describe("recent map data query provider", () => {
  it("gates network queries until restore and cleanup finish", async () => {
    const f = fixture();
    let releaseRestore!: (client: PersistedClient) => void;
    let releaseCleanup!: () => void;
    f.persister.restoreClient.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRestore = resolve;
        }),
    );
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );
    render(
      <RecentMapDataQueryProvider
        client={f.queryClient}
        persistOptions={f.persistOptions}
        onSuccess={cleanup}
      >
        <Probe queryFn={f.queryFn} />
      </RecentMapDataQueryProvider>,
    );
    expect(screen.getByText("restoring")).toBeInTheDocument();
    expect(f.queryFn).not.toHaveBeenCalled();
    await act(async () => {
      releaseRestore(f.snapshot);
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(screen.getByText("restoring")).toBeInTheDocument();
    expect(f.queryFn).not.toHaveBeenCalled();
    await act(async () => {
      releaseCleanup();
    });
    await screen.findByText("cached");
    expect(f.queryFn).not.toHaveBeenCalled();
  });

  it("does not hydrate a detached query client when restoration resolves after unmount", async () => {
    const f = fixture();
    let release!: (client: PersistedClient) => void;
    f.persister.restoreClient.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const onSuccess = vi.fn();
    const view = render(
      <RecentMapDataQueryProvider
        client={f.queryClient}
        persistOptions={f.persistOptions}
        onSuccess={onSuccess}
      >
        <Probe queryFn={f.queryFn} />
      </RecentMapDataQueryProvider>,
    );
    view.unmount();
    await act(async () => {
      release(f.snapshot);
    });
    expect(f.queryClient.getQueryData(["place", "test"])).toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(f.persister.persistClient).not.toHaveBeenCalled();
  });

  it("restores once under StrictMode and leaves queries usable", async () => {
    const f = fixture();
    render(
      <StrictMode>
        <RecentMapDataQueryProvider client={f.queryClient} persistOptions={f.persistOptions}>
          <Probe queryFn={f.queryFn} />
        </RecentMapDataQueryProvider>
      </StrictMode>,
    );
    await screen.findByText("cached");
    expect(f.persister.restoreClient).toHaveBeenCalledTimes(1);
    expect(f.queryFn).not.toHaveBeenCalled();
  });

  it.each(["expired", "buster"])("rejects a %s snapshot before fetching", async (reason) => {
    const f = fixture();
    if (reason === "expired") f.snapshot.timestamp -= 24 * 60 * 60 * 1000 + 1;
    if (reason === "buster") f.snapshot.buster = "old-format";
    render(
      <RecentMapDataQueryProvider client={f.queryClient} persistOptions={f.persistOptions}>
        <Probe queryFn={f.queryFn} />
      </RecentMapDataQueryProvider>,
    );
    await screen.findByText("network");
    expect(f.persister.removeClient).toHaveBeenCalledTimes(1);
    expect(f.queryFn).toHaveBeenCalledTimes(1);
  });

  it("cleans legacy timeline mutations before releasing restoration", async () => {
    const f = fixture();
    const stored = new QueryClient();
    stored.getMutationCache().build(
      stored,
      { mutationKey: ["personalTimeline", "connect"] },
      {
        context: undefined,
        data: undefined,
        error: null,
        failureCount: 0,
        failureReason: null,
        isPaused: true,
        status: "pending",
        submittedAt: Date.now(),
        variables: { apiKey: "secret" },
      },
    );
    f.snapshot.clientState.mutations = dehydrate(stored).mutations;
    const cleanup = vi.fn(() => removePersonalTimelineMutations(f.queryClient));
    render(
      <RecentMapDataQueryProvider
        client={f.queryClient}
        persistOptions={f.persistOptions}
        onSuccess={cleanup}
      >
        <Probe queryFn={f.queryFn} />
      </RecentMapDataQueryProvider>,
    );
    await screen.findByText("cached");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(f.queryClient.getMutationCache().getAll()).toEqual([]);
  });

  it("releases queries after a restore error", async () => {
    const f = fixture();
    const error = new Error("storage unavailable");
    f.persister.restoreClient.mockRejectedValueOnce(error);
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(
        <RecentMapDataQueryProvider
          client={f.queryClient}
          persistOptions={f.persistOptions}
          onError={onError}
        >
          <Probe queryFn={f.queryFn} />
        </RecentMapDataQueryProvider>,
      );
      await screen.findByText("network");
      await waitFor(() => expect(onError).toHaveBeenCalledWith());
      expect(f.persister.removeClient).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });
});
