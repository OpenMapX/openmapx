// @vitest-environment node
import { apiClient, configureApiClient } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSelfHosted } from "./serverDeployment";

vi.mock("@openmapx/core/server-api", () => ({ serverApiUrl: () => "http://server.test" }));
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
  it("isolates concurrent cookies and never changes singleton authentication", async () => {
    configureApiClient({
      baseUrl: "http://browser.test",
      headerInterceptor: () => ({ authorization: "synthetic-browser" }),
    });
    const requests: { url: string; init: RequestInit }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.startsWith("http://server.test")) {
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
      "http://browser.test/probe",
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
  ])("fails closed for malformed or failed deployment", async (response) => {
    vi.stubGlobal("fetch", async () => response.clone());
    expect(await getSelfHosted("session=one")).toBe(false);
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
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(false);
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
    expect((vi as typeof vi & { getTimerCount(): number }).getTimerCount()).toBe(0);
  });
});

it("returns false when the deployment headers fail or time out", async () => {
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
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toBe(false);
  expect(signal?.aborted).toBe(true);
  expect((vi as typeof vi & { getTimerCount(): number }).getTimerCount()).toBe(0);
  vi.stubGlobal("fetch", async () => {
    throw new Error("synthetic acquisition failure");
  });
  expect(await getSelfHosted("session=one")).toBe(false);
});
