import { describe, expect, it, vi } from "vitest";
import { parseDeOcpdbLive } from "../de-ocpdb-live-parser.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function seedPage(items: unknown[]) {
  return Buffer.from(JSON.stringify({ items, next_offset: null }));
}

describe("parseDeOcpdbLive", () => {
  it("maps AVAILABLE/CHARGING to operational and counts availability", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const map = await parseDeOcpdbLive(
      seedPage([{ id: "42", evses: [{ status: "AVAILABLE" }, { status: "CHARGING" }] }]),
      { log },
    );
    vi.unstubAllGlobals();
    const state = map.get("42");
    expect(state?.status).toBe("operational");
    expect(state).toMatchObject({ available: 1, total: 2 });
  });

  it("omits counts when every EVSE status is unknown (STATIC)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const map = await parseDeOcpdbLive(seedPage([{ id: "7", evses: [{ status: "STATIC" }] }]), {
      log,
    });
    vi.unstubAllGlobals();
    const state = map.get("7");
    expect(state?.status).toBe("unknown");
    expect(state).not.toHaveProperty("available");
  });
});
