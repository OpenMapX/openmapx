import { describe, expect, it, vi } from "vitest";
import type { GithubIssueSink } from "../../src/jobs/github-issue-sink.js";
import {
  type AlertLogger,
  detectStaleFeeds,
  emitFeedAlerts,
  emitPipelineFailureAlert,
  type FeedAlert,
  type FeedStateReader,
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
  debugCalls: Array<[string, Record<string, unknown> | undefined]>;
} {
  const infoCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const warnCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const errorCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  const debugCalls: Array<[string, Record<string, unknown> | undefined]> = [];
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
    debug: (msg, extra) => {
      debugCalls.push([msg, extra]);
    },
    infoCalls,
    warnCalls,
    errorCalls,
    debugCalls,
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

describe("emitPipelineFailureAlert", () => {
  it("logs and opens a GitHub issue when a sync run fails", async () => {
    const log = buildLogger();
    const created: Array<{ title: string; body: string }> = [];
    const sink: GithubIssueSink = {
      findOpenIssueByTitle: async () => null,
      createIssue: async (title, body) => {
        created.push({ title, body });
        return "https://github.com/foo/bar/issues/9";
      },
    };
    await emitPipelineFailureAlert({
      alert: {
        trigger: "cron",
        jobId: "job-1",
        failedStage: "motis-health",
        reason: "rentals empty",
      },
      log,
      githubIssue: sink,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toContain("cron");
    expect(created[0]?.body).toContain("motis-health");
    expect(created[0]?.body).toContain("rentals empty");
    expect(log.errorCalls).toHaveLength(1);
  });

  it("dedupes against an already-open issue rather than filing a new one each run", async () => {
    const log = buildLogger();
    let createCalls = 0;
    const sink: GithubIssueSink = {
      findOpenIssueByTitle: async () => "https://github.com/foo/bar/issues/1",
      createIssue: async () => {
        createCalls++;
        return "https://github.com/foo/bar/issues/2";
      },
    };
    await emitPipelineFailureAlert({
      alert: { trigger: "cron", jobId: "job-2", reason: "boom" },
      log,
      githubIssue: sink,
    });
    expect(createCalls).toBe(0);
  });

  it("logs even without a GitHub sink configured", async () => {
    const log = buildLogger();
    await emitPipelineFailureAlert({
      alert: { trigger: "auto-bump", jobId: "job-3", reason: "canary rejected candidate" },
      log,
    });
    expect(log.errorCalls).toHaveLength(1);
  });

  it("does not publish a credential-bearing URL into the issue body", async () => {
    const log = buildLogger();
    const created: Array<{ title: string; body: string }> = [];
    const sink: GithubIssueSink = {
      findOpenIssueByTitle: async () => null,
      createIssue: async (title, body) => {
        created.push({ title, body });
        return "https://github.com/foo/bar/issues/10";
      },
    };
    await emitPipelineFailureAlert({
      alert: {
        trigger: "cron",
        jobId: "job-4",
        reason:
          "Command failed with exit code 8: curl 'https://feeds.example.org/gtfs.zip?api-key=FAKEKEY123'",
      },
      log,
      githubIssue: sink,
    });
    expect(created).toHaveLength(1);
    const body = created[0]?.body ?? "";
    expect(body).not.toContain("FAKEKEY123");
    expect(body).not.toContain("api-key=");
    expect(body).toContain("feeds.example.org");
  });

  it("does not publish git userinfo credentials into the issue body", async () => {
    const log = buildLogger();
    const created: Array<{ title: string; body: string }> = [];
    const sink: GithubIssueSink = {
      findOpenIssueByTitle: async () => null,
      createIssue: async (title, body) => {
        created.push({ title, body });
        return "https://github.com/foo/bar/issues/11";
      },
    };
    await emitPipelineFailureAlert({
      alert: {
        trigger: "auto-bump",
        jobId: "job-5",
        reason:
          "Command failed with exit code 128: git clone https://oauth2:FAKETOKEN@github.com/acme/catalog.git",
      },
      log,
      githubIssue: sink,
    });
    expect(created).toHaveLength(1);
    const body = created[0]?.body ?? "";
    expect(body).not.toContain("FAKETOKEN");
    expect(body).toContain("github.com");
  });

  it("scrubs the reason on the structured log line too", async () => {
    const log = buildLogger();
    await emitPipelineFailureAlert({
      alert: {
        trigger: "cron",
        jobId: "job-6",
        reason: "curl https://feeds.example.org/x.zip?token=FAKELOGTOKEN",
      },
      log,
    });
    const [, extra] = log.errorCalls[0] as [string, Record<string, unknown>];
    expect(extra.reason).not.toContain("FAKELOGTOKEN");
  });

  it("keeps the unscrubbed reason available at debug level", async () => {
    const log = buildLogger();
    await emitPipelineFailureAlert({
      alert: {
        trigger: "cron",
        jobId: "job-7",
        reason: "curl https://feeds.example.org/x.zip?token=FAKEDEBUGTOKEN",
      },
      log,
    });
    expect(log.debugCalls).toHaveLength(1);
    const [, debugExtra] = log.debugCalls[0] as [string, Record<string, unknown>];
    const [, errorExtra] = log.errorCalls[0] as [string, Record<string, unknown>];
    expect(debugExtra.reason).toContain("FAKEDEBUGTOKEN");
    expect(errorExtra.reason).not.toContain("FAKEDEBUGTOKEN");
  });

  it("leaves a reason with no credentials byte-identical", async () => {
    const log = buildLogger();
    const created: Array<{ title: string; body: string }> = [];
    const sink: GithubIssueSink = {
      findOpenIssueByTitle: async () => null,
      createIssue: async (title, body) => {
        created.push({ title, body });
        return "https://github.com/foo/bar/issues/12";
      },
    };
    await emitPipelineFailureAlert({
      alert: {
        trigger: "cron",
        jobId: "job-8",
        reason: "motis-health probe returned zero rentals",
      },
      log,
      githubIssue: sink,
    });
    expect(created[0]?.body).toContain("motis-health probe returned zero rentals");
  });

  it("scrubs validationMessage in the per-feed issue body", async () => {
    const log = buildLogger();
    const created: Array<{ title: string; body: string }> = [];
    const sink: GithubIssueSink = {
      findOpenIssueByTitle: async () => null,
      createIssue: async (title, body) => {
        created.push({ title, body });
        return "https://github.com/foo/bar/issues/13";
      },
    };
    await emitFeedAlerts({
      alerts: [
        {
          region: "de",
          name: "vbb",
          kind: "consecutive-failures",
          threshold: { consecutiveFailures: 3 },
          detail: {
            consecutiveFailures: 3,
            validationMessage: "fetch failed: https://feeds.example.org/x.zip?token=FAKEFEEDTOKEN",
          },
        },
      ],
      log,
      githubIssue: sink,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.body).not.toContain("FAKEFEEDTOKEN");
  });
});
