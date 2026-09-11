import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createQueryWrapper, renderHook, waitFor } from "@/test";
import { fetchCoverageJson, useCoverageReport } from "./coverageHooks";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));

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

  it("uses credentialed requests and preserves structured HTTP errors", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ value: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const controller = new AbortController();
    await expect(
      fetchCoverageJson<{ value: string }>("/coverage", controller.signal),
    ).resolves.toEqual({
      value: "ok",
    });
    expect(fetchMock).toHaveBeenCalledWith("/coverage", {
      credentials: "include",
      signal: controller.signal,
    });

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "snapshot_expired" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(fetchCoverageJson("/coverage", controller.signal)).rejects.toMatchObject({
      status: 409,
      code: "snapshot_expired",
    });
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
      second.resolve(
        new Response(JSON.stringify({ region: "extract:second" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    await waitFor(() => expect(query.result.current.data).toEqual({ region: "extract:second" }));

    await act(async () => {
      first.resolve(
        new Response(JSON.stringify({ region: "extract:first" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    await waitFor(() => expect(query.result.current.data).toEqual({ region: "extract:second" }));
  });
});
