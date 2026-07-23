import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDeOcpdbLive } from "../de-ocpdb-live-parser.js";

const sourcesSeed = readFileSync(
  fileURLToPath(new URL("./fixtures/de-ocpdb-sources.json", import.meta.url)),
);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function stubPerSource(perSource: Record<string, unknown[]>) {
  const fetchMock = vi.fn(async (url: string) => {
    const m = url.match(/source_uid=([^&]+)/);
    const items = m ? (perSource[decodeURIComponent(m[1])] ?? []) : [];
    return new Response(JSON.stringify({ items, next_offset: null }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("parseDeOcpdbLive", () => {
  it("derives realtime sources, skips bnetza, and maps availability", async () => {
    const fetchMock = stubPerSource({
      datex2_enbw: [{ id: "42", evses: [{ status: "AVAILABLE" }, { status: "CHARGING" }] }],
    });
    const map = await parseDeOcpdbLive(sourcesSeed, { log });
    vi.unstubAllGlobals();
    // bnetza_api is static-only and must never be fetched.
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("bnetza_api"))).toBe(true);
    expect(map.get("42")).toMatchObject({ status: "operational", available: 1, total: 2 });
  });

  it("omits counts when every EVSE status is unknown (STATIC)", async () => {
    stubPerSource({ datex2_enbw: [{ id: "7", evses: [{ status: "STATIC" }] }] });
    const map = await parseDeOcpdbLive(sourcesSeed, { log });
    vi.unstubAllGlobals();
    expect(map.get("7")?.status).toBe("unknown");
    expect(map.get("7")).not.toHaveProperty("available");
  });

  it("throws (rather than wiping the hash) on an unparseable /sources seed", async () => {
    stubPerSource({});
    await expect(parseDeOcpdbLive(Buffer.from("not json"), { log })).rejects.toThrow(
      /no realtime sources/,
    );
    vi.unstubAllGlobals();
  });

  it("throws when every realtime source pages to zero locations", async () => {
    stubPerSource({});
    await expect(parseDeOcpdbLive(sourcesSeed, { log })).rejects.toThrow(/zero locations/);
    vi.unstubAllGlobals();
  });
});
