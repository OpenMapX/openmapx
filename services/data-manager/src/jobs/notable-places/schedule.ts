import { Cron } from "croner";
import type postgres from "postgres";
import { pickCronExpression } from "../../utils/cron-expression.js";
import type { SearchIndexOperationLock } from "../search-index/operation-lock.js";
import { buildNotablePlaces } from "./build.js";
import { DEFAULT_NOTABLE_MIN_SITELINKS } from "./sparql.js";
import { hasPublishedNotablePlaces, type NotablePlacesRuntimeState } from "./state.js";

/** Monthly: fame moves slowly, and each refresh downloads a few hundred MB. */
const NOTABLE_PLACES_REFRESH_CRON_DEFAULT = "0 2 1 * *";

export interface NotablePlacesSettings {
  endpoint?: string;
  minSitelinks: number;
}

/** `NOTABLE_PLACES_SPARQL_URL` and `NOTABLE_PLACES_MIN_SITELINKS`, defaults when unset. */
export function notablePlacesSettings(env: NodeJS.ProcessEnv = process.env): NotablePlacesSettings {
  const endpoint = env.NOTABLE_PLACES_SPARQL_URL?.trim() || undefined;
  const parsed = Number.parseInt(env.NOTABLE_PLACES_MIN_SITELINKS ?? "", 10);
  const minSitelinks =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_NOTABLE_MIN_SITELINKS;
  return { endpoint, minSitelinks };
}

export interface NotablePlacesLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface NotablePlacesScheduleOptions {
  sql: postgres.Sql;
  runtimeState: NotablePlacesRuntimeState;
  operationLock: SearchIndexOperationLock;
  logger: NotablePlacesLogger;
  /** Overrides `NOTABLE_PLACES_REFRESH_CRON`; "off" disables refreshes and the first build. */
  cronExpression?: string;
  build?: typeof buildNotablePlaces;
}

export interface NotablePlacesSchedule {
  /** Builds the index now if none is published yet; resolves when that build ends. */
  buildIfMissing(): Promise<void>;
  stop(): void;
}

/**
 * Keeps the notable-places index present and fresh without an operator: one
 * build when the data-manager starts without a snapshot, then a refresh on
 * the schedule. A failed build leaves the previous snapshot searchable and is
 * retried at the next run.
 */
export function scheduleNotablePlaces(opts: NotablePlacesScheduleOptions): NotablePlacesSchedule {
  const expression = pickCronExpression(
    opts.cronExpression,
    "NOTABLE_PLACES_REFRESH_CRON",
    NOTABLE_PLACES_REFRESH_CRON_DEFAULT,
  );
  const build = opts.build ?? buildNotablePlaces;
  const run = async (reason: string): Promise<void> => {
    if (opts.operationLock.inFlight) return;
    opts.logger.info({ reason }, "notable-places: build starting");
    try {
      const result = await build({
        sql: opts.sql,
        runtimeState: opts.runtimeState,
        operationLock: opts.operationLock,
        ...notablePlacesSettings(),
      });
      opts.logger.info(
        { places: result.placeCount, names: result.nameCount, epoch: result.epoch },
        "notable-places: published",
      );
    } catch (error) {
      opts.logger.warn({ err: (error as Error).message }, "notable-places: build failed");
    }
  };
  const cron = expression
    ? new Cron(expression, { name: "notable-places-refresh", protect: true }, () => run("schedule"))
    : null;
  return {
    async buildIfMissing() {
      if (!expression) return;
      if (await hasPublishedNotablePlaces(opts.sql)) return;
      await run("no snapshot published");
    },
    stop() {
      cron?.stop();
    },
  };
}
