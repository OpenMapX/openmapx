import type { CoverageReport } from "@openmapx/core/coverage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createQueryWrapper, renderHook, waitFor } from "@/test";
import { useCoverageReport } from "./coverageHooks";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));

function report(regionKey: string): CoverageReport {
  return {
    schemaVersion: 1,
    snapshotId: "snapshot-1",
    generatedAt: "2026-09-10T12:00:00.000Z",
    evaluatedAt: "2026-09-10T12:00:00.000Z",
    collectionStatus: "complete",
    collectionAgeSeconds: 0,
    warnings: [],
    authorities: [],
    region: { key: regionKey, label: regionKey, kind: "extract" },
    summary: [],
    capabilities: [],
    operations: [],
    sources: [],
    sourcePagination: { offset: 0, limit: 50, total: 0, hasMore: false, snapshotId: "snapshot-1" },
    totalSourceCount: 0,
    unassignedSourceCount: 0,
    assessment: "operational",
    nextDeadlineAt: null,
    policy: { effectiveSourcePolicy: "permissive", gatedSourceCount: 0, gatedIntegrationCount: 0 },
  };
}

function reply(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: status === 200 ? { "cache-control": "private, no-store" } : {},
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("coverage query hooks", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("uses credentialed, cancellable requests and preserves structured HTTP errors", async () => {
    fetchMock.mockResolvedValue(reply({ error: "snapshot_expired" }, 409));
    const query = renderHook(() => useCoverageReport({ regionId: "extract:first", limit: 50 }), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(query.result.current.isError).toBe(true));
    expect(query.result.current.error).toMatchObject({ status: 409, code: "snapshot_expired" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/admin/coverage");
    expect(new URL(url).searchParams.get("regionId")).toBe("extract:first");
    expect(init.credentials).toBe("include");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a malformed report instead of rendering it", async () => {
    fetchMock.mockResolvedValue(reply({ region: "extract:first" }));
    const query = renderHook(() => useCoverageReport({ regionId: "extract:first", limit: 50 }), {
      wrapper: createQueryWrapper(),
    });
    await waitFor(() => expect(query.result.current.isError).toBe(true));
    expect(query.result.current.error).toMatchObject({ status: 200 });
    expect(query.result.current.data).toBeUndefined();
  });

  it("keys reports by region so a late response cannot populate a new region", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockImplementation((input) => {
      const regionId = new URL(String(input)).searchParams.get("regionId");
      return regionId === "extract:first" ? first.promise : second.promise;
    });

    const query = renderHook(
      ({ regionId }: { regionId: string }) => useCoverageReport({ regionId, limit: 50 }),
      {
        initialProps: { regionId: "extract:first" },
        wrapper: createQueryWrapper(),
      },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    query.rerender({ regionId: "extract:second" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(reply(report("extract:second")));
    });
    await waitFor(() => expect(query.result.current.data?.region.key).toBe("extract:second"));

    await act(async () => {
      first.resolve(reply(report("extract:first")));
    });
    await waitFor(() => expect(query.result.current.data?.region.key).toBe("extract:second"));
  });
});
