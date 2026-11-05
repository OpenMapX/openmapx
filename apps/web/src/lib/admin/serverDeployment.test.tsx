// @vitest-environment node
import { apiClient, configureApiClient } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSelfHosted } from "./serverDeployment";

vi.mock("@openmapx/core/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/server-api")>()),
  serverApiUrl: () => "http://server.test",
}));
const deployment = {
  selfHosted: true,
  dockerAvailable: false,
  hostControlConfigured: true,
  hostDir: null,
  composeRendered: false,
  infraDir: "/synthetic",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  configureApiClient({ baseUrl: "http://localhost:3001", credentials: "include" });
});
describe("request-scoped deployment", () => {
  it.each([
    "http://browser.test",
    "http://server.test.evil.test",
    "http://server.test:8080",
    "https://server.test",
  ])("isolates concurrent cookies and singleton authentication for %s", async (browserOrigin) => {
    configureApiClient({
      baseUrl: browserOrigin,
      headerInterceptor: () => ({ authorization: "synthetic-browser" }),
    });
    const requests: { url: string; init: RequestInit }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (new URL(url).origin === "http://server.test") {
        await gate;
        return Response.json({
          ...deployment,
          selfHosted: new Headers(init.headers).get("cookie") === "session=one",
        });
      }
      return Response.json({ browser: true });
    });
    const first = getSelfHosted("session=one");
    const second = getSelfHosted("session=two");
    release();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(await apiClient.get("/probe")).toEqual({ browser: true });
    expect(requests.map(({ url }) => url)).toEqual([
      "http://server.test/api/admin/deployment",
      "http://server.test/api/admin/deployment",
      `${browserOrigin}/probe`,
    ]);
    for (const [i, cookie] of ["session=one", "session=two"].entries()) {
      expect(Object.fromEntries(new Headers(requests[i].init.headers))).toEqual({
        accept: "application/json",
        cookie,
      });
      expect(requests[i].init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      });
    }
    expect(new Headers(requests[2].init.headers).get("cookie")).toBeNull();
    expect(new Headers(requests[2].init.headers).get("authorization")).toBe("synthetic-browser");
  });
  it.each([
    Response.json({ selfHosted: true }),
    Response.json({ error: "denied" }, { status: 403 }),
    new Response("invalid", { headers: { "content-type": "application/json" } }),
    Response.json(deployment, { headers: { "content-type": "text/plain" } }),
  ])("preserves unknown for malformed or failed deployment", async (response) => {
    vi.stubGlobal("fetch", async () => response.clone());
    expect(await getSelfHosted("session=one")).toBe(null);
  });
  it("aborts stalled body at 30 seconds, cancels/unlocks it and clears timers", async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    );
    const pending = getSelfHosted("session=one");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    expect(canceled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(null);
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
    expect((vi as typeof vi & { getTimerCount(): number }).getTimerCount()).toBe(0);
  });
});

it("returns unknown when the deployment headers fail or time out", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
  });
  const pending = getSelfHosted("session=one");
  await vi.advanceTimersByTimeAsync(29_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe(null);
  expect(signal?.aborted).toBe(true);
  expect((vi as typeof vi & { getTimerCount(): number }).getTimerCount()).toBe(0);
  vi.stubGlobal("fetch", async () => {
    throw new Error("synthetic acquisition failure");
  });
  expect(await getSelfHosted("session=one")).toBe(null);
});
