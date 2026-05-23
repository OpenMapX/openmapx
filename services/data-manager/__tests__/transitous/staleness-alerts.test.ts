import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AlertLogger,
  buildGithubIssueSink,
  detectStaleFeeds,
  emitFeedAlerts,
  type FeedAlert,
  type FeedStateReader,
  type GithubIssueSink,
  githubIssueTitle,
} from "../../src/jobs/transitous/staleness-alerts.js";

/**
 * `detectStaleFeeds` reads `data_manager.feed_state` via the package-wide db
 * handle. Each test passes a synthetic `db` argument that mirrors the
 * drizzle-postgres `.select().from(...)` chain so we can drive the function
 * without spinning up Postgres.
 */
type FeedStateRow = {
  region: string;
  name: string;
  lastFetchedAt: Date | null;
  validationMessage: string | null;
  consecutiveFailures: number;
};

function buildFakeDb(rows: FeedStateRow[]): { handle: FeedStateReader } {
  const fakeDb = {
    select(_columns: unknown) {
      return {
        from(_table: unknown) {
          return Promise.resolve(rows);
        },
      };
    },
  };
  return { handle: fakeDb as unknown as FeedStateReader };
}

function buildLogger(): AlertLogger & {
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

describe("detectStaleFeeds", () => {
  const NOW = new Date("2026-05-23T12:00:00Z");

  it("returns no alerts when every feed is fresh", async () => {
    const fresh = new Date(NOW.getTime() - 2 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        region: "de",
        name: "vbb",
        lastFetchedAt: fresh,
        validationMessage: null,
        consecutiveFailures: 0,
      },
      {
        region: "ch",
        name: "sbb",
        lastFetchedAt: fresh,
        validationMessage: null,
        consecutiveFailures: 0,
      },
    ]);
    const alerts = await detectStaleFeeds({ db: handle, now: () => NOW });
    expect(alerts).toEqual([]);
  });

  it("flags a feed older than the staleness window", async () => {
    const stale = new Date(NOW.getTime() - 51 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        region: "de",
        name: "vbb",
        lastFetchedAt: stale,
        validationMessage: null,
        consecutiveFailures: 0,
      },
    ]);
    const alerts = await detectStaleFeeds({ db: handle, now: () => NOW });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as FeedAlert;
    expect(alert.kind).toBe("stale");
    expect(alert.region).toBe("de");
    expect(alert.name).toBe("vbb");
    expect(alert.threshold.hoursStale).toBe(48);
    expect(alert.detail.hoursStale).toBeCloseTo(51, 0);
  });

  it("flags a feed at the consecutive-failure threshold", async () => {
    const { handle } = buildFakeDb([
      {
        region: "de",
        name: "vbb",
        lastFetchedAt: new Date(NOW.getTime() - 3 * 3600 * 1000),
        validationMessage: "missing feed_info.txt",
        consecutiveFailures: 3,
      },
    ]);
    const alerts = await detectStaleFeeds({ db: handle, now: () => NOW });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as FeedAlert;
    expect(alert.kind).toBe("consecutive-failures");
    expect(alert.detail.consecutiveFailures).toBe(3);
    expect(alert.detail.validationMessage).toBe("missing feed_info.txt");
  });

  it("emits both alert kinds for a feed that is both stale AND failing", async () => {
    const stale = new Date(NOW.getTime() - 72 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        region: "fr",
        name: "ratp",
        lastFetchedAt: stale,
        validationMessage: "archive is empty",
        consecutiveFailures: 5,
      },
    ]);
    const alerts = await detectStaleFeeds({ db: handle, now: () => NOW });
    const kinds = alerts.map((alert) => alert.kind).sort();
    expect(kinds).toEqual(["consecutive-failures", "stale"]);
  });

  it("does not flag a feed with no lastFetchedAt (unknown state)", async () => {
    const { handle } = buildFakeDb([
      {
        region: "de",
        name: "vbb",
        lastFetchedAt: null,
        validationMessage: null,
        consecutiveFailures: 0,
      },
    ]);
    const alerts = await detectStaleFeeds({ db: handle, now: () => NOW });
    expect(alerts).toEqual([]);
  });

  it("honours custom thresholds", async () => {
    const stale = new Date(NOW.getTime() - 26 * 3600 * 1000);
    const { handle } = buildFakeDb([
      {
        region: "de",
        name: "vbb",
        lastFetchedAt: stale,
        validationMessage: null,
        consecutiveFailures: 2,
      },
    ]);
    const alerts = await detectStaleFeeds({
      db: handle,
      staleAfterHours: 24,
      failuresThreshold: 2,
      now: () => NOW,
    });
    expect(alerts.map((alert) => alert.kind).sort()).toEqual(["consecutive-failures", "stale"]);
  });
});

describe("emitFeedAlerts", () => {
  const SAMPLE_ALERT: FeedAlert = {
    region: "de",
    name: "vbb",
    kind: "stale",
    threshold: { hoursStale: 48 },
    detail: { lastFetchedAt: "2026-05-21T09:00:00.000Z", hoursStale: 51 },
  };

  it("writes one structured warn line per alert", async () => {
    const log = buildLogger();
    await emitFeedAlerts({ alerts: [SAMPLE_ALERT], log });
    expect(log.warnCalls).toHaveLength(1);
    const [msg, extra] = log.warnCalls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("transit feed alert");
    expect(extra.region).toBe("de");
    expect(extra.name).toBe("vbb");
    expect(extra.kind).toBe("stale");
  });

  it("does nothing when there are no alerts", async () => {
    const log = buildLogger();
    await emitFeedAlerts({ alerts: [], log });
    expect(log.warnCalls).toEqual([]);
    expect(log.infoCalls).toEqual([]);
  });

  it("creates a GitHub issue when the sink is provided and no open one matches", async () => {
    const log = buildLogger();
    const createIssue = vi.fn(async () => "https://github.com/openmapx/openmapx/issues/1");
    const findOpenIssueByTitle = vi.fn(async () => null);
    const sink: GithubIssueSink = { createIssue, findOpenIssueByTitle };
    await emitFeedAlerts({ alerts: [SAMPLE_ALERT], log, githubIssue: sink });
    expect(findOpenIssueByTitle).toHaveBeenCalledTimes(1);
    expect(findOpenIssueByTitle).toHaveBeenCalledWith("Stale transit feed: de/vbb");
    expect(createIssue).toHaveBeenCalledTimes(1);
    const createInfo = log.infoCalls.find(([msg]) => msg.includes("GitHub issue created"));
    expect(createInfo).toBeDefined();
  });

  it("skips creation when an open issue with the same title already exists", async () => {
    const log = buildLogger();
    const createIssue = vi.fn(async () => "ignored");
    const findOpenIssueByTitle = vi.fn(async () => "https://github.com/openmapx/openmapx/issues/9");
    const sink: GithubIssueSink = { createIssue, findOpenIssueByTitle };
    await emitFeedAlerts({ alerts: [SAMPLE_ALERT], log, githubIssue: sink });
    expect(findOpenIssueByTitle).toHaveBeenCalledTimes(1);
    expect(createIssue).not.toHaveBeenCalled();
    const skipInfo = log.infoCalls.find(([msg]) => msg.includes("existing GitHub issue"));
    expect(skipInfo).toBeDefined();
  });

  it("logs an error and continues when the GitHub sink throws", async () => {
    const log = buildLogger();
    const createIssue = vi.fn(async () => {
      throw new Error("boom");
    });
    const sink: GithubIssueSink = { createIssue };
    await emitFeedAlerts({ alerts: [SAMPLE_ALERT], log, githubIssue: sink });
    expect(log.errorCalls).toHaveLength(1);
    const [errMsg, errExtra] = log.errorCalls[0] as [string, Record<string, unknown>];
    expect(errMsg).toContain("GitHub issue failed");
    expect(errExtra.err).toBe("boom");
  });

  it("uses kind-specific issue title prefixes", () => {
    expect(githubIssueTitle({ ...SAMPLE_ALERT, kind: "stale" })).toBe("Stale transit feed: de/vbb");
    expect(githubIssueTitle({ ...SAMPLE_ALERT, kind: "consecutive-failures" })).toBe(
      "Failing transit feed: de/vbb",
    );
  });
});

describe("buildGithubIssueSink", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when token or repo is missing", () => {
    expect(buildGithubIssueSink(undefined, "openmapx/openmapx")).toBeNull();
    expect(buildGithubIssueSink("t", undefined)).toBeNull();
    expect(buildGithubIssueSink("", "openmapx/openmapx")).toBeNull();
  });

  it("returns a sink that hits the GitHub REST API when both are set", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ html_url: "https://github.com/foo/bar/issues/2" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const sink = buildGithubIssueSink("tok", "foo/bar");
    expect(sink).not.toBeNull();
    if (!sink) return;
    const existing = await sink.findOpenIssueByTitle?.("Stale transit feed: de/vbb");
    expect(existing).toBeNull();
    const url = await sink.createIssue("Stale transit feed: de/vbb", "body");
    expect(url).toBe("https://github.com/foo/bar/issues/2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("missing first fetch call");
    expect(firstCall[0]).toContain("/repos/foo/bar/issues?state=open");
  });
});
