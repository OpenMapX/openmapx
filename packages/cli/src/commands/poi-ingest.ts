import { services } from "@openmapx/core/server";
import type { Command } from "commander";
import { log, table } from "../lib/output";

const { DataManagerClient } = services;

const DEFAULT_DM_URL = process.env.DATA_MANAGER_URL ?? "http://localhost:4000";

function formatTs(value: unknown): string {
  if (typeof value !== "string") return "-";
  // Trim to minute precision so the table stays narrow.
  return value.slice(0, 16).replace("T", " ");
}

function asString(value: unknown, fallback = "-"): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

interface SourceSummary {
  sourceId: string;
  domain: string;
  name: string;
  kinds: string[];
  status: string;
  consecutiveFailures: number;
  lastStaticIngestAt: string | null;
  lastLiveIngestAt: string | null;
  lastStaticRowCount: number | null;
  lastLiveRowCount: number | null;
}

function asSourceSummary(row: Record<string, unknown>): SourceSummary {
  return {
    sourceId: asString(row.sourceId),
    domain: asString(row.domain),
    name: asString(row.name),
    kinds: Array.isArray(row.kinds) ? (row.kinds as string[]) : [],
    status: asString(row.status, "unknown"),
    consecutiveFailures: asNumber(row.consecutiveFailures),
    lastStaticIngestAt: (row.lastStaticIngestAt as string | null) ?? null,
    lastLiveIngestAt: (row.lastLiveIngestAt as string | null) ?? null,
    lastStaticRowCount: (row.lastStaticRowCount as number | null) ?? null,
    lastLiveRowCount: (row.lastLiveRowCount as number | null) ?? null,
  };
}

function printSourcesTable(rows: SourceSummary[]): void {
  if (rows.length === 0) {
    log.info("(no POI sources registered)");
    return;
  }
  console.log(
    table(
      [
        { key: "id", header: "Source ID" },
        { key: "domain", header: "Domain" },
        { key: "kinds", header: "Kinds" },
        { key: "status", header: "Status" },
        { key: "fails", header: "Fails" },
        { key: "staticRows", header: "Static Rows" },
        { key: "staticAt", header: "Static @" },
        { key: "liveRows", header: "Live Rows" },
        { key: "liveAt", header: "Live @" },
      ],
      rows.map((r) => ({
        id: r.sourceId,
        domain: r.domain,
        kinds: r.kinds.join("+"),
        status: r.status,
        fails: r.consecutiveFailures > 0 ? String(r.consecutiveFailures) : "-",
        staticRows: r.lastStaticRowCount === null ? "-" : String(r.lastStaticRowCount),
        staticAt: formatTs(r.lastStaticIngestAt),
        liveRows: r.lastLiveRowCount === null ? "-" : String(r.lastLiveRowCount),
        liveAt: formatTs(r.lastLiveIngestAt),
      })),
    ),
  );
}

function dataManagerHint(): void {
  log.dim(
    `(hint: data-manager URL is ${DEFAULT_DM_URL} — override with DATA_MANAGER_URL; auth uses DATA_MANAGER_AUTH_TOKEN)`,
  );
}

export function registerPoiIngestCommands(program: Command): void {
  const poi = program
    .command("poi-ingest")
    .description("Inspect and trigger POI ingest sources (EV charging, parking, ...)");

  poi
    .command("state")
    .description("Print overall POI ingest state (counts by domain + status)")
    .action(async () => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const state = await client.poiIngestState();
        const drift = state.registryCountMatchesUpstream;
        log.info(`Sources registered: ${asNumber(state.sourcesCount)}`);
        const byDomain = state.byDomain as Record<string, number> | undefined;
        if (byDomain && Object.keys(byDomain).length > 0) {
          log.info("By domain:");
          for (const [k, v] of Object.entries(byDomain)) console.log(`  ${k}: ${v}`);
        }
        const byStatus = state.byStatus as Record<string, number> | undefined;
        if (byStatus) {
          log.info("By status:");
          for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k}: ${v}`);
        }
        const inflight = state.inflight as Array<Record<string, unknown>> | undefined;
        if (inflight && inflight.length > 0) {
          log.info(`In-flight: ${inflight.length}`);
          for (const j of inflight) {
            console.log(
              `  ${asString(j.sourceId)} (${asString(j.kind)}) since ${formatTs(j.startedAt)}`,
            );
          }
        }
        if (drift !== "unknown") {
          log.info(
            `Drift vs apps/api: ${drift === true ? "match" : "MISMATCH (check admin UI for detail)"}`,
          );
        }
        const failures = state.recentFailures as Array<Record<string, unknown>> | undefined;
        if (failures && failures.length > 0) {
          log.warn(`Recent failures (top ${failures.length}):`);
          for (const f of failures) {
            console.log(
              `  ${asString(f.sourceId)}  failures=${asNumber(f.consecutiveFailures)}  ${asString((f.lastError as Record<string, unknown> | null)?.message, "")}`,
            );
          }
        }
      } catch (err) {
        log.err(`poi-ingest state failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  poi
    .command("list")
    .description("List all registered POI sources")
    .option("--domain <name>", "Filter by domain (e.g. ev-charging, parking)")
    .option("--status <name>", "Filter by status (active | stale | failed | unknown)")
    .action(async (options: { domain?: string; status?: string }) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const rows = await client.poiIngestSources({
          domain: options.domain,
          status: options.status,
        });
        printSourcesTable(rows.map(asSourceSummary));
      } catch (err) {
        log.err(`poi-ingest list failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  poi
    .command("show <sourceId>")
    .description("Print full detail for one POI source (declaration + last run + recent jobs)")
    .action(async (sourceId: string) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const detail = await client.poiIngestSource(sourceId);
        console.log(JSON.stringify(detail, null, 2));
      } catch (err) {
        log.err(`poi-ingest show failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });

  poi
    .command("sync <sourceId>")
    .description("Trigger a full sync (static + live for two-tier; bundled for combined)")
    .option("--live-only", "Only refresh the live cache (not allowed for bundled sources)")
    .option("--idempotency-key <key>", "Optional idempotency key to dedupe replays")
    .action(async (sourceId: string, options: { liveOnly?: boolean; idempotencyKey?: string }) => {
      const client = new DataManagerClient({ baseUrl: DEFAULT_DM_URL });
      try {
        const res = await client.poiIngestSync(sourceId, {
          liveOnly: options.liveOnly,
          idempotencyKey: options.idempotencyKey,
        });
        log.ok(
          `Triggered ${options.liveOnly ? "live" : "full"} sync for ${sourceId}: jobId=${asString(res.jobId)} status=${asString(res.status)}`,
        );
        log.dim("(Tail data-manager logs to watch progress.)");
      } catch (err) {
        log.err(`poi-ingest sync failed: ${(err as Error).message}`);
        dataManagerHint();
        process.exit(1);
      }
    });
}
