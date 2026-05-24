import { poiFeedState } from "@openmapx/db-schema";
import { db as defaultDb } from "../../db/index.js";

/**
 * Per-POI-source staleness + consecutive-failure alerting.
 *
 * Mirrors the transitous staleness-alert contract (see
 * `services/data-manager/src/jobs/transitous/staleness-alerts.ts`) so operators
 * get the same UX — structured log line per alert and an optional GitHub
 * Issue per (sourceId, kind).
 *
 * Two triggers:
 *   - `stale`: `last_static_ingest_at` is older than `staleAfterHours`
 *     (default 48h — most POI feeds refresh at least daily; 48h gives two
 *     missed runs of grace before alerting).
 *   - `consecutive-failures`: `consecutive_failures >= failuresThreshold`
 *     (default 3).
 *
 * Output:
 *   - Always: a structured log line per alert (warn level).
 *   - Optional: a GitHub Issue per alert when the `githubIssue` sink is
 *     supplied. The sink is expected to dedupe by title.
 */

export type PoiAlertKind = "stale" | "consecutive-failures";

export interface PoiAlert {
  sourceId: string;
  domain: string;
  kind: PoiAlertKind;
  threshold: { hoursStale?: number; consecutiveFailures?: number };
  detail: {
    lastStaticIngestAt?: string;
    hoursStale?: number;
    consecutiveFailures?: number;
    lastErrorMessage?: string;
  };
}

export interface PoiAlertLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface PoiGithubIssueSink {
  createIssue: (title: string, body: string) => Promise<string>;
  findOpenIssueByTitle?: (title: string) => Promise<string | null>;
}

/**
 * Structural alias matching the slice of Drizzle the detector uses. Keeps
 * the test surface a hand-rolled stub rather than a full Drizzle mock.
 */
export type PoiFeedStateReader = {
  select: (columns: {
    sourceId: typeof poiFeedState.sourceId;
    domain: typeof poiFeedState.domain;
    lastStaticIngestAt: typeof poiFeedState.lastStaticIngestAt;
    consecutiveFailures: typeof poiFeedState.consecutiveFailures;
    lastError: typeof poiFeedState.lastError;
  }) => {
    from: (table: typeof poiFeedState) => PromiseLike<
      Array<{
        sourceId: string;
        domain: string;
        lastStaticIngestAt: Date | null;
        consecutiveFailures: number;
        lastError: { message?: string } | null;
      }>
    >;
  };
};

export interface DetectStalePoiSourcesOptions {
  db?: PoiFeedStateReader;
  staleAfterHours?: number;
  failuresThreshold?: number;
  now?: () => Date;
}

export interface EmitPoiAlertsOptions {
  alerts: PoiAlert[];
  log: PoiAlertLogger;
  githubIssue?: PoiGithubIssueSink;
}

const DEFAULT_STALE_AFTER_HOURS = 48;
const DEFAULT_FAILURES_THRESHOLD = 3;

/**
 * Scan `data_manager.poi_feed_state` and surface every row that crossed
 * either threshold. A single source can produce both kinds (very stale AND
 * repeatedly failing) — each kind generates its own `PoiAlert` so downstream
 * dedup keys on `(sourceId, kind)`.
 */
export async function detectStalePoiSources(
  opts: DetectStalePoiSourcesOptions = {},
): Promise<PoiAlert[]> {
  const handle: PoiFeedStateReader = opts.db ?? (defaultDb as unknown as PoiFeedStateReader);
  const staleAfterHours = opts.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;
  const failuresThreshold = opts.failuresThreshold ?? DEFAULT_FAILURES_THRESHOLD;
  const now = opts.now ? opts.now() : new Date();

  const rows = await handle
    .select({
      sourceId: poiFeedState.sourceId,
      domain: poiFeedState.domain,
      lastStaticIngestAt: poiFeedState.lastStaticIngestAt,
      consecutiveFailures: poiFeedState.consecutiveFailures,
      lastError: poiFeedState.lastError,
    })
    .from(poiFeedState);

  const alerts: PoiAlert[] = [];
  const staleCutoffMs = now.getTime() - staleAfterHours * 3600 * 1000;

  for (const row of rows) {
    // Trigger 1: stale. A row that has never recorded an ingest yet is
    // `unknown` rather than stale — bootstrap covers the first-deploy case.
    if (row.lastStaticIngestAt) {
      const ingestedMs = new Date(row.lastStaticIngestAt).getTime();
      if (ingestedMs < staleCutoffMs) {
        const hoursStale = (now.getTime() - ingestedMs) / 3600 / 1000;
        alerts.push({
          sourceId: row.sourceId,
          domain: row.domain,
          kind: "stale",
          threshold: { hoursStale: staleAfterHours },
          detail: {
            lastStaticIngestAt: new Date(row.lastStaticIngestAt).toISOString(),
            hoursStale: Math.round(hoursStale * 10) / 10,
          },
        });
      }
    }

    // Trigger 2: consecutive validation failures.
    if (row.consecutiveFailures >= failuresThreshold) {
      alerts.push({
        sourceId: row.sourceId,
        domain: row.domain,
        kind: "consecutive-failures",
        threshold: { consecutiveFailures: failuresThreshold },
        detail: {
          consecutiveFailures: row.consecutiveFailures,
          lastErrorMessage: row.lastError?.message,
        },
      });
    }
  }

  return alerts;
}

/**
 * Emit every alert through the configured sinks. The log sink runs first
 * unconditionally so warnings reach centralized logging even without GitHub
 * credentials. The GitHub sink is opt-in: without `POI_INGEST_ALERT_GH_TOKEN`
 * + `POI_INGEST_ALERT_GH_REPO` the caller passes no `githubIssue` argument.
 */
export async function emitPoiAlerts(opts: EmitPoiAlertsOptions): Promise<void> {
  for (const alert of opts.alerts) {
    const base = {
      sourceId: alert.sourceId,
      domain: alert.domain,
      kind: alert.kind,
      ...alert.detail,
    };
    opts.log.warn("poi-ingest alert", base);

    if (!opts.githubIssue) continue;
    const title = poiGithubIssueTitle(alert);
    const body = poiGithubIssueBody(alert);
    try {
      if (opts.githubIssue.findOpenIssueByTitle) {
        const existing = await opts.githubIssue.findOpenIssueByTitle(title);
        if (existing) {
          opts.log.info("poi-ingest alert: existing GitHub issue, skipped creation", {
            ...base,
            existing,
          });
          continue;
        }
      }
      const issueUrl = await opts.githubIssue.createIssue(title, body);
      opts.log.info("poi-ingest alert: GitHub issue created", { ...base, issueUrl });
    } catch (err) {
      opts.log.error("poi-ingest alert: GitHub issue failed", {
        ...base,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Stable issue title — the dedup path searches for an open issue with this
 * exact string. Do not change the format without a migration plan.
 */
export function poiGithubIssueTitle(alert: PoiAlert): string {
  const prefix = alert.kind === "stale" ? "Stale POI source" : "Failing POI source";
  return `${prefix}: ${alert.sourceId}`;
}

function poiGithubIssueBody(alert: PoiAlert): string {
  const lines: string[] = [];
  lines.push(`Automatic alert from the openmapx data-manager POI ingest pipeline.`);
  lines.push("");
  lines.push(`- sourceId: \`${alert.sourceId}\``);
  lines.push(`- domain: \`${alert.domain}\``);
  lines.push(`- kind: \`${alert.kind}\``);
  if (alert.threshold.hoursStale !== undefined) {
    lines.push(`- threshold (hours): \`${alert.threshold.hoursStale}\``);
  }
  if (alert.threshold.consecutiveFailures !== undefined) {
    lines.push(`- threshold (failures): \`${alert.threshold.consecutiveFailures}\``);
  }
  if (alert.detail.lastStaticIngestAt) {
    lines.push(`- lastStaticIngestAt: \`${alert.detail.lastStaticIngestAt}\``);
  }
  if (alert.detail.hoursStale !== undefined) {
    lines.push(`- hoursStale: \`${alert.detail.hoursStale}\``);
  }
  if (alert.detail.consecutiveFailures !== undefined) {
    lines.push(`- consecutiveFailures: \`${alert.detail.consecutiveFailures}\``);
  }
  if (alert.detail.lastErrorMessage) {
    lines.push(`- lastErrorMessage: \`${alert.detail.lastErrorMessage}\``);
  }
  return lines.join("\n");
}

/**
 * Build a `PoiGithubIssueSink` from raw token + repo. Returns `null` when
 * either is missing so callers can wire env-var lookup without conditionals.
 */
export function buildPoiGithubIssueSink(
  token: string | undefined,
  repo: string | undefined,
): PoiGithubIssueSink | null {
  if (!token || !repo) return null;
  const apiBase = `https://api.github.com/repos/${repo}`;
  return {
    async findOpenIssueByTitle(title: string): Promise<string | null> {
      const url = `${apiBase}/issues?state=open&per_page=100`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub list issues failed: ${res.status} ${res.statusText}`);
      }
      const issues = (await res.json()) as Array<{ title: string; html_url: string }>;
      const match = issues.find((issue) => issue.title === title);
      return match ? match.html_url : null;
    },
    async createIssue(title: string, body: string): Promise<string> {
      const res = await fetch(`${apiBase}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body }),
      });
      if (!res.ok) {
        throw new Error(`GitHub create issue failed: ${res.status} ${res.statusText}`);
      }
      const issue = (await res.json()) as { html_url: string };
      return issue.html_url;
    },
  };
}
