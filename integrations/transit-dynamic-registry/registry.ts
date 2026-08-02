import type { BBox } from "@openmapx/core";
import { fetchRegistryEntries } from "./fetcher";
import { TRANSPORT_APIS_COMMIT } from "./pin";
import type { ProtocolType, RegistryEntry } from "./registry-types";

/** Hand-crafted provider equivalents — suppress these dynamic entries */
const SUPPRESSED_IDS = new Set([
  "de/db-hafas-mgate",
  "be/nmbs-sncb-hafas-mgate",
  "ch/sbb-cff-ffs-hafas-mgate",
  "ch/bls-hafas-mgate",
  "ch/zvv-hafas-mgate",
  "ch/tpg-hafas-mgate",
  "us/mbta-otp",
]);

/** Protocols we currently have adapters for */
const SUPPORTED_ADAPTER_PROTOCOLS = new Set<ProtocolType>(["hafasMgate", "otpGraphQl"]);

function bboxesOverlap(a: BBox, b: BBox): boolean {
  return a[2] > b[0] && b[2] > a[0] && a[3] > b[1] && b[3] > a[1];
}

class RegistryManager {
  private entries: RegistryEntry[] = [];
  private byPrefix = new Map<string, RegistryEntry>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _initialized = false;

  get initialized(): boolean {
    return this._initialized;
  }

  get entryCount(): number {
    return this.entries.length;
  }

  async initialize(): Promise<void> {
    const all = await fetchRegistryEntries();
    this.index(all);
    this._initialized = true;
    console.log(
      `[transit-registry] Loaded ${this.entries.length} dynamic providers (${all.length} total, ${all.length - this.entries.length} suppressed/unsupported, transport-apis @ ${TRANSPORT_APIS_COMMIT.slice(0, 12)})`,
    );
  }

  private index(all: RegistryEntry[]): void {
    // Filter out suppressed entries and protocols without adapters
    const usable = all.filter(
      (e) => !SUPPRESSED_IDS.has(e.id) && SUPPORTED_ADAPTER_PROTOCOLS.has(e.protocol),
    );

    // Check for prefix collisions
    const seen = new Map<string, string>();
    const deduped: RegistryEntry[] = [];
    for (const entry of usable) {
      const existing = seen.get(entry.prefix);
      if (existing) {
        console.warn(
          `[transit-registry] Prefix collision: "${entry.prefix}" used by ${existing} and ${entry.id}, keeping first`,
        );
        continue;
      }
      seen.set(entry.prefix, entry.id);
      deduped.push(entry);
    }

    this.entries = deduped;
    this.byPrefix.clear();
    for (const entry of this.entries) {
      this.byPrefix.set(entry.prefix, entry);
    }
  }

  startRefresh(): void {
    // Refresh every 24 hours
    this.refreshTimer = setInterval(
      async () => {
        try {
          const all = await fetchRegistryEntries();
          this.index(all);
          console.log(`[transit-registry] Refreshed: ${this.entries.length} dynamic providers`);
        } catch (err) {
          console.warn("[transit-registry] Refresh failed:", err);
        }
      },
      24 * 60 * 60 * 1000,
    );
    // Don't keep the process alive just for this timer
    this.refreshTimer.unref?.();
  }

  stopRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Find all dynamic providers whose coverage overlaps the given bbox */
  findProviders(bbox: BBox): RegistryEntry[] {
    return this.entries.filter((e) => bboxesOverlap(bbox, e.coverage.bbox));
  }

  /** Find a provider by its stop-ID prefix (e.g. "oebb:") */
  findByPrefix(prefix: string): RegistryEntry | null {
    return this.byPrefix.get(prefix) ?? null;
  }

  /** Get all loaded entries (for debug endpoint and attribution wiring) */
  listEntries(): Array<{
    id: string;
    slug: string;
    prefix: string;
    name: string;
    protocol: ProtocolType;
    bbox: BBox;
    attribution?: RegistryEntry["attribution"];
  }> {
    return this.entries.map((e) => ({
      id: e.id,
      slug: e.slug,
      prefix: e.prefix,
      name: e.name,
      protocol: e.protocol,
      bbox: e.coverage.bbox,
      attribution: e.attribution,
    }));
  }

  /** Get slug → { label, url } for every loaded dynamic provider. */
  listProviders(): Array<{ slug: string; label: string; url: string }> {
    return this.entries.map((e) => ({
      slug: e.slug,
      label: e.attribution?.name ?? e.name,
      url: e.attribution?.homepage ?? "",
    }));
  }
}

export const registry = new RegistryManager();
