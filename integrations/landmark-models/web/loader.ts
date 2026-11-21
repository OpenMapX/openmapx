import type { Attribution } from "@openmapx/integration-framework";
import { readCapturedContributors } from "@openmapx/mobility-core/contributors";
import type { CellResponse, CoverageResponse, WireAsset } from "../wire";
import { cellsInArea } from "./area";

type Box = [number, number, number, number];

export interface Candidate {
  asset: WireAsset;
  receipts: Attribution[];
}

const ROUTE = "/api/integrations/landmark-models";
const COVERAGE_MAX_AGE_MS = 5 * 60_000;

const intersects = (a: readonly number[], b: readonly number[]) =>
  (a[0] as number) <= (b[2] as number) &&
  (a[2] as number) >= (b[0] as number) &&
  (a[1] as number) <= (b[3] as number) &&
  (a[3] as number) >= (b[1] as number);

/**
 * The browser's view of the merged landmark catalogue: coverage, then the
 * z12 cells of the area being looked at. Cell URLs carry the coverage
 * revision so each revision has its own cache entry; a cell that answers with
 * another revision (a different API replica, a refresh in between) is used
 * for that one answer and the coverage is fetched again from the network.
 * Only cells of the current coverage revision are kept.
 */
export class LandmarkCatalogue {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private coverage: { value: CoverageResponse; at: number } | null = null;
  private pendingCoverage: Promise<CoverageResponse> | null = null;
  private readonly cells = new Map<string, Candidate[]>();

  constructor(
    private readonly options: { apiUrl: string; fetch?: typeof fetch; now?: () => number },
  ) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  async ensureCoverage(maxAgeMs = COVERAGE_MAX_AGE_MS): Promise<CoverageResponse> {
    if (this.coverage && this.now() - this.coverage.at < maxAgeMs) return this.coverage.value;
    return this.loadCoverage();
  }

  private loadCoverage(reload = false): Promise<CoverageResponse> {
    this.pendingCoverage ??= (async () => {
      try {
        const response = await this.fetchImpl(
          `${this.options.apiUrl}${ROUTE}/coverage`,
          reload ? { cache: "reload" } : {},
        );
        if (!response.ok) throw new Error(`Landmark coverage answered ${response.status}`);
        const value = (await response.json()) as CoverageResponse;
        if (this.coverage?.value.revision !== value.revision) this.cells.clear();
        this.coverage = { value, at: this.now() };
        return value;
      } finally {
        this.pendingCoverage = null;
      }
    })();
    return this.pendingCoverage;
  }

  /** Assets inside an area that show at this zoom, nearest to its centre first. */
  async candidates(area: Box, zoom: number, signal: AbortSignal): Promise<Candidate[]> {
    const coverage = await this.ensureCoverage();
    const occupied = new Set(coverage.occupied);
    let stale = false;
    const fetched = new Map<string, { revision: string; candidates: Candidate[] }>();
    for (const cell of cellsInArea(area, occupied)) {
      if (this.cells.has(cell)) continue;
      const response = await this.fetchImpl(
        `${this.options.apiUrl}${ROUTE}/cells/${cell}?r=${encodeURIComponent(coverage.revision)}`,
        { signal },
      );
      if (!response.ok) continue;
      const body = (await response.json()) as CellResponse;
      const receipts = body.receipts.map((receipt) => readCapturedContributors([receipt])?.[0]);
      const candidates = body.assets.map((asset) => ({
        asset,
        receipts: asset.receipts.flatMap((index) => {
          const receipt = receipts[index];
          return receipt ? [receipt] : [];
        }),
      }));
      fetched.set(cell, { revision: body.revision, candidates });
      if (body.revision === coverage.revision) this.cells.set(cell, candidates);
      else stale = true;
    }
    // This call answers from what it has, whatever revision a cell came from.
    const answer = new Map(this.cells);
    for (const [cell, { candidates }] of fetched) answer.set(cell, candidates);
    if (stale) {
      const current = await this.loadCoverage(true);
      // Fresh answers of the new revision are kept; the rest are used once.
      for (const [cell, answer] of fetched)
        if (answer.revision === current.revision) this.cells.set(cell, answer.candidates);
    }

    const [west, south, east, north] = area;
    const center = [(west + east) / 2, (south + north) / 2] as const;
    const byId = new Map<string, Candidate>();
    for (const cell of cellsInArea(area, occupied)) {
      for (const candidate of answer.get(cell) ?? []) {
        if (candidate.asset.minZoom > zoom) continue;
        if (!intersects(candidate.asset.bounds, area)) continue;
        byId.set(candidate.asset.id, candidate);
      }
    }
    const distance = (asset: WireAsset) =>
      Math.hypot(asset.anchor[0] - center[0], asset.anchor[1] - center[1]);
    return [...byId.values()].sort((a, b) => distance(a.asset) - distance(b.asset));
  }
}
