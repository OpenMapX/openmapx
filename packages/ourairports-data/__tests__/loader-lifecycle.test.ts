import type { Logger } from "@openmapx/integration-framework";
import {
  type FakeHttpRequest,
  fakeHttpClient,
  httpStatus,
} from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Loader = typeof import("../loader.js");

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} satisfies Logger;

const DAY_MS = 24 * 60 * 60 * 1000;

const CSV: Record<string, string> = {
  "airports.csv": [
    "id,ident,type,name,latitude_deg,longitude_deg,iata_code",
    "1,EDDF,large_airport,Frankfurt am Main,50.03,8.57,FRA",
  ].join("\n"),
  "runways.csv": "airport_ref,le_ident,length_ft",
  "airport-frequencies.csv": "airport_ref,type,frequency_mhz",
  "navaids.csv": "associated_airport,ident,type",
};

function csvClient(answer: (req: FakeHttpRequest, file: string) => unknown) {
  return fakeHttpClient((req) => answer(req, req.url.split("/").pop() ?? ""));
}

let loader: Loader;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  loader = await import("../loader.js");
});

afterEach(() => {
  loader.stopBackgroundLoad();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OurAirports background load", () => {
  it("keeps the shared refresh timer alive until every generation owner releases it", () => {
    const pending = fakeHttpClient(() => new Promise(() => {}));
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const releaseOldGeneration = loader.startBackgroundLoad(pending, log);
    const releaseNewGeneration = loader.startBackgroundLoad(pending, log);

    releaseOldGeneration();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    releaseNewGeneration();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("loads nothing before an owner registers", async () => {
    expect(await loader.getStore(log)).toBeNull();
  });

  it("reads bounded CSV text through the owner's client", async () => {
    const http = csvClient((_req, file) => ({ status: 200, headers: {}, body: CSV[file] }));
    loader.startBackgroundLoad(http, log);

    const store = await loader.getStore(log);

    expect(store?.byIata.get("FRA")?.name).toBe("Frankfurt am Main");
    expect(http.calls.map((call) => call.url.split("/").pop()).sort()).toEqual([
      "airport-frequencies.csv",
      "airports.csv",
      "navaids.csv",
      "runways.csv",
    ]);
    expect(http.calls[0]?.options).toMatchObject({
      maxBytes: 64 * 1024 * 1024,
      contentTypes: ["text/csv", "text/plain"],
      responseHeaders: ["etag", "last-modified"],
    });
  });

  it("revalidates with the same generation's validators and starts afresh after a reload", async () => {
    let first = true;
    const http = csvClient((req, file) => {
      if (!first && req.options?.headers?.["If-None-Match"] === `"${file}"`) {
        return httpStatus(304);
      }
      return { status: 200, headers: { etag: `"${file}"` }, body: CSV[file] };
    });
    const release = loader.startBackgroundLoad(http, log);
    await loader.getStore(log);
    first = false;

    await vi.advanceTimersByTimeAsync(DAY_MS);
    const refreshed = await loader.getStore(log);

    expect(refreshed?.byIata.get("FRA")?.name).toBe("Frankfurt am Main");
    expect(http.calls).toHaveLength(8);
    for (const call of http.calls.slice(4)) {
      expect(call.options?.headers?.["If-None-Match"]).toBe(`"${call.url.split("/").pop()}"`);
    }

    const reloaded = csvClient((_req, file) => ({ status: 200, headers: {}, body: CSV[file] }));
    loader.startBackgroundLoad(reloaded, log);
    release();
    await vi.advanceTimersByTimeAsync(DAY_MS);
    await loader.getStore(log);

    expect(http.calls).toHaveLength(8);
    expect(reloaded.calls).toHaveLength(4);
    for (const call of reloaded.calls) expect(call.options?.headers).toEqual({});
  });

  it("keeps the previous data when a refresh fails", async () => {
    let fail = false;
    const http = csvClient((_req, file) =>
      fail ? httpStatus(503) : { status: 200, headers: {}, body: CSV[file] },
    );
    loader.startBackgroundLoad(http, log);
    const loaded = await loader.getStore(log);
    fail = true;

    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(await loader.getStore(log)).toBe(loaded);
    expect(log.warn).toHaveBeenCalledWith(
      "ourairports-data: failed to load CSV data: OurAirports CSV HTTP 503",
    );
  });
});
