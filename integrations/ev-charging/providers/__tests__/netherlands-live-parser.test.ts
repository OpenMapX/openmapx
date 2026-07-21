import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDotNlLive } from "../netherlands-live-parser.js";

const LIVE_FIXTURE = readFileSync(join(__dirname, "fixtures", "netherlands-live-sample.json"));

const noopLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe("parseDotNlLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces one PoiLiveState per location keyed by the composite country+party+id poiId", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    expect(out.size).toBe(7);
    expect(out.has(encodeURIComponent("NL*MIX*live-station-mixed"))).toBe(true);
    expect(out.has(encodeURIComponent("NL*OOO*live-station-outoforder"))).toBe(true);
  });

  it("keeps locations that share a location.id but differ by party_id distinct (matches the static parser's dedupe-safe key)", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    expect(out.has(encodeURIComponent("NL*MIX*live-station-mixed"))).toBe(true);
    expect(out.has(encodeURIComponent("NL*OTHER*live-station-mixed"))).toBe(true);
  });

  it("counts AVAILABLE toward available and every EVSE toward total, including UNKNOWN", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*MIX*live-station-mixed"));
    expect(state?.total).toBe(3);
    expect(state?.available).toBe(1);
    expect(state?.status).toBe("operational");
  });

  it("aggregates OUTOFORDER/REMOVED to not-operational with zero available", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*OOO*live-station-outoforder"));
    expect(state?.status).toBe("not-operational");
    expect(state?.available).toBe(0);
    // The REMOVED evse is excluded from `total` — only the OUTOFORDER evse
    // still counts as a physical EVSE at this location.
    expect(state?.total).toBe(1);
  });

  it("excludes REMOVED EVSEs from total while still counting AVAILABLE/CHARGING", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*REM*live-station-removed"));
    expect(state?.available).toBe(1);
    expect(state?.total).toBe(2);
    expect(state?.status).toBe("operational");
  });

  it("stamps asOf with the current parse time, ignoring the location's (potentially stale) last_updated", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*MIX*live-station-mixed"));
    // The fixture's last_updated ("2026-07-20T18:00:00Z") must NOT leak through —
    // the DOT-NL locations file is a bulk snapshot re-fetched every 15 min, so
    // the EVSE statuses are only as fresh as OUR poll, not the CPO's last edit.
    expect(state?.asOf).toBe("2026-07-21T12:00:00.000Z");
  });

  it("stamps every row with the same parse-time asOf even when last_updated is missing", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*NOT*live-station-no-timestamp"));
    expect(state?.asOf).toBe("2026-07-21T12:00:00.000Z");
  });

  it("reports status unknown and omits available/total for a location with no EVSEs", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*NOE*live-station-no-evses"));
    expect(state?.status).toBe("unknown");
    expect(state?.total).toBeUndefined();
    expect(state?.available).toBeUndefined();
  });

  it("reports status unknown and omits available/total when every EVSE has an unrecognized status", async () => {
    const out = await parseDotNlLive(LIVE_FIXTURE, { log: noopLog });
    const state = out.get(encodeURIComponent("NL*UNK*live-station-all-unknown"));
    expect(state?.status).toBe("unknown");
    expect(state?.total).toBeUndefined();
    expect(state?.available).toBeUndefined();
    expect(state?.asOf).toBe("2026-07-21T12:00:00.000Z");
  });
});
