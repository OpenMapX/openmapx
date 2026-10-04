import type { IntegrationContext, IntegrationDataSource } from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "./client.js";

/** A right as OpenConditions states it: granted, denied, or not stated (null). */
type Right = boolean | null;

/** One feed an OpenConditions instance serves, as `GET /sources` lists it. */
export interface OcSource {
  id: string;
  name: string;
  domain: string;
  product: string;
  operator: string;
  region: string;
  country?: string;
  subdivision?: string;
  accessMode: "bulk" | "on_demand";
  /** Its records are withheld from the public scope; the entry is metadata only. */
  restricted: boolean;
  license: string;
  licenseUrl?: string;
  attribution: string;
  homepage: string;
  privacyUrl: string;
  terms?: { url?: string; reviewedAt?: string; note?: string };
  rights: {
    redistribution: Right;
    derivedRedistribution: Right;
    commercialUse: Right;
    attributionRequired: Right;
    retention: Right;
    shareAlike: boolean;
  };
}

/** The OpenMapX domain each OpenConditions domain is served under. */
const DOMAINS: Readonly<Record<string, string>> = {
  roads: "road-conditions",
  fuel: "fuel-stations",
};

/** How often the list is read again. */
export const SOURCE_SYNC_INTERVAL_MS = 300_000;
/** How soon a failed read is tried again. */
export const SOURCE_SYNC_RETRY_MS = 30_000;
const SOURCE_READ_TIMEOUT_MS = 10_000;

const permission = (right: Right): "yes" | "no" | "unknown" =>
  right === true ? "yes" : right === false ? "no" : "unknown";

/** A redistribution right; share-alike attaches a condition to a granted one. */
function redistributionOf(
  right: Right,
  shareAlike: boolean,
): "yes" | "no" | "conditional" | "unknown" {
  return right === true && shareAlike ? "conditional" : permission(right);
}

/** The usage condition of a share-alike licence. */
export const SHARE_ALIKE_CONDITION =
  "Share-alike: a database derived from this data must be published under the same licence.";

/** The terms note (the host caps a condition at 1,000 characters) and share-alike. */
function usageConditionsOf(source: OcSource): string[] {
  return [
    ...(source.terms?.note ? [source.terms.note.slice(0, 1000)] : []),
    ...(source.rights.shareAlike ? [SHARE_ALIKE_CONDITION] : []),
  ];
}

function providerCountryOf(source: OcSource): string {
  if (source.country) return source.country.toUpperCase();
  return source.region === "eu" ? "EU" : "INT";
}

/**
 * An OpenConditions source as an OpenMapX data source, or undefined for a
 * source in a domain OpenMapX does not serve. OpenMapX reads every source
 * server-side through OpenConditions, so none reaches the browser directly.
 */
export function toDataSource(source: OcSource): IntegrationDataSource | undefined {
  const domain = DOMAINS[source.domain];
  if (domain === undefined) return undefined;
  const usageConditions = usageConditionsOf(source);
  return {
    sourceId: source.id,
    domain,
    name: source.name,
    url: source.homepage,
    license: source.license,
    ...(source.licenseUrl ? { licenseUrl: source.licenseUrl } : {}),
    attribution: source.attribution,
    ...(source.terms?.url ? { termsUrl: source.terms.url } : {}),
    ...(source.terms?.reviewedAt ? { reviewedAt: source.terms.reviewedAt } : {}),
    ...(usageConditions.length > 0 ? { usageConditions } : {}),
    providerCountry: providerCountryOf(source),
    providerPrivacyUrl: source.privacyUrl,
    commercialUse: permission(source.rights.commercialUse),
    redistribution: {
      sourceData: redistributionOf(source.rights.redistribution, source.rights.shareAlike),
      derivedData: redistributionOf(source.rights.derivedRedistribution, source.rights.shareAlike),
    },
    endUserExposure: "server-only",
    personalData: false,
    cookies: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

interface ReadList {
  list: IntegrationDataSource[];
  /** Ids of the entries that are not a source OpenConditions describes. */
  invalid: string[];
  /** Ids of the sources in a domain OpenMapX does not serve. */
  unmapped: string[];
  /** Ids of the restricted sources left out in the public scope. */
  withheld: string[];
}

/** The scope OpenConditions served a read in; the operator scope includes restricted sources. */
export type OcScope = "public" | "operator";

/** A `GET /sources` answer. */
export interface OcSourceList {
  generatedAt: string;
  /** The scope the list was served in. */
  scope: OcScope;
  sources: OcSource[];
}

/**
 * The data sources of a `/sources` answer; throws on an answer that is not
 * one. The answer names the scope it was served in, and in the public scope
 * a restricted source is left out: its records are never served to
 * OpenMapX. The scope is OpenConditions' own, not whether OpenMapX sent a
 * token: an instance that holds no token answers a bearer read in public.
 */
function dataSourcesOf(answer: unknown): ReadList {
  const sources = isRecord(answer) ? answer["sources"] : undefined;
  const scope = isRecord(answer) ? answer["scope"] : undefined;
  if (!Array.isArray(sources) || (scope !== "public" && scope !== "operator")) {
    throw new Error("Malformed /sources answer");
  }
  const operator = scope === "operator";
  const out: ReadList = { list: [], invalid: [], unmapped: [], withheld: [] };
  for (const source of sources) {
    const id = isRecord(source) && typeof source["id"] === "string" ? source["id"] : "(no id)";
    if (
      !isRecord(source) ||
      id === "(no id)" ||
      !isRecord(source["rights"]) ||
      typeof source["restricted"] !== "boolean"
    ) {
      out.invalid.push(id);
      continue;
    }
    if (source["restricted"] && !operator) {
      out.withheld.push(id);
      continue;
    }
    const ds = toDataSource(source as unknown as OcSource);
    if (ds) out.list.push(ds);
    else out.unmapped.push(id);
  }
  return out;
}

/**
 * The sources the instance lists, as the providers check them: no source is
 * listed until the first list arrives, so a provider serves nothing it
 * cannot credit or gate.
 */
export interface LiveSources {
  /** False until the first list arrives. */
  readonly ready: boolean;
  has(sourceId: string): boolean;
  /** The source's credit link: its homepage. */
  link(sourceId: string): string | undefined;
}

export interface UpdatableLiveSources extends LiveSources {
  update(list: readonly Pick<IntegrationDataSource, "sourceId" | "url">[]): void;
}

export function createLiveSources(): UpdatableLiveSources {
  let links: ReadonlyMap<string, string> | undefined;
  return {
    get ready() {
      return links !== undefined;
    },
    has: (sourceId) => links?.has(sourceId) ?? false,
    link: (sourceId) => links?.get(sourceId),
    update(list) {
      links = new Map(list.map((ds) => [ds.sourceId, ds.url]));
    },
  };
}

export interface SourceSyncOptions {
  /** Time between reads after a successful one; 5 minutes by default. */
  intervalMs?: number;
  /** Time before the next read after a failed one; 30 seconds by default, never more than `intervalMs`. */
  retryMs?: number;
  /** Called with the sources the host accepted from each list. */
  onSources?: (list: readonly IntegrationDataSource[]) => void;
}

export interface SourceSync {
  /** Settles once the first read has succeeded or failed; never rejects. */
  first: Promise<void>;
  /** Stops reading; a read still in flight is discarded. Also runs on shutdown. */
  stop(): void;
}

/**
 * Keeps the integration's data sources in step with the OpenConditions
 * `/sources` list: reads it now and every `intervalMs`, supplies each list to
 * the host with `ctx.setDataSources` and hands `onSources` the sources the
 * host accepted. A failed or malformed read
 * keeps the last list in place and is retried after `retryMs`.
 */
export function startSourceSync(
  ctx: IntegrationContext,
  client: OpenConditionsClient,
  opts: SourceSyncOptions = {},
): SourceSync {
  const intervalMs = opts.intervalMs ?? SOURCE_SYNC_INTERVAL_MS;
  const retryMs = Math.min(opts.retryMs ?? SOURCE_SYNC_RETRY_MS, intervalMs);
  let stopped = false;
  let failing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function read(): Promise<boolean> {
    try {
      const answer = await client.get<unknown>("/sources", undefined, {
        timeoutMs: SOURCE_READ_TIMEOUT_MS,
      });
      if (stopped) return true;
      const { list, invalid, unmapped, withheld } = dataSourcesOf(answer);
      if (invalid.length > 0) {
        ctx.log.warn(`OpenConditions /sources: skipped malformed entries ${invalid.join(", ")}`);
      }
      if (unmapped.length > 0) {
        ctx.log.debug(
          `OpenConditions /sources: no OpenMapX domain for ${unmapped.join(", ")}; not credited`,
        );
      }
      if (withheld.length > 0) {
        ctx.log.debug(
          `OpenConditions /sources: ${withheld.join(", ")} restricted; not served in the public scope (OPENCONDITIONS_OPERATOR_TOKEN unset, or not the token OpenConditions holds)`,
        );
      }
      // The host may drop an entry (no credit link, a sourceId another
      // integration declares): a dropped source is neither credited nor
      // gated, so the providers serve only what it accepted.
      const accepted = ctx.setDataSources(list);
      opts.onSources?.(accepted);
      if (failing) {
        failing = false;
        ctx.log.info(`OpenConditions /sources recovered: ${accepted.length} sources`);
      }
      return true;
    } catch (err) {
      if (stopped) return false;
      const reason = err instanceof Error ? err.message : String(err);
      // An outage is logged when it starts and when it ends, not at every retry.
      if (failing) {
        ctx.log.debug(`OpenConditions /sources read failed again: ${reason}`);
      } else {
        failing = true;
        ctx.log.warn(
          `OpenConditions /sources read failed; keeping the last list and retrying: ${reason}`,
        );
      }
      return false;
    }
  }

  function schedule(ok: boolean): void {
    if (stopped) return;
    timer = setTimeout(
      () => {
        void read().then(schedule);
      },
      ok ? intervalMs : retryMs,
    );
    timer.unref?.();
  }

  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
  ctx.onShutdown(async () => stop());

  const first = read().then((ok) => {
    schedule(ok);
  });
  return { first, stop };
}
