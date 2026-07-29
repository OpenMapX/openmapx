import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSiNapHeaders, setSiNapToken } from "../si-nap.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function tokenResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  setSiNapToken(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolveSiNapHeaders", () => {
  it("throws (aborting the fetch stage, ingesting nothing) when no token is configured", async () => {
    setSiNapToken(undefined);
    await expect(resolveSiNapHeaders(log)).rejects.toThrow(/not configured/i);
  });

  it("throws for a blank string token, same as unset", async () => {
    setSiNapToken("   ".trim());
    await expect(resolveSiNapHeaders(log)).rejects.toThrow(/not configured/i);
  });

  it("exchanges the configured refresh token for a bearer access token via the NAP OAuth2 endpoint", async () => {
    setSiNapToken("my-refresh-token");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      tokenResponse({
        access_token: "at-1",
        token_type: "bearer",
        expires_in: 86399,
        refresh_token: "my-refresh-token",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const headers = await resolveSiNapHeaders(log);

    expect(headers).toEqual({ Authorization: "Bearer at-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://b2b.nap.si/uc/user/token");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("grant_type=refresh_token&refresh_token=my-refresh-token");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  it("caches the access token and does not re-exchange until it nears expiry", async () => {
    vi.useFakeTimers();
    setSiNapToken("refresh-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "at-1", token_type: "bearer", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "at-2", token_type: "bearer", expires_in: 3600 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveSiNapHeaders(log);
    expect(first).toEqual({ Authorization: "Bearer at-1" });

    // Still well within the 3600s expiry — no re-exchange.
    vi.advanceTimersByTime(60_000);
    const second = await resolveSiNapHeaders(log);
    expect(second).toEqual({ Authorization: "Bearer at-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past expiry (minus the 60s safety margin) — re-exchanges.
    vi.advanceTimersByTime(3600_000);
    const third = await resolveSiNapHeaders(log);
    expect(third).toEqual({ Authorization: "Bearer at-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("adopts a rotated refresh_token returned by the token endpoint", async () => {
    vi.useFakeTimers();
    setSiNapToken("refresh-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: "at-1",
          token_type: "bearer",
          expires_in: 1,
          refresh_token: "refresh-2",
        }),
      )
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "at-2", token_type: "bearer", expires_in: 3600 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await resolveSiNapHeaders(log);
    vi.advanceTimersByTime(2_000);
    await resolveSiNapHeaders(log);

    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(secondInit.body)).toBe("grant_type=refresh_token&refresh_token=refresh-2");
  });

  it("clearing the token after it was set makes the source inert again", async () => {
    setSiNapToken("refresh-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({ access_token: "at-1", token_type: "bearer", expires_in: 3600 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await resolveSiNapHeaders(log);

    setSiNapToken(undefined);
    await expect(resolveSiNapHeaders(log)).rejects.toThrow(/not configured/i);
  });
});
