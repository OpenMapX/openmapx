import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHookWithQuery, waitFor } from "@/test";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

import { useServicesList } from "./useServices";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

describe("useServicesList", () => {
  it("fetches the admin services endpoint and returns the payload", async () => {
    const payload = {
      services: [],
      summary: { running: 2, stopped: 1, total: 3 },
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload });

    const { result } = renderHookWithQuery(() => useServicesList());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/admin/services", {
      credentials: "include",
    });
  });

  it("surfaces an error when the response is not ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });

    const { result } = renderHookWithQuery(() => useServicesList());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Failed to load services");
  });
});
