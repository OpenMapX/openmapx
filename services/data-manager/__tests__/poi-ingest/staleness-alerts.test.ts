import { describe, expect, it, vi } from "vitest";
import {
  buildPoiGithubIssueSink,
  detectStalePoiSources,
  emitPoiAlerts,
  type PoiAlert,
  type PoiAlertLogger,
  type PoiFeedStateReader,
  type PoiGithubIssueSink,
  poiGithubIssueTitle,
} from "../../src/jobs/poi-ingest/staleness-alerts.js";

/**
 * `detectStalePoiSources` reads `data_manager.poi_feed_state` via the
 * package-wide db handle. Each test passes a synthetic `db` argument that
 * mirrors the drizzle-postgres `.select().from(...)` chain so we can drive
 * the function without spinning up Postgres.
 */
type PoiFeedStateRow = {
  sourceId: string;
  domain: string;
  lastStaticIngestAt: Date | null;
  consecutiveFailures: number;
  lastError: { message?: string } | null;
};

function buildFakeDb(rows: PoiFeedStateRow[]): { handle: PoiFeedStateReader } {
  const fakeDb = {
    select(_columns: unknown) {
      return {
        from(_table: unknown) {
          return Promise.resolve(rows);
        },
      };
    },
  };
  return { handle: fakeDb as unknown as PoiFeedStateReader };
}

function buildLogger(): PoiAlertLogger & {
  infoCalls: Array<[string, Record<string, unknown> | undefined]>;
  warnCalls: Array<[string, Record<string, unknown> | undefined]>;
  errorCalls: Array<[string, Record<string, unknown> | undefined]>;
} {
  const infoCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const warnCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const errorCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    info: (msg, extra) => {
      infoCalls.push([msg, extra]);
    },
    warn: (msg, extra) => {
      warnCalls.push([msg, extra]);
    },
    error: (msg, extra) => {
      errorCalls.push([msg, extra]);
    },
    infoCalls,
    warnCalls,
    errorCalls,
  };
}

describe("detectStalePoiSources", () => {
  const NOW = new Date("2026-05-24T12:00:00Z");

  it("returns no alerts when every source is fresh and healthy", async () => {
    const fresh = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        sourceId: "bnetza-ev",
        domain: "ev-charging",
        lastStaticIngestAt: fresh,
        consecutiveFailures: 0,
        lastError: null,
      },
    ]);
    const alerts = await detectStalePoiSources({ db: handle, now: () => NOW });
    expect(alerts).toEqual([]);
  });

  it("emits a stale alert when last_static_ingest_at exceeds the threshold", async () => {
    const tooOld = new Date(NOW.getTime() - 72 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        sourceId: "bnetza-ev",
        domain: "ev-charging",
        lastStaticIngestAt: tooOld,
        consecutiveFailures: 0,
        lastError: null,
      },
    ]);
    const alerts = await detectStalePoiSources({ db: handle, now: () => NOW });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as PoiAlert;
    expect(alert.kind).toBe("stale");
    expect(alert.sourceId).toBe("bnetza-ev");
    expect(alert.threshold.hoursStale).toBe(48);
    expect(alert.detail.hoursStale).toBeGreaterThan(48);
  });

  it("ignores rows that have never been ingested (unknown, not stale)", async () => {
    const { handle } = buildFakeDb([
      {
        sourceId: "switzerland-ev",
        domain: "ev-charging",
        lastStaticIngestAt: null,
        consecutiveFailures: 0,
        lastError: null,
      },
    ]);
    const alerts = await detectStalePoiSources({ db: handle, now: () => NOW });
    expect(alerts).toEqual([]);
  });

  it("emits a consecutive-failures alert when the threshold is crossed", async () => {
    const fresh = new Date(NOW.getTime() - 1 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        sourceId: "utmc-newcastle",
        domain: "parking",
        lastStaticIngestAt: fresh,
        consecutiveFailures: 3,
        lastError: { message: "401 Unauthorized" },
      },
    ]);
    const alerts = await detectStalePoiSources({ db: handle, now: () => NOW });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as PoiAlert;
    expect(alert.kind).toBe("consecutive-failures");
    expect(alert.detail.consecutiveFailures).toBe(3);
    expect(alert.detail.lastErrorMessage).toBe("401 Unauthorized");
  });

  it("emits both alert kinds for a single source when both triggers cross", async () => {
    const tooOld = new Date(NOW.getTime() - 100 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        sourceId: "apag",
        domain: "parking",
        lastStaticIngestAt: tooOld,
        consecutiveFailures: 5,
        lastError: { message: "DNS lookup failed" },
      },
    ]);
    const alerts = await detectStalePoiSources({ db: handle, now: () => NOW });
    expect(alerts.map((a) => a.kind).sort()).toEqual(["consecutive-failures", "stale"]);
  });

  it("honours custom thresholds", async () => {
    const eightHoursAgo = new Date(NOW.getTime() - 8 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        sourceId: "bnetza-ev",
        domain: "ev-charging",
        lastStaticIngestAt: eightHoursAgo,
        consecutiveFailures: 1,
        lastError: null,
      },
    ]);
    const alerts = await detectStalePoiSources({
      db: handle,
      now: () => NOW,
      staleAfterHours: 4,
      failuresThreshold: 1,
    });
    expect(alerts.map((a) => a.kind).sort()).toEqual(["consecutive-failures", "stale"]);
  });
});

describe("emitPoiAlerts", () => {
  const alert: PoiAlert = {
    sourceId: "bnetza-ev",
    domain: "ev-charging",
    kind: "stale",
    threshold: { hoursStale: 48 },
    detail: { lastStaticIngestAt: "2026-05-20T00:00:00.000Z", hoursStale: 96 },
  };

  it("always emits a structured warn log line", async () => {
    const log = buildLogger();
    await emitPoiAlerts({ alerts: [alert], log });
    expect(log.warnCalls).toHaveLength(1);
    expect(log.warnCalls[0]?.[0]).toBe("poi-ingest alert");
    expect(log.warnCalls[0]?.[1]).toMatchObject({
      sourceId: "bnetza-ev",
      domain: "ev-charging",
      kind: "stale",
      hoursStale: 96,
    });
  });

  it("skips creation when an open GitHub issue already exists", async () => {
    const log = buildLogger();
    const githubIssue: PoiGithubIssueSink = {
      findOpenIssueByTitle: vi.fn().mockResolvedValue("https://github.com/x/y/issues/1"),
      createIssue: vi.fn().mockRejectedValue(new Error("should not be called")),
    };
    await emitPoiAlerts({ alerts: [alert], log, githubIssue });
    expect(githubIssue.findOpenIssueByTitle).toHaveBeenCalledWith(poiGithubIssueTitle(alert));
    expect(githubIssue.createIssue).not.toHaveBeenCalled();
    expect(log.infoCalls.some(([m]) => m.includes("existing GitHub issue"))).toBe(true);
  });

  it("creates a new issue when no open match exists", async () => {
    const log = buildLogger();
    const githubIssue: PoiGithubIssueSink = {
      findOpenIssueByTitle: vi.fn().mockResolvedValue(null),
      createIssue: vi.fn().mockResolvedValue("https://github.com/x/y/issues/2"),
    };
    await emitPoiAlerts({ alerts: [alert], log, githubIssue });
    expect(githubIssue.createIssue).toHaveBeenCalledTimes(1);
    const [title, body] = (githubIssue.createIssue as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    expect(title).toBe(poiGithubIssueTitle(alert));
    expect(body).toContain("- sourceId: `bnetza-ev`");
    expect(body).toContain("- kind: `stale`");
    expect(log.infoCalls.some(([m]) => m.includes("GitHub issue created"))).toBe(true);
  });

  it("logs but does not throw when the GitHub sink fails", async () => {
    const log = buildLogger();
    const githubIssue: PoiGithubIssueSink = {
      createIssue: vi.fn().mockRejectedValue(new Error("rate limited")),
    };
    await expect(emitPoiAlerts({ alerts: [alert], log, githubIssue })).resolves.toBeUndefined();
    expect(log.errorCalls.some(([m]) => m.includes("GitHub issue failed"))).toBe(true);
  });
});

describe("buildPoiGithubIssueSink", () => {
  it("returns null when either credential is missing", () => {
    expect(buildPoiGithubIssueSink(undefined, "x/y")).toBeNull();
    expect(buildPoiGithubIssueSink("tok", undefined)).toBeNull();
    expect(buildPoiGithubIssueSink("", "x/y")).toBeNull();
    expect(buildPoiGithubIssueSink("tok", "")).toBeNull();
  });

  it("returns a sink when both credentials are provided", () => {
    const sink = buildPoiGithubIssueSink("tok", "x/y");
    expect(sink).not.toBeNull();
    expect(typeof sink?.createIssue).toBe("function");
    expect(typeof sink?.findOpenIssueByTitle).toBe("function");
  });
});

describe("poiGithubIssueTitle", () => {
  it("stable title format for stale", () => {
    expect(
      poiGithubIssueTitle({
        sourceId: "bnetza-ev",
        domain: "ev-charging",
        kind: "stale",
        threshold: {},
        detail: {},
      }),
    ).toBe("Stale POI source: bnetza-ev");
  });

  it("stable title format for consecutive-failures", () => {
    expect(
      poiGithubIssueTitle({
        sourceId: "utmc-newcastle",
        domain: "parking",
        kind: "consecutive-failures",
        threshold: {},
        detail: {},
      }),
    ).toBe("Failing POI source: utmc-newcastle");
  });
});
