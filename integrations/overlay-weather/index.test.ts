import {
  createMockIntegrationContext,
  createPassthroughCache,
} from "@openmapx/integration-framework/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
}));

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchJson: coreMocks.fetchJson,
  };
});

import { canonicalizeRainViewerHost, setup } from "./index.js";

interface Sent {
  status: number;
  body: unknown;
}

async function callRadarMeta(host: string) {
  coreMocks.fetchJson.mockResolvedValue({
    host,
    radar: {
      past: [{ time: 1, path: "/v2/radar/1" }],
      nowcast: [],
    },
  });
  const cacheSet = vi.fn(async () => undefined);
  const cache = { ...createPassthroughCache(), set: cacheSet };
  const ctx = createMockIntegrationContext({ cache });
  setup(ctx);
  const route = ctx.registered.routes.find((candidate) => candidate.path === "/radar/meta");
  if (!route) throw new Error("no /radar/meta route");

  const sent: Sent = { status: 200, body: undefined };
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  await route.handler({ query: {}, params: {}, headers: {} } as never, reply as never);
  return { cacheSet, sent };
}

beforeEach(() => {
  coreMocks.fetchJson.mockReset();
});

describe("RainViewer metadata host", () => {
  it.each([
    ["https://rainviewer.com", "https://rainviewer.com"],
    ["https://RAINVIEWER.COM/", "https://rainviewer.com"],
    ["https://tilecache.rainviewer.com", "https://tilecache.rainviewer.com"],
    ["https://EU.TILECACHE.RAINVIEWER.COM:443/", "https://eu.tilecache.rainviewer.com"],
  ])("canonicalizes the trusted HTTPS origin %s", (input, expected) => {
    expect(canonicalizeRainViewerHost(input)).toBe(expected);
  });

  it.each([
    "http://rainviewer.com",
    "https://user:secret@rainviewer.com",
    "https://rainviewer.com:8443",
    "https://rainviewer.com/tiles",
    "https://rainviewer.com?target=attacker.example",
    "https://rainviewer.com#attacker.example",
    "https://attacker.example",
    "https://rainviewer.com.attacker.example",
    "https://notrainviewer.com",
  ])("rejects the untrusted or non-origin value %s", (input) => {
    expect(canonicalizeRainViewerHost(input)).toBeNull();
  });

  it("caches only the canonical trusted origin", async () => {
    const { cacheSet, sent } = await callRadarMeta("https://EU.TILECACHE.RAINVIEWER.COM:443/");

    expect(sent).toMatchObject({
      status: 200,
      body: { host: "https://eu.tilecache.rainviewer.com" },
    });
    expect(cacheSet).toHaveBeenCalledWith(
      "weather:radar:meta",
      expect.objectContaining({ host: "https://eu.tilecache.rainviewer.com" }),
      300,
    );
  });

  it("rejects metadata with an untrusted host before caching", async () => {
    const { cacheSet, sent } = await callRadarMeta("https://rainviewer.com.attacker.example");

    expect(sent).toEqual({ status: 502, body: { message: "RainViewer unavailable" } });
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
